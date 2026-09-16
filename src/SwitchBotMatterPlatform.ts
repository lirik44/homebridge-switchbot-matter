import type { API, Logger, PlatformConfig } from 'homebridge'

import type { SwitchBotPluginConfig } from './settings.js'

import { createDevice } from './deviceFactory.js'
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js'
import { SwitchBotClient } from './switchbotClient.js'
import { collectConfiguredDevices, createMatterHandlers, DEVICE_MATTER_CLUSTERS, DEVICE_MATTER_SUPPORTED, matterStateFor, normalizeTypeForMatter, resolveMatterDeviceType } from './utils.js'

/**
 * Homebridge platform class for SwitchBot Matter integration.
 * Handles device discovery, registration, polling, and accessory lifecycle for Matter-enabled SwitchBot devices.
 *
 * @class SwitchBotMatterPlatform
 * @param {Logger} log - Homebridge logger instance
 * @param {PlatformConfig} config - Platform configuration object
 * @param {API} [api] - Optional Homebridge API instance
 * @property {API | undefined} api - Homebridge API instance
 * @property {Logger} log - Homebridge logger instance
 * @property {SwitchBotPluginConfig} config - Parsed plugin config
 * @property {any[]} devices - All created device instances
 * @property {Map<string, any>} accessories - Map of accessory UUID to accessory object
 * @property {string} lastConfigHash - Hash of last loaded config for change detection
 * @property {NodeJS.Timeout | null} configReloadInterval - Interval for periodic config reload
 * @property {Map<string, NodeJS.Timeout>} openApiPollTimers - Timers for per-device OpenAPI polling
 * @property {NodeJS.Timeout | null} openApiBatchTimer - Timer for batched OpenAPI polling
 * @property {number} openApiRequestsToday - Count of OpenAPI requests made today
 * @property {number} openApiLastReset - Timestamp (ms) of last OpenAPI daily counter reset
 */
export class SwitchBotMatterPlatform {
  /** Homebridge API instance */
  api: API | undefined
  /** Homebridge logger instance */
  log: Logger
  /** Parsed plugin config */
  config: SwitchBotPluginConfig
  /** All created device instances */
  devices: any[] = []
  /** Map of accessory UUID to accessory object */
  accessories: Map<string, any>
  /** Hash of last loaded config for change detection */
  private lastConfigHash: string = ''
  /** Interval for periodic config reload */
  private configReloadInterval: NodeJS.Timeout | null = null
  /** Timers for per-device OpenAPI polling */
  private openApiPollTimers: Map<string, NodeJS.Timeout> = new Map()
  /** Timer for batched OpenAPI polling */
  private openApiBatchTimer: NodeJS.Timeout | null = null
  /** Count of OpenAPI requests made today */
  private openApiRequestsToday = 0
  /** Timestamp (ms) of last OpenAPI daily counter reset */
  private openApiLastReset = 0
  /** The accessories to keep in step with their devices, by UUID */
  private synced: Map<string, { device: any, type: string }> = new Map()
  /** The attributes last published per accessory and cluster, so an unchanged poll writes nothing */
  private published: Map<string, string> = new Map()
  /** Timer for the periodic state sync */
  private stateSyncInterval: NodeJS.Timeout | null = null
  /** Timers for the refresh that follows a command */
  private refreshTimers: Map<string, NodeJS.Timeout> = new Map()

  /**
   * Construct the SwitchBot Matter platform.
   * @param log Homebridge logger
   * @param config Platform config
   * @param api Homebridge API instance
   */
  constructor(log: Logger, config: PlatformConfig, api?: API) {
    this.log = log
    // Ensure both log and logger are set for downstream device constructors
    this.config = { ...(config as any), log, logger: log }
    this.api = api
    this.accessories = new Map()
    this.log.info('SwitchBot Matter platform initialized')

    // Create/shared SwitchBot client and attach to config so child devices reuse it.
    try {
      // A client passed in is shared with the other platform: one radio, one cloud session.
      const client = (config as any)?._client ?? new SwitchBotClient(this.config)
      if (!(config as any)?._client) {
        void client.init()
      }
      (this.config as any)._client = client
    } catch (e) {
      this.log.debug('Failed to create shared SwitchBot client', e)
    }

    // Wait for Homebridge to finish launching to create/register accessories
    if (this.api && typeof (this.api as any).on === 'function') {
      (this.api as any).on('didFinishLaunching', async () => {
        await this.loadDevices()
        this._setupOpenApiPolling()
        // Start periodic config reload to pick up UI changes
        this.configReloadInterval = setInterval(() => {
          void this.checkAndReloadDevices()
        }, 10000) // Check every 10 seconds
        // Listen for Homebridge shutdown to clear interval
        if (typeof (this.api as any).on === 'function') {
          (this.api as any).on('shutdown', () => {
            this.shutdown()
          })
        }
      })
    } else {
      void this.loadDevices()
      this._setupOpenApiPolling()
      // Start periodic config reload to pick up UI changes
      this.configReloadInterval = setInterval(() => {
        void this.checkAndReloadDevices()
      }, 10000) // Check every 10 seconds
    }
  }

  /**
   * Discover and create all device instances from config.
   * Populates this.devices and logs registration status for each device.
   *
   * @returns {Promise<void>} Resolves when all devices are loaded and registered
   */
  async loadDevices(): Promise<void> {
    const newHash = this.getConfigHash()
    if (newHash === this.lastConfigHash) {
      this.log.debug('Config unchanged, skipping device reload')
      return
    }

    // SwitchBot devices and infrared remotes both, with hidden ones left out.
    const devices = collectConfiguredDevices(this.config)
    const createdDevices: { created: any, d: any, type: string, useMatter: boolean, matterAvailable: boolean }[] = []
    for (const raw of devices) {
      const d: any = raw
      const type: string = normalizeTypeForMatter(d.type)
      const deviceOpts: any = { id: d.id, type, name: d.name, encryptionKey: d.encryptionKey, keyId: d.keyId, log: this.log }
      this.log.debug(`[Matter/Debug] Device options for ${d.name ?? d.id}:`, JSON.stringify(deviceOpts, null, 2))
      const matterSupported = !!DEVICE_MATTER_SUPPORTED[(type || '').toLowerCase()]
      const matterAvailable = !!(this.api?.isMatterAvailable?.() && this.api?.isMatterEnabled?.())
      const matterEnabled = matterAvailable || !!this.config.enableMatter
      const useMatter = matterEnabled && matterSupported
      try {
        const created = await createDevice(deviceOpts, this.config, useMatter)
        this.devices.push(created)
        createdDevices.push({ created, d, type, useMatter, matterAvailable })
        if (useMatter) {
          this.log.info(`Prepared Matter accessory for ${d.id} (${type})${matterAvailable ? ' (auto-detected)' : ' (manually enabled)'}`)
        } else {
          if (!matterEnabled) {
            this.log.info(`Skipping Matter for ${d.id} (${type}) - Matter not available on this bridge`)
          } else if (!matterSupported) {
            this.log.info(`Skipping Matter for ${d.id} (${type}) - device type not supported`)
          } else {
            this.log.info(`Skipping Matter for ${d.id} (${type}) - not supported`)
          }
        }
      } catch (e: any) {
        this.log.error(`Failed to create Matter device ${d.id}:`, e instanceof Error ? e.stack || e.message : e)
      }
    }
    // Register Matter accessories after device creation for symmetry with HAP platform
    await this.registerMatterAccessories(createdDevices)
    this.lastConfigHash = newHash
  }

  /**
   * Registers all Matter accessories with the Homebridge Matter API.
   *
   * This method is called after all device instances have been created. It handles both new and restored
   * accessories, updating their context, clusters, and other Matter-specific metadata as needed. Accessories
   * are registered with Homebridge using the Matter API, and the internal accessory map is updated accordingly.
   *
   * @param {Array<{created: any, d: any, type: string, useMatter: boolean, matterAvailable: boolean}>} createdDevices - Array of device descriptors:
   *   - created: The created device instance
   *   - d: The normalized device config object
   *   - type: The normalized device type string
   *   - useMatter: Whether Matter is enabled for this device
   *   - matterAvailable: Whether Matter is available on this bridge
   * @returns {Promise<void>} Resolves when registration is complete
   *
   * Differences from HAP registration:
   *   - Uses the Matter API (not HAP API) for accessory registration.
   *   - Adds Matter clusters and handlers to each accessory based on the device descriptor.
   *   - Only registers accessories where Matter is enabled and supported.
   *   - Accessory context and cluster wiring are Matter-specific.
   *
   * If the Homebridge Matter API is not available, registration is skipped and a log message is emitted.
   * Accessories that are not enabled for Matter are ignored.
   */
  async registerMatterAccessories(createdDevices: { created: any, d: any, type: string, useMatter: boolean, matterAvailable: boolean }[]): Promise<void> {
    if (!this.api || !(this.api as any).matter || typeof (this.api as any).matter.registerPlatformAccessories !== 'function') {
      this.log.info('Homebridge Matter API not available; skipping Matter accessory registration')
      return
    }
    const matterApi = (this.api as any).matter
    const accessoriesToRegister: any[] = []
    for (const { created, d, type, useMatter, matterAvailable } of createdDevices) {
      // Only register accessories where Matter is enabled and supported
      if (!useMatter) {
        // Log reason for skipping registration
        if (!matterAvailable) {
          this.log.info(`Skipping Matter registration for ${d.id} (${type}) - Matter API not available on this bridge`)
        } else {
          this.log.info(`Skipping Matter registration for ${d.id} (${type}) - device type not supported for Matter`)
        }
        continue
      }
      try {
        // Prepare accessory descriptor from device
        const createdDesc = await created.createAccessory(this.api)
        const uuid = matterApi.uuid.generate(`${d.id}`)
        // Reuse cached accessory if available by uuid
        let accessory: any = this.accessories.get(uuid)
        // Reuse cached accessory if available by uuid or deviceId
        if (!accessory) {
          for (const [, a] of this.accessories.entries()) {
            try {
              if (a && a.context && a.context.deviceId === d.id) {
                accessory = a
                break
              }
            } catch (e) {
              // ignore
            }
          }
        }
        if (!accessory) {
          // Create new accessory object for Matter
          let clusters = DEVICE_MATTER_CLUSTERS[type.toLowerCase()]
          if (!clusters) {
            clusters = createdDesc.clusters || { onOff: { onOff: false } }
          }
          const deviceType = resolveMatterDeviceType(matterApi, type, createdDesc.deviceType, clusters)
          accessory = {
            UUID: uuid,
            displayName: createdDesc.name || d.name || type,
            deviceType,
            manufacturer: createdDesc.manufacturer || 'SwitchBot',
            model: createdDesc.model || type,
            serialNumber: createdDesc.serialNumber || d.id,
            reachable: createdDesc.reachable !== false,
            firmwareRevision: createdDesc.firmwareRevision || '1.0.0',
            hardwareRevision: createdDesc.hardwareRevision || '',
            clusters,
            handlers: createdDesc.handlers || createMatterHandlers(this.log, d.id, type, (this.config as any)?._client) || undefined,
            context: { deviceId: d.id, type, created: true },
          }
          accessoriesToRegister.push(accessory)
          this.accessories.set(uuid, accessory)
        } else {
          // Ensure context and update properties for restored accessory
          let clusters = DEVICE_MATTER_CLUSTERS[type.toLowerCase()]
          if (!clusters) {
            clusters = accessory.clusters || createdDesc.clusters || { onOff: { onOff: false } }
          }
          const deviceType = resolveMatterDeviceType(matterApi, type, accessory.deviceType || createdDesc.deviceType, clusters)
          accessory.context = accessory.context || {}
          accessory.context.deviceId = accessory.context.deviceId || d.id
          accessory.context.type = accessory.context.type || type
          accessory.deviceType = deviceType
          accessory.manufacturer = accessory.manufacturer || createdDesc.manufacturer || 'SwitchBot'
          accessory.model = accessory.model || createdDesc.model || type
          accessory.serialNumber = accessory.serialNumber || createdDesc.serialNumber || d.id
          accessory.reachable = accessory.reachable !== false
          accessory.firmwareRevision = accessory.firmwareRevision || createdDesc.firmwareRevision || '1.0.0'
          accessory.hardwareRevision = accessory.hardwareRevision || createdDesc.hardwareRevision || ''
          accessory.clusters = clusters
          accessory.handlers = createdDesc.handlers || createMatterHandlers(this.log, d.id, type, (this.config as any)?._client) || undefined
          accessory.displayName = createdDesc.name || d.name || type
          accessory.UUID = accessory.UUID || accessory.uuid || uuid
          accessoriesToRegister.push(accessory)
          this.accessories.set(accessory.UUID || uuid, accessory)
        }
        this.synced.set(accessory.UUID ?? uuid, { device: created.instance, type })
        this.log.info(`Created/updated Matter accessory ${d.id} (${type})`)
      } catch (e) {
        this.log.warn(`Matter accessory creation failed for ${d.id} (${type})`, e)
      }
    }
    if (accessoriesToRegister.length > 0) {
      try {
        await matterApi.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, accessoriesToRegister)
        this.log.info(`Registered ${accessoriesToRegister.length} Matter accessory(ies) with Homebridge`)
      } catch (e) {
        this.log.warn('Failed to register Matter accessories', e)
      }
    } else {
      this.log.info('No Matter accessories to register')
    }

    this._startStateSync()
  }

  /**
   * Keeps the Matter attributes in step with the devices.
   *
   * A Matter controller reads its own cached copy of an attribute and is told about changes only
   * when the node reports them - unlike HomeKit, which asks for a value whenever it wants one. So
   * the state has to be pushed, or every Matter app keeps showing whatever the accessory was
   * registered with: curtains frozen at the position they had at startup, a light stuck off.
   *
   * @returns {void}
   */
  private _startStateSync(): void {
    if (this.stateSyncInterval) {
      clearInterval(this.stateSyncInterval)
      this.stateSyncInterval = null
    }
    if (this.synced.size === 0) {
      return
    }

    const cfg = this.config as any
    const seconds = Math.max(Number(cfg.matterStateSyncSeconds) || 60, 15)

    // A command is answered by a refresh straight away; the interval is for everything else -
    // a curtain pulled by hand, or the SwitchBot app.
    for (const [uuid, entry] of this.synced.entries()) {
      this._watchCommands(uuid, entry.device)
    }

    this.stateSyncInterval = setInterval(() => void this._syncAllState(), seconds * 1000)
    void this._syncAllState()
    this.log.info(`Keeping Matter attributes in step with ${this.synced.size} device(s), every ${seconds}s`)
  }

  /**
   * Refreshes an accessory shortly after a command, so a controller sees the result of its own
   * action without waiting for the next sync.
   *
   * @param {string} uuid The accessory UUID.
   * @param {any} device The device instance, shared with the HAP platform.
   * @returns {void}
   */
  private _watchCommands(uuid: string, device: any): void {
    if (!device || typeof device.setState !== 'function' || device._matterSyncHooked) {
      return
    }

    const original = device.setState.bind(device)
    device.setState = async (change: any) => {
      const result = await original(change)
      clearTimeout(this.refreshTimers.get(uuid))
      this.refreshTimers.set(uuid, setTimeout(() => void this._syncState(uuid), 1500))
      return result
    }
    device._matterSyncHooked = true
  }

  /**
   * @returns {Promise<void>} Resolves once every accessory has been brought up to date.
   */
  private async _syncAllState(): Promise<void> {
    for (const uuid of this.synced.keys()) {
      await this._syncState(uuid)
    }
  }

  /**
   * @param {string} uuid The accessory to bring up to date.
   * @returns {Promise<void>} Resolves once its attributes have been published.
   */
  private async _syncState(uuid: string): Promise<void> {
    const entry = this.synced.get(uuid)
    const matterApi = (this.api as any)?.matter
    if (!entry || !matterApi || typeof matterApi.updateAccessoryState !== 'function') {
      return
    }

    try {
      const clusters = matterStateFor(entry.type, await entry.device.getState())
      if (!clusters) {
        return
      }

      for (const [cluster, attributes] of Object.entries(clusters)) {
        const key = `${uuid}:${cluster}`
        const payload = JSON.stringify(attributes)
        if (this.published.get(key) === payload) {
          continue
        }

        await matterApi.updateAccessoryState(uuid, cluster, attributes)
        this.published.set(key, payload)
        this.log.debug(`[Matter] ${entry.type} ${uuid}: ${cluster} = ${payload}`)
      }
    } catch (e) {
      // A device that cannot be read right now is reported again on the next sync.
      this.log.debug(`[Matter] Could not sync ${uuid}:`, (e as Error)?.message)
    }
  }

  /**
   * Returns the timestamp (ms) of the last OpenAPI daily counter reset.
   * @returns {number} Timestamp in ms
   */
  getOpenApiLastReset(): number {
    return this.openApiLastReset
  }

  /**
   * Logs the last OpenAPI reset time in a human-readable format.
   * @returns {void}
   */
  logOpenApiLastReset(): void {
    if (this.openApiLastReset) {
      const date = new Date(this.openApiLastReset)
      this.log.info(`[OpenAPI] Last daily counter reset: ${date.toLocaleString()}`)
    } else {
      this.log.info('[OpenAPI] Daily counter has not been reset yet.')
    }
  }

  /**
   * Compute a hash of the current device config for change detection.
   * @returns {string} JSON string hash of device config
   */
  private getConfigHash(): string {
    // Create a simple hash of current device config to detect changes
    const devices = (this.config as any)?.devices ?? []
    return JSON.stringify(devices.map((d: any) => ({
      id: d.deviceId ?? d.id,
      type: d.configDeviceType ?? d.type,
      name: d.configDeviceName ?? d.name,
    })))
  }

  /**
   * Reload devices if config has changed since last load.
   * Unregisters accessories and removes devices no longer in config.
   * Calls loadDevices to repopulate devices and accessories.
   *
   * @returns {Promise<void>} Resolves when reload is complete
   */
  private async checkAndReloadDevices(): Promise<void> {
    const currentHash = this.getConfigHash()
    if (currentHash !== this.lastConfigHash) {
      this.log.info('[SwitchBot] Detected config changes, reloading devices...')
      // Identify device IDs in new config
      const devicesInConfig = new Set(((this.config as any)?.devices ?? []).map((d: any) => d.deviceId ?? d.id))
      // Find accessories to remove (not in config)
      const accessoriesToRemove: any[] = []
      for (const [uuid, accessory] of this.accessories.entries()) {
        const deviceId = accessory?.context?.deviceId
        if (deviceId && !devicesInConfig.has(deviceId)) {
          accessoriesToRemove.push({ accessory, uuid })
        }
      }
      // Unregister removed accessories from Homebridge (Matter API)
      if (accessoriesToRemove.length > 0 && this.api && (this.api as any).matter && (this.api as any).matter.unregisterPlatformAccessories) {
        try {
          (this.api as any).matter.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, accessoriesToRemove.map(a => a.accessory))
          this.log.info(`Unregistered ${accessoriesToRemove.length} Matter accessory(ies) removed from config`)
          for (const { uuid } of accessoriesToRemove) {
            this.accessories.delete(uuid)
          }
        } catch (e) {
          this.log.warn('Failed to unregister removed Matter accessories', e)
        }
      }
      // Remove devices from this.devices that are no longer in config
      this.devices = this.devices.filter((dev: any) => devicesInConfig.has(dev?.id))
      await this.loadDevices()
      this.lastConfigHash = currentHash
    }
  }

  /**
   * Cleanup method to clear config reload interval on shutdown.
   * Called by Homebridge on shutdown event.
   * @returns {void}
   */
  shutdown(): void {
    if (this.stateSyncInterval) {
      clearInterval(this.stateSyncInterval)
      this.stateSyncInterval = null
    }
    for (const timer of this.refreshTimers.values()) {
      clearTimeout(timer)
    }
    this.refreshTimers.clear()
    if (this.configReloadInterval) {
      clearInterval(this.configReloadInterval)
      this.configReloadInterval = null
      this.log.info('Cleared config reload interval on shutdown')
    }
  }

  /**
   * Setup OpenAPI polling for all devices according to config (global, per-device, batch, rate limit).
   * Handles daily request limits, per-device and batch polling, and resets.
   *
   * @returns {void}
   */
  private _setupOpenApiPolling(): void {
    // Clear any existing timers
    for (const t of this.openApiPollTimers.values()) clearInterval(t)
    this.openApiPollTimers.clear()
    if (this.openApiBatchTimer) {
      clearInterval(this.openApiBatchTimer)
    }
    this.openApiBatchTimer = null

    const cfg = this.config as any
    const devices = cfg.devices ?? []
    const globalRate = Math.max(Number(cfg.openApiRefreshRate) || 300, 30)
    const batchEnabled = cfg.matterBatchEnabled !== false
    const batchRate = Math.max(Number(cfg.matterBatchRefreshRate) || globalRate, 30)
    const batchConcurrency = Math.max(Number(cfg.matterBatchConcurrency) || 5, 1)
    const batchJitter = Math.max(Number(cfg.matterBatchJitter) || 0, 0)
    const dailyLimit = Math.max(Number(cfg.dailyApiLimit) || 10000, 1000)
    const dailyReserve = Math.max(Number(cfg.dailyApiReserveForCommands) || 1000, 0)
    const resetAtLocalMidnight = !!cfg.dailyApiResetLocalMidnight
    const webhookOnlyOnReserve = !!cfg.webhookOnlyOnReserve

    // Helper to reset daily counter
    const resetCounter = () => {
      this.openApiRequestsToday = 0
      this.openApiLastReset = Date.now()
      this.log.info('[OpenAPI] Daily request counter reset')
    }
    // Schedule reset at midnight
    const scheduleMidnightReset = () => {
      const now = new Date()
      let nextReset: Date
      if (resetAtLocalMidnight) {
        nextReset = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 1)
      } else {
        nextReset = new Date(now)
        nextReset.setUTCHours(24, 0, 1, 0)
      }
      const ms = nextReset.getTime() - now.getTime()
      setTimeout(() => {
        resetCounter()
        scheduleMidnightReset()
      }, ms)
    }
    scheduleMidnightReset()

    // Helper to check if polling is allowed
    const canPoll = () => {
      if (this.openApiRequestsToday + dailyReserve >= dailyLimit) {
        if (!webhookOnlyOnReserve) {
          this.log.warn('[OpenAPI] Daily request limit reached, pausing background polling')
        }
        return false
      }
      return true
    }

    // Per-device polling (devices with per-device refreshRate)
    for (const dev of devices) {
      const id = dev.deviceId ?? dev.id
      const enabled = dev.enabled !== false
      if (!id || !enabled) {
        continue
      }
      const perDeviceRate = dev.refreshRate ? Math.max(Number(dev.refreshRate), 30) : null
      if (perDeviceRate) {
        // Individual polling interval for this device
        const timer = setInterval(async () => {
          if (!canPoll()) {
            return
          }
          try {
            const client = (this.config as any)._client
            if (client && typeof client.getDevice === 'function') {
              await client.getDevice(id)
              this.openApiRequestsToday++
              this.log.debug(`[OpenAPI] Polled device ${id} (per-device interval ${perDeviceRate}s) [${this.openApiRequestsToday}/${dailyLimit}]`)
            }
          } catch (e) {
            this.log.debug(`[OpenAPI] Polling failed for device ${id}:`, (e as Error)?.message)
          }
        }, perDeviceRate * 1000)
        this.openApiPollTimers.set(id, timer)
      }
    }

    // Batched polling for all other devices
    if (batchEnabled) {
      // Devices not already polled individually
      const batchDevices = devices.filter((dev: any) => {
        const id = dev.deviceId ?? dev.id
        const enabled = dev.enabled !== false
        const perDeviceRate = dev.refreshRate ? Math.max(Number(dev.refreshRate), 30) : null
        return id && enabled && !perDeviceRate
      })
      // Optional jitter before first batch
      const startBatch = () => {
        this.openApiBatchTimer = setInterval(async () => {
          if (!canPoll()) {
            return
          }
          const client = (this.config as any)._client
          if (!client || typeof client.getDevice !== 'function') {
            return
          }
          // Limit concurrency
          const chunks: any[][] = []
          for (let i = 0; i < batchDevices.length; i += batchConcurrency) {
            chunks.push(batchDevices.slice(i, i + batchConcurrency))
          }
          for (const chunk of chunks) {
            await Promise.all(chunk.map(async (dev: any) => {
              try {
                await client.getDevice(dev.deviceId ?? dev.id)
                this.openApiRequestsToday++
                this.log.debug(`[OpenAPI] Batched poll device ${dev.deviceId ?? dev.id} [${this.openApiRequestsToday}/${dailyLimit}]`)
              } catch (e) {
                this.log.debug(`[OpenAPI] Batched polling failed for device ${dev.deviceId ?? dev.id}:`, (e as Error)?.message)
              }
            }))
          }
        }, batchRate * 1000)
      }
      if (batchJitter > 0) {
        setTimeout(startBatch, Math.floor(Math.random() * batchJitter * 1000))
      } else {
        startBatch()
      }
    }
  }

  /**
   * Called by Homebridge to restore cached Matter accessories on startup.
   * @param {any} accessory - The cached accessory object
   * @returns {Promise<void>} Resolves when accessory is restored
   */
  async configureAccessory(accessory: any): Promise<void> {
    try {
      const uuid = accessory.UUID || accessory.UUID
      this.accessories.set(uuid, accessory)
      this.log.info(`Restored cached Matter accessory ${accessory.displayName || uuid}`)
    } catch (e) {
      this.log.warn('configureAccessory failed to restore Matter accessory', e)
    }
  }

  /**
   * Called by Homebridge to restore cached Matter accessories (alternate signature).
   * @param {any} accessory - The cached accessory object
   * @returns {void}
   */
  configureMatterAccessory(accessory: any): void {
    try {
      const uuid = accessory.uuid || accessory.UUID || accessory.uuid
      this.accessories.set(uuid, accessory)
      this.log.info(`Restored cached Matter accessory ${accessory.displayName || uuid}`)
    } catch (e) {
      this.log.warn('configureMatterAccessory failed to restore Matter accessory', e)
    }
  }
}

export default SwitchBotMatterPlatform
