import type { SwitchBotPluginConfig } from './settings.js'

import { getDeviceCommandHandler } from './deviceCommandMapper.js'
import { CharacteristicMissingError, SwitchbotAuthenticationError, SwitchbotOperationError } from './errors.js'
import { OpenApiClient } from './openApiClient.js'

/**
 * The Bluetooth library, which is not installed by default: it carries a native stack that has to
 * be compiled wherever this plugin is installed, and a hub makes it unnecessary.
 */
const BLE_LIBRARY = 'node-switchbot'

export interface ISwitchBotClient {
  init: () => Promise<void>
  getDevice: (id: string) => Promise<any>
  getStatus: (id: string, maxAgeMs?: number) => Promise<any>
  getDevices: () => Promise<any[]>
  setDeviceState: (id: string, body: any) => Promise<any>
  sendIRCommand: (id: string, command: string, parameter?: string) => Promise<any>
  destroy: () => Promise<void>
}

/**
 * Thin wrapper around node-switchbot v4.0.0+
 * Leverages upstream resilience features (retry, circuit breaker, connection intelligence)
 * while maintaining plugin-specific features like write debouncing and OpenAPI fallback.
 */
export class SwitchBotClient implements ISwitchBotClient {
  private cfg: SwitchBotPluginConfig
  private client: any | null = null
  private api: OpenApiClient | null = null
  private cloudDevices: { at: number, devices: any[] } | null = null
  private writeDebounceMs = 100
  private discoveryCacheTtlMs = 30_000
  private lastDiscoveryAt = 0
  private logger: import('homebridge').Logger
  private pendingWrites: Map<string, { timer: any, body: any, resolvers: Array<{ resolve: (v: any) => void, reject: (e: any) => void }> }> = new Map()
  private statusCache: Map<string, { at: number, status: any }> = new Map()

  constructor(cfg: SwitchBotPluginConfig) {
    this.cfg = cfg
    this.logger = (cfg as any)?.logger as import('homebridge').Logger
    if (!this.logger) {
      throw new Error('SwitchBotClient requires a logger (Homebridge logger) in config')
    }
    if (typeof (cfg as any)?.writeDebounceMs === 'number') {
      this.writeDebounceMs = (cfg as any).writeDebounceMs
    }
    if (typeof (cfg as any)?.discoveryCacheTtlMs === 'number') {
      this.discoveryCacheTtlMs = Math.max(0, (cfg as any).discoveryCacheTtlMs)
    }
  }

  async init(): Promise<void> {
    if (this.client || this.api) {
      return
    }

    if (this.cfg.enableBLE === true) {
      try {
        // Only loaded when asked for: see BLE_LIBRARY. The specifier is held in a variable so
        // that a build does not require the package to be there.
        const { SwitchBot } = await import(BLE_LIBRARY)
        const rawNodeClientConfig = typeof (this.cfg as any)?.nodeClientConfig === 'object' ? (this.cfg as any).nodeClientConfig : {}
        const scanTimeout = this.resolveScanTimeoutMs(rawNodeClientConfig)
        this.client = new SwitchBot({
          token: this.cfg.openApiToken,
          secret: this.cfg.openApiSecret,
          // Enable built-in resilience features from node-switchbot v4.
          enableFallback: true, // Auto-fallback from BLE to API
          enableRetry: true, // Retry with exponential backoff
          enableCircuitBreaker: true, // Circuit breaker per connection type
          enableConnectionIntelligence: true, // Connection tracking and route preference
          enableBLE: true,
          scanTimeout,
          ...rawNodeClientConfig,
        })
        this.lastDiscoveryAt = 0
        this.logger?.info?.('SwitchBot client initialized over Bluetooth and the cloud')
        return
      } catch (e) {
        this.logger?.warn?.(`Bluetooth support needs ${BLE_LIBRARY} installed alongside this plugin; falling back to the cloud:`, (e as Error)?.message)
        this.client = null
      }
    }

    if (!this.cfg.openApiToken || !this.cfg.openApiSecret) {
      this.logger?.error?.('No SwitchBot token and secret configured: the plugin has no way to reach the devices')
      return
    }

    this.api = new OpenApiClient(this.cfg.openApiToken, this.cfg.openApiSecret, this.logger)
    this.logger?.info?.('SwitchBot client initialized against the cloud')
  }

  /**
   * @returns {any} Whichever client can talk to the SwitchBot cloud - the one inside the Bluetooth
   * library when that is in use, and this plugin's own otherwise.
   */
  private get cloud(): any {
    const fromLibrary = typeof (this.client as any)?.getAPIClient === 'function' ? (this.client as any).getAPIClient() : undefined
    return fromLibrary ?? this.api
  }

  /**
   * Lists what the account holds, as plain objects rather than things to talk to.
   *
   * @param {boolean} force Whether to ask again rather than use the last answer.
   * @returns {Promise<any[]>} Every device and infrared remote, each with an `id` and a
   * `deviceType`.
   */
  private async listCloudDevices(force = false): Promise<any[]> {
    const fresh = this.cloudDevices && Date.now() - this.cloudDevices.at < 60_000
    if (!force && fresh) {
      return this.cloudDevices!.devices
    }

    const { deviceList, infraredRemoteList } = await this.cloud.getDevices()
    const devices = [
      ...deviceList.map((d: any) => ({ ...d, id: d.deviceId, name: d.deviceName, type: d.deviceType })),
      // A remote has no device type of its own; what it pretends to be is its remote type.
      ...infraredRemoteList.map((d: any) => ({ ...d, id: d.deviceId, name: d.deviceName, type: d.remoteType, deviceType: d.remoteType, isIR: true })),
    ]
    this.cloudDevices = { at: Date.now(), devices }
    return devices
  }

  async getDevice(id: string): Promise<any> {
    if (!this.client && this.api) {
      const devices = await this.listCloudDevices()
      return devices.find((d: any) => d.id === id) ?? (await this.listCloudDevices(true)).find((d: any) => d.id === id)
    }

    if (this.client) {
      try {
        const fromManager = this.getManagedDevice(id)
        if (fromManager) {
          return fromManager
        }

        const devices = await this.ensureDiscovered(false)
        const fromDiscovery = devices.find((d: any) => d.id === id)
        if (fromDiscovery) {
          return fromDiscovery
        }

        const refreshDevices = await this.ensureDiscovered(true)
        return refreshDevices.find((d: any) => d.id === id)
      } catch (e: any) {
        if (e instanceof SwitchbotAuthenticationError) {
          this.logger?.error?.(`Authentication error for getDevice(${id}):`, e.message)
          throw e
        } else if (e instanceof SwitchbotOperationError) {
          this.logger?.warn?.(`Operation error for getDevice(${id}):`, e.message, e.code)
          throw e
        } else if (e instanceof CharacteristicMissingError) {
          this.logger?.warn?.(`Characteristic missing for getDevice(${id}):`, e.characteristic)
          throw e
        } else {
          this.logger?.warn?.(`Client getDevice failed for ${id}:`, e)
          throw e
        }
      }
    }
    throw new SwitchbotOperationError('No SwitchBot client available', 'no_client')
  }

  /**
   * Reads a device's state from the SwitchBot cloud.
   *
   * A device found over BLE is an object to talk to, not a reading: it carries no position and no
   * power state, and after a restart the plugin knows nothing about a curtain until someone moves
   * it. The cloud does know, and this is the only way to ask.
   *
   * The answer is cached briefly because HomeKit reads a characteristic whenever it feels like it,
   * and the SwitchBot API allows a limited number of calls per day.
   *
   * @param {string} id The device id.
   * @param {number} maxAgeMs How old an answer may be before it is asked for again.
   * @returns {Promise<any>} The status the cloud reports, or undefined when it cannot be asked.
   */
  async getStatus(id: string, maxAgeMs = 20_000): Promise<any> {
    const cached = this.statusCache.get(id)
    if (cached && Date.now() - cached.at < maxAgeMs) {
      return cached.status
    }

    const api = this.cloud
    if (!api || typeof api.getStatus !== 'function') {
      return undefined
    }

    try {
      const status = await api.getStatus(id)
      this.statusCache.set(id, { at: Date.now(), status })
      return status
    } catch (e) {
      this.logger?.debug?.(`Cloud status read failed for ${id}:`, (e as Error)?.message)
      // Better a stale reading than none: the alternative is reporting a default.
      return cached?.status
    }
  }

  async getDevices(): Promise<any[]> {
    if (!this.client && this.api) {
      return this.listCloudDevices()
    }

    if (this.client) {
      try {
        const fromManager = this.getManagedDevices()
        if (fromManager.length > 0) {
          return fromManager
        }
        return await this.ensureDiscovered(false)
      } catch (e) {
        this.logger?.warn?.('Client getDevices failed:', e)
        throw e
      }
    }
    throw new SwitchbotOperationError('No SwitchBot client available', 'no_client')
  }

  async setDeviceState(id: string, body: any): Promise<any> {
    // Plugin-level debounce: coalesce rapid writes per device
    if (!this.writeDebounceMs || this.writeDebounceMs <= 0) {
      return this._doSetDeviceState(id, body)
    }

    return new Promise((resolve, reject) => {
      const existing = this.pendingWrites.get(id)
      if (existing) {
        existing.body = body
        existing.resolvers.push({ resolve, reject })
        return
      }

      const resolvers: Array<{ resolve: (v: any) => void, reject: (e: any) => void }> = [{ resolve, reject }]
      const timer = setTimeout(async () => {
        const entry = this.pendingWrites.get(id)
        if (!entry) {
          return
        }
        this.pendingWrites.delete(id)
        try {
          const out = await this._doSetDeviceState(id, entry.body)
          for (const r of entry.resolvers) r.resolve(out)
        } catch (e: any) {
          if (e instanceof SwitchbotAuthenticationError) {
            this.logger?.error?.(`Authentication error for setDeviceState(${id}):`, e.message)
          } else if (e instanceof SwitchbotOperationError) {
            this.logger?.warn?.(`Operation error for setDeviceState(${id}):`, e.message, e.code)
          } else if (e instanceof CharacteristicMissingError) {
            this.logger?.warn?.(`Characteristic missing for setDeviceState(${id}):`, e.characteristic)
          }
          for (const r of entry.resolvers) r.reject(e)
        }
      }, this.writeDebounceMs)

      this.pendingWrites.set(id, { timer, body, resolvers })
    })
  }

  /**
   * Press a button on an infrared remote.
   *
   * IR remotes are not devices the hub talks to - they are codes it blasts - so they never show
   * up in discovery and `setDeviceState` cannot be used for them: it resolves the device first
   * and would fail with `device_not_found`. The command goes straight to the cloud instead, which
   * is the only route the SwitchBot API offers for infrared.
   *
   * @param id The remote's device id, as listed under `infraredRemoteList` in the SwitchBot API.
   * @param command The command to send, e.g. `turnOn` or `turnOff`.
   * @param parameter The command parameter; `default` for the standard buttons.
   */
  async sendIRCommand(id: string, command: string, parameter: string = 'default'): Promise<any> {
    if (!this.client && !this.api) {
      throw new SwitchbotOperationError('No SwitchBot client available for IR command', 'no_client')
    }

    const api = this.cloud
    if (!api || typeof api.sendCommand !== 'function') {
      throw new SwitchbotOperationError(
        'Infrared remotes are only reachable through the SwitchBot cloud: set openApiToken and openApiSecret',
        'no_openapi',
      )
    }

    this.logger?.debug?.(`Sending IR command ${command} to ${id}`)
    return api.sendCommand(id, command, parameter)
  }

  /**
   * Sends a command the way the cloud expects it.
   *
   * @param {string} id The device to command.
   * @param {any} body The command, as the rest of the plugin words it.
   * @returns {Promise<any>} Whatever the cloud answers.
   */
  private async _sendCloudCommand(id: string, body: any): Promise<any> {
    const command = body?.command
    if (!command) {
      throw new SwitchbotOperationError('No command specified in body', 'no_command')
    }

    const device = await this.getDevice(id)
    const deviceType = String(device?.deviceType ?? '').toLowerCase()
    let parameter = body?.parameter ?? 'default'

    // A curtain takes its position as index, mode and percentage together; everywhere else in
    // this plugin a position is just the percentage.
    if (command === 'setPosition' && !String(parameter).includes(',') && (deviceType.includes('curtain') || deviceType.includes('blind'))) {
      parameter = `0,ff,${parameter}`
    }

    this.logger?.debug?.(`[${id}] Sending ${command} (${parameter}) over the cloud`)
    return this.cloud.sendCommand(id, command, parameter, body?.commandType ?? 'command')
  }

  private async _doSetDeviceState(id: string, body: any): Promise<any> {
    if (!this.client && this.api) {
      return this._sendCloudCommand(id, body)
    }
    if (!this.client) {
      throw new SwitchbotOperationError('No SwitchBot client available for setDeviceState', 'no_client')
    }
    try {
      const device = await this.getDevice(id)
      if (!device) {
        throw new SwitchbotOperationError(`Device ${id} not found`, 'device_not_found')
      }
      const deviceType = (device.deviceType ?? '').toLowerCase()
      const command = body?.command
      if (!command) {
        throw new SwitchbotOperationError('No command specified in body', 'no_command')
      }
      const handler = getDeviceCommandHandler(deviceType, command)
      if (!handler) {
        throw new SwitchbotOperationError(`Unsupported command '${command}' for device type '${deviceType}'`, 'unsupported_command')
      }
      this.logger?.debug?.(`[${id}] Calling mapped command '${command}' for device type '${deviceType}'`)
      return await handler(device, body)
    } catch (e: any) {
      if (e instanceof SwitchbotAuthenticationError) {
        this.logger?.error?.(`Authentication error for setDeviceState(${id}):`, e.message)
        throw e
      } else if (e instanceof SwitchbotOperationError) {
        this.logger?.warn?.(`Operation error for setDeviceState(${id}):`, e.message, e.code)
        throw e
      } else if (e instanceof CharacteristicMissingError) {
        this.logger?.warn?.(`Characteristic missing for setDeviceState(${id}):`, e.characteristic)
        throw e
      } else {
        this.logger?.warn?.(`Device command failed for ${id}:`, e)
        throw e
      }
    }
  }

  async destroy(): Promise<void> {
    for (const [, pending] of this.pendingWrites) {
      clearTimeout(pending.timer)
      const err = new SwitchbotOperationError('Client destroyed before pending write was sent', 'client_destroyed')
      for (const r of pending.resolvers) {
        r.reject(err)
      }
    }
    this.pendingWrites.clear()

    if (this.client?.cleanup) {
      await this.client.cleanup()
    }
    this.client = null
    this.api = null
    this.cloudDevices = null
    this.lastDiscoveryAt = 0
  }

  private resolveScanTimeoutMs(rawNodeClientConfig: Record<string, any>): number {
    if (typeof rawNodeClientConfig.scanTimeout === 'number' && Number.isFinite(rawNodeClientConfig.scanTimeout)) {
      return Math.max(500, rawNodeClientConfig.scanTimeout)
    }

    if (typeof rawNodeClientConfig.scanDuration === 'number' && Number.isFinite(rawNodeClientConfig.scanDuration)) {
      return Math.max(500, rawNodeClientConfig.scanDuration)
    }

    if (typeof (this.cfg as any)?.bleScanDurationSeconds === 'number') {
      return Math.max(500, (this.cfg as any).bleScanDurationSeconds * 1000)
    }

    return 5000
  }

  private getManagedDevice(id: string): any {
    const manager = (this.client as any)?.devices
    if (manager?.get) {
      return manager.get(id)
    }
    return undefined
  }

  private getManagedDevices(): any[] {
    const manager = (this.client as any)?.devices
    if (manager?.list) {
      const list = manager.list()
      return Array.isArray(list) ? list : []
    }
    return []
  }

  private async ensureDiscovered(force: boolean): Promise<any[]> {
    if (!this.client) {
      throw new SwitchbotOperationError('No SwitchBot client available', 'no_client')
    }

    const fromManager = this.getManagedDevices()
    const cacheValid = this.discoveryCacheTtlMs > 0 && (Date.now() - this.lastDiscoveryAt) < this.discoveryCacheTtlMs
    if (!force && cacheValid && fromManager.length > 0) {
      return fromManager
    }

    const discovered = await this.client.discover()
    this.lastDiscoveryAt = Date.now()
    return discovered
  }
}
