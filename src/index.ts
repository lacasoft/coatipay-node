import Fastify from 'fastify'
import type { Address, Hex } from 'viem'
import { createDaemonChainClients, isDevChainConfig } from './lib/chain-client'
import { loadConfig } from './lib/config'
import { InternalApiClient } from './lib/internal-api-client'
import { initNodeStatus } from './lib/node-status'
import { healthRoute, infoRoute } from './routes/health'
import { startAuthorizationSettler } from './services/authorization-settler'
import { verifyRegistration } from './services/registry'
import { startSettlementEventWatcher } from './services/settlement-event-watcher'

const config = loadConfig()

const isDev = process.env.NODE_ENV !== 'production'
const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? 'info',
    ...(isDev && {
      transport: { target: 'pino-pretty', options: { colorize: true } },
    }),
  },
})

app.decorate('config', config)

app.register(healthRoute)
app.register(infoRoute)

const shutdown = async () => {
  app.log.info('Shutting down node daemon...')
  await app.close()
  process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

async function start() {
  await verifyRegistration(config, app.log)

  // ── ADR-003 Phase B4: ERC-3009 settlement services ──────────────
  // Create chain clients (null in dev) + API client (used by both
  // settler and event-watcher).
  const hubClients = isDevChainConfig(config.settlementHubAddress)
    ? null
    : createDaemonChainClients({
        privateKey: config.privateKey as Hex,
        baseRpcUrl: config.baseRpcUrl,
        baseRpcFallbackUrls: config.baseRpcFallbackUrls,
        settlementHubAddress: config.settlementHubAddress as Address,
      })
  const api = new InternalApiClient({ apiUrl: config.apiUrl, privateKey: config.privateKey })

  // Seed the /health snapshot. `enabled=false` in dev (no SettlementHub) →
  // /health reports the settler/watcher as `disabled` rather than `stalled`.
  initNodeStatus({ enabled: hubClients !== null, chain: hubClients?.chainName ?? 'dev' })

  // Settler (write path): polls API queue → submits payIntentWithAuth on-chain.
  const stopSettler = startAuthorizationSettler({
    config,
    hubClients,
    api,
    logger: app.log,
  })
  app.addHook('onClose', () => stopSettler())

  // Event watcher (read path / source of truth): subscribes to IntentSettled
  // events from SettlementHub → calls API to update intent + fire webhook.
  const stopEventWatcher = startSettlementEventWatcher({
    config,
    hubClients,
    api,
    logger: app.log,
  })
  app.addHook('onClose', () => stopEventWatcher())

  await app.listen({ port: config.port, host: '0.0.0.0' })
  app.log.info('CoatiPay Node v0.1.0')
  app.log.info(`Operator: ${config.operatorAddress}`)
  app.log.info(`Endpoint: ${config.endpoint}`)
}

start().catch((err) => {
  app.log.error(err)
  process.exit(1)
})
