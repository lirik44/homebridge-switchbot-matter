import { describe, expect, it } from 'vitest'

import { commandedStateFor, echoesPublishedState, matterStateFor, matterStateFromHap, snapCurtainPosition, stateFromApiStatus } from '../../src/utils'

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

describe('matterStateFromHap', () => {
  // Whatever the HAP getters answer is what Apple Home shows, so reporting the same values over
  // Matter is what keeps the two ecosystems from disagreeing.

  function service(type: string, values: Record<string, any>) {
    const characteristics: Record<string, any> = {}
    for (const [name, value] of Object.entries(values)) {
      characteristics[name] = { get: async () => value }
    }
    return { services: [{ type, characteristics }] }
  }

  it('mirrors a covering, because the two scales run in opposite directions', async () => {
    // HomeKit counts from the closed end, Matter from the open one.
    await expect(matterStateFromHap(service('WindowCovering', { CurrentPosition: 100, TargetPosition: 100 })))
      .resolves
      .toStrictEqual({ windowCovering: { currentPositionLiftPercent100ths: 0, targetPositionLiftPercent100ths: 0 } })
    await expect(matterStateFromHap(service('WindowCovering', { CurrentPosition: 0, TargetPosition: 0 })))
      .resolves
      .toStrictEqual({ windowCovering: { currentPositionLiftPercent100ths: 10000, targetPositionLiftPercent100ths: 10000 } })
    await expect(matterStateFromHap(service('WindowCovering', { CurrentPosition: 30, TargetPosition: 80 })))
      .resolves
      .toStrictEqual({ windowCovering: { currentPositionLiftPercent100ths: 7000, targetPositionLiftPercent100ths: 2000 } })
  })

  it('reports a lightbulb as on/off and a level', async () => {
    await expect(matterStateFromHap(service('Lightbulb', { On: true, Brightness: 50 })))
      .resolves
      .toStrictEqual({ onOff: { onOff: true }, levelControl: { currentLevel: 127 } })
  })

  it('reports a bare switch, which is all an IR remote has', async () => {
    await expect(matterStateFromHap(service('Lightbulb', { On: true }))).resolves.toStrictEqual({ onOff: { onOff: true } })
    await expect(matterStateFromHap(service('Switch', { On: false }))).resolves.toStrictEqual({ onOff: { onOff: false } })
  })

  it('reports sensors in the hundredths Matter counts in', async () => {
    await expect(matterStateFromHap(service('TemperatureSensor', { CurrentTemperature: 21.5 })))
      .resolves
      .toStrictEqual({ temperatureMeasurement: { measuredValue: 2150 } })
    await expect(matterStateFromHap(service('HumiditySensor', { CurrentRelativeHumidity: 48 })))
      .resolves
      .toStrictEqual({ relativeHumidityMeasurement: { measuredValue: 4800 } })
  })

  it('reports a contact the way each side words it', async () => {
    // HomeKit says 0 for a contact that is made, Matter says true.
    await expect(matterStateFromHap(service('ContactSensor', { ContactSensorState: 0 })))
      .resolves
      .toStrictEqual({ booleanState: { stateValue: true } })
    await expect(matterStateFromHap(service('MotionSensor', { MotionDetected: true })))
      .resolves
      .toStrictEqual({ occupancySensing: { occupancy: { occupied: true } } })
  })

  it('leaves out a value that could not be read rather than reporting a wrong one', async () => {
    const descriptor = {
      services: [{
        type: 'WindowCovering',
        characteristics: {
          CurrentPosition: { get: async () => 40 },
          TargetPosition: { get: async () => {
            throw new Error('device unreachable')
          } },
        },
      }],
    }
    await expect(matterStateFromHap(descriptor)).resolves.toStrictEqual({
      windowCovering: { currentPositionLiftPercent100ths: 6000 },
    })
  })

  it('reports nothing for a descriptor it cannot read', async () => {
    await expect(matterStateFromHap(undefined)).resolves.toBeUndefined()
    await expect(matterStateFromHap({ services: [{ type: 'Battery', characteristics: {} }] })).resolves.toBeUndefined()
  })
})

describe('stateFromApiStatus', () => {
  it('reads a curtain position, which BLE discovery does not carry', () => {
    expect(stateFromApiStatus({ deviceId: 'D1', slidePosition: 0 })).toStrictEqual({ position: 0 })
    expect(stateFromApiStatus({ deviceId: 'D1', slidePosition: 100 })).toStrictEqual({ position: 100 })
  })

  it('reads power, brightness and the sensor readings', () => {
    expect(stateFromApiStatus({ power: 'on', brightness: 40 })).toStrictEqual({ on: true, brightness: 40 })
    expect(stateFromApiStatus({ power: 'OFF' })).toStrictEqual({ on: false })
    expect(stateFromApiStatus({ temperature: 23.4, humidity: 51 })).toStrictEqual({ temperature: 23.4, humidity: 51 })
  })

  it('reports nothing for a status with nothing this plugin reads', () => {
    expect(stateFromApiStatus({ deviceId: 'D1', deviceType: 'Hub 2', version: '1.2' })).toBeUndefined()
    expect(stateFromApiStatus(undefined)).toBeUndefined()
  })
})

describe('commandedStateFor', () => {
  // A Matter controller's commands reach the cloud without passing through the device object, so
  // this is how the plugin hears about them - and stops reporting the old state back.

  it('reads an on/off command', () => {
    expect(commandedStateFor('onOff', 'on', undefined)).toStrictEqual({ on: true })
    expect(commandedStateFor('onOff', 'off', undefined)).toStrictEqual({ on: false })
  })

  it('reads a covering command in the scale the plugin works in', () => {
    expect(commandedStateFor('windowCovering', 'upOrOpen', undefined)).toStrictEqual({ position: 0 })
    expect(commandedStateFor('windowCovering', 'downOrClose', undefined)).toStrictEqual({ position: 100 })
    expect(commandedStateFor('windowCovering', 'goToLiftPercentage', { request: { liftPercent100thsValue: 2500 } }))
      .toStrictEqual({ position: 25 })
  })

  it('reads a level as a percentage', () => {
    expect(commandedStateFor('levelControl', 'moveToLevel', { request: { level: 254 } })).toStrictEqual({ brightness: 100 })
    expect(commandedStateFor('levelControl', 'moveToLevelWithOnOff', { level: 127 })).toStrictEqual({ brightness: 50 })
  })

  it('records nothing for a command it cannot read', () => {
    expect(commandedStateFor('onOff', 'toggle', undefined)).toBeUndefined()
    expect(commandedStateFor('rvcRunMode', 'changeToMode', { newMode: 1 })).toBeUndefined()
    expect(commandedStateFor('windowCovering', 'goToLiftPercentage', {})).toBeUndefined()
  })
})

describe('snapCurtainPosition', () => {
  it('rounds off a curtain that has run into its end stop', () => {
    // The motor stops where its calibration says, not at a round number, and a curtain reported
    // at 99 shows up as "1% open" in every app the moment after it was told to close.
    expect(snapCurtainPosition(99)).toBe(100)
    expect(snapCurtainPosition(1)).toBe(0)
    expect(stateFromApiStatus({ slidePosition: 99 })).toStrictEqual({ position: 100 })
  })

  it('leaves a curtain that is genuinely part way alone', () => {
    expect(snapCurtainPosition(35)).toBe(35)
    expect(snapCurtainPosition(97)).toBe(97)
  })

  it('keeps the position in range', () => {
    expect(snapCurtainPosition(140)).toBe(100)
    expect(snapCurtainPosition(-5)).toBe(0)
  })
})

describe('echoesPublishedState', () => {
  // Reporting a value can reach the accessory's handlers as though a controller had commanded it,
  // and acting on that has the two halves of the plugin echoing each other for ever.

  it('recognises the value just reported', () => {
    expect(echoesPublishedState({ onOff: true }, { on: true })).toBe(true)
    expect(echoesPublishedState({ currentLevel: 254 }, { brightness: 100 })).toBe(true)
    expect(echoesPublishedState({ targetPositionLiftPercent100ths: 2500 }, { position: 25 })).toBe(true)
  })

  it('lets a real command through', () => {
    expect(echoesPublishedState({ onOff: true }, { on: false })).toBe(false)
    expect(echoesPublishedState({ currentLevel: 254 }, { brightness: 40 })).toBe(false)
    expect(echoesPublishedState({ targetPositionLiftPercent100ths: 0 }, { position: 100 })).toBe(false)
  })

  it('lets everything through when nothing has been reported', () => {
    expect(echoesPublishedState(undefined, { on: true })).toBe(false)
    expect(echoesPublishedState({ onOff: true }, { mode: 'auto' })).toBe(false)
  })
})
