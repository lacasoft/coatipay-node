import { CHAIN_IDS, resolveRpcUrls } from '@lacasoft/coatipay-protocol'
import type { FastifyBaseLogger } from 'fastify'
import { type Address, createPublicClient, http, isAddressEqual } from 'viem'
import type { DaemonChainClients } from '../lib/chain-client'
import type { Config } from '../lib/config'
import { SETTLEMENT_HUB_ABI } from '../lib/settlement-hub-abi'

/// ABI mínimo del registro: solo lo que hace falta para saber si podemos
/// trabajar. No merece un fichero propio.
const NODE_REGISTRY_ABI = [
  {
    type: 'function',
    name: 'isActive',
    stateMutability: 'view',
    inputs: [{ name: 'operator', type: 'address' }],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const

/// La configuración contradice a la cadena. El nodo no arranca.
export class ConfiguracionIncorrecta extends Error {
  override name = 'ConfiguracionIncorrecta'
}

/// La cadena no respondió: no se sabe si la configuración es correcta.
class SinRespuesta extends Error {}

/// Solo el host: las URLs de proveedores como Alchemy llevan la clave en la
/// ruta, y esto va a los logs.
export function hostDe(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return '(URL no válida)'
  }
}

/// Errores de viem que son la respuesta de la cadena: en esa dirección no hay
/// contrato (o no tiene esa función), o revierte.
const VEREDICTOS = new Set([
  'ContractFunctionZeroDataError',
  'ContractFunctionRevertedError',
  'ExecutionRevertedError',
])

/// ¿El error es la respuesta de la cadena, o solo que no respondió? Lo primero
/// es un veredicto sobre la configuración.
///
/// Por nombre y no con `instanceof`: con dos copias de viem cargadas (ESM y
/// CommonJS, o una duplicada por una dependencia) el error de una no es
/// instancia de las clases de la otra, y un veredicto pasaría por una caída.
/// Ocurrió al validar esto contra un fork.
export function esVeredictoDeLaCadena(err: unknown): boolean {
  let e: unknown = err
  for (let nivel = 0; e instanceof Error && nivel < 10; nivel++) {
    if (VEREDICTOS.has(e.name)) return true
    e = e.cause
  }
  return false
}

/// Lo que devuelve eth_chainId para una URL: el número, o null si no responde.
export type LeerChainId = (url: string) => Promise<number | null>

const leerChainIdReal: LeerChainId = async (url) => {
  try {
    return await createPublicClient({
      transport: http(url, { retryCount: 0, timeout: 8_000 }),
    }).getChainId()
  } catch {
    return null
  }
}

/**
 * Comprobaciones al arrancar, antes de aceptar trabajo.
 *
 * Existen porque varios fallos reales solo se manifestaron cuando un pago
 * falló, con `/health` diciendo `ok`:
 *
 * 1. `SETTLEMENT_HUB_ADDRESS` apuntaba al contrato anterior. El ABI cambió con
 *    ADR-004, así que `registerIntent` revertía y el settler marcaba el pago
 *    como **rechazo permanente** — irrecuperable, hay que crear otro cobro.
 * 2. El nodeit no estaba registrado en el NodeRegistry nuevo (el stake no viaja
 *    entre despliegues), y la API le devolvía 403 en cada intento.
 *
 * Y dos que no llegaron a pasar, pero fallarían igual de callados:
 *
 * 3. Un RPC que sirve otra red. La red se declara (CHAIN) y aquí se comprueba
 *    en CADA URL, respaldos incluidos: un respaldo en otra red solo se notaría
 *    durante una caída del principal, justo cuando más falta hace.
 * 4. Un USDC_ADDRESS que no es el USDC con el que se desplegó el hub.
 *
 * Una incoherencia lanza `ConfiguracionIncorrecta`: fallar al arrancar, y decir
 * por qué, es mucho mejor que descubrirlo perdiendo un cobro. Que la cadena no
 * responda no es un error de configuración: devuelve `sin_respuesta` y quien
 * llama vuelve a intentarlo, sin salir del proceso (en Fly, una máquina que
 * sale una y otra vez agota sus reinicios y se queda parada).
 */
export async function preflight(
  clients: DaemonChainClients,
  config: Pick<
    Config,
    | 'chain'
    | 'baseRpcUrl'
    | 'baseRpcFallbackUrls'
    | 'operatorAddress'
    | 'nodeRegistryAddress'
    | 'usdcAddress'
  >,
  logger: FastifyBaseLogger,
  leerChainId: LeerChainId = leerChainIdReal,
): Promise<'ok' | 'sin_respuesta'> {
  const hub = clients.settlementHubAddress
  const chainId = CHAIN_IDS[config.chain]

  // ── 1. ¿Cada RPC sirve la red declarada? ──
  const urls = resolveRpcUrls(
    config.baseRpcUrl,
    config.baseRpcFallbackUrls,
    config.chain === 'base-sepolia',
  )
  for (const url of urls) {
    const visto = await leerChainId(url)
    if (visto === null) {
      // Una caída no es una mala configuración, y ya se ve en /health.
      logger.warn(
        { rpc: hostDe(url) },
        'RPC sin respuesta al arrancar — no se pudo comprobar su red',
      )
    } else if (visto !== chainId) {
      throw new ConfiguracionIncorrecta(
        `El RPC ${hostDe(url)} sirve la red ${visto}, no ${config.chain} (${chainId}). ` +
          'Revisa BASE_RPC_URL, BASE_RPC_FALLBACK_URLS y CHAIN.',
      )
    }
  }

  /// Lee de la cadena. Un veredicto («no hay contrato», «revierte») se convierte
  /// en ConfiguracionIncorrecta con `siNoHay`; que no responda, en SinRespuesta.
  const leer = async <T>(lectura: () => Promise<T>, siNoHay: string): Promise<T> => {
    try {
      return await lectura()
    } catch (err) {
      if (esVeredictoDeLaCadena(err)) throw new ConfiguracionIncorrecta(siNoHay)
      throw new SinRespuesta(err instanceof Error ? err.message : String(err))
    }
  }

  try {
    // ── 2. ¿El hub configurado es el que espera este código, en esta red? ──
    const noEsHub =
      `SETTLEMENT_HUB_ADDRESS (${hub}) no es un SettlementHub en ${config.chain}: es de ` +
      'un despliegue anterior o de otra red. Con esta configuración cada pago revertiría ' +
      'y se marcaría como rechazo permanente. Ojo: en Fly un secret con el mismo nombre ' +
      'GANA sobre [env] del toml, así que revisa también `fly secrets list`.'
    const intentSigner = (await leer(
      () =>
        clients.publicClient.readContract({
          address: hub,
          abi: SETTLEMENT_HUB_ABI,
          functionName: 'intentSigner',
        }),
      noEsHub,
    )) as Address

    // ── 3. ¿USDC_ADDRESS es el USDC del hub? ──
    const usdcDelHub = (await leer(
      () =>
        clients.publicClient.readContract({
          address: hub,
          abi: SETTLEMENT_HUB_ABI,
          functionName: 'usdc',
        }),
      noEsHub,
    )) as Address
    if (!isAddressEqual(usdcDelHub, config.usdcAddress as Address)) {
      throw new ConfiguracionIncorrecta(
        `USDC_ADDRESS (${config.usdcAddress}) no es el USDC del hub (${usdcDelHub}).`,
      )
    }

    // ── 4. ¿Estamos registrados y activos? ──
    const activo = await leer(
      () =>
        clients.publicClient.readContract({
          address: config.nodeRegistryAddress as Address,
          abi: NODE_REGISTRY_ABI,
          functionName: 'isActive',
          args: [config.operatorAddress as Address],
        }),
      `NODE_REGISTRY_ADDRESS (${config.nodeRegistryAddress}) no es un NodeRegistry en ${config.chain}.`,
    )
    if (!activo) {
      throw new ConfiguracionIncorrecta(
        `El operador ${config.operatorAddress} no está activo en el NodeRegistry ` +
          `${config.nodeRegistryAddress}. El stake NO viaja entre despliegues: vive en el ` +
          'almacenamiento del contrato, así que tras un redespliegue hay que repetir ' +
          'approve → deposit → register. La API rechazará cada petición con 403.',
      )
    }

    logger.info(
      {
        hub,
        intentSigner,
        usdc: usdcDelHub,
        operator: config.operatorAddress,
        chain: config.chain,
      },
      'Preflight OK',
    )
    return 'ok'
  } catch (err) {
    if (!(err instanceof SinRespuesta)) throw err
    logger.warn(
      { err: err.message },
      'La cadena no responde: el nodo espera a poder comprobar su configuración',
    )
    return 'sin_respuesta'
  }
}
