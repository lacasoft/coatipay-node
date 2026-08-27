// AuthorizationSettler — write path of ADR-003 Phase B4.
//
// Polls the API's queue of ERC-3009 authorizations and submits them
// on-chain via SettlementHub.payIntentWithAuthorization. Lazy-registers
// intents on the way (only intents with at least one authorization end
// up on-chain — saves gas on cancelled/expired intents).
//
// Lifecycle of one cycle:
//   1. Claim next queued authorization (atomic via API; receives auth
//      fields + intent fields in one round-trip).
//   2. If intent.on_chain_id is null → lazy register:
//      - Call SettlementHub.getIntent(idBytes32) (cheap view, double-check
//        not registered by a concurrent worker).
//      - If still not registered, call registerIntent on-chain.
//      - Wait for receipt.
//      - Call API /intents/:id/registered to persist on_chain_id.
//   3. Submit payIntentWithAuthorization.
//   4. Exit cycle — DO NOT call back to mark settled. The
//      SettlementEventWatcher catches the IntentSettled event and is the
//      source of truth for settlement state + webhooks.
//
// On failure: permanent errors (contract revert — bad signature, nonce
// reused, intent not payable) → call API /authorizations/:id/rejected; the
// payer must re-sign. Transient errors (RPC/network blip, replica lag) →
// leave the row `claimed`; the API sweeper re-queues it for a later retry,
// bounded by the authorization's validBefore.
//
// Concurrency: single worker per daemon. The API's claimNextPending uses
// `FOR UPDATE SKIP LOCKED` so multiple daemons can run safely.
//
// ETH balance: checked before each cycle. Below threshold → skip + log
// warning. Operator must top up.
import { MAX_BATCH_SIZE } from '@lacasoft/coatipay-protocol'
import type { FastifyBaseLogger } from 'fastify'
import {
  type Address,
  BaseError,
  ContractFunctionExecutionError,
  decodeAbiParameters,
  formatEther,
  type Hex,
  parseEventLogs,
} from 'viem'
import { type DaemonChainClients, isDevChainConfig } from '../lib/chain-client'
import type { Config } from '../lib/config'
import { type InternalApiClient, InternalApiError } from '../lib/internal-api-client'
import {
  GAS_CRITICAL_WEI,
  markSettlerTick,
  recordBalance,
  recordRpcError,
} from '../lib/node-status'
import { intentIdToBytes32, SETTLEMENT_HUB_ABI, ZERO_ADDRESS } from '../lib/settlement-hub-abi'

/// Base poll interval. Used while the queue has work — every cycle finds
/// something to settle. When the queue goes empty, the next-tick delay
/// backs off geometrically up to POLL_INTERVAL_MAX_MS so we stop
/// hammering the API and RPC with no-op cycles.
const POLL_INTERVAL_MS = 5_000
/// Cap on the backoff. 60s is the longest acceptable wait before we
/// notice the queue has work again — a merchant who just submitted an
/// authorization shouldn't wait more than this for first settlement attempt.
const POLL_INTERVAL_MAX_MS = 60_000
/// Multiplier per empty cycle. 5s → 10s → 20s → 40s → 60s (capped).
/// 5 doublings to reach max.
const BACKOFF_MULTIPLIER = 2

// Below this ETH balance the settler logs a warning and skips its cycle
// (~5 settlements at Base mainnet baseline). SSOT lives in lib/node-status
// (`GAS_CRITICAL_WEI`) so the skip threshold and the /health gas gauge
// boundary can never drift apart.

interface SettlerContext {
  config: Config
  hubClients: DaemonChainClients
  api: InternalApiClient
  logger: FastifyBaseLogger
}

interface ClaimResponse {
  authorization: {
    id: string
    intent_id: string
    payer_address: Address
    valid_after: string
    valid_before: string
    nonce: Hex
    signature: Hex
  }
  intent: {
    intent_id: string
    merchant_address: Address
    amount: string
    expires_at: string
    on_chain_id: Hex | null
  }
}

/**
 * Start the polling loop. Returns a stop function for graceful shutdown.
 * In dev mode (no SettlementHub configured), the settler is a no-op.
 */
export function startAuthorizationSettler(
  ctx: Omit<SettlerContext, 'hubClients'> & { hubClients: DaemonChainClients | null },
): () => void {
  if (!ctx.hubClients || isDevChainConfig(ctx.config.settlementHubAddress)) {
    ctx.logger.warn(
      '[settler] Authorization settler disabled — SETTLEMENT_HUB_ADDRESS not configured',
    )
    return () => {}
  }

  const fullCtx: SettlerContext = { ...ctx, hubClients: ctx.hubClients }

  // Scheduling: chained setTimeout instead of setInterval. Two reasons:
  //   1. Overlap is structurally impossible — the next tick is only
  //      scheduled AFTER runOnce completes. Eliminates the nonce-collision
  //      race that the prior `running` guard worked around. Even a hung
  //      runOnce produces no overlap (no next tick scheduled).
  //   2. Lets each tick decide its own next-delay. When the queue has
  //      work we stay at POLL_INTERVAL_MS for low latency; when it's
  //      empty we back off geometrically so an idle settler doesn't
  //      hammer the API/RPC every 5s for no reason.
  let stopped = false
  let delayMs = POLL_INTERVAL_MS
  let pendingTimer: ReturnType<typeof setTimeout> | null = null

  const tick = async (): Promise<void> => {
    pendingTimer = null
    if (stopped) return
    try {
      const hadWork = await runOnce(fullCtx)
      delayMs = hadWork
        ? POLL_INTERVAL_MS
        : Math.min(delayMs * BACKOFF_MULTIPLIER, POLL_INTERVAL_MAX_MS)
    } catch (err) {
      ctx.logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        '[settler] tick failed',
      )
      // Don't adjust delay on transient errors — retry at the same cadence.
    }
    // Record loop liveness (success OR caught error — the loop is cycling).
    // A hung runOnce never reaches here, so /health reports `stalled`.
    markSettlerTick()
    if (!stopped) {
      pendingTimer = setTimeout(tick, delayMs)
    }
  }

  // First tick at +POLL_INTERVAL_MS — matches the original setInterval cadence.
  pendingTimer = setTimeout(tick, POLL_INTERVAL_MS)

  ctx.logger.info(
    {
      hub: ctx.config.settlementHubAddress,
      poll_interval_ms: POLL_INTERVAL_MS,
      poll_interval_max_ms: POLL_INTERVAL_MAX_MS,
      operator: ctx.config.operatorAddress,
    },
    '[settler] Authorization settler started',
  )

  return () => {
    stopped = true
    if (pendingTimer) clearTimeout(pendingTimer)
  }
}

/// Classifies a settlement error as permanent or transient.
///   - Permanent: the authorization cannot succeed (contract revert) —
///     reject it so the payer learns to re-sign.
///   - Transient: an RPC/network blip — leave the row `claimed` so the API
///     sweeper re-queues it for retry (bounded by the auth's validBefore).
/// Conservative default: an unrecognized error is treated as transient —
/// better to retry than to permanently kill a valid authorization.
function isPermanentError(err: unknown): boolean {
  // Our own signal: the tx mined and reverted (see registerIntent /
  // submitPayment). Retrying the same authorization is futile.
  if (err instanceof Error && err.message.includes('_reverted:')) return true
  // A contract revert surfaced at gas-estimation (eth_call) means the tx
  // would revert on-chain — permanent. Any other BaseError (HTTP, timeout,
  // RPC transport) is transient.
  if (err instanceof BaseError) {
    return err.walk((e) => e instanceof ContractFunctionExecutionError) !== null
  }
  return false
}

/// API claim-batch response — a wrapper around an array of claimed
/// authorizations (the same shape `ClaimResponse` describes for a single
/// claim). The array is empty when the queue is empty.
interface ClaimBatchResponse {
  authorizations: ClaimResponse[]
}

/// Returns `true` when this cycle did real work (settled at least one
/// authorization), `false` when it was a no-op (empty queue or skipped
/// due to low ETH balance). The scheduling loop uses this signal to
/// reset / advance the backoff delay.
async function runOnce(ctx: SettlerContext): Promise<boolean> {
  // ── 1. ETH balance pre-flight ────────────────────────────────────
  // Also feeds the /health gas gauge (recordBalance) and the RPC signal
  // (recordRpcError on a read failure). Rethrow preserves the existing
  // tick-level error handling.
  let balance: bigint
  try {
    balance = await ctx.hubClients.publicClient.getBalance({
      address: ctx.config.operatorAddress as Address,
    })
    recordBalance(balance)
  } catch (err) {
    recordRpcError()
    throw err
  }
  if (balance < GAS_CRITICAL_WEI) {
    ctx.logger.warn(
      { balance_eth: formatEther(balance) },
      '[settler] ETH balance below warn threshold — skipping cycle, top up operator wallet',
    )
    // Treat as no-work: back off so a stuck operator wallet doesn't
    // burn an RPC + API call every 5 seconds while waiting for a top-up.
    return false
  }

  // ── 2. Greedy per-cycle claim: pull up to MAX_BATCH_SIZE at once ──
  const result = await ctx.api.post<ClaimBatchResponse>('/v1/internal/authorizations/claim-batch', {
    max: MAX_BATCH_SIZE,
  })
  const claimedList = result?.authorizations ?? []

  // ── 3. Empty queue — nothing to do ───────────────────────────────
  if (claimedList.length === 0) return false

  // ── 4. Economic guard: never settle a payment whose value can't cover
  //      its gas share. Sub-economic auths are held (gas spike → retry when
  //      gas drops) or rejected near expiry. ──────────────────────────
  const toSettle = await applyEconomicGuard(ctx, claimedList)
  if (toSettle.length === 0) return true // worked (held/rejected), nothing to settle

  // ── 5. Single claim → preserve the existing single-settle path ──
  if (toSettle.length === 1) {
    const claimed = toSettle[0]
    if (claimed) await settleSingle(ctx, claimed)
    return true
  }

  // ── 6. Multiple claims → batch-settle path ──────────────────────
  await settleBatch(ctx, toSettle)
  return true
}

/// Gas-scaled economic floor: the node pays gas (ETH) but only keeps
/// OPERATOR_SHARE_BPS of the fee (USDC), so tiny payments settle at a loss.
/// The operator calibrates `minPaymentAmount` (USDC) at `gasPriceRefGwei`; we
/// scale it by the LIVE gas price so the floor rises with gas:
///   effectiveMin = minPaymentAmount × max(1, gasPriceLive / gasPriceRef)
/// (The ETH/USD rate is baked into minPaymentAmount — a Chainlink feed is the
/// future upgrade.) Returns only the auths worth settling now; holds the rest
/// (left `claimed` → sweeper re-queues) or rejects them if near expiry.
async function applyEconomicGuard(
  ctx: SettlerContext,
  claimed: ClaimResponse[],
): Promise<ClaimResponse[]> {
  if (ctx.config.minPaymentAmount <= 0) return claimed // floor disabled

  let gasPriceWei: bigint
  try {
    gasPriceWei = await ctx.hubClients.publicClient.getGasPrice()
  } catch {
    // Can't read gas — fail OPEN (don't block settlement on an RPC blip).
    return claimed
  }

  const refWei = ctx.config.gasPriceRefGwei * 1e9
  const scale = refWei > 0 ? Math.max(1, Number(gasPriceWei) / refWei) : 1
  const effectiveMin = Math.ceil(ctx.config.minPaymentAmount * scale)

  const now = Math.floor(Date.now() / 1000)
  const toSettle: ClaimResponse[] = []

  for (const c of claimed) {
    if (Number(c.intent.amount) >= effectiveMin) {
      toSettle.push(c)
      continue
    }
    // Sub-economic at the current gas price.
    const validBefore = Number(c.authorization.valid_before)
    if (validBefore - now <= ctx.config.settleExpiryBufferSeconds) {
      // Won't become profitable before it expires → reject (discard).
      await rejectAuthorization(
        ctx,
        c.authorization.id,
        `uneconomical: amount ${c.intent.amount} < effective min ${effectiveMin} (gas ${gasPriceWei} wei) near expiry`,
      )
      ctx.logger.warn(
        { auth_id: c.authorization.id, amount: c.intent.amount, effective_min: effectiveMin },
        '[settler] Rejected uneconomical authorization near expiry',
      )
    } else {
      // Gas spike: hold (leave claimed). The sweeper re-queues it; a later
      // cycle retries when gas drops, bounded by validBefore.
      ctx.logger.info(
        { auth_id: c.authorization.id, amount: c.intent.amount, effective_min: effectiveMin },
        '[settler] Holding sub-economic authorization — retry when gas drops',
      )
    }
  }

  if (toSettle.length < claimed.length) {
    ctx.logger.info(
      { claimed: claimed.length, settling: toSettle.length, effective_min: effectiveMin },
      '[settler] Economic guard filtered the batch',
    )
  }
  return toSettle
}

/// POST the API rejection for an authorization. Centralizes the call used by
/// the economic guard and batch reconciliation.
async function rejectAuthorization(
  ctx: SettlerContext,
  authId: string,
  reason: string,
): Promise<void> {
  try {
    await ctx.api.post(`/v1/internal/authorizations/${authId}/rejected`, {
      reason: reason.slice(0, 200),
    })
  } catch (err) {
    ctx.logger.error(
      { auth_id: authId, report_error: err instanceof Error ? err.message : String(err) },
      '[settler] Could not report rejection — sweeper will release the claim',
    )
  }
}

/// Single-authorization settle path — the original per-tx flow. Lazy
/// registers the intent, submits payIntentWithAuthorization, and on
/// failure distinguishes permanent (reject) from transient (leave
/// claimed for the sweeper) errors. Behaviour is unchanged from the
/// pre-batch implementation.
async function settleSingle(ctx: SettlerContext, claimed: ClaimResponse): Promise<void> {
  const authId = claimed.authorization.id
  const intentId = claimed.intent.intent_id

  ctx.logger.info({ auth_id: authId, intent_id: intentId }, '[settler] Claimed authorization')

  try {
    // ── Lazy registerIntent if needed ─────────────────────────────
    const onChainId = await ensureIntentRegistered(ctx, claimed)

    // ── Submit payIntentWithAuthorization ─────────────────────────
    await submitPayment(ctx, claimed, onChainId)

    ctx.logger.info(
      { auth_id: authId, intent_id: intentId, on_chain_id: onChainId },
      '[settler] Submitted on-chain — awaiting IntentSettled event for state update',
    )
    // Note: we DO NOT call API to mark settled. The SettlementEventWatcher
    // catches the on-chain event and is the source of truth.
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'unknown'

    if (!isPermanentError(err)) {
      // Transient failure (RPC/network blip, replica lag). Do NOT reject —
      // leave the row `claimed`; the API sweeper re-queues it after the
      // claim timeout and a later cycle retries. Retries are bounded by the
      // authorization's validBefore — once past, the sweeper expires it.
      ctx.logger.warn(
        { auth_id: authId, intent_id: intentId, reason: reason.slice(0, 300) },
        '[settler] Transient failure — leaving claimed for sweeper re-drive',
      )
      return
    }

    // Permanent failure — the authorization cannot succeed. Reject it.
    try {
      await ctx.api.post(`/v1/internal/authorizations/${authId}/rejected`, {
        reason: reason.slice(0, 200),
      })
    } catch (reportErr) {
      // If even the rejection report fails, the sweeper will eventually
      // recover the row (claim timeout) — log so we have a trail.
      ctx.logger.error(
        {
          auth_id: authId,
          original_error: reason.slice(0, 300),
          report_error: reportErr instanceof Error ? reportErr.message : String(reportErr),
        },
        '[settler] Could not report rejection — sweeper will release the claim',
      )
      return
    }
    ctx.logger.error(
      { auth_id: authId, intent_id: intentId, reason: reason.slice(0, 500) },
      '[settler] Submission failed (permanent) → marked rejected',
    )
  }
}

/// Batch-settle path — registers any not-yet-on-chain intents in one
/// registerIntentBatch tx, then settles every authorization in one
/// payIntentBatchWithAuthorization tx. Gas amortization for x402
/// micropayments.
///
/// Error policy (per the batch design): the batch path does NOT reject
/// authorizations individually. On ANY failure we log and return,
/// leaving every row `claimed`. The API sweeper re-queues them after the
/// claim timeout; retries are bounded by each authorization's
/// validBefore. Individual rejection inside a batch is a future
/// refinement, out of scope here.
async function settleBatch(ctx: SettlerContext, claimedList: ClaimResponse[]): Promise<void> {
  ctx.logger.info({ count: claimedList.length }, '[settler] Claimed authorization batch')

  try {
    // ── Register intents not yet on-chain (single batch tx) ───────
    const needRegister = claimedList.filter((c) => c.intent.on_chain_id == null)

    if (needRegister.length > 0) {
      const intentIds = needRegister.map((c) => intentIdToBytes32(c.intent.intent_id))
      const merchants = needRegister.map((c) => c.intent.merchant_address)
      const operators = needRegister.map(() => ctx.config.operatorAddress as Address)
      const amounts = needRegister.map((c) => BigInt(c.intent.amount))
      const expirations = needRegister.map((c) => BigInt(c.intent.expires_at))

      const regTxHash = await ctx.hubClients.walletClient.writeContract({
        address: ctx.hubClients.settlementHubAddress,
        abi: SETTLEMENT_HUB_ABI,
        functionName: 'registerIntentBatch',
        args: [intentIds, merchants, operators, amounts, expirations],
        account: ctx.hubClients.account,
        chain: null,
      })

      const regReceipt = await ctx.hubClients.publicClient.waitForTransactionReceipt({
        hash: regTxHash,
      })
      if (regReceipt.status !== 'success') {
        throw new Error(`registerIntentBatch_reverted: ${regTxHash}`)
      }

      // All intents registered in the same tx/block — waiting for one to
      // be visible on the read path is enough to guard the read-after-write
      // gap before payIntentBatchWithAuthorization estimates gas.
      const firstOnChainId = intentIds[0]
      if (firstOnChainId) await waitForIntentVisible(ctx, firstOnChainId)

      // Persist on_chain_id for each — idempotent (API returns applied=false
      // on race with another worker).
      for (let i = 0; i < needRegister.length; i++) {
        const claimed = needRegister[i]
        const onChainId = intentIds[i]
        if (claimed && onChainId) {
          await persistOnChainIdSafe(ctx, claimed.intent.intent_id, onChainId)
        }
      }

      ctx.logger.info(
        { count: needRegister.length, tx_hash: regTxHash },
        '[settler] registerIntentBatch confirmed',
      )
    }

    // ── Settle every authorization in one batch tx ────────────────
    // Resolve signatures sequentially: a counterfactual (ERC-6492) auth needs a
    // wallet-deploy tx first, and serial sends avoid nonce races on the operator.
    const auths = []
    for (const c of claimedList) {
      const signature = await resolveSettlementSignature(
        ctx,
        c.authorization.payer_address,
        c.authorization.signature,
      )
      auths.push({
        intentId: intentIdToBytes32(c.intent.intent_id),
        payer: c.authorization.payer_address,
        validAfter: BigInt(c.authorization.valid_after),
        validBefore: BigInt(c.authorization.valid_before),
        nonce: c.authorization.nonce,
        signature,
      })
    }

    const payTxHash = await ctx.hubClients.walletClient.writeContract({
      address: ctx.hubClients.settlementHubAddress,
      abi: SETTLEMENT_HUB_ABI,
      functionName: 'payIntentBatchWithAuthorization',
      args: [auths],
      account: ctx.hubClients.account,
      chain: null,
    })

    const payReceipt = await ctx.hubClients.publicClient.waitForTransactionReceipt({
      hash: payTxHash,
    })
    if (payReceipt.status !== 'success') {
      throw new Error(`payIntentBatchWithAuthorization_reverted: ${payTxHash}`)
    }

    ctx.logger.info(
      { count: claimedList.length, tx_hash: payTxHash },
      `[settler] Batch submitted on-chain — ${claimedList.length} authorizations`,
    )

    // Reconcile: the batch is skip-on-failure, so some auths may have been
    // skipped on-chain. Reject the permanently-bad ones (expired / nonce
    // already used) so they don't churn until expiry; leave transient ones
    // claimed for the sweeper to re-drive. (Settled ones: the event-watcher
    // is the source of truth for state — we don't mark them here.)
    await reconcileBatchOutcome(ctx, claimedList, payReceipt)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    // Batch design: no individual rejection. Leave every row `claimed` —
    // the API sweeper re-queues them; retries are bounded by validBefore.
    ctx.logger.warn(
      { count: claimedList.length, reason: reason.slice(0, 300) },
      '[settler] Batch settle failed — leaving claims for sweeper re-drive',
    )
  }
}

/// USDC EIP-3009 nonce-consumption check — used in batch reconciliation to tell
/// "already settled elsewhere" apart from a transient skip.
const USDC_AUTH_STATE_ABI = [
  {
    type: 'function',
    name: 'authorizationState',
    stateMutability: 'view',
    inputs: [
      { name: 'authorizer', type: 'address' },
      { name: 'nonce', type: 'bytes32' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const

/// After a (skip-on-failure) batch tx, figure out which authorizations were
/// skipped on-chain and act on each — read-only classification, NO re-simulation
/// (which could trigger a counterfactual-wallet deploy):
///   - settled (IntentSettled emitted)  → nothing (event-watcher owns state)
///   - expired                          → reject (permanent)
///   - nonce already consumed on-chain  → reject (settled via another tx)
///   - otherwise                        → leave claimed (transient → sweeper retries)
async function reconcileBatchOutcome(
  ctx: SettlerContext,
  claimed: ClaimResponse[],
  receipt: { logs: readonly unknown[] },
): Promise<void> {
  let settledIds: Set<string>
  try {
    const logs = parseEventLogs({
      abi: SETTLEMENT_HUB_ABI,
      eventName: 'IntentSettled',
      // biome-ignore lint/suspicious/noExplicitAny: viem log[] vs readonly unknown[]
      logs: receipt.logs as any,
    })
    settledIds = new Set(logs.map((l) => (l.args as { intentId: Hex }).intentId.toLowerCase()))
  } catch {
    // Can't parse logs — rely on the event-watcher + sweeper as before.
    return
  }

  const now = Math.floor(Date.now() / 1000)
  for (const c of claimed) {
    const onChainId = intentIdToBytes32(c.intent.intent_id).toLowerCase()
    if (settledIds.has(onChainId)) continue // settled — event-watcher confirms

    // Skipped on-chain. Classify cheaply (reads only).
    if (Number(c.authorization.valid_before) <= now) {
      await rejectAuthorization(ctx, c.authorization.id, 'expired (skipped in batch)')
      ctx.logger.warn(
        { auth_id: c.authorization.id, intent_id: c.intent.intent_id },
        '[settler] Batch-skipped authorization expired → rejected',
      )
      continue
    }

    let nonceUsed = false
    try {
      nonceUsed = (await ctx.hubClients.publicClient.readContract({
        address: ctx.config.usdcAddress as Address,
        abi: USDC_AUTH_STATE_ABI,
        functionName: 'authorizationState',
        args: [c.authorization.payer_address, c.authorization.nonce],
      })) as boolean
    } catch {
      // Read failed — treat as transient (leave claimed for retry).
    }

    if (nonceUsed) {
      await rejectAuthorization(ctx, c.authorization.id, 'nonce already used (settled elsewhere)')
      ctx.logger.warn(
        { auth_id: c.authorization.id, intent_id: c.intent.intent_id },
        '[settler] Batch-skipped authorization nonce already used → rejected',
      )
    } else {
      ctx.logger.warn(
        { auth_id: c.authorization.id, intent_id: c.intent.intent_id },
        '[settler] Batch-skipped authorization — leaving claimed for sweeper re-drive',
      )
    }
  }
}

/// Ensures the intent is registered on-chain. Returns the bytes32 id used.
/// Three paths:
///   - Already in API DB (on_chain_id != null): just compute and verify
///     locally; nothing to do on-chain.
///   - In API DB but on-chain check shows it's not registered → register.
///   - Not in API DB, also not on-chain → register + persist via API.
///
/// The on-chain getIntent check is a defensive read even when on_chain_id
/// is set, to handle the edge case where the DB says "registered" but the
/// chain was reorged (rare; ~impossible on Base with 1-block finality
/// but cheap to defend against).
async function ensureIntentRegistered(ctx: SettlerContext, claimed: ClaimResponse): Promise<Hex> {
  const onChainId = intentIdToBytes32(claimed.intent.intent_id)

  // Check chain state (view call, no gas)
  const existing = await ctx.hubClients.publicClient.readContract({
    address: ctx.hubClients.settlementHubAddress,
    abi: SETTLEMENT_HUB_ABI,
    functionName: 'getIntent',
    args: [onChainId],
  })

  if ((existing as { merchant: string }).merchant !== ZERO_ADDRESS) {
    // Already on-chain. If DB doesn't know, persist (race recovery).
    if (claimed.intent.on_chain_id == null) {
      await persistOnChainIdSafe(ctx, claimed.intent.intent_id, onChainId)
    }
    return onChainId
  }

  // Not on-chain. Register.
  const txHash = await ctx.hubClients.walletClient.writeContract({
    address: ctx.hubClients.settlementHubAddress,
    abi: SETTLEMENT_HUB_ABI,
    functionName: 'registerIntent',
    args: [
      onChainId,
      claimed.intent.merchant_address,
      ctx.config.operatorAddress as Address,
      BigInt(claimed.intent.amount),
      BigInt(claimed.intent.expires_at),
    ],
    account: ctx.hubClients.account,
    chain: null,
  })

  const receipt = await ctx.hubClients.publicClient.waitForTransactionReceipt({ hash: txHash })
  if (receipt.status !== 'success') {
    throw new Error(`registerIntent_reverted: ${txHash}`)
  }

  // RPC read replicas can briefly lag a freshly-confirmed write. The next
  // step (payIntentWithAuthorization) estimates gas via an eth_call that
  // reverts IntentNotFound against a stale replica — block until the
  // registered intent is visible on the read path.
  await waitForIntentVisible(ctx, onChainId)

  // Persist on_chain_id. Idempotent — another worker may have just done
  // this; the API helper returns { applied: false } silently in that case.
  await persistOnChainIdSafe(ctx, claimed.intent.intent_id, onChainId)

  ctx.logger.info(
    { intent_id: claimed.intent.intent_id, on_chain_id: onChainId, tx_hash: txHash },
    '[settler] registerIntent confirmed',
  )

  return onChainId
}

/// Polls getIntent until a freshly-registered intent is readable. Guards the
/// read-after-write gap between registerIntent's receipt and the
/// payIntentWithAuthorization gas estimation, both of which hit RPC read
/// replicas that can lag a confirmed write by a few hundred ms.
async function waitForIntentVisible(ctx: SettlerContext, onChainId: Hex): Promise<void> {
  const MAX_ATTEMPTS = 10
  const DELAY_MS = 600
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const intent = await ctx.hubClients.publicClient.readContract({
      address: ctx.hubClients.settlementHubAddress,
      abi: SETTLEMENT_HUB_ABI,
      functionName: 'getIntent',
      args: [onChainId],
    })
    if ((intent as { merchant: string }).merchant !== ZERO_ADDRESS) return
    if (attempt < MAX_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, DELAY_MS))
    }
  }
  throw new Error('registerIntent confirmed but intent not visible on read path after retries')
}

async function persistOnChainIdSafe(ctx: SettlerContext, intentId: string, onChainId: Hex) {
  try {
    await ctx.api.post(`/v1/internal/intents/${intentId}/registered`, { on_chain_id: onChainId })
  } catch (err) {
    // If the API rejects (e.g. unknown intent), we still continue — the
    // bytes32 id is deterministic, so payment will work. Log for trail.
    if (err instanceof InternalApiError && err.status === 404) {
      ctx.logger.warn(
        { intent_id: intentId, status: err.status },
        '[settler] API rejected intent registration persistence — continuing with on-chain only',
      )
      return
    }
    throw err
  }
}

// ERC-6492: a counterfactual (not-yet-deployed) smart-wallet signature is
//   abi.encode(factory, factoryCalldata, innerSig) ++ MAGIC  (last 32 bytes).
const ERC6492_MAGIC_SUFFIX = '6492649264926492649264926492649264926492649264926492649264926492'

/**
 * Resolve a signature into one USDC's SignatureChecker can validate at settle
 * time:
 *   - EOA (65-byte ECDSA) or already-deployed ERC-1271 → returned unchanged.
 *   - ERC-6492 (counterfactual smart wallet, e.g. a brand-new Coinbase Smart
 *     Wallet): if the account has no code yet, DEPLOY it via the factory call
 *     embedded in the wrapper (the operator pays a one-time gas cost), then
 *     return the unwrapped inner signature. The signed digest is unchanged, so
 *     once the account exists its `isValidSignature` accepts the inner sig.
 *
 * Without this, USDC's SignatureChecker reverts on a counterfactual account
 * (no code → ERC-1271 call fails; it doesn't unwrap 6492 itself).
 */
/// Multicall3 — the address Coinbase Smart Wallet uses as the ERC-6492 "factory",
/// wrapping the real deploy in `aggregate3([...])`. Same address on every chain.
const MULTICALL3_ADDRESS = '0xca11bde05977b3631167028862be2a173976ca11'
/// `aggregate3((address target, bool allowFailure, bytes callData)[])` selector.
const AGGREGATE3_SELECTOR = '0x82ad56cb'

/// Turn an ERC-6492 (factory, factoryCalldata) into the concrete deploy call(s).
/// Coinbase wraps the deploy in `Multicall3.aggregate3`, whose `allowFailure`
/// SWALLOWS inner reverts — calling it blindly can "succeed" without deploying.
/// So when the factory is Multicall3 we unwrap the aggregate and return the inner
/// (target, callData) calls, which we then send DIRECTLY so any revert surfaces.
function deployCallsFromWrapper(
  factory: Address,
  factoryCalldata: Hex,
): Array<{ to: Address; data: Hex }> {
  if (
    factory.toLowerCase() === MULTICALL3_ADDRESS &&
    factoryCalldata.toLowerCase().startsWith(AGGREGATE3_SELECTOR)
  ) {
    const [calls] = decodeAbiParameters(
      [
        {
          type: 'tuple[]',
          components: [
            { name: 'target', type: 'address' },
            { name: 'allowFailure', type: 'bool' },
            { name: 'callData', type: 'bytes' },
          ],
        },
      ],
      `0x${factoryCalldata.slice(10)}` as Hex,
    ) as readonly [readonly { target: Address; allowFailure: boolean; callData: Hex }[]]
    return calls.map((c) => ({ to: c.target, data: c.callData }))
  }
  return [{ to: factory, data: factoryCalldata }]
}

async function resolveSettlementSignature(
  ctx: SettlerContext,
  payer: Address,
  signature: Hex,
): Promise<Hex> {
  if (!signature.toLowerCase().endsWith(ERC6492_MAGIC_SUFFIX)) {
    return signature
  }

  // Strip the 32-byte magic suffix, then decode the wrapper.
  const wrapped = signature.slice(0, signature.length - 64) as Hex
  const [factory, factoryCalldata, innerSig] = decodeAbiParameters(
    [{ type: 'address' }, { type: 'bytes' }, { type: 'bytes' }],
    wrapped,
  ) as [Address, Hex, Hex]

  const code = await ctx.hubClients.publicClient.getCode({ address: payer })
  if (!code || code === '0x') {
    ctx.logger.info(
      { payer, factory },
      '[settler] ERC-6492 counterfactual wallet — deploying before settle',
    )
    // Call the real factory call(s) directly (unwrapped from Multicall3 so a
    // failed deploy reverts loudly instead of being swallowed by allowFailure).
    for (const call of deployCallsFromWrapper(factory, factoryCalldata)) {
      const deployTx = await ctx.hubClients.walletClient.sendTransaction({
        to: call.to,
        data: call.data,
        account: ctx.hubClients.account,
        chain: null,
      })
      const receipt = await ctx.hubClients.publicClient.waitForTransactionReceipt({
        hash: deployTx,
      })
      if (receipt.status !== 'success') {
        throw new Error(`erc6492_deploy_reverted: ${deployTx}`)
      }
    }
    // Verify the account actually materialized — if not, settling with the inner
    // (ERC-1271) sig would fail confusingly on USDC's ECDSA fallback. Permanent.
    const deployedCode = await ctx.hubClients.publicClient.getCode({ address: payer })
    if (!deployedCode || deployedCode === '0x') {
      throw new Error('erc6492_deploy_reverted: account has no code after factory call')
    }
  }
  return innerSig
}

async function submitPayment(
  ctx: SettlerContext,
  claimed: ClaimResponse,
  onChainId: Hex,
): Promise<void> {
  const auth = claimed.authorization
  const signature = await resolveSettlementSignature(ctx, auth.payer_address, auth.signature)
  const txHash = await ctx.hubClients.walletClient.writeContract({
    address: ctx.hubClients.settlementHubAddress,
    abi: SETTLEMENT_HUB_ABI,
    functionName: 'payIntentWithAuthorization',
    args: [
      {
        intentId: onChainId,
        payer: auth.payer_address,
        validAfter: BigInt(auth.valid_after),
        validBefore: BigInt(auth.valid_before),
        nonce: auth.nonce,
        signature,
      },
    ],
    account: ctx.hubClients.account,
    chain: null,
  })

  const receipt = await ctx.hubClients.publicClient.waitForTransactionReceipt({ hash: txHash })
  if (receipt.status !== 'success') {
    throw new Error(`payIntentWithAuthorization_reverted: ${txHash}`)
  }
}
