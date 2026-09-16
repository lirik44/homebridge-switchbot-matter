export const PLUGIN_NAME = '@lirik44/homebridge-switchbot'
export const PLATFORM_NAME = 'SwitchBot'

export interface SwitchBotPluginConfig {
  openApiToken?: string
  openApiSecret?: string
  preferMatter?: boolean
  enableMatter?: boolean
  enableBLE?: boolean // Reach devices over Bluetooth; needs node-switchbot installed alongside this plugin
  // other plugin-specific configuration
  [key: string]: any
}

export const DEFAULT_CONFIG: Partial<SwitchBotPluginConfig> = {
  preferMatter: true,
  enableMatter: true,
  enableBLE: false,
}

export type DeviceType = string

/**
 * When an accessory is read back after being commanded. A curtain is still on its way for the
 * first of these, and settled well before the last.
 */
export const REFRESH_AFTER_COMMAND_MS = [800, 3000, 10_000, 25_000, 45_000]
