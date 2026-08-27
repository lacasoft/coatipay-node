import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { healthRoute, infoRoute } from '../../routes/health.js'

let app: FastifyInstance

const mockConfig = {
  port: 4000,
  operatorAddress: '0xTestOperator1234567890abcdef1234567890ab',
  privateKey: `0x${'01'.repeat(32)}` as `0x${string}`,
  endpoint: 'http://localhost:4000',
  baseRpcUrl: 'https://sepolia.base.org',
  baseRpcFallbackUrls: [],
  nodeRegistryAddress: '0x0000000000000000000000000000000000000000',
  stakeManagerAddress: '0x0000000000000000000000000000000000000000',
  settlementHubAddress: '0x0000000000000000000000000000000000000000',
  usdcAddress: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  apiUrl: 'http://localhost:3000',
  eventMaxBlockRange: 9,
  eventPollIntervalMs: 4000,
  eventLookbackBlocks: 2000,
  minPaymentAmount: 0,
  gasPriceRefGwei: 0.02,
  settleExpiryBufferSeconds: 300,
}

beforeAll(async () => {
  app = Fastify({ logger: false })
  app.decorate('config', mockConfig as never)
  app.register(healthRoute)
  app.register(infoRoute)
  await app.ready()
})

afterAll(async () => {
  await app.close()
})

describe('GET /health (public — coarse node health buckets)', () => {
  it('should return status ok', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' })
    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.status).toBe('ok')
  })

  it('should return version', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' })
    const body = response.json()
    expect(body.version).toBe('0.1.0')
  })

  it('should NOT expose operator address (public endpoint)', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' })
    const body = response.json()
    expect(body.operator).toBeUndefined()
  })

  it('exposes coarse subsystem buckets (gas / rpc / settler / watcher)', async () => {
    // initNodeStatus() isn't called in this route-only test, so the daemon
    // reads as disabled (dev): services `disabled`, but every bucket present.
    const response = await app.inject({ method: 'GET', url: '/health' })
    const body = response.json()
    expect(body).toMatchObject({
      settler: 'disabled',
      watcher: 'disabled',
      gas: 'offline',
      rpc: 'down',
    })
    expect(typeof body.uptime_seconds).toBe('number')
    expect(typeof body.chain).toBe('string')
    // Still no exact balance / block numbers leaked on the public endpoint.
    expect(body.balance).toBeUndefined()
    expect(body.balance_wei).toBeUndefined()
  })
})

describe('GET /info (respuesta pública)', () => {
  it('devuelve solo status y version', async () => {
    const res = await app.inject({ method: 'GET', url: '/info' })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ status: 'ok', version: '0.1.0' })
  })

  it('NO expone la dirección del operador', async () => {
    // La variante autenticada se retiró con el secreto HMAC compartido: nadie
    // la consumía y devolvía un stake hardcodeado. El stake real se lee
    // on-chain en StakeManager.
    const res = await app.inject({ method: 'GET', url: '/info' })
    expect(res.body).not.toContain('0x')
  })
})
