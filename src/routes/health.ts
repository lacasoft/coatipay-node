import type { FastifyInstance } from 'fastify'
import { computeHealth } from '../lib/node-status'

/**
 * Base URL for the error reference in this node's error responses.
 * Env-driven (`DOCS_URL`) so the docs can move without a code change — the API
 * reads the same variable; each service carries its own env.
 */
const DOCS_URL = (process.env.DOCS_URL || 'https://docs.coatipay.com').replace(/\/+$/, '')

export async function healthRoute(app: FastifyInstance) {
  // Public, coarse, non-sensitive node health. Beyond a liveness ping it
  // surfaces a rollup `status` plus per-subsystem buckets (gas / rpc /
  // settler / watcher) so a monitor can tell WHY a nodeit is degraded, not
  // just THAT it is. No exact balances/addresses — see lib/node-status.ts.
  app.get('/health', async () => computeHealth())
}

export async function infoRoute(app: FastifyInstance) {
  // Info pública y mínima del nodeit. La variante AUTENTICADA se retiró junto
  // con el secreto HMAC compartido: nadie la consumía (el API mide liveness
  // contra /health) y devolvía un stake hardcodeado. El stake real es
  // verificable on-chain en StakeManager, que es donde debe leerse.
  app.get('/info', async () => ({ status: 'ok', version: '0.1.0' }))
}
