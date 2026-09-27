import type { FastifyBaseLogger } from 'fastify'
import {
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  HttpRequestError,
} from 'viem'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DaemonChainClients } from '../../lib/chain-client'
import {
  ConfiguracionIncorrecta,
  esVeredictoDeLaCadena,
  type LeerChainId,
  preflight,
} from '../../services/preflight'

const HUB = '0x4444444444444444444444444444444444444444'
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
const REGISTRO = '0x1111111111111111111111111111111111111111'
const OPERADOR = '0x3333333333333333333333333333333333333333'
const PRINCIPAL = 'https://base-sepolia.g.alchemy.com/v2/CLAVE-SECRETA'
const RESPALDO = 'https://respaldo.example/rpc'
const PUBLICO = 'https://sepolia.base.org'

const config = {
  chain: 'base-sepolia' as const,
  baseRpcUrl: PRINCIPAL,
  baseRpcFallbackUrls: [RESPALDO],
  operatorAddress: OPERADOR,
  nodeRegistryAddress: REGISTRO,
  usdcAddress: USDC,
}

/// Los errores tal como los envuelve viem en `readContract`.
const envuelto = (causa: Error, functionName: string) =>
  new ContractFunctionExecutionError(causa as never, {
    abi: [],
    functionName,
    contractAddress: HUB,
  })
/// En esa dirección no hay contrato (o no tiene esa función).
const sinContrato = (fn: string) =>
  envuelto(new ContractFunctionZeroDataError({ functionName: fn }), fn)
/// El contrato revierte.
const revierte = (fn: string) =>
  envuelto(new ContractFunctionRevertedError({ abi: [], functionName: fn }), fn)
/// La cadena no responde.
const caida = (fn: string) =>
  envuelto(new HttpRequestError({ url: PRINCIPAL, status: 503, body: {} }), fn)

/// Lo que la cadena responde a cada lectura; un `Error` se lanza.
let cadena: Record<string, unknown>
const readContract = vi.fn(async ({ functionName }: { functionName: string }) => {
  const r = cadena[functionName]
  if (r instanceof Error) throw r
  return r
})
const clients = {
  publicClient: { readContract },
  settlementHubAddress: HUB,
} as unknown as DaemonChainClients

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  fatal: vi.fn(),
} as unknown as FastifyBaseLogger

/// Todas las URLs en Base Sepolia, salvo las que se indiquen.
const redes =
  (excepciones: Record<string, number | null> = {}): LeerChainId =>
  async (url) =>
    url in excepciones ? (excepciones[url] as number | null) : 84532

beforeEach(() => {
  vi.clearAllMocks()
  cadena = {
    intentSigner: '0x5555555555555555555555555555555555555555',
    usdc: USDC,
    isActive: true,
  }
})

describe('preflight — la red de cada RPC', () => {
  it('con todo en orden, pasa', async () => {
    await expect(preflight(clients, config, logger, redes())).resolves.toBe('ok')
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ chain: 'base-sepolia', usdc: USDC }),
      'Preflight OK',
    )
  })

  it('comprueba el principal, cada respaldo y el público', async () => {
    const vistas: string[] = []
    await preflight(clients, config, logger, async (url) => {
      vistas.push(url)
      return 84532
    })
    expect(vistas).toEqual([PRINCIPAL, RESPALDO, PUBLICO])
  })

  it('un respaldo en otra red no arranca: solo se notaría en plena caída del principal', async () => {
    await expect(preflight(clients, config, logger, redes({ [RESPALDO]: 8453 }))).rejects.toThrow(
      ConfiguracionIncorrecta,
    )
    await expect(preflight(clients, config, logger, redes({ [RESPALDO]: 8453 }))).rejects.toThrow(
      /respaldo\.example sirve la red 8453/,
    )
    expect(readContract).not.toHaveBeenCalled()
  })

  it('el principal en otra red no arranca, y el error no filtra la clave de la URL', async () => {
    const error = await preflight(clients, config, logger, redes({ [PRINCIPAL]: 8453 })).catch(
      (e: Error) => e,
    )
    expect(error).toBeInstanceOf(ConfiguracionIncorrecta)
    const mensaje = (error as Error).message
    expect(mensaje).toContain('base-sepolia.g.alchemy.com')
    expect(mensaje).not.toContain('CLAVE-SECRETA')
  })

  it('un RPC que no responde avisa pero no impide arrancar: es una caída, no un error de configuración', async () => {
    await expect(preflight(clients, config, logger, redes({ [RESPALDO]: null }))).resolves.toBe(
      'ok',
    )
    expect(logger.warn).toHaveBeenCalledWith(
      { rpc: 'respaldo.example' },
      expect.stringContaining('sin respuesta'),
    )
  })

  it('declarada mainnet, un RPC de Sepolia no arranca', async () => {
    await expect(preflight(clients, { ...config, chain: 'base' }, logger, redes())).rejects.toThrow(
      /sirve la red 84532, no base \(8453\)/,
    )
  })
})

describe('preflight — el hub, su USDC y el registro', () => {
  it('sin contrato en SETTLEMENT_HUB_ADDRESS no arranca', async () => {
    cadena.intentSigner = sinContrato('intentSigner')
    await expect(preflight(clients, config, logger, redes())).rejects.toThrow(
      /SETTLEMENT_HUB_ADDRESS .* no es un SettlementHub/,
    )
  })

  it('un contrato que revierte a intentSigner() no arranca', async () => {
    cadena.intentSigner = revierte('intentSigner')
    await expect(preflight(clients, config, logger, redes())).rejects.toThrow(
      ConfiguracionIncorrecta,
    )
  })

  it('un USDC_ADDRESS que no es el USDC del hub no arranca', async () => {
    cadena.usdc = '0x6666666666666666666666666666666666666666'
    await expect(preflight(clients, config, logger, redes())).rejects.toThrow(
      /USDC_ADDRESS .* no es el USDC del hub/,
    )
  })

  it('el USDC se compara sin importar mayúsculas', async () => {
    cadena.usdc = USDC.toLowerCase()
    await expect(preflight(clients, config, logger, redes())).resolves.toBe('ok')
  })

  it('un nodeit inactivo en el registro no arranca', async () => {
    cadena.isActive = false
    await expect(preflight(clients, config, logger, redes())).rejects.toThrow(/no está activo/)
  })

  it('pregunta al registro por la dirección del operador', async () => {
    await preflight(clients, config, logger, redes())
    expect(readContract).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: 'isActive', args: [OPERADOR] }),
    )
  })
})

describe('preflight — una caída no es un error de configuración', () => {
  it.each([['intentSigner'], ['usdc'], ['isActive']])(
    'si %s() no responde, devuelve sin_respuesta y no lanza',
    async (fn) => {
      cadena[fn] = caida(fn)
      await expect(preflight(clients, config, logger, redes())).resolves.toBe('sin_respuesta')
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(String) }),
        expect.stringContaining('no responde'),
      )
      expect(logger.info).not.toHaveBeenCalledWith(expect.anything(), 'Preflight OK')
    },
  )

  it('distingue el veredicto de la cadena de su silencio', () => {
    expect(esVeredictoDeLaCadena(sinContrato('usdc'))).toBe(true)
    expect(esVeredictoDeLaCadena(revierte('usdc'))).toBe(true)
    expect(esVeredictoDeLaCadena(caida('usdc'))).toBe(false)
    expect(esVeredictoDeLaCadena(new Error('fetch failed'))).toBe(false)
  })

  it('reconoce el veredicto aunque venga de otra copia de viem (ESM/CommonJS)', () => {
    // Otra copia: mismo nombre, otra clase. Con `instanceof` pasaba por caída.
    const deOtraCopia = new Error('The contract function "usdc" returned no data ("0x").')
    deOtraCopia.name = 'ContractFunctionZeroDataError'
    const envoltorio = new Error('ContractFunctionExecutionError', { cause: deOtraCopia })
    expect(esVeredictoDeLaCadena(envoltorio)).toBe(true)
  })
})
