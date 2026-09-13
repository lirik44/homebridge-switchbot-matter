import { describe, expect, it, vi } from 'vitest'

import {
  createPlatformProxy,
  MATTER_ATTRIBUTE_IDS,
  MATTER_CLUSTER_IDS,
  normalizeConfig,
} from '../../src/utils'

describe('utils', () => {
  it('should expose correct MATTER_CLUSTER_IDS', () => {
    expect(MATTER_CLUSTER_IDS.OnOff).toBe(0x0006)
    expect(MATTER_CLUSTER_IDS.FanControl).toBe(0x0202)
  })

  it('should expose correct MATTER_ATTRIBUTE_IDS', () => {
    expect(MATTER_ATTRIBUTE_IDS.OnOff.OnOff).toBe(0x0000)
    expect(MATTER_ATTRIBUTE_IDS.ColorControl.CurrentHue).toBe(0x0000)
  })

  it('normalizeConfig returns empty object for undefined', () => {
    expect(normalizeConfig(undefined)).toEqual({})
  })

  it('normalizeConfig returns shallow copy of config', () => {
    const input = { foo: 'bar', preferMatter: false }
    const result = normalizeConfig(input as any)
    expect(result).toMatchObject(input)
    expect(result).not.toBe(input)
  })

  it('createPlatformProxy publishes over HAP and Matter when Matter is available', () => {
    // HomeKit speaks HAP and everything else speaks Matter, so a home usually wants both.
    const HAP = vi.fn(function (this: any) {
      this.configureAccessory = vi.fn()
      this.config = { _client: 'shared-client' }
    })
    const Matter = vi.fn(function (this: any) {
      this.configureMatterAccessory = vi.fn()
    })
    const api = { isMatterAvailable: () => true, isMatterEnabled: () => true }
    const Proxy = createPlatformProxy(HAP, Matter)

    const platform: any = new Proxy('log', { enableMatter: true } as any, api)

    expect(HAP).toHaveBeenCalled()
    expect(Matter).toHaveBeenCalled()
    // One client between them: two would put two BLE scanners on the same radio.
    expect((Matter.mock.calls[0] as any[])[1]._client).toBe('shared-client')
    platform.configureAccessory('hap-accessory')
    platform.configureMatterAccessory('matter-accessory')
    expect(platform.hap.configureAccessory).toHaveBeenCalledWith('hap-accessory')
    expect(platform.matter.configureMatterAccessory).toHaveBeenCalledWith('matter-accessory')
  })

  it('createPlatformProxy publishes over Matter alone when matterOnly is set', () => {
    const HAP = vi.fn()
    const Matter = vi.fn()
    const api = { isMatterAvailable: () => true, isMatterEnabled: () => true }
    const Proxy = createPlatformProxy(HAP, Matter)

    new Proxy('log', { enableMatter: true, matterOnly: true } as any, api)

    expect(Matter).toHaveBeenCalled()
    expect(HAP).not.toHaveBeenCalled()
  })

  it('createPlatformProxy falls back to HAPPlatform if Matter not available', () => {
    const HAP = vi.fn()
    const Matter = vi.fn()
    const api = { isMatterAvailable: () => false, isMatterEnabled: () => false }
    const config = { enableMatter: true, preferMatter: true }
    const Proxy = createPlatformProxy(HAP, Matter)
    new Proxy('log', config, api)
    expect(HAP).toHaveBeenCalled()
    expect(Matter).not.toHaveBeenCalled()
  })
})
