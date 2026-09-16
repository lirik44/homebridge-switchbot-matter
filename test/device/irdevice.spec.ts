import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { IRLightDevice } from '../../src/devices/irDevice'
import { collectConfiguredDevices, createMatterHandlers, DEVICE_MATTER_CLUSTERS, DEVICE_MATTER_SUPPORTED, isInfraredType, normalizeTypeForMatter } from '../../src/utils'

const log = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  log: vi.fn(),
} as any

function createDevice(client: any) {
  return new IRLightDevice({ id: 'ir-1', type: 'ir light', name: 'Christmas Light', log }, { _client: client } as any)
}

describe('iR remote types', () => {
  it('maps the remote types the SwitchBot app produces onto one internal type', () => {
    expect(normalizeTypeForMatter('DIY Light')).toBe('ir light')
    expect(normalizeTypeForMatter('IR Light')).toBe('ir light')
  })

  it('tells an infrared remote apart from the SwitchBot device of the same name', () => {
    expect(isInfraredType('DIY Light')).toBe(true)
    // A SwitchBot bulb is a device the hub talks to, not a code it blasts.
    expect(isInfraredType('Light')).toBe(false)
    expect(isInfraredType('Curtain')).toBe(false)
  })

  it('is exposed over Matter as a plain on/off light', () => {
    expect(DEVICE_MATTER_SUPPORTED['ir light']).toBe(true)
    expect(DEVICE_MATTER_CLUSTERS['ir light']).toStrictEqual({ onOff: { onOff: false } })
  })
})

describe('iRLightDevice', () => {
  let client: any

  beforeEach(() => {
    vi.clearAllMocks()
    client = { sendIRCommand: vi.fn(async () => ({ statusCode: 100 })) }
  })

  it('starts off, because a remote has nothing to report', async () => {
    await expect(createDevice(client).getState()).resolves.toEqual(expect.objectContaining({ on: false }))
  })

  it('presses turnOn and turnOff', async () => {
    const device = createDevice(client)

    await device.setState({ on: true })
    expect(client.sendIRCommand).toHaveBeenCalledWith('ir-1', 'turnOn')
    await expect(device.getState()).resolves.toEqual(expect.objectContaining({ on: true }))

    await device.setState({ on: false })
    expect(client.sendIRCommand).toHaveBeenCalledWith('ir-1', 'turnOff')
    await expect(device.getState()).resolves.toEqual(expect.objectContaining({ on: false }))
  })

  it('keeps the old state when the hub refused the command', async () => {
    // Otherwise the controller would show a light that was never turned on.
    client.sendIRCommand.mockRejectedValueOnce(new Error('device offline'))
    const device = createDevice(client)

    await expect(device.setState({ on: true })).resolves.toEqual(expect.objectContaining({ success: false }))
    await expect(device.getState()).resolves.toEqual(expect.objectContaining({ on: false }))
  })

  it('reports rather than throws when there is no client', async () => {
    const device = new IRLightDevice({ id: 'ir-1', type: 'ir light', log }, {} as any)
    await expect(device.setState({ on: true })).resolves.toEqual(expect.objectContaining({ success: false, reason: 'no client' }))
  })

  it('ignores a change an IR remote cannot make', async () => {
    await expect(createDevice(client).setState({ brightness: 50 })).resolves.toEqual(expect.objectContaining({ success: false }))
    expect(client.sendIRCommand).not.toHaveBeenCalled()
  })

  it('is a lightbulb over HAP', () => {
    const descriptor = createDevice(client).createHAPAccessory()
    expect(descriptor.services).toHaveLength(1)
    expect(descriptor.services[0].type).toBe('Lightbulb')
    expect(descriptor.services[0].characteristics.On).toBeDefined()
  })

  it('drives the device through the HAP characteristic', async () => {
    const device = createDevice(client)
    const { On } = device.createHAPAccessory().services[0].characteristics

    await On.set(true)
    expect(client.sendIRCommand).toHaveBeenCalledWith('ir-1', 'turnOn')
    await expect(On.get()).resolves.toBe(true)
  })
})

describe('matter handlers for an IR light', () => {
  it('presses the remote from the Matter commands', async () => {
    const client = { sendIRCommand: vi.fn(async () => ({ statusCode: 100 })) }
    const handlers = createMatterHandlers(log, 'ir-1', 'ir light', client)

    await expect(handlers.onOff.on()).resolves.toEqual(expect.objectContaining({ success: true }))
    expect(client.sendIRCommand).toHaveBeenCalledWith('ir-1', 'turnOn')

    await handlers.onOff.off()
    expect(client.sendIRCommand).toHaveBeenCalledWith('ir-1', 'turnOff')
  })

  it('reports a failure instead of throwing at the controller', async () => {
    const client = {
      sendIRCommand: vi.fn(async () => {
        throw new Error('cloud unreachable')
      }),
    }
    const handlers = createMatterHandlers(log, 'ir-1', 'ir light', client)

    await expect(handlers.onOff.on()).resolves.toEqual(expect.objectContaining({ success: false }))
  })
})

describe('collectConfiguredDevices', () => {
  it('takes SwitchBot devices and infrared remotes from their separate config keys', () => {
    const devices = collectConfiguredDevices({
      devices: [{ deviceId: 'D1', configDeviceName: 'Left curtain', configDeviceType: 'Curtain' }],
      irdevices: [{ deviceId: 'IR1', configDeviceName: 'Christmas Light', configRemoteType: 'DIY Light' }],
    })

    expect(devices).toStrictEqual([
      expect.objectContaining({ id: 'D1', name: 'Left curtain', type: 'Curtain' }),
      expect.objectContaining({ id: 'IR1', name: 'Christmas Light', type: 'DIY Light' }),
    ])
  })

  it('leaves out what the user hid', () => {
    const devices = collectConfiguredDevices({
      devices: [{ deviceId: 'D1', hide_device: true }, { deviceId: 'D2' }],
      irdevices: [{ deviceId: 'IR1', hide_device: true }],
    })

    expect(devices.map(d => d.id)).toStrictEqual(['D2'])
  })

  it('skips entries with no device id, which the API cannot address', () => {
    expect(collectConfiguredDevices({ devices: [{ configDeviceName: 'Nameless' }] })).toStrictEqual([])
  })

  it('copes with a config that has neither key', () => {
    expect(collectConfiguredDevices({})).toStrictEqual([])
    expect(collectConfiguredDevices(undefined)).toStrictEqual([])
  })
})

describe('remembering what the remote was told', () => {
  // A remote has nothing to read back, so if the plugin forgets on restart it reports the lights
  // off while they are on - and every controller is told so.
  it('carries the last command across a restart', async () => {
    const storagePath = mkdtempSync(join(tmpdir(), 'switchbot-ir-'))
    const client = { sendIRCommand: vi.fn(async () => ({ statusCode: 100 })) }
    const opts = { id: 'ir-1', type: 'ir light', name: 'Christmas Light', log, storagePath }

    const before = new IRLightDevice(opts as any, { _client: client } as any)
    await before.setState({ on: true })

    const after = new IRLightDevice(opts as any, { _client: client } as any)
    await expect(after.getState()).resolves.toEqual(expect.objectContaining({ on: true }))
  })

  it('starts off when there is nowhere to remember it', async () => {
    const client = { sendIRCommand: vi.fn(async () => ({ statusCode: 100 })) }
    const device = new IRLightDevice({ id: 'ir-2', type: 'ir light', log } as any, { _client: client } as any)
    await device.setState({ on: true })
    await expect(device.getState()).resolves.toEqual(expect.objectContaining({ on: true }))
  })
})
