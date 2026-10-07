import type { FastifyInstance } from 'fastify'
import { computeHealth } from '../lib/node-status'
import { VERSION } from '../lib/version'

export async function healthRoute(app: FastifyInstance) {
  // Public, coarse, non-sensitive node health. Beyond a liveness ping it
  // surfaces a rollup `status` plus per-subsystem buckets (gas / rpc /
  // settler) so a monitor can tell WHY a nodeit is degraded, not
  // just THAT it is. No exact balances/addresses — see lib/node-status.ts.
  app.get('/health', async () => computeHealth())
}

export async function infoRoute(app: FastifyInstance) {
  // Info pública y mínima del nodeit. La variante AUTENTICADA se retiró junto
  // con el secreto HMAC compartido: nadie la consumía (el API mide liveness
  // contra /health) y devolvía un stake hardcodeado. El stake real es
  // verificable on-chain en StakeManager, que es donde debe leerse.
  app.get('/info', async () => ({ status: 'ok', version: VERSION }))
}
