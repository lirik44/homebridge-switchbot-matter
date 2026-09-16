import { createHmac } from 'node:crypto'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { OpenApiClient } from '../../src/openApiClient'

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn() } as any

function answer(body: any, statusCode = 100) {
  return { ok: true, status: 200, json: async () => ({ statusCode, message: 'success', body }) }
}

function stubFetch(response: any) {
  const fetchMock = vi.fn(async () => response)
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('openApiClient', () => {
  it('signs a request the way the API asks for', async () => {
    const fetchMock = stubFetch(answer({ deviceList: [], infraredRemoteList: [] }))
    await new OpenApiClient('token', 'secret', log).getDevices()

    const [url, init] = fetchMock.mock.calls[0] as any
    expect(url).toBe('https://api.switch-bot.com/v1.1/devices')
    expect(init.headers.Authorization).toBe('token')

    // The signature covers the token, the moment and a nonce, so a captured request is useless.
    const expected = createHmac('sha256', 'secret')
      .update(`token${init.headers.t}${init.headers.nonce}`)
      .digest('base64')
    expect(init.headers.sign).toBe(expected)
  })

  it('lists devices and remotes separately, as the API does', async () => {
    stubFetch(answer({
      deviceList: [{ deviceId: 'D1', deviceType: 'Curtain3' }],
      infraredRemoteList: [{ deviceId: 'IR1', remoteType: 'DIY Light' }],
    }))

    await expect(new OpenApiClient('token', 'secret').getDevices()).resolves.toStrictEqual({
      deviceList: [{ deviceId: 'D1', deviceType: 'Curtain3' }],
      infraredRemoteList: [{ deviceId: 'IR1', remoteType: 'DIY Light' }],
    })
  })

  it('reads a status', async () => {
    const fetchMock = stubFetch(answer({ deviceId: 'D1', slidePosition: 40 }))
    await expect(new OpenApiClient('token', 'secret').getStatus('D1')).resolves.toStrictEqual({ deviceId: 'D1', slidePosition: 40 })
    expect((fetchMock.mock.calls[0] as any)[0]).toBe('https://api.switch-bot.com/v1.1/devices/D1/status')
  })

  it('sends a command', async () => {
    const fetchMock = stubFetch(answer({}))
    await new OpenApiClient('token', 'secret').sendCommand('D1', 'setPosition', '0,ff,50')

    const [url, init] = fetchMock.mock.calls[0] as any
    expect(url).toBe('https://api.switch-bot.com/v1.1/devices/D1/commands')
    expect(JSON.parse(init.body)).toStrictEqual({ command: 'setPosition', parameter: '0,ff,50', commandType: 'command' })
  })

  it('says so when the credentials are refused', async () => {
    stubFetch({ ok: false, status: 401, json: async () => ({}) })
    await expect(new OpenApiClient('token', 'secret').getDevices()).rejects.toThrow(/token and secret/)
  })

  it('carries the reason the cloud gave for refusing', async () => {
    // The API answers 200 with its own status code inside.
    stubFetch({ ok: true, status: 200, json: async () => ({ statusCode: 161, message: 'device offline' }) })
    await expect(new OpenApiClient('token', 'secret').sendCommand('D1', 'turnOn')).rejects.toThrow(/device offline/)
  })

  it('reports an unreachable cloud rather than hanging on to the error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('getaddrinfo ENOTFOUND')
    }))
    await expect(new OpenApiClient('token', 'secret').getStatus('D1')).rejects.toThrow(/unreachable/)
  })
})
