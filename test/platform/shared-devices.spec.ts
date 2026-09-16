import { describe, expect, it, vi } from 'vitest'

import { SwitchBotHAPPlatform } from '../../src/SwitchBotHAPPlatform'
import { SwitchBotMatterPlatform } from '../../src/SwitchBotMatterPlatform'
import { createPlatformProxy } from '../../src/utils'

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn() } as any

/** Enough of the Homebridge API for both platforms to register what they build. */
function fakeApi() {
  const listeners: Record<string, (() => void)[]> = {}
  const updates: { uuid: string, cluster: string, attributes: any }[] = []

  return {
    updates,
    launch: async () => {
      for (const listener of listeners.didFinishLaunching ?? []) {
        await listener()
      }
    },
    on: (event: string, listener: () => void) => {
      listeners[event] = [...(listeners[event] ?? []), listener]
    },
    user: { storagePath: () => undefined },
    isMatterAvailable: () => true,
    isMatterEnabled: () => true,
    hap: { uuid: { generate: (id: string) => `uuid-${id}` } },
    matter: {
      uuid: { generate: (id: string) => `uuid-${id}` },
      deviceTypes: {},
      registerPlatformAccessories: async () => {},
      updateAccessoryState: async (uuid: string, cluster: string, attributes: any) => {
        updates.push({ uuid, cluster, attributes })
      },
    },
  } as any
}

const CONFIG = {
  platform: 'SwitchBot',
  openApiToken: 'token',
  openApiSecret: 'secret',
  enableMatter: true,
  irdevices: [{ deviceId: 'IR1', configDeviceName: 'Christmas Light', configRemoteType: 'DIY Light' }],
} as any

describe('both halves of the plugin', () => {
  it('drive one device object, so a command in one ecosystem is seen in the other', async () => {
    const Proxy = createPlatformProxy(SwitchBotHAPPlatform, SwitchBotMatterPlatform)
    const api = fakeApi()
    const platform: any = new Proxy(log, CONFIG, api)
    await api.launch()

    const fromHap = platform.hap.devices.find((d: any) => d.instance?.opts?.id === 'IR1')?.instance
    const fromMatter = platform.matter.devices.find((d: any) => d.instance?.opts?.id === 'IR1')?.instance

    expect(fromHap).toBeDefined()
    // An IR remote has no state to read back, so the plugin's own memory of it is all there is:
    // two objects would mean two different answers, one per ecosystem.
    expect(fromMatter).toBe(fromHap)

    platform.shutdown()
  })

  it('reports a HomeKit command over Matter without waiting for the next sync', async () => {
    const Proxy = createPlatformProxy(SwitchBotHAPPlatform, SwitchBotMatterPlatform)
    const api = fakeApi()
    const platform: any = new Proxy(log, CONFIG, api)
    await api.launch()

    const device = platform.hap.devices.find((d: any) => d.instance?.opts?.id === 'IR1')!.instance
    device.client = { sendIRCommand: vi.fn(async () => ({ statusCode: 100 })) }
    api.updates.length = 0

    // What HomeKit does when the tile is tapped.
    await device.createHAPAccessory().services[0].characteristics.On.set(true)

    await vi.waitFor(
      () => expect(api.updates.at(-1)).toStrictEqual({ uuid: 'uuid-IR1', cluster: 'onOff', attributes: { onOff: true } }),
      { timeout: 6000, interval: 100 },
    )

    platform.shutdown()
  })
})
