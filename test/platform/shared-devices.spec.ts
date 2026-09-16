import { describe, expect, it, vi } from 'vitest'

import { SwitchBotHAPPlatform } from '../../src/SwitchBotHAPPlatform'
import { SwitchBotMatterPlatform } from '../../src/SwitchBotMatterPlatform'
import { createPlatformProxy } from '../../src/utils'

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn() } as any

/** Enough of the Homebridge API for both platforms to register what they build. */
function fakeApi() {
  const listeners: Record<string, (() => void)[]> = {}
  const updates: { uuid: string, cluster: string, attributes: any }[] = []
  const characteristics: any[] = []

  function characteristic(name: string) {
    const existing = characteristics.find(c => c.name === name)
    if (existing) {
      return existing
    }
    const created = {
      name,
      displayName: name,
      onGet: vi.fn(function (this: any) {
        return this
      }),
      onSet: vi.fn(function (this: any) {
        return this
      }),
      setProps: vi.fn(),
      updateValue: vi.fn(),
    }
    characteristics.push(created)
    return created
  }

  function service(name: string) {
    return { name, constructor: { name }, characteristics: [], getCharacteristic: (c: string) => characteristic(c), setCharacteristic: () => {} }
  }

  const hap = {
    uuid: { generate: (id: string) => `uuid-${id}` },
    Service: new Proxy({}, { get: (_t, name: string) => name }),
    Characteristic: new Proxy({}, { get: (_t, name: string) => name }),
  }

  class FakeAccessory {
    services: any[] = []
    context: any = {}
    constructor(public displayName: string, public UUID: string) {}
    getService(name: string) {
      return this.services.find(s => s.name === name)
    }

    addService(name: string) {
      const added = service(name)
      this.services.push(added)
      return added
    }

    removeService(target: any) {
      this.services = this.services.filter(s => s !== target)
    }
  }

  return {
    updates,
    characteristics,
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
    hap,
    platformAccessory: FakeAccessory,
    registerPlatformAccessories: () => {},
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

  it('tells HomeKit about a command that came from the other ecosystem', async () => {
    const Proxy = createPlatformProxy(SwitchBotHAPPlatform, SwitchBotMatterPlatform)
    const api = fakeApi()
    const platform: any = new Proxy(log, CONFIG, api)
    await api.launch()

    const device = platform.hap.devices.find((d: any) => d.instance?.opts?.id === 'IR1')!.instance
    const on = api.characteristics.find((c: any) => c.name === 'On')
    expect(on).toBeDefined()

    // What a Matter controller's command leaves behind: the device knows, HomeKit does not.
    device.noteCommandedState({ on: true })

    await vi.waitFor(() => expect(on.updateValue).toHaveBeenCalledWith(true), { timeout: 6000, interval: 100 })

    platform.shutdown()
  })
})
