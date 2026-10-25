import type { FastifyBaseLogger } from 'fastify'
import type { Hex } from 'viem'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DaemonChainClients } from '../../lib/chain-client'
import { GAS_CRITICAL_WEI } from '../../lib/node-status'
import { cobrarComision, startFeeClaimer } from '../../services/fee-claimer'

const HUB = '0x1111111111111111111111111111111111111111' as Hex
const OPERADOR = '0x2222222222222222222222222222222222222222' as Hex

/// La cadena simulada: lo acreditado al operador, su ETH y cómo sale el cobro.
let cadena: { acreditado: bigint; eth: bigint; simulacion: Error | null; recibo: string }

function clientes() {
  return {
    publicClient: {
      readContract: vi.fn(async () => cadena.acreditado),
      getBalance: vi.fn(async () => cadena.eth),
      simulateContract: vi.fn(async (p: unknown) => {
        if (cadena.simulacion) throw cadena.simulacion
        return { request: p }
      }),
      waitForTransactionReceipt: vi.fn(async () => ({ status: cadena.recibo })),
    },
    walletClient: { writeContract: vi.fn(async () => '0xc1a1' as Hex) },
    account: { address: OPERADOR },
    settlementHubAddress: HUB,
  } as unknown as DaemonChainClients
}

const logger = { info: vi.fn(), warn: vi.fn() } as unknown as FastifyBaseLogger
const config = { operatorAddress: OPERADOR, feeClaimMinAmount: 1_000_000 }

beforeEach(() => {
  vi.clearAllMocks()
  cadena = { acreditado: 2_500_000n, eth: 10n ** 18n, simulacion: null, recibo: 'success' }
})

describe('cobrarComision (ADR-009 §1)', () => {
  it('desde el umbral, cobra lo acreditado con claim()', async () => {
    const hubClients = clientes()
    expect(await cobrarComision({ config, hubClients, logger })).toEqual({
      cobrado: 2_500_000n,
      tx: '0xc1a1',
    })
    expect(hubClients.publicClient.readContract).toHaveBeenCalledWith(
      expect.objectContaining({ address: HUB, functionName: 'accrued', args: [OPERADOR] }),
    )
    expect(hubClients.publicClient.simulateContract).toHaveBeenCalledWith(
      expect.objectContaining({ address: HUB, functionName: 'claim' }),
    )
  })

  it('sin nada acreditado, no hace nada', async () => {
    cadena.acreditado = 0n
    const hubClients = clientes()
    expect(await cobrarComision({ config, hubClients, logger })).toEqual({
      omitido: 'nada',
      acreditado: 0n,
    })
    expect(hubClients.walletClient.writeContract).not.toHaveBeenCalled()
  })

  it('por debajo del umbral, lo junta: una transacción por tanda, no por pago', async () => {
    cadena.acreditado = 999_999n
    const hubClients = clientes()
    expect(await cobrarComision({ config, hubClients, logger })).toMatchObject({
      omitido: 'por_debajo_del_umbral',
    })
    expect(hubClients.walletClient.writeContract).not.toHaveBeenCalled()
  })

  it('sin ETH para el gas, no lo intenta: la comisión sigue acreditada', async () => {
    cadena.eth = GAS_CRITICAL_WEI - 1n
    const hubClients = clientes()
    expect(await cobrarComision({ config, hubClients, logger })).toMatchObject({
      omitido: 'sin_gas',
    })
    expect(hubClients.walletClient.writeContract).not.toHaveBeenCalled()
  })

  it('si el cobro revertiría (el operador en la lista negra), no se envía: no cuesta gas', async () => {
    cadena.simulacion = new Error('Blacklistable: account is blacklisted')
    const hubClients = clientes()
    await expect(cobrarComision({ config, hubClients, logger })).rejects.toThrow('Blacklistable')
    expect(hubClients.walletClient.writeContract).not.toHaveBeenCalled()
  })

  it('una transacción minada que revierte, se dice', async () => {
    cadena.recibo = 'reverted'
    await expect(cobrarComision({ config, hubClients: clientes(), logger })).rejects.toThrow(
      'claim_reverted',
    )
  })
})

describe('startFeeClaimer', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('la primera vuelta poco después de arrancar, y después cada hora', async () => {
    const hubClients = clientes()
    const parar = startFeeClaimer({ config, hubClients, logger })
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000)
    expect(hubClients.walletClient.writeContract).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    expect(hubClients.walletClient.writeContract).toHaveBeenCalledTimes(2)
    parar()
    await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000)
    expect(hubClients.walletClient.writeContract).toHaveBeenCalledTimes(2)
  })

  it('un fallo solo se anota, y la siguiente vuelta lo vuelve a intentar', async () => {
    cadena.simulacion = new Error('fetch failed')
    const hubClients = clientes()
    const parar = startFeeClaimer({ config, hubClients, logger })
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000)
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: 'fetch failed' }),
      expect.stringContaining('queda acreditada'),
    )
    cadena.simulacion = null
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    expect(hubClients.walletClient.writeContract).toHaveBeenCalledTimes(1)
    parar()
  })
})
