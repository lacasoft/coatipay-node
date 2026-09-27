import {
  DEFAULT_GAS_PRICE_REF_GWEI,
  DEFAULT_MIN_PAYMENT_AMOUNT,
  parseRpcUrlList,
  USDC_ADDRESSES,
} from '@lacasoft/coatipay-protocol'
import { isAddressEqual } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { z } from 'zod'

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const ZERO_KEY = `0x${'0'.repeat(64)}`

const ConfigSchema = z
  .object({
    port: z.coerce.number().default(4000),
    /// Red en la que opera el nodo, declarada — no deducida del texto de la URL
    /// del RPC. Al arrancar se comprueba que cada RPC sirve esa red. CHAIN.
    chain: z.enum(['base', 'base-sepolia']),
    /// NODE_ENV=production. En producción no hay «modo dev»: una dirección de
    /// contrato o una clave a cero es un error de configuración, no un permiso
    /// para arrancar sin liquidar.
    isProduction: z.boolean(),
    /// Opcional: la dirección del operador sale de su clave. Si se declara
    /// (NODE_OPERATOR_ADDRESS), tiene que ser la de esa clave.
    operatorAddress: z.string().optional(),
    /// Llave del operador. Es la MISMA con la que el nodeit se registró en
    /// NodeRegistry: firma las llamadas al canal interno y el API recupera la
    /// dirección de esa firma, así que aquí es también la identidad del nodo.
    privateKey: z
      .custom<`0x${string}`>((v) => typeof v === 'string' && /^0x[a-fA-F0-9]{64}$/.test(v), {
        message: 'NODE_OPERATOR_PRIVATE_KEY must be 0x + 64 hex chars',
      })
      .default('0x0000000000000000000000000000000000000000000000000000000000000000'),
    endpoint: z.string().default('http://localhost:4000'),
    baseRpcUrl: z.string().url().default('https://sepolia.base.org'),
    /// Optional backup RPC endpoints for failover when the primary errors or
    /// hits its quota. The chain's public RPC is always appended as last resort.
    /// From BASE_RPC_FALLBACK_URLS (comma-separated).
    baseRpcFallbackUrls: z.array(z.string().url()).default([]),
    nodeRegistryAddress: z.string().default('0x0000000000000000000000000000000000000000'),
    /// SettlementHub address — daemon calls registerIntent (lazy, on first
    /// claim) and payIntentWithAuthorization in the settler service. Zero in dev.
    settlementHubAddress: z.string().default('0x0000000000000000000000000000000000000000'),
    /// Por defecto, el USDC oficial de la red declarada. Al arrancar se
    /// comprueba que es el del hub.
    usdcAddress: z.string().optional(),
    /// Internal API base URL (where /v1/internal/* endpoints live). Read from
    /// API_INTERNAL_URL. Default `http://api:3000` matches the docker-compose
    /// service name; override to localhost for non-docker dev.
    apiUrl: z.string().url().default('http://api:3000'),

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
  .superRefine((c, ctx) => {
    if (c.isProduction) {
      const obligatorias = [
        ['settlementHubAddress', 'SETTLEMENT_HUB_ADDRESS'],
        ['nodeRegistryAddress', 'NODE_REGISTRY_ADDRESS'],
      ] as const
      for (const [campo, variable] of obligatorias) {
        if (c[campo].toLowerCase() === ZERO_ADDRESS) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [campo],
            message: `${variable} está a cero. En producción el nodo no arranca sin liquidar: sin esta dirección no podría hacer su trabajo`,
          })
        }
      }
      if (c.privateKey === ZERO_KEY) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['privateKey'],
          message: 'NODE_OPERATOR_PRIVATE_KEY no está definida',
        })
      }
    }
    if (c.operatorAddress && c.privateKey !== ZERO_KEY) {
      const deLaClave = privateKeyToAccount(c.privateKey).address
      if (!isAddressEqual(c.operatorAddress as `0x${string}`, deLaClave)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['operatorAddress'],
          message: `no es la dirección de NODE_OPERATOR_PRIVATE_KEY (${deLaClave}). La API te identifica por la clave; el gas se vigilaría en otra cuenta`,
        })
      }
    }
  })
  .transform((c) => ({
    ...c,
    usdcAddress: c.usdcAddress ?? USDC_ADDRESSES[c.chain],
    // La identidad del nodo es su clave: la dirección siempre sale de ella.
    operatorAddress:
      c.privateKey === ZERO_KEY
        ? (c.operatorAddress ?? ZERO_ADDRESS)
        : privateKeyToAccount(c.privateKey).address,
  }))

export type Config = z.infer<typeof ConfigSchema>

const VARIABLES: Record<string, string> = {
  chain: 'CHAIN',
  operatorAddress: 'NODE_OPERATOR_ADDRESS',
  privateKey: 'NODE_OPERATOR_PRIVATE_KEY',
  baseRpcUrl: 'BASE_RPC_URL',
  settlementHubAddress: 'SETTLEMENT_HUB_ADDRESS',
  nodeRegistryAddress: 'NODE_REGISTRY_ADDRESS',
  usdcAddress: 'USDC_ADDRESS',
  apiUrl: 'API_INTERNAL_URL',
}

/// Carga la configuración. Si algo está mal, no arranca y lo dice nombrando la
/// VARIABLE DE ENTORNO —que es lo que el operador configura—, no un volcado de
/// zod con claves internas.
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const isProduction = env.NODE_ENV === 'production'
  const resultado = ConfigSchema.safeParse({
    // Fuera de producción, Sepolia por defecto; en producción se declara.
    chain: env.CHAIN ?? (isProduction ? undefined : 'base-sepolia'),
    isProduction,
    port: env.PORT,
    operatorAddress: env.NODE_OPERATOR_ADDRESS || undefined,
    privateKey: env.NODE_OPERATOR_PRIVATE_KEY,
    endpoint: env.NODE_ENDPOINT,
    baseRpcUrl: env.BASE_RPC_URL,
    baseRpcFallbackUrls: parseRpcUrlList(env.BASE_RPC_FALLBACK_URLS),
    nodeRegistryAddress: env.NODE_REGISTRY_ADDRESS,
    settlementHubAddress: env.SETTLEMENT_HUB_ADDRESS,
    // Vacía cuenta como no definida: el USDC sale de la red.
    usdcAddress: env.USDC_ADDRESS || undefined,
    apiUrl: env.API_INTERNAL_URL,
    minPaymentAmount: env.MIN_PAYMENT_AMOUNT,
    gasPriceRefGwei: env.GAS_PRICE_REF_GWEI,
    settleExpiryBufferSeconds: env.SETTLE_EXPIRY_BUFFER_SECONDS,
  })
  if (!resultado.success) {
    const problemas = resultado.error.issues.map((i) => {
      const campo = String(i.path[0] ?? '(raíz)')
      return `  ${VARIABLES[campo] ?? campo}: ${i.message}`
    })
    throw new Error(
      `Configuración del nodo inválida — el nodo no arranca:\n${problemas.join('\n')}`,
    )
  }
  return resultado.data
}
