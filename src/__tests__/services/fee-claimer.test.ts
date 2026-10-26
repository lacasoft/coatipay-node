import type { FastifyBaseLogger } from 'fastify'
import type { Hex } from 'viem'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DaemonChainClients } from '../../lib/chain-client'
import { GAS_CRITICAL_WEI, GAS_WARNING_WEI } from '../../lib/node-status'
import { cobrarComision, cobrarTesoreria, startFeeClaimer } from '../../services/fee-claimer'

const HUB = '0x1111111111111111111111111111111111111111' as Hex
const OPERADOR = '0x2222222222222222222222222222222222222222' as Hex
const TESORERIA = '0x3333333333333333333333333333333333333333' as Hex

/// La cadena simulada: lo acreditado al operador y a la tesorería, el ETH del
/// operador y cómo sale cada cobro (`simulacion` vale para los dos; las
/// `…Tesoreria`, solo para el de la tesorería).
let cadena: {
  acreditado: bigint
  tesoreria: bigint
  eth: bigint
  simulacion: Error | null
  simulacionTesoreria: Error | null
  recibo: string
}

function clientes() {
  return {
    publicClient: {
      readContract: vi.fn(
        async ({ functionName, args }: { functionName: string; args?: Hex[] }) => {
          if (functionName === 'treasury') return TESORERIA
          return args?.[0] === TESORERIA ? cadena.tesoreria : cadena.acreditado
        },
      ),
      getBalance: vi.fn(async () => cadena.eth),
      simulateContract: vi.fn(async (p: { functionName: string }) => {
        if (p.functionName === 'claimFor' && cadena.simulacionTesoreria) {
          throw cadena.simulacionTesoreria
        }
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
const conTesoreria = { ...config, treasuryClaimMinAmount: 1_000_000 }

beforeEach(() => {
  vi.clearAllMocks()
  cadena = {
    acreditado: 2_500_000n,
    tesoreria: 1_200_000n,
    eth: 10n ** 18n,
    simulacion: null,
    simulacionTesoreria: null,
    recibo: 'success',
  }
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

describe('cobrarTesoreria (ADR-009 §1): claimFor, solo si se pide', () => {
  it('apagado por defecto: ni lee ni envía nada', async () => {
    const hubClients = clientes()
    expect(await cobrarTesoreria({ config, hubClients, logger })).toEqual({ omitido: 'apagado' })
    expect(hubClients.publicClient.readContract).not.toHaveBeenCalled()
    expect(hubClients.walletClient.writeContract).not.toHaveBeenCalled()
  })

  it('desde el umbral, lleva a la tesorería lo suyo con claimFor(tesorería)', async () => {
    const hubClients = clientes()
    expect(await cobrarTesoreria({ config: conTesoreria, hubClients, logger })).toEqual({
      cobrado: 1_200_000n,
      tesoreria: TESORERIA,
      tx: '0xc1a1',
    })
    // La tesorería sale del hub, no de la configuración: no se puede desviar.
    expect(hubClients.publicClient.readContract).toHaveBeenCalledWith(
      expect.objectContaining({ address: HUB, functionName: 'treasury' }),
    )
    expect(hubClients.publicClient.readContract).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: 'accrued', args: [TESORERIA] }),
    )
    expect(hubClients.publicClient.simulateContract).toHaveBeenCalledWith(
      expect.objectContaining({ address: HUB, functionName: 'claimFor', args: [TESORERIA] }),
    )
  })

  it('sin nada acreditado o por debajo del umbral, no envía nada', async () => {
    cadena.tesoreria = 0n
    let hubClients = clientes()
    expect(await cobrarTesoreria({ config: conTesoreria, hubClients, logger })).toMatchObject({
      omitido: 'nada',
    })
    cadena.tesoreria = 999_999n
    hubClients = clientes()
    expect(await cobrarTesoreria({ config: conTesoreria, hubClients, logger })).toMatchObject({
      omitido: 'por_debajo_del_umbral',
    })
    expect(hubClients.walletClient.writeContract).not.toHaveBeenCalled()
  })

  // El gas es de este nodo y es para otro: con el ETH justo para liquidar, la
  // tesorería espera; su propia comisión sí la cobra.
  it('por debajo del umbral de aviso de gas, no lo intenta (el cobro propio sí)', async () => {
    cadena.eth = GAS_WARNING_WEI - 1n
    expect(
      await cobrarTesoreria({ config: conTesoreria, hubClients: clientes(), logger }),
    ).toMatchObject({ omitido: 'sin_gas' })
    expect(
      await cobrarComision({ config: conTesoreria, hubClients: clientes(), logger }),
    ).toMatchObject({ cobrado: 2_500_000n })
  })

  it('si revertiría (la tesorería en la lista negra), no se envía: no cuesta gas', async () => {
    cadena.simulacionTesoreria = new Error('Blacklistable: account is blacklisted')
    const hubClients = clientes()
    await expect(cobrarTesoreria({ config: conTesoreria, hubClients, logger })).rejects.toThrow(
      'Blacklistable',
    )
    expect(hubClients.walletClient.writeContract).not.toHaveBeenCalled()
  })

  it('una transacción minada que revierte, se dice', async () => {
    cadena.recibo = 'reverted'
    await expect(
      cobrarTesoreria({ config: conTesoreria, hubClients: clientes(), logger }),
    ).rejects.toThrow('claimFor_reverted')
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

  it('con la tesorería encendida, cada vuelta cobra las dos comisiones', async () => {
    const hubClients = clientes()
    const parar = startFeeClaimer({ config: conTesoreria, hubClients, logger })
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000)
    const funciones = vi
      .mocked(hubClients.publicClient.simulateContract)
      .mock.calls.map(([p]) => (p as { functionName: string }).functionName)
    expect(funciones.sort()).toEqual(['claim', 'claimFor'])
    expect(hubClients.walletClient.writeContract).toHaveBeenCalledTimes(2)
    parar()
  })

  it('un fallo en el cobro de la tesorería no frena el propio', async () => {
    cadena.simulacionTesoreria = new Error('Blacklistable: account is blacklisted')
    const hubClients = clientes()
    const parar = startFeeClaimer({ config: conTesoreria, hubClients, logger })
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000)
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: 'Blacklistable: account is blacklisted' }),
      expect.stringContaining('[tesorería]'),
    )
    expect(hubClients.walletClient.writeContract).toHaveBeenCalledTimes(1)
    expect(hubClients.publicClient.simulateContract).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: 'claim' }),
    )
    parar()
  })
})
