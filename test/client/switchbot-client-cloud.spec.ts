import { afterEach, describe, expect, it, vi } from 'vitest'

import { SwitchBotClient } from '../../src/switchbotClient'

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn() } as any

function cloudAnswers(bodies: any[]) {
  const fetchMock = vi.fn(async () => {
    const body = bodies.shift()
    return { ok: true, status: 200, json: async () => ({ statusCode: 100, message: 'success', body }) } as any
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function client() {
  return new SwitchBotClient({ logger, openApiToken: 'token', openApiSecret: 'secret', writeDebounceMs: 0 } as any)
}

const DEVICE_LIST = {
  deviceList: [{ deviceId: 'D1', deviceType: 'Curtain3', deviceName: 'Left curtain' }],
  infraredRemoteList: [{ deviceId: 'IR1', remoteType: 'DIY Light', deviceName: 'Christmas Light' }],
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('a client with no Bluetooth', () => {
  // Bluetooth support is a separate install; with a hub, everything goes through the cloud.

  it('finds a device in the account, remotes included', async () => {
    cloudAnswers([DEVICE_LIST])
    const sb = client()
    await sb.init()

    await expect(sb.getDevice('D1')).resolves.toEqual(expect.objectContaining({ id: 'D1', deviceType: 'Curtain3' }))
    // A remote has no device type of its own, so its remote type stands in for one.
    await expect(sb.getDevice('IR1')).resolves.toEqual(expect.objectContaining({ id: 'IR1', deviceType: 'DIY Light', isIR: true }))
  })

  it('asks for the list once and then reuses it', async () => {
    const fetchMock = cloudAnswers([DEVICE_LIST, DEVICE_LIST])
    const sb = client()
    await sb.init()

    await sb.getDevice('D1')
    await sb.getDevice('D1')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('words a curtain position the way the API wants it', async () => {
    const fetchMock = cloudAnswers([DEVICE_LIST, {}])
    const sb = client()
    await sb.init()

    await sb.setDeviceState('D1', { command: 'setPosition', parameter: '50', commandType: 'command' })

    const [url, init] = fetchMock.mock.calls[1] as any
    expect(url).toBe('https://api.switch-bot.com/v1.1/devices/D1/commands')
    // index, mode, then the percentage - everywhere else in this plugin it is just the percentage.
    expect(JSON.parse(init.body).parameter).toBe('0,ff,50')
  })

  it('leaves the argument of every other command alone', async () => {
    const fetchMock = cloudAnswers([DEVICE_LIST, {}])
    const sb = client()
    await sb.init()

    await sb.setDeviceState('D1', { command: 'turnOn', parameter: 'default', commandType: 'command' })
    expect(JSON.parse((fetchMock.mock.calls[1] as any)[1].body)).toStrictEqual({
      command: 'turnOn',
      parameter: 'default',
      commandType: 'command',
    })
  })

  it('presses an infrared remote', async () => {
    const fetchMock = cloudAnswers([{}])
    const sb = client()
    await sb.init()

    await sb.sendIRCommand('IR1', 'turnOn')
    expect((fetchMock.mock.calls[0] as any)[0]).toBe('https://api.switch-bot.com/v1.1/devices/IR1/commands')
  })

  it('reads a status, and does not ask again straight away', async () => {
    const fetchMock = cloudAnswers([{ slidePosition: 40 }, { slidePosition: 60 }])
    const sb = client()
    await sb.init()

    await expect(sb.getStatus('D1')).resolves.toStrictEqual({ slidePosition: 40 })
    await expect(sb.getStatus('D1')).resolves.toStrictEqual({ slidePosition: 40 })
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // Unless the caller says the cached answer is no use, which is what happens after a command.
    await expect(sb.getStatus('D1', 0)).resolves.toStrictEqual({ slidePosition: 60 })
  })

  it('says plainly when there is nothing to reach the devices with', async () => {
    const sb = new SwitchBotClient({ logger } as any)
    await sb.init()
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('no way to reach'))
  })
})
