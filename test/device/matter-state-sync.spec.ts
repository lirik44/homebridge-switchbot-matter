import { describe, expect, it } from 'vitest'

import { matterStateFor } from '../../src/utils'

describe('matterStateFor', () => {
  // HomeKit asks for a value whenever it wants one; a Matter controller reads its own cached copy
  // and only learns about changes when the node reports them. This is what gets reported.

  it('reports an infrared light as on or off', () => {
    expect(matterStateFor('ir light', { on: true })).toStrictEqual({ onOff: { onOff: true } })
    expect(matterStateFor('ir light', { on: false })).toStrictEqual({ onOff: { onOff: false } })
  })

  it('accepts the shapes the SwitchBot API uses for power', () => {
    expect(matterStateFor('plug', { state: 'on' })).toStrictEqual({ onOff: { onOff: true } })
    expect(matterStateFor('bot', { power: 'on' })).toStrictEqual({ onOff: { onOff: true } })
  })

  it('reports a curtain position in the hundredths of a percent Matter counts in', () => {
    // Both scales put 0 at fully open.
    expect(matterStateFor('curtain', { position: 0 })).toStrictEqual({
      windowCovering: { currentPositionLiftPercent100ths: 0, targetPositionLiftPercent100ths: 0 },
    })
    expect(matterStateFor('curtain3', { position: 100 })).toStrictEqual({
      windowCovering: { currentPositionLiftPercent100ths: 10000, targetPositionLiftPercent100ths: 10000 },
    })
    expect(matterStateFor('curtain', { position: 35 })).toStrictEqual({
      windowCovering: { currentPositionLiftPercent100ths: 3500, targetPositionLiftPercent100ths: 3500 },
    })
  })

  it('keeps a curtain position within range whatever the API reports', () => {
    expect(matterStateFor('curtain', { position: 140 })?.windowCovering.currentPositionLiftPercent100ths).toBe(10000)
    expect(matterStateFor('curtain', { position: -5 })?.windowCovering.currentPositionLiftPercent100ths).toBe(0)
  })

  it('converts a light brightness onto the Matter level scale', () => {
    expect(matterStateFor('light', { on: true, brightness: 100 })).toStrictEqual({
      onOff: { onOff: true },
      levelControl: { currentLevel: 254 },
    })
    // Level 0 means "off" in Matter, so the dimmest a lit lamp reports is 1.
    expect(matterStateFor('light', { on: true, brightness: 0 })?.levelControl.currentLevel).toBe(1)
  })

  it('reports temperature and humidity in hundredths', () => {
    expect(matterStateFor('meter', { temperature: 23.5, humidity: 74 })).toStrictEqual({
      temperatureMeasurement: { measuredValue: 2350 },
      relativeHumidityMeasurement: { measuredValue: 7400 },
    })
  })

  it('reports nothing for a device with no readable state', () => {
    expect(matterStateFor('curtain', {})).toBeUndefined()
    expect(matterStateFor('meter', {})).toBeUndefined()
    expect(matterStateFor('hub 2', { on: true })).toBeUndefined()
    expect(matterStateFor('ir light', undefined)).toBeUndefined()
  })
})
