import type { Logger } from 'homebridge'

import type { SwitchBotPluginConfig } from '../settings.js'
import type { DeviceOptions } from './deviceBase.js'

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

  constructor(opts: DeviceOptions, cfg: SwitchBotPluginConfig) {
    super(opts, cfg)
    this.log = (opts as any)?.log ?? (cfg as any)?.log
    if (!this.log) {
      throw new Error('IR device requires a logger (Homebridge logger) in opts or cfg')
    }
    this.on = (opts as any)?.initialState === true
  }

  async getState(): Promise<any> {
    return { id: this.opts.id, type: this.opts.type, on: this.on }
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
      this.on = change.on
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
