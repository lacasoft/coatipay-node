// FeeClaimer — cobra la comisión del nodeit (ADR-009 §1).
//
// El hub ya no transfiere la comisión en cada pago: la acredita a nombre del
// operador (`accrued`), y se cobra con `claim()`. Así, si USDC bloquea al
// operador, sus pagos se siguen liquidando y la comisión espera en el hub; y en
// un lote, la del mismo operador se acumula en una sola escritura.
//
// Cada hora mira lo acreditado y, desde `feeClaimMinAmount`, lo cobra: una
// transacción (~60k de gas) por cada tanda, no una por pago. Sin ETH para el
// gas no lo intenta; el settler ya avisa de eso en /health.
//
// Un fallo (el RPC, o el operador en la lista negra de USDC) solo se anota: la
// comisión sigue acreditada y la siguiente vuelta lo vuelve a intentar. Nada se
// pierde por no cobrar a tiempo.
//
// Con TREASURY_CLAIM_MIN_AMOUNT, cada vuelta cobra también la comisión de la
// tesorería con `claimFor(tesorería)`: el hub solo la deja ir a la tesorería,
// así que este nodo no toca ese dinero; solo paga el gas. Apagado por defecto:
// es para el nodeit del equipo. Un cobro no frena al otro.
import type { FastifyBaseLogger } from 'fastify'
import type { Address } from 'viem'
import type { DaemonChainClients } from '../lib/chain-client'
import type { Config } from '../lib/config'
import { GAS_CRITICAL_WEI, GAS_WARNING_WEI } from '../lib/node-status'
import { SETTLEMENT_HUB_ABI } from '../lib/settlement-hub-abi'

const CADA_MS = 60 * 60 * 1000
/// La primera vuelta, poco después de arrancar: un nodo que se reinicia a
/// menudo también cobra.
const PRIMERA_MS = 2 * 60 * 1000

export interface FeeClaimerContext {
  config: Pick<Config, 'operatorAddress' | 'feeClaimMinAmount' | 'treasuryClaimMinAmount'>
  hubClients: DaemonChainClients
  logger: FastifyBaseLogger
}

export type ResultadoDelCobro =
  | { cobrado: bigint; tx: `0x${string}` }
  | { omitido: 'nada' | 'por_debajo_del_umbral' | 'sin_gas'; acreditado: bigint }

export type ResultadoDelCobroDeLaTesoreria =
  | { cobrado: bigint; tesoreria: Address; tx: `0x${string}` }
  | { omitido: 'apagado' }
  | { omitido: 'nada' | 'por_debajo_del_umbral' | 'sin_gas'; acreditado: bigint }

/// Una vuelta: mira lo acreditado y, si llega al umbral y hay gas, lo cobra.
/// Lanza si falla la lectura o la transacción.
export async function cobrarComision(ctx: FeeClaimerContext): Promise<ResultadoDelCobro> {
  const { publicClient, walletClient, account, settlementHubAddress } = ctx.hubClients
  const operador = ctx.config.operatorAddress as Address
  const acreditado = await publicClient.readContract({
    address: settlementHubAddress,
    abi: SETTLEMENT_HUB_ABI,
    functionName: 'accrued',
    args: [operador],
  })
  if (acreditado === 0n) return { omitido: 'nada', acreditado }
  if (acreditado < BigInt(ctx.config.feeClaimMinAmount)) {
    return { omitido: 'por_debajo_del_umbral', acreditado }
  }
  const saldo = await publicClient.getBalance({ address: operador })
  if (saldo < GAS_CRITICAL_WEI) return { omitido: 'sin_gas', acreditado }

  // Se simula antes: una reversión (el operador en la lista negra) no cuesta gas.
  const { request } = await publicClient.simulateContract({
    address: settlementHubAddress,
    abi: SETTLEMENT_HUB_ABI,
    functionName: 'claim',
    account,
  })
  const tx = await walletClient.writeContract({ ...request, chain: null })
  const recibo = await publicClient.waitForTransactionReceipt({ hash: tx })
  if (recibo.status !== 'success') throw new Error(`claim_reverted: ${tx}`)
  return { cobrado: acreditado, tx }
}

/// Una vuelta para la tesorería: si `treasuryClaimMinAmount` está definido y lo
/// acreditado llega, lo lleva a la tesorería con `claimFor`. El gas es de este
/// nodo y es para otro, así que pide más margen que el cobro propio: no lo
/// intenta por debajo del umbral de aviso de gas, para no quitarle ETH a las
/// liquidaciones. Lanza si falla la lectura o la transacción.
export async function cobrarTesoreria(
  ctx: FeeClaimerContext,
): Promise<ResultadoDelCobroDeLaTesoreria> {
  const umbral = ctx.config.treasuryClaimMinAmount
  if (umbral === undefined) return { omitido: 'apagado' }
  const { publicClient, walletClient, account, settlementHubAddress } = ctx.hubClients
  const tesoreria = await publicClient.readContract({
    address: settlementHubAddress,
    abi: SETTLEMENT_HUB_ABI,
    functionName: 'treasury',
  })
  const acreditado = await publicClient.readContract({
    address: settlementHubAddress,
    abi: SETTLEMENT_HUB_ABI,
    functionName: 'accrued',
    args: [tesoreria],
  })
  if (acreditado === 0n) return { omitido: 'nada', acreditado }
  if (acreditado < BigInt(umbral)) return { omitido: 'por_debajo_del_umbral', acreditado }
  const saldo = await publicClient.getBalance({ address: ctx.config.operatorAddress as Address })
  if (saldo < GAS_WARNING_WEI) return { omitido: 'sin_gas', acreditado }

  // Se simula antes: una reversión (la tesorería en la lista negra) no cuesta gas.
  const { request } = await publicClient.simulateContract({
    address: settlementHubAddress,
    abi: SETTLEMENT_HUB_ABI,
    functionName: 'claimFor',
    args: [tesoreria],
    account,
  })
  const tx = await walletClient.writeContract({ ...request, chain: null })
  const recibo = await publicClient.waitForTransactionReceipt({ hash: tx })
  if (recibo.status !== 'success') throw new Error(`claimFor_reverted: ${tx}`)
  return { cobrado: acreditado, tesoreria, tx }
}

/// Arranca las vueltas. Devuelve la función para pararlas.
export function startFeeClaimer(ctx: FeeClaimerContext): () => void {
  const deLaTesoreria = async () => {
    try {
      const r = await cobrarTesoreria(ctx)
      if ('cobrado' in r) {
        ctx.logger.info(
          { cobrado: r.cobrado.toString(), tesoreria: r.tesoreria, tx_hash: r.tx },
          '[tesorería] Llevada a la tesorería su comisión acreditada en el hub',
        )
      } else if (r.omitido === 'sin_gas') {
        ctx.logger.warn(
          { acreditado: r.acreditado.toString() },
          '[tesorería] Poco ETH para pagar el gas de otro: la comisión de la tesorería queda acreditada',
        )
      }
    } catch (err) {
      ctx.logger.warn(
        { err: err instanceof Error ? err.message.slice(0, 300) : String(err) },
        '[tesorería] No se pudo cobrar: queda acreditada y se reintenta en la próxima vuelta',
      )
    }
  }
  const vuelta = async () => {
    await deLaTesoreria()
    try {
      const r = await cobrarComision(ctx)
      if ('cobrado' in r) {
        ctx.logger.info(
          { cobrado: r.cobrado.toString(), tx_hash: r.tx },
          '[comisión] Cobrada la comisión acreditada en el hub',
        )
      } else if (r.omitido === 'sin_gas') {
        ctx.logger.warn(
          { acreditado: r.acreditado.toString() },
          '[comisión] Sin ETH para el gas del cobro: queda acreditada',
        )
      }
    } catch (err) {
      ctx.logger.warn(
        { err: err instanceof Error ? err.message.slice(0, 300) : String(err) },
        '[comisión] No se pudo cobrar: queda acreditada y se reintenta en la próxima vuelta',
      )
    }
  }
  const primera = setTimeout(vuelta, PRIMERA_MS)
  const intervalo = setInterval(vuelta, CADA_MS)
  return () => {
    clearTimeout(primera)
    clearInterval(intervalo)
  }
}
