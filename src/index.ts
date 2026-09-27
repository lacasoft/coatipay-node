import Fastify from 'fastify'
import type { Address, Hex } from 'viem'
import { createDaemonChainClients, isDevChainConfig } from './lib/chain-client'
import { loadConfig } from './lib/config'
import { InternalApiClient } from './lib/internal-api-client'
import { initNodeStatus } from './lib/node-status'
import { healthRoute, infoRoute } from './routes/health'
import { startAuthorizationSettler } from './services/authorization-settler'
import { ConfiguracionIncorrecta, preflight } from './services/preflight'

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
  // ── ADR-003 Phase B4: ERC-3009 settlement services ──────────────
  // Create chain clients (null in dev) + API client (used by the settler).
  const hubClients = isDevChainConfig(config.settlementHubAddress)
    ? null
    : createDaemonChainClients({
        privateKey: config.privateKey as Hex,
        chain: config.chain,
        baseRpcUrl: config.baseRpcUrl,
        baseRpcFallbackUrls: config.baseRpcFallbackUrls,
        settlementHubAddress: config.settlementHubAddress as Address,
      })
  // Comprobaciones on-chain antes de aceptar trabajo: que cada RPC sirva la
  // red declarada, que el hub y su USDC sean los configurados, y que estemos
  // registrados. Todo falló alguna vez sin que /health lo reflejara. Sin hub
  // solo se llega aquí fuera de producción (la configuración lo impide).
  // Si la cadena no responde, se espera: sin ella el nodo no puede trabajar, y
  // no se empieza sin haber comprobado.
  if (hubClients) {
    let espera = 5_000
    while ((await preflight(hubClients, config, app.log)) === 'sin_respuesta') {
      await new Promise((r) => setTimeout(r, espera))
      espera = Math.min(espera * 2, 60_000)
    }
  }

  const api = new InternalApiClient({ apiUrl: config.apiUrl, privateKey: config.privateKey })

  // Seed the /health snapshot. `enabled=false` in dev (no SettlementHub) →
  // /health reports the settler as `disabled` rather than `stalled`.
  initNodeStatus({ enabled: hubClients !== null, chain: hubClients?.chainName ?? 'dev' })

  // Settler (write path): polls API queue → submits payIntentWithAuth on-chain.
  const stopSettler = startAuthorizationSettler({
    config,
    hubClients,
    api,
    logger: app.log,
  })
  app.addHook('onClose', () => stopSettler())

  // No event watcher: the API reads IntentSettled from the hub itself and
  // does not take a node's word for what settled (F-5, ADR-007).

  await app.listen({ port: config.port, host: '0.0.0.0' })
  app.log.info('CoatiPay Node v0.1.0')
  app.log.info(`Operator: ${config.operatorAddress}`)
  app.log.info(`Endpoint: ${config.endpoint}`)
}

start().catch((err) => {
  if (err instanceof ConfiguracionIncorrecta) {
    app.log.fatal(`Configuración incorrecta — el nodo no arranca. ${err.message}`)
  } else {
    app.log.error(err)
  }
  process.exit(1)
})
