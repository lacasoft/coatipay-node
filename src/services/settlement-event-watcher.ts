// SettlementEventWatcher — read path / source of truth of ADR-003 Phase B4.
//
// Subscribes to `IntentSettled` events emitted by the SettlementHub. When
// an event arrives, calls API /v1/internal/settlements/by-on-chain-id
// which atomically updates the payment_intent + pending_authorization
// rows AND fires the merchant webhook.
//
// Why this is the source of truth (and not the daemon's own callback):
//   - Daemon may crash between submitting the tx and reporting back —
//     the chain has the truth, not our process state.
//   - API may be unreachable when daemon tries to report — same problem.
//   - Multiple daemons may submit the same authorization concurrently
//     (only one wins on-chain due to nonce burn) — only the chain knows
//     which won.
//   - Reorgs (theoretical on Base, but defensive) — the watcher
//     re-receives the canonical event after re-org.
//
// Reliability:
//   - Chunked polling (NOT viem's watchContractEvent). The watcher scans
//     `eth_getLogs` in bounded windows (`eventMaxBlockRange`, default 9)
//     and only advances its cursor AFTER a window is processed. This is
//     what makes it recover from falling behind: viem's watchContractEvent
//     requests the whole last-block→head range in one getLogs call, which
//     exceeds free-tier provider caps (Alchemy: 10 blocks) the moment the
//     daemon is >N blocks behind — then it never advances and the range
//     only grows (a death spiral observed in production).
//   - The API endpoint is idempotent (returns 200 + already_settled on
//     duplicate), so re-scanning a window after a transient failure is safe.
//   - If the API returns 404 (intent_not_found), the watcher logs + skips
//     that one event — likely a race where /intents/:id/registered hasn't
//     landed yet; the cursor still advances and a later re-scan is not
//     needed because the event is re-emitted only once (the daemon's own
//     /registered call lands shortly after).
import type { FastifyBaseLogger } from 'fastify'
import type { Address, Hex } from 'viem'
import { type DaemonChainClients, isDevChainConfig } from '../lib/chain-client'
import type { Config } from '../lib/config'
import { type InternalApiClient, InternalApiError } from '../lib/internal-api-client'
import { markWatcherTick, recordRpcError } from '../lib/node-status'
import { SETTLEMENT_HUB_ABI } from '../lib/settlement-hub-abi'

interface WatcherContext {
  config: Config
  hubClients: DaemonChainClients
  api: InternalApiClient
  logger: FastifyBaseLogger
}

/**
 * Start watching IntentSettled events via chunked polling. Returns a stop
 * function. In dev mode (no SettlementHub configured), it is a no-op.
 */
export function startSettlementEventWatcher(
  ctx: Omit<WatcherContext, 'hubClients'> & { hubClients: DaemonChainClients | null },
): () => void {
  if (!ctx.hubClients || isDevChainConfig(ctx.config.settlementHubAddress)) {
    ctx.logger.warn('[event-watcher] Disabled — SETTLEMENT_HUB_ADDRESS not configured')
    return () => {}
  }

  const fullCtx: WatcherContext = { ...ctx, hubClients: ctx.hubClients }
  const maxRange = BigInt(ctx.config.eventMaxBlockRange)
  const lookback = BigInt(ctx.config.eventLookbackBlocks)
  const pollMs = ctx.config.eventPollIntervalMs

  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null
  // Next block to scan from. null until the first poll resolves head.
  let cursor: bigint | null = null

  async function pollOnce(): Promise<void> {
    const head = await fullCtx.hubClients.publicClient.getBlockNumber()
    // Local `from` is always a bigint (resolved from the cursor or the
    // first-boot lookback) — keeps it out of the `bigint | null` union.
    let from = cursor ?? (head > lookback ? head - lookback : 0n)
    // Walk forward in windows of at most `maxRange` blocks. Advance the
    // cursor only after a window's logs are handled, so a mid-window
    // failure re-scans that window (idempotent) instead of skipping it.
    while (from <= head && !stopped) {
      const toBlock = from + maxRange - 1n < head ? from + maxRange - 1n : head
      const logs = await fullCtx.hubClients.publicClient.getContractEvents({
        address: fullCtx.hubClients.settlementHubAddress,
        abi: SETTLEMENT_HUB_ABI,
        eventName: 'IntentSettled',
        fromBlock: from,
        toBlock,
      })
      for (const log of logs) {
        const args = (log as { args: IntentSettledArgs }).args
        const txHash = (log as { transactionHash: Hex }).transactionHash
        await handleSettlementEvent(fullCtx, {
          intentId: args.intentId,
          payer: args.payer,
          merchantAmount: args.merchantAmount,
          operatorFee: args.operatorFee,
          treasuryFee: args.treasuryFee,
          txHash,
        })
      }
      from = toBlock + 1n
      cursor = from // persist progress so the next poll resumes here
    }
  }

  async function tick(): Promise<void> {
    timer = null
    if (stopped) return
    try {
      await pollOnce()
      markWatcherTick(true)
    } catch (err) {
      // Transport blip, provider hiccup, or an API error other than 404.
      // Cursor is NOT advanced past the failed window, so the next tick
      // re-scans it. Re-delivery is safe (the API is idempotent).
      // Feeds /health: watcher → `lagging`, rpc → `down`.
      markWatcherTick(false)
      recordRpcError()
      fullCtx.logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        '[event-watcher] poll error — will retry next tick',
      )
    }
    if (!stopped) timer = setTimeout(tick, pollMs)
  }

  // First poll immediately so a settlement that landed during startup is
  // picked up without waiting a full interval.
  timer = setTimeout(tick, 0)

  ctx.logger.info(
    {
      hub: ctx.config.settlementHubAddress,
      operator: ctx.config.operatorAddress,
      max_block_range: ctx.config.eventMaxBlockRange,
      poll_interval_ms: pollMs,
    },
    '[event-watcher] Watching IntentSettled events (chunked polling)',
  )

  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
  }
}

interface IntentSettledArgs {
  intentId: Hex
  payer: Address
  merchantAmount: bigint
  operatorFee: bigint
  treasuryFee: bigint
}

interface HandlerInput {
  intentId: Hex
  payer: Address
  merchantAmount: bigint
  operatorFee: bigint
  treasuryFee: bigint
  txHash: Hex
}

async function handleSettlementEvent(ctx: WatcherContext, evt: HandlerInput): Promise<void> {
  ctx.logger.info(
    {
      on_chain_id: evt.intentId,
      tx_hash: evt.txHash,
      payer: evt.payer,
      merchant_amount: evt.merchantAmount.toString(),
    },
    '[event-watcher] IntentSettled received',
  )

  try {
    const result = await ctx.api.post<{ ok: boolean; applied: boolean; already_settled?: boolean }>(
      '/v1/internal/settlements/by-on-chain-id',
      {
        on_chain_id: evt.intentId,
        tx_hash: evt.txHash,
        payer_address: evt.payer,
        settled_at: Math.floor(Date.now() / 1000),
      },
    )

    if (result?.already_settled) {
      ctx.logger.debug(
        { on_chain_id: evt.intentId, tx_hash: evt.txHash },
        '[event-watcher] already settled (idempotent re-delivery)',
      )
    }
  } catch (err) {
    if (err instanceof InternalApiError && err.status === 404) {
      // Race: /intents/:id/registered hasn't landed yet. Don't alarm —
      // the event watcher's natural re-subscribe will redeliver.
      ctx.logger.warn(
        { on_chain_id: evt.intentId },
        '[event-watcher] intent not found in DB yet (race with /registered) — will retry on redelivery',
      )
      return
    }
    throw err
  }
}
