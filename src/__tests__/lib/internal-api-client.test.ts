import { createHash } from 'node:crypto'
import { recoverMessageAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InternalApiClient, InternalApiError, mensajeDelCanal } from '../../lib/internal-api-client'
import { CANAL, VERSION } from '../../lib/version'

// Anvil #1 — llave pública documentada por Foundry, nunca fondear en mainnet.
const KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const
const OPERADOR = privateKeyToAccount(KEY).address

const mockFetch = vi.fn()
const cliente = () => new InternalApiClient({ apiUrl: 'https://api.test', privateKey: KEY })
const respuesta = (status: number, cuerpo: unknown = {}, cabeceras: Record<string, string> = {}) =>
  new Response(status === 204 ? null : JSON.stringify(cuerpo), { status, headers: cabeceras })
/// Las cabeceras y el cuerpo de la petición n-ésima que salió.
const enviada = (n = 0) => {
  const [url, init] = mockFetch.mock.calls[n] as [string, RequestInit]
  return { url, cabeceras: init.headers as Record<string, string>, cuerpo: init.body as string }
}

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch)
  mockFetch.mockReset()
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('mensajeDelCanal — lo que firma el operador (canal v2)', () => {
  // El mismo vector está en las pruebas de la API (operator-auth.test.ts): si
  // un lado cambia el formato sin el otro, falla el suyo.
  it('el vector compartido con la API', () => {
    const cuerpo = '{"max":50}'
    expect(
      mensajeDelCanal({
        timestamp: 1_790_000_000,
        nonce: '000102030405060708090a0b0c0d0e0f',
        metodo: 'POST',
        ruta: '/v1/internal/authorizations/claim-batch',
        cuerpo,
      }),
    ).toBe(
      [
        'coatipay-operator-channel/2',
        '1790000000',
        '000102030405060708090a0b0c0d0e0f',
        'POST',
        '/v1/internal/authorizations/claim-batch',
        createHash('sha256').update(cuerpo).digest('hex'),
      ].join('\n'),
    )
    expect(createHash('sha256').update(cuerpo).digest('hex')).toBe(
      '7290bcced19420bbb41fcf7454cb8916cadfede7b1bfef92ae338fd5bab4f302',
    )
  })
})

describe('InternalApiClient.post', () => {
  it('manda el canal, la versión del nodo, la hora y un nonce, y firma todo ello con la clave del operador', async () => {
    mockFetch.mockResolvedValueOnce(respuesta(200, { authorizations: [] }))
    await cliente().post('/v1/internal/authorizations/claim-batch', { max: 50 })

    const { url, cabeceras, cuerpo } = enviada()
    expect(url).toBe('https://api.test/v1/internal/authorizations/claim-batch')
    expect(cuerpo).toBe('{"max":50}')
    expect(cabeceras['X-Operator-Channel']).toBe(String(CANAL))
    expect(cabeceras['X-Node-Version']).toBe(VERSION)
    expect(cabeceras['X-Operator-Nonce']).toMatch(/^[0-9a-f]{32}$/)
    const timestamp = Number(cabeceras['X-Operator-Timestamp'])
    expect(Math.abs(timestamp - Date.now() / 1000)).toBeLessThan(5)

    // Quien reconstruya el mensaje con lo que viaja recupera al operador…
    const mensaje = (ruta: string, body = cuerpo) =>
      mensajeDelCanal({
        timestamp,
        nonce: cabeceras['X-Operator-Nonce'] as string,
        metodo: 'POST',
        ruta,
        cuerpo: body,
      })
    const firma = cabeceras['X-Operator-Signature'] as `0x${string}`
    const quien = (m: string) => recoverMessageAddress({ message: m, signature: firma })
    expect(await quien(mensaje('/v1/internal/authorizations/claim-batch'))).toBe(OPERADOR)
    // …y con otra ruta u otro cuerpo, no: la firma no vale para otra cosa.
    expect(await quien(mensaje('/v1/internal/authorizations/claim'))).not.toBe(OPERADOR)
    expect(await quien(mensaje('/v1/internal/authorizations/pa_otra/rejected'))).not.toBe(OPERADOR)
    expect(await quien(mensaje('/v1/internal/authorizations/claim-batch', '{"max":1}'))).not.toBe(
      OPERADOR,
    )
  })

  it('cada petición lleva un nonce distinto, aunque sea la misma', async () => {
    mockFetch.mockImplementation(async () => respuesta(200, { authorizations: [] }))
    const c = cliente()
    for (let i = 0; i < 20; i++)
      await c.post('/v1/internal/authorizations/claim-batch', { max: 50 })

    const nonces = mockFetch.mock.calls.map((_, n) => enviada(n).cabeceras['X-Operator-Nonce'])
    expect(new Set(nonces).size).toBe(20)
  })

  it('204 es «sin trabajo»: null', async () => {
    mockFetch.mockResolvedValueOnce(respuesta(204))
    expect(await cliente().post('/v1/internal/authorizations/claim', {})).toBeNull()
  })

  it('un 403 corriente es un rechazo, no una incompatibilidad', async () => {
    mockFetch.mockResolvedValueOnce(respuesta(403, { error: { code: 'forbidden' } }))
    const err = (await cliente()
      .post('/v1/internal/authorizations/claim', {})
      .catch((e: unknown) => e)) as InternalApiError

    expect(err).toBeInstanceOf(InternalApiError)
    expect(err.status).toBe(403)
    expect(err.canalDeLaApi).toBeNull()
  })

  it('la API habla otro canal: el error lo dice, con qué hacer', async () => {
    mockFetch.mockResolvedValueOnce(
      respuesta(403, { error: { code: 'forbidden' } }, { 'X-Operator-Channel': '3' }),
    )
    const err = (await cliente()
      .post('/v1/internal/authorizations/claim', {})
      .catch((e: unknown) => e)) as InternalApiError

    expect(err).toBeInstanceOf(InternalApiError)
    expect(err.canalDeLaApi).toBe('3')
    expect(err.message).toMatch(/La API habla el canal v3 y este nodo el v2: actualiza el nodo/)
  })

  it('si la API va por detrás de este nodo, no le dice que se actualice', async () => {
    mockFetch.mockResolvedValueOnce(
      respuesta(403, { error: { code: 'forbidden' } }, { 'X-Operator-Channel': '1' }),
    )
    const err = (await cliente()
      .post('/v1/internal/authorizations/claim', {})
      .catch((e: unknown) => e)) as InternalApiError

    expect(err.canalDeLaApi).toBe('1')
    expect(err.message).toMatch(/este nodo es más nuevo que la API/)
    expect(err.message).not.toMatch(/actualiza el nodo/)
  })

  it('si la API responde con el mismo canal que el nodo, no es incompatibilidad', async () => {
    mockFetch.mockResolvedValueOnce(
      respuesta(403, { error: { code: 'forbidden' } }, { 'X-Operator-Channel': String(CANAL) }),
    )
    const err = (await cliente()
      .post('/v1/internal/authorizations/claim', {})
      .catch((e: unknown) => e)) as InternalApiError
    expect(err.canalDeLaApi).toBeNull()
  })
})
