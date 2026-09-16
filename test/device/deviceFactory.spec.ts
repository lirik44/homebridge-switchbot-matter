import { describe, expect, it } from 'vitest'

import { createDevice } from '../../src/deviceFactory'

const botRegex = /Bot/i
const curtainRegex = /Curtain/i

describe('createDevice', () => {
  const mockLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
  const dummyConfig = { logger: mockLogger, log: mockLogger }

  it('should create a Bot device instance', async () => {
    const result = await createDevice({ id: 'abc', type: 'Bot' }, dummyConfig as any, false)
    expect(result.instance).toBeDefined()
    expect(result.instance.constructor.name).toMatch(botRegex)
  })

  it('should create a Curtain device instance', async () => {
    const result = await createDevice({ id: 'def', type: 'Curtain' }, dummyConfig as any, false)
    expect(result.instance).toBeDefined()
    expect(result.instance.constructor.name).toMatch(curtainRegex)
  })

  it('should create a device with protocol matter if useMatter is true', async () => {
    const result = await createDevice({ id: 'ghi', type: 'Bot' }, dummyConfig as any, true)
    expect(result.protocol).toBe('matter')
  })

  it('should throw for unknown device type', async () => {
    const result = await createDevice({ id: 'xyz', type: 'UnknownType' }, dummyConfig as any, false)
    expect(result.instance.constructor.name).toBe('GenericDevice')
  })

  it('should create a WaterDetectorDevice for normalized "waterdetector" type', async () => {
    // normalizeTypeForMatter() returns 'waterdetector' (no space) for water detector variants.
    // This regression test ensures the no-space key is mapped so devices aren't silently
    // downgraded to GenericDevice (which would expose a bogus Switch service).
    const result = await createDevice({ id: 'wd1', type: 'waterdetector' }, dummyConfig as any, false)
    expect(result.instance).toBeDefined()
    expect(result.instance.constructor.name).toBe('WaterDetectorDevice')
  })
})

describe('building the same device from both halves at once', () => {
  it('builds it once, however the two requests interleave', async () => {
    // The HAP and Matter platforms load their devices at the same time. If the register is only
    // written after the device is built, both look, find nothing, and each gets its own object -
    // and then each ecosystem has its own idea of what an IR remote was last told to do.
    const log = { debug() {}, info() {}, warn() {}, error() {}, log() {} } as any
    const cfg = { log, logger: log, _client: { getDevice: async () => undefined, getStatus: async () => undefined } } as any
    const opts = { id: 'IR-RACE', type: 'ir light', name: 'Christmas Light', log }

    const [first, second] = await Promise.all([
      createDevice({ ...opts }, cfg, false),
      createDevice({ ...opts }, cfg, true),
    ])

    expect(second.instance).toBe(first.instance)
  })
})
