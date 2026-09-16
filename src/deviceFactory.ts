import type { Logger } from 'homebridge'

import type { DeviceType, SwitchBotPluginConfig } from './settings.js'

import { DEVICE_TYPE_NORMALIZATION_MAP } from './device-types.js'
import {
  BlindTiltDevice,
  BotDevice,
  ContactSensorDevice,
  Curtain3Device,
  CurtainDevice,
  FanDevice,
  GenericDevice,
  Hub2Device,
  HumidifierDevice,
  LightDevice,
  LightStripDevice,
  LockDevice,
  MeterDevice,
  MotionSensorDevice,
  PlugDevice,
  PlugMiniDevice,
  RelaySwitch1PMDevice,
  RelaySwitchDevice,
  RollerShadeDevice,
  SmartFanDevice,
  StripLightDevice,
  TemperatureSensorDevice,
  VacuumDevice,
  WalletFinderDevice,
  WaterDetectorDevice,
  WoSweeperDevice,
  WoSweeperMiniDevice,
  WoSweeperMiniProDevice,
} from './devices/genericDevice.js'
import { IRLightDevice } from './devices/irDevice.js'
import { SwitchBotClient } from './switchbotClient.js'
import { isInfraredType, stateFromApiStatus } from './utils.js'

export interface DeviceOptions {
  id: string
  type: DeviceType
  name?: string
  [key: string]: any
}

const DEVICE_CLASS_MAP: Record<string, any> = {
  // Infrared remotes. Cloud-only, stateless, and unrelated to the SwitchBot device of the same
  // name: an `ir light` is a lamp the hub blasts codes at, a `light` is a SwitchBot bulb.
  'ir light': IRLightDevice,
  // Primary device type keys (lowercase, simplified)
  'bot': BotDevice,
  'curtain': CurtainDevice,
  'curtain3': Curtain3Device,
  'fan': FanDevice,
  'light': LightDevice,
  'lightstrip': LightStripDevice,
  'motion': MotionSensorDevice,
  'contact': ContactSensorDevice,
  'vacuum': VacuumDevice,
  // Canonical, normalized device type keys (lowercase, mapped to device classes)
  'video doorbell': GenericDevice,
  'smart radiator thermostat': GenericDevice,
  'woiosensor': GenericDevice,
  'garage door opener': GenericDevice,
  'air purifier table pm2.5': GenericDevice,
  'air purifier voc': GenericDevice,
  'air purifier table voc': GenericDevice,
  'meterplus': MeterDevice,
  'meterpro': MeterDevice,
  'meterpro(co2)': MeterDevice,
  'walletfinder': WalletFinderDevice,
  'plug': PlugDevice,
  'plug mini (eu)': PlugMiniDevice,
  'plug mini (jp)': PlugMiniDevice,
  'plug mini (us)': PlugMiniDevice,
  'relay switch 1pm': RelaySwitch1PMDevice,
  'relay switch 2pm': RelaySwitch1PMDevice,
  'k10+ pro': WoSweeperDevice,
  'robot vacuum cleaner k10+ pro combo': WoSweeperDevice,
  'robot vacuum cleaner k11+': WoSweeperDevice,
  'robot vacuum cleaner k20 plus pro': WoSweeperDevice,
  'ai hub': GenericDevice,
  'hub': GenericDevice,
  'hub 2': Hub2Device,
  'hub 3': GenericDevice,
  'hub mini': GenericDevice,
  'hub plus': GenericDevice,
  'indoor cam': GenericDevice,
  'pan/tilt cam': GenericDevice,
  'pan/tilt cam 2k': GenericDevice,
  'pan/tilt cam plus 2k': GenericDevice,
  'pan/tilt cam plus 3k': GenericDevice,
  'humidifier': HumidifierDevice, // Includes evaporative humidifier mapping
  'roller shade': RollerShadeDevice,
  'strip light 3': StripLightDevice,
  'circulator fan': FanDevice,
  'smart lock pro': LockDevice,
  'lock lite': LockDevice,
  'keypad': LockDevice,
  'lock vision pro': LockDevice,
  'floor lamp': LightDevice,
  'rgbicww floor lamp': LightStripDevice,
  'rgbicww strip light': LightStripDevice,
  'home climate panel': GenericDevice, // Climate panel family
  'lock': LockDevice,
  'humidifier2': HumidifierDevice,
  'temperature': TemperatureSensorDevice,
  'relay switch 1': RelaySwitchDevice,
  'blind tilt': BlindTiltDevice,
  'worollershade': RollerShadeDevice,
  'wo rollershade': RollerShadeDevice,
  'rollershade': RollerShadeDevice,
  'meter': MeterDevice,
  'meter plus (jp)': MeterDevice,
  'water detector': WaterDetectorDevice,
  'waterdetector': WaterDetectorDevice,
  'smart fan': SmartFanDevice,
  'strip light': StripLightDevice,
  'wosweeper': WoSweeperDevice,
  'wosweepermini': WoSweeperMiniDevice,
  'wosweeperminipro': WoSweeperMiniProDevice,
  'k10+': WoSweeperDevice,
  'k10+ pro (wosweeperminipro)': WoSweeperMiniProDevice,
  'battery circulator fan': FanDevice,
  'standing circulator fan': FanDevice,
  'smart lock': LockDevice,
  'smart lock ultra': LockDevice,
  'keypad touch': LockDevice,
  'keypad vision': LockDevice,
  'keypad vision pro': LockDevice,
  'color bulb': LightDevice,
  'ceiling light': LightDevice,
  'ceiling light pro': LightDevice,
  'candle warmer lamp': LightDevice,
  'rgbic neon rope light': LightStripDevice,
  'rgbic neon wire rope light': LightStripDevice,
  'robot vacuum cleaner s1': VacuumDevice,
  'robot vacuum cleaner s1 plus': VacuumDevice,
  'robot vacuum cleaner s10': VacuumDevice,
  'robot vacuum cleaner s20': VacuumDevice,
}

function classForType(type: string) {
  const rawKey = (type || '').toLowerCase()
  const key = DEVICE_TYPE_NORMALIZATION_MAP[rawKey] ?? rawKey
  return DEVICE_CLASS_MAP[key] ?? GenericDevice
}

/**
 * One device instance per physical device, shared by the HAP and Matter platforms.
 *
 * With both platforms running, each used to build its own instance of the same device. That is
 * wasteful for anything with a cache, and wrong for anything whose state lives in the plugin
 * rather than on the device: an infrared remote has no state to read back, so a garland switched
 * on through HAP stayed "off" for the Matter half, which held a different object. Keyed by the
 * shared client so a config reload, which builds a new client, starts fresh.
 */
const DEVICE_INSTANCES = new WeakMap<object, Map<string, any>>()

/**
 * @param {object} client The shared SwitchBot client.
 * @returns {Map<string, any>} The instances built against that client.
 */
function instancesFor(client: object): Map<string, any> {
  let instances = DEVICE_INSTANCES.get(client)
  if (!instances) {
    instances = new Map()
    DEVICE_INSTANCES.set(client, instances)
  }
  return instances
}

export async function createDevice(opts: DeviceOptions, cfg: SwitchBotPluginConfig, useMatter: boolean, log?: Logger) {
  // Always pass the logger to both device opts and config
  const logger = log || (cfg as any)?.logger || (cfg as any)?.log
  if (opts && opts.name && logger && typeof logger.info === 'function') {
    logger.info(`[Matter/Debug] createDevice: Passing opts for ${opts.name}:`, JSON.stringify(opts, null, 2))
  }
  // Reuse existing client when provided via config to avoid creating
  // a new SwitchBotClient per device (which can be expensive).
  let client: any = (cfg as any)?._client ?? null
  if (!client) {
    client = new SwitchBotClient(cfg)
    await client.init()
  }
  // Pass client via config so devices can access it
  const mergedCfg = { ...(cfg as any), _client: client }
  // Always pass logger to mergedCfg
  if (logger) {
    mergedCfg.log = logger
  }
  // Pass encryptionKey and keyId to device opts if present
  const deviceOpts = { ...opts }
  if (opts.encryptionKey) {
    deviceOpts.encryptionKey = opts.encryptionKey
  }
  if (opts.keyId) {
    deviceOpts.keyId = opts.keyId
  }
  // Always pass logger to deviceOpts
  if (logger) {
    deviceOpts.log = logger
  }
  const instances = instancesFor(client)
  const shared = instances.get(opts.id)
  if (shared) {
    return {
      instance: shared,
      createAccessory: useMatter
        ? async (api: any) => await shared.createMatterAccessory(api)
        : (api: any) => shared.createHAPAccessory(api),
      protocol: useMatter ? 'matter' : 'hap',
    }
  }

  const DeviceCtor = classForType(opts.type)
  const device = new DeviceCtor(deviceOpts, mergedCfg)
  await device.init()

  // Attach a simple getState delegator to the client where appropriate. An IR remote is not in
  // discovery and has nothing to report, so it keeps the state it remembers instead.
  const originalGetState = device.getState.bind(device)
  device.getState = isInfraredType(opts.type)
    ? originalGetState
    : async () => {
      let local: any
      try {
        // Prefer client-backed getDevice when available
        local = await client.getDevice(opts.id)
      } catch (e) {
        // ignore and fallback to device implementation
      }
      if (!local) {
        try {
          local = await originalGetState()
        } catch (e) {
          // ignore; the cloud reading below may still have something
        }
      }

      // A device found over BLE is something to talk to, not a reading - it carries no position
      // and no power state. Whatever the cloud knows takes precedence over what it does not.
      let reported: Record<string, any> | undefined
      try {
        if (typeof client.getStatus === 'function') {
          reported = stateFromApiStatus(await client.getStatus(opts.id))
        }
      } catch (e) {
        // ignore; a stale or missing cloud reading is not worth failing a HomeKit read over
      }

      return reported ? { ...(local ?? {}), ...reported } : local
    }

  // A command sent from either half of the plugin is a change both halves need to hear about.
  const originalSetState = device.setState.bind(device)
  device.setState = async (change: any) => {
    const result = await originalSetState(change)
    device.notifyStateChanged?.()
    return result
  }

  instances.set(opts.id, device)

  // Provide accessory factory based on platform selection
  return {
    instance: device,
    createAccessory: useMatter
      ? async (api: any) => await device.createMatterAccessory(api)
      : (api: any) => device.createHAPAccessory(api),
    protocol: useMatter ? 'matter' : 'hap',
  }
}
