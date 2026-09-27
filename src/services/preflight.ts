import type { FastifyBaseLogger } from 'fastify'
import type { Address } from 'viem'
import type { DaemonChainClients } from '../lib/chain-client'
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

/**
 * Comprobaciones al arrancar, antes de aceptar trabajo.
 *
 * Existen porque dos fallos reales solo se manifestaron cuando un pago falló:
 *
 * 1. `SETTLEMENT_HUB_ADDRESS` apuntaba al contrato anterior. El ABI cambió con
 *    ADR-004, así que `registerIntent` revertía y el settler marcaba el pago
 *    como **rechazo permanente** — irrecuperable, hay que crear otro cobro.
 * 2. El nodeit no estaba registrado en el NodeRegistry nuevo (el stake no viaja
 *    entre despliegues), y la API le devolvía 403 en cada intento.
 *
 * En ambos casos `/health` decía `ok` y el daemon parecía sano. Fallar al
 * arrancar, y decir por qué, es mucho mejor que descubrirlo perdiendo un cobro.
 */
export async function preflight(
  clients: DaemonChainClients,
  operatorAddress: Address,
  nodeRegistryAddress: string,
  logger: FastifyBaseLogger,
): Promise<void> {
  const hub = clients.settlementHubAddress

  // ── 1. ¿El hub configurado es el que espera este código? ──
  let intentSigner: Address
  try {
    intentSigner = (await clients.publicClient.readContract({
      address: hub,
      abi: SETTLEMENT_HUB_ABI,
      functionName: 'intentSigner',
    })) as Address
  } catch (err) {
    logger.fatal(
      { hub, err: err instanceof Error ? err.message : String(err) },
      `SETTLEMENT_HUB_ADDRESS (${hub}) no responde a intentSigner(). ` +
        'Es una dirección de un despliegue anterior, o no es un SettlementHub. ' +
        'Con esta configuración cada pago revertiría y se marcaría como rechazo ' +
        'permanente. Ojo: en Fly un secret con el mismo nombre GANA sobre [env] ' +
        'del toml, así que revisa también `fly secrets list`.',
    )
    throw new Error(`SettlementHub inválido en ${hub}`)
  }

  // ── 2. ¿Estamos registrados y activos? ──
  if (nodeRegistryAddress !== '0x0000000000000000000000000000000000000000') {
    const activo = await clients.publicClient.readContract({
      address: nodeRegistryAddress as Address,
      abi: NODE_REGISTRY_ABI,
      functionName: 'isActive',
      args: [operatorAddress],
    })
    if (!activo) {
      logger.fatal(
        { operator: operatorAddress, registry: nodeRegistryAddress },
        `El operador ${operatorAddress} no está activo en el NodeRegistry ` +
          `${nodeRegistryAddress}. El stake NO viaja entre despliegues: vive en el ` +
          'almacenamiento del contrato, así que tras un redespliegue hay que repetir ' +
          'approve → deposit → register. La API rechazará cada petición con 403.',
      )
      throw new Error('Nodeit no registrado o inactivo on-chain')
    }
  }

  logger.info({ hub, intentSigner, operator: operatorAddress }, 'Preflight OK')
}
