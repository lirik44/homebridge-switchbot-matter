import { describe, expect, it } from 'vitest'

import { DEVICE_MATTER_CLUSTERS, matterStateFromHap } from '../src/utils'

const batteryService = (level: number) => ({
  services: [
    {
      type: 'Battery',
      characteristics: {
        BatteryLevel: { get: () => level },
      },
    },
  ],
})

describe('a battery reaching Matter', () => {
  it('doubles the percentage, because Matter encodes 100% as 200', async () => {
    const state = await matterStateFromHap(batteryService(74))

    expect(state?.powerSource?.batPercentRemaining).toBe(148)
  })

  it('grades the charge so a controller can warn without doing the arithmetic', async () => {
    expect((await matterStateFromHap(batteryService(80)))?.powerSource?.batChargeLevel).toBe(0)
    expect((await matterStateFromHap(batteryService(15)))?.powerSource?.batChargeLevel).toBe(1)
    expect((await matterStateFromHap(batteryService(5)))?.powerSource?.batChargeLevel).toBe(2)
  })

  it('asks for a replacement only once the battery is nearly out', async () => {
    expect((await matterStateFromHap(batteryService(15)))?.powerSource?.batReplacementNeeded).toBe(false)
    expect((await matterStateFromHap(batteryService(5)))?.powerSource?.batReplacementNeeded).toBe(true)
  })

  it('says nothing at all when the battery cannot be read', async () => {
    const state = await matterStateFromHap({
      services: [{ type: 'Battery', characteristics: { BatteryLevel: { get: () => {
        throw new Error('not reachable')
      } } } }],
    })

    expect(state?.powerSource).toBeUndefined()
  })
})

describe('devices that run on batteries', () => {
  it('declare the power source cluster, without which no controller reads the battery', () => {
    for (const type of ['curtain', 'blindtilt', 'lock', 'motion', 'contact', 'meter', 'waterdetector']) {
      expect(DEVICE_MATTER_CLUSTERS[type]?.powerSource, type).toBeDefined()
    }
  })

  it('leaves the mains-powered ones alone', () => {
    for (const type of ['plug', 'relay', 'light', 'humidifier']) {
      expect(DEVICE_MATTER_CLUSTERS[type]?.powerSource, type).toBeUndefined()
    }
  })
})
