import {
  DEFAULT_GAS_PRICE_REF_GWEI,
  DEFAULT_MIN_PAYMENT_AMOUNT,
  parseRpcUrlList,
} from '@lacasoft/coatipay-protocol'
import { z } from 'zod'

const ConfigSchema = z.object({
  port: z.coerce.number().default(4000),
  operatorAddress: z.string().default('0x0000000000000000000000000000000000000000'),
  /// Llave del operador. Es la MISMA con la que el nodeit se registró en
  /// NodeRegistry: firma las llamadas al canal interno y el API recupera la
  /// dirección de esa firma, así que aquí es también la identidad del nodo.
  privateKey: z
    .custom<`0x${string}`>((v) => typeof v === 'string' && /^0x[a-fA-F0-9]{64}$/.test(v), {
      message: 'NODE_OPERATOR_PRIVATE_KEY must be 0x + 64 hex chars',
    })
    .default('0x0000000000000000000000000000000000000000000000000000000000000000'),
  endpoint: z.string().default('http://localhost:4000'),
  // Required, min 32, no default. The previous dev default passed validation,
  baseRpcUrl: z.string().url().default('https://sepolia.base.org'),
  /// Optional backup RPC endpoints for failover when the primary errors or
  /// hits its quota. The chain's public RPC is always appended as last resort.
  /// From BASE_RPC_FALLBACK_URLS (comma-separated).
  baseRpcFallbackUrls: z.array(z.string().url()).default([]),
  nodeRegistryAddress: z.string().default('0x0000000000000000000000000000000000000000'),
  stakeManagerAddress: z.string().default('0x0000000000000000000000000000000000000000'),
  /// SettlementHub address — daemon calls registerIntent (lazy, on first
  /// claim) and payIntentWithAuthorization in the settler service, plus
  /// subscribes to IntentSettled events in the watcher. Zero in dev.
  settlementHubAddress: z.string().default('0x0000000000000000000000000000000000000000'),
  usdcAddress: z.string().default('0x036CbD53842c5426634e7929541eC2318f3dCF7e'),
  /// Internal API base URL (where /v1/internal/* endpoints live). Read from
  /// API_INTERNAL_URL. Default `http://api:3000` matches the docker-compose
  /// service name; override to localhost for non-docker dev.
  apiUrl: z.string().url().default('http://api:3000'),

  // ── SettlementEventWatcher tuning ──────────────────────────────
  /// Max block span per `eth_getLogs` when scanning for IntentSettled.
  /// MUST fit the RPC provider's limit — Alchemy's free tier caps
  /// eth_getLogs at 10 blocks, so the default 9 stays safely under it.
  /// Raise it on a provider without that cap (public RPC, paid tier) to
  /// catch up faster. EVENT_MAX_BLOCK_RANGE.
  eventMaxBlockRange: z.coerce.number().int().positive().default(9),
  /// How often the watcher polls for new blocks. EVENT_POLL_INTERVAL_MS.
  eventPollIntervalMs: z.coerce.number().int().positive().default(4000),
  /// On first boot, how many blocks back from head to start scanning, so
  /// we don't replay all of history but still catch a settlement that
  /// landed just before the daemon started. EVENT_LOOKBACK_BLOCKS.
  eventLookbackBlocks: z.coerce.number().int().nonnegative().default(2000),

  // ── Settlement economics (never settle at a loss) ──────────────
  /// Minimum payment value (USDC base units) worth settling at the reference
  /// gas price. Scaled up live by current gas: effectiveMin = minPaymentAmount
  /// × max(1, gasPriceLive / gasPriceRefGwei). Below effectiveMin a payment is
  /// held (gas spike) or, near expiry, rejected as uneconomical. MIN_PAYMENT_AMOUNT.
  minPaymentAmount: z.coerce.number().int().nonnegative().default(DEFAULT_MIN_PAYMENT_AMOUNT),
  /// Gas price (gwei) at which `minPaymentAmount` was calibrated. The live gas
  /// price is compared against this to scale the floor. GAS_PRICE_REF_GWEI.
  gasPriceRefGwei: z.coerce.number().positive().default(DEFAULT_GAS_PRICE_REF_GWEI),
  /// A held (currently-unprofitable) authorization this close to its
  /// `validBefore` is rejected as uneconomical instead of retried — it won't
  /// become profitable before it expires. Seconds. SETTLE_EXPIRY_BUFFER_SECONDS.
  settleExpiryBufferSeconds: z.coerce.number().int().nonnegative().default(300),
})

export type Config = z.infer<typeof ConfigSchema>

export function loadConfig(): Config {
  return ConfigSchema.parse({
    port: process.env.PORT,
    operatorAddress: process.env.NODE_OPERATOR_ADDRESS,
    privateKey: process.env.NODE_OPERATOR_PRIVATE_KEY,
    endpoint: process.env.NODE_ENDPOINT,
    baseRpcUrl: process.env.BASE_RPC_URL,
    baseRpcFallbackUrls: parseRpcUrlList(process.env.BASE_RPC_FALLBACK_URLS),
    nodeRegistryAddress: process.env.NODE_REGISTRY_ADDRESS,
    stakeManagerAddress: process.env.STAKE_MANAGER_ADDRESS,
    settlementHubAddress: process.env.SETTLEMENT_HUB_ADDRESS,
    usdcAddress: process.env.USDC_ADDRESS,
    apiUrl: process.env.API_INTERNAL_URL,
    eventMaxBlockRange: process.env.EVENT_MAX_BLOCK_RANGE,
    eventPollIntervalMs: process.env.EVENT_POLL_INTERVAL_MS,
    eventLookbackBlocks: process.env.EVENT_LOOKBACK_BLOCKS,
    minPaymentAmount: process.env.MIN_PAYMENT_AMOUNT,
    gasPriceRefGwei: process.env.GAS_PRICE_REF_GWEI,
    settleExpiryBufferSeconds: process.env.SETTLE_EXPIRY_BUFFER_SECONDS,
  })
}
