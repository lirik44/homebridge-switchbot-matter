import type { Logger } from 'homebridge'

import type { SwitchBotPluginConfig } from '../settings.js'
import type { DeviceOptions } from './deviceBase.js'

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { DeviceBase } from './deviceBase.js'

/**
 * An infrared remote, as a SwitchBot hub sees it.
 *
 * There is nothing on the other end of an IR remote: the hub blasts a code at whatever is in
 * front of it and nothing answers. So a remote has no state to read, only the state the plugin
 * remembers having sent - which is what the SwitchBot app shows too. It also has no BLE presence
 * and never appears in device discovery, so every command goes through the cloud.
 */
export class IRDevice extends DeviceBase {
  protected log: Logger
  /** What was last sent to the remote. There is no way to ask the appliance itself. */
  protected on: boolean
  /** Where that is kept, so a restart does not claim the lights went off. */
  private readonly stateFile: string | undefined

  constructor(opts: DeviceOptions, cfg: SwitchBotPluginConfig) {
    super(opts, cfg)
    this.log = (opts as any)?.log ?? (cfg as any)?.log
    if (!this.log) {
      throw new Error('IR device requires a logger (Homebridge logger) in opts or cfg')
    }
    const storagePath = (opts as any)?.storagePath ?? (cfg as any)?.storagePath
    this.stateFile = typeof storagePath === 'string' ? join(storagePath, 'switchbot-ir-state.json') : undefined
    this.on = this.readRemembered() ?? (opts as any)?.initialState === true
  }

  /**
   * @param {boolean} on What the remote is now believed to be doing.
   * @param {string} reason Who says so.
   * @returns {void}
   */
  private record(on: boolean, reason: string): void {
    if (this.on !== on) {
      this.log.info(`[${this.opts.id}] Now ${on ? 'on' : 'off'}, ${reason}`)
    }
    this.on = on
    this.remember(on)
  }

  /**
   * @returns {boolean | undefined} What the remote was last told to do before the last restart.
   */
  private readRemembered(): boolean | undefined {
    if (!this.stateFile || !existsSync(this.stateFile)) {
      return undefined
    }
    try {
      const remembered = JSON.parse(readFileSync(this.stateFile, 'utf8'))?.[this.opts.id]?.on
      return typeof remembered === 'boolean' ? remembered : undefined
    } catch {
      return undefined
    }
  }

  /**
   * @param {boolean} on What the remote was just told to do.
   * @returns {void}
   */
  protected remember(on: boolean): void {
    if (!this.stateFile) {
      return
    }
    try {
      const all = existsSync(this.stateFile) ? JSON.parse(readFileSync(this.stateFile, 'utf8')) ?? {} : {}
      all[this.opts.id] = { on }
      writeFileSync(this.stateFile, JSON.stringify(all, null, 2))
    } catch (e) {
      this.log.debug(`[${this.opts.id}] Could not remember the remote's state:`, e instanceof Error ? e.message : e)
    }
  }

  async getState(): Promise<any> {
    return { id: this.opts.id, type: this.opts.type, on: this.on }
  }

  noteCommandedState(change: Record<string, any>): void {
    if (typeof change?.on === 'boolean') {
      this.record(change.on, 'another ecosystem commanded it')
      this.notifyStateChanged()
    }
  }

  async setState(change: any): Promise<any> {
    if (typeof change?.on !== 'boolean') {
      return { success: false, reason: 'unsupported change for an IR remote', change }
    }

    const command = change.on ? 'turnOn' : 'turnOff'
    if (!this.client || typeof this.client.sendIRCommand !== 'function') {
      this.log.warn(`[${this.opts.id}] Cannot send ${command}: no SwitchBot client available`)
      return { success: false, reason: 'no client' }
    }

    try {
      const result = await this.client.sendIRCommand(this.opts.id, command)
      // Only remember the new state once the hub accepted the command, so a failed press does
      // not leave the controller showing a light that was never turned on.
      this.record(change.on, 'the remote was pressed here')
      this.log.debug(`[${this.opts.id}] Sent ${command} to the IR remote`)
      return { success: true, result }
    } catch (e) {
      this.log.error(`[${this.opts.id}] Failed to send ${command} to the IR remote:`, e instanceof Error ? e.message : e)
      return { success: false, error: e }
    }
  }
}

/**
 * An IR remote for a light, exposed as a lightbulb with nothing but on and off.
 *
 * This covers the `Light` and `DIY Light` remote types, which is what the SwitchBot app produces
 * for a lamp or a string of fairy lights taught to the hub.
 */
export class IRLightDevice extends IRDevice {
  createHAPAccessory(): any {
    return {
      id: this.opts.id,
      name: this.opts.name ?? this.opts.type,
      protocol: 'hap',
      services: [
        {
          type: 'Lightbulb',
          characteristics: {
            On: {
              get: async () => {
                const s = await this.getState()
                return !!s?.on
              },
              set: async (v: any) => {
                await this.setState({ on: !!v })
              },
            },
          },
        },
      ],
    }
  }

  createMatterAccessory(): any {
    return {
      id: this.opts.id,
      name: this.opts.name ?? this.opts.type,
      protocol: 'matter',
      deviceType: 'ir light',
      clusters: { onOff: { onOff: this.on } },
    }
  }
}
