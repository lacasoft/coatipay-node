import { describe, expect, it, vi } from 'vitest'
import { avisarEnvio } from '../../services/authorization-settler'

/**
 * El aviso de broadcast solo alimenta métricas (punto 6): la liquidación no lo
 * espera, y si la API no lo recibe no pasa nada más que un hueco en la medida.
 */
const contexto = (post: (p: string, b: unknown) => Promise<unknown>) => {
  const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }
  return { ctx: { api: { post }, logger } as never, logger }
}

describe('avisarEnvio', () => {
  it('manda los ids del lote y el hash de la transacción', async () => {
    const post = vi.fn(async () => ({ ok: true }))
    const { ctx } = contexto(post)
    avisarEnvio(ctx, ['pa_1', 'pa_2'], `0x${'cd'.repeat(32)}`)
    expect(post).toHaveBeenCalledWith('/v1/internal/authorizations/broadcast', {
      ids: ['pa_1', 'pa_2'],
      tx_hash: `0x${'cd'.repeat(32)}`,
    })
  })

  it('si la API falla, no lanza: deja un aviso en el log', async () => {
    const { ctx, logger } = contexto(async () => {
      throw new Error('API caída')
    })
    expect(() => avisarEnvio(ctx, ['pa_1'], `0x${'cd'.repeat(32)}`)).not.toThrow()
    await new Promise((r) => setImmediate(r))
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(String(logger.warn.mock.calls[0]?.[1])).toContain('solo afecta a las métricas')
  })
})
