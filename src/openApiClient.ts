import type { Logger } from 'homebridge'

import { createHmac, randomUUID } from 'node:crypto'

import { SwitchbotAuthenticationError, SwitchbotOperationError } from './errors.js'

const BASE_URL = 'https://api.switch-bot.com'
const REQUEST_TIMEOUT_MS = 15_000

/** What the device list endpoint answers with. */
export interface SwitchBotDeviceList {
  deviceList: any[]
  infraredRemoteList: any[]
}

/**
 * The SwitchBot cloud API, spoken directly.
 *
 * The library this plugin used for it also carries a Bluetooth stack, which has to be compiled
 * from C++ wherever the plugin is installed - minutes of it on a Raspberry Pi, every time. Nothing
 * here needs Bluetooth: everything these devices do goes through the hub anyway.
 */
export class OpenApiClient {
  private readonly token: string
  private readonly secret: string
  private readonly logger?: Logger

  constructor(token: string, secret: string, logger?: Logger) {
    this.token = token
    this.secret = secret
    this.logger = logger
  }

  /**
   * @returns {Record<string, string>} Headers signing one request, as the API requires: the
   * signature covers the token, the moment, and a nonce, so a captured request cannot be reused.
   */
  private headers(): Record<string, string> {
    const t = Date.now().toString()
    const nonce = randomUUID()
    const sign = createHmac('sha256', this.secret).update(`${this.token}${t}${nonce}`).digest('base64')

    return {
      'Authorization': this.token,
      'Content-Type': 'application/json',
      t,
      sign,
      nonce,
    }
  }

  /**
   * @param {string} method The HTTP method.
   * @param {string} path The path below the API root.
   * @param {any} body What to send, for a command.
   * @returns {Promise<any>} The body of the answer.
   */
  private async request(method: string, path: string, body?: any): Promise<any> {
    let response: Response
    try {
      response = await fetch(`${BASE_URL}${path}`, {
        method,
        headers: this.headers(),
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch (e) {
      throw new SwitchbotOperationError(`SwitchBot cloud unreachable: ${(e as Error)?.message}`, 'network', e as Error)
    }

    if (response.status === 401 || response.status === 403) {
      throw new SwitchbotAuthenticationError('SwitchBot rejected the token and secret', String(response.status))
    }
    if (!response.ok) {
      throw new SwitchbotOperationError(`SwitchBot cloud answered ${response.status}`, String(response.status))
    }

    const answer = await response.json() as { statusCode?: number, message?: string, body?: any }
    // 100 is the API's own way of saying it worked; anything else carries the reason.
    if (answer?.statusCode !== 100 && answer?.statusCode !== 200) {
      if (answer?.statusCode === 401) {
        throw new SwitchbotAuthenticationError('SwitchBot rejected the token and secret', '401')
      }
      throw new SwitchbotOperationError(
        `SwitchBot cloud refused the request: ${answer?.message ?? 'no reason given'}`,
        String(answer?.statusCode ?? 'unknown'),
      )
    }

    return answer.body
  }

  /**
   * @returns {Promise<SwitchBotDeviceList>} Every device on the account, infrared remotes included.
   */
  async getDevices(): Promise<SwitchBotDeviceList> {
    const body = await this.request('GET', '/v1.1/devices')
    return {
      deviceList: Array.isArray(body?.deviceList) ? body.deviceList : [],
      infraredRemoteList: Array.isArray(body?.infraredRemoteList) ? body.infraredRemoteList : [],
    }
  }

  /**
   * @param {string} deviceId The device to read.
   * @returns {Promise<any>} What it reports - a curtain's position, a plug's power, a meter's
   * readings.
   */
  async getStatus(deviceId: string): Promise<any> {
    return this.request('GET', `/v1.1/devices/${encodeURIComponent(deviceId)}/status`)
  }

  /**
   * @param {string} deviceId The device to command.
   * @param {string} command The command name.
   * @param {any} parameter Its argument, where it takes one.
   * @param {string} commandType `command` for the device's own commands, `customize` for a scene
   * button on an infrared remote.
   * @returns {Promise<any>} Whatever the cloud answers.
   */
  async sendCommand(deviceId: string, command: string, parameter: any = 'default', commandType = 'command'): Promise<any> {
    this.logger?.debug?.(`[${deviceId}] Sending ${command} to the SwitchBot cloud`)
    return this.request('POST', `/v1.1/devices/${encodeURIComponent(deviceId)}/commands`, {
      command,
      parameter: parameter ?? 'default',
      commandType,
    })
  }
}
