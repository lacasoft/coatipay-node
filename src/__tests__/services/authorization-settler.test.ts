import { intentIdOf, intentRef } from '@lacasoft/coatipay-protocol'
import {
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  encodeFunctionData,
  erc20Abi,
  type Hex,
  keccak256,
} from 'viem'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DaemonChainClients } from '../../lib/chain-client'
import { InternalApiClient, InternalApiError } from '../../lib/internal-api-client'
import { computeHealth, initNodeStatus } from '../../lib/node-status'
import { SETTLEMENT_HUB_ABI } from '../../lib/settlement-hub-abi.js'
import { startAuthorizationSettler } from '../../services/authorization-settler'

const HUB = '0x1111111111111111111111111111111111111111' as `0x${string}`
const OPERATOR = '0x2222222222222222222222222222222222222222' as `0x${string}`
const PAYER = '0x3333333333333333333333333333333333333333' as `0x${string}`
const MERCHANT = '0x4444444444444444444444444444444444444444' as `0x${string}`

/// El id on-chain de un cobro de prueba: el que calculará el hub con la cartera
/// del comercio (ADR-009 §3), y el que el pagador firmó como nonce.
const idDe = (intentId: string) => intentIdOf(MERCHANT, intentId)

const baseConfig = {
  port: 4000,
  chain: 'base-sepolia' as const,
  isProduction: false,
  operatorAddress: OPERATOR,
  privateKey: `0x${'01'.repeat(32)}` as Hex,
  endpoint: 'http://localhost:4000',
  baseRpcUrl: 'https://sepolia.base.org',
  baseRpcFallbackUrls: [],
  nodeRegistryAddress: '0xRegistry',
  settlementHubAddress: HUB,
  usdcAddress: '0xUSDC',
  apiUrl: 'http://localhost:3000',
  minPaymentAmount: 0, // floor disabled by default; specific tests override
  gasPriceRefGwei: 0.02,
  feeClaimMinAmount: 1_000_000,
  settleExpiryBufferSeconds: 300,
}

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  fatal: vi.fn(),
  silent: vi.fn(),
  level: 'info',
  child: function child() {
    return mockLogger
  },
}

function buildHubClients(overrides: Partial<DaemonChainClients> = {}): DaemonChainClients {
  return {
    publicClient: {
      getBalance: vi.fn().mockResolvedValue(10n ** 18n), // 1 ETH
      readContract: vi.fn().mockResolvedValue({
        merchant: '0x0000000000000000000000000000000000000000', // not registered
        amount: 0n,
        operator: '0x0000000000000000000000000000000000000000',
        expiresAt: 0n,
        status: 0,
      }),
      waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: 'success' }),
      // El lote de pagos se simula antes de enviarlo (OCT-04): por defecto, liquida.
      simulateContract: vi.fn().mockResolvedValue({ result: 1n }),
    } as never,
    walletClient: {
      writeContract: vi.fn(),
    } as never,
    account: { address: OPERATOR, type: 'local', source: 'privateKey' } as never,
    settlementHubAddress: HUB,
    ...overrides,
  } as DaemonChainClients
}

function makeClaimResponse(
  overrides: { id?: string; intentId?: string; onChainId?: string | null; signature?: string } = {},
) {
  const id = overrides.id ?? 'pa_1'
  const intentId = overrides.intentId ?? 'pi_test'
  return {
    authorization: {
      id,
      intent_id: intentId,
      payer_address: PAYER,
      valid_after: '0',
      valid_before: '9999999999',
      // El pagador firma el id on-chain como nonce (ADR-004, ADR-009).
      nonce: idDe(intentId) as Hex,
      signature: overrides.signature ?? `0x${'ab'.repeat(65)}`,
    },
    intent: {
      intent_id: intentId,
      merchant_address: MERCHANT,
      amount: '5000000',
      expires_at: String(Math.floor(Date.now() / 1000) + 1800),
      on_chain_id: (overrides.onChainId ?? null) as string | null,
    },
    // El API firma el registro (ADR-004); el daemon lo reenvía tal cual.
    registration: {
      ref: intentRef(intentId),
      intent_id: idDe(intentId),
      merchant: MERCHANT,
      operator: OPERATOR,
      amount: '5000000',
      expires_at: String(Math.floor(Date.now() / 1000) + 1800),
      signature: `0x${'cd'.repeat(65)}`,
    },
  }
}

/// Wrap one or more claim payloads in the /claim-batch response envelope.
function batchOf(...claims: ReturnType<typeof makeClaimResponse>[]) {
  return { authorizations: claims }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

function buildApiMock(): {
  api: InternalApiClient
  postCalls: Array<{ path: string; body: unknown }>
} {
  const calls: Array<{ path: string; body: unknown }> = []
  const api = new InternalApiClient({
    apiUrl: 'http://localhost:3000',
    privateKey: `0x${'01'.repeat(32)}` as Hex,
  })
  // Override post with a mock that records calls + returns scripted responses
  ;(api as unknown as { post: (p: string, b: unknown) => Promise<unknown> }).post = vi.fn(
    async (path: string, body: unknown) => {
      calls.push({ path, body })
      return null
    },
  )
  return { api, postCalls: calls }
}

describe('startAuthorizationSettler', () => {
  it('no-op in dev mode (zero SettlementHub address)', () => {
    const { api } = buildApiMock()
    const stop = startAuthorizationSettler({
      config: { ...baseConfig, settlementHubAddress: '0x0000000000000000000000000000000000000000' },
      hubClients: null,
      api,
      logger: mockLogger as never,
    })
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('disabled — SETTLEMENT_HUB_ADDRESS'),
    )
    stop()
  })

  it('happy path: claim → registerIntent → submit → no callback (the API reads the chain)', async () => {
    const hubClients = buildHubClients()
    // getIntent: not-registered on the pre-register check, then registered on
    // the waitForIntentVisible poll that follows registerIntent's receipt.
    ;(hubClients.publicClient.readContract as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        merchant: '0x0000000000000000000000000000000000000000',
        amount: 0n,
        operator: '0x0000000000000000000000000000000000000000',
        expiresAt: 0n,
        status: 0,
      })
      .mockResolvedValue({
        merchant: MERCHANT,
        amount: 0n,
        operator: OPERATOR,
        expiresAt: 0n,
        status: 0,
      })
    const { api, postCalls } = buildApiMock()

    // Sequence of API responses: only /claim-batch. Nothing is reported back —
    // not the registration, not the settlement (F-5, ADR-007).
    let callIndex = 0
    const responses = [batchOf(makeClaimResponse())]
    ;(api as unknown as { post: (p: string, b: unknown) => Promise<unknown> }).post = vi.fn(
      async (path: string, body: unknown) => {
        postCalls.push({ path, body })
        const r = responses[callIndex++]
        return r === undefined ? null : r
      },
    )

    // viem writeContract: registerIntent → tx hash A, payIntentWithAuth → tx hash B
    ;(hubClients.walletClient.writeContract as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce('0xaaaa' as Hex)
      .mockResolvedValueOnce('0xbbbb' as Hex)

    const stop = startAuthorizationSettler({
      config: baseConfig,
      hubClients,
      api,
      logger: mockLogger as never,
    })
    await vi.advanceTimersByTimeAsync(5_001)
    await Promise.resolve()
    await Promise.resolve()
    stop()

    // Two writeContract calls: registerIntent + payIntentWithAuthorization
    expect(hubClients.walletClient.writeContract).toHaveBeenCalledTimes(2)
    const writeCalls = (hubClients.walletClient.writeContract as ReturnType<typeof vi.fn>).mock
      .calls
    expect((writeCalls[0]![0] as { functionName: string }).functionName).toBe('registerIntent')
    expect((writeCalls[1]![0] as { functionName: string }).functionName).toBe(
      'payIntentWithAuthorization',
    )
    // The settled auth carries the raw `signature` (not v/r/s) on-chain.
    const payAuth = (writeCalls[1]![0] as { args: [{ signature: string }] }).args[0]
    expect(payAuth.signature).toBe(`0x${'ab'.repeat(65)}`)

    // API calls: the claim, and the broadcast notice (only for metrics, punto
    // 6). The node reports neither the registration nor the settlement — the
    // API reads both from the chain (F-5).
    expect(postCalls.map((c) => c.path)).toEqual([
      '/v1/internal/authorizations/claim-batch',
      '/v1/internal/authorizations/broadcast',
    ])
    expect(postCalls[1]?.body).toEqual({ ids: ['pa_1'], tx_hash: '0xbbbb' })
  })

  it('skips registerIntent when intent already on-chain', async () => {
    const hubClients = buildHubClients({
      publicClient: {
        getBalance: vi.fn().mockResolvedValue(10n ** 18n),
        readContract: vi.fn().mockResolvedValue({
          merchant: MERCHANT, // non-zero = already registered
          amount: 5_000_000n,
          operator: OPERATOR,
          expiresAt: 9999999999n,
          status: 0,
        }),
        waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: 'success' }),
      } as never,
    })

    const { api, postCalls } = buildApiMock()
    let callIndex = 0
    const responses = [batchOf(makeClaimResponse())]
    ;(api as unknown as { post: (p: string, b: unknown) => Promise<unknown> }).post = vi.fn(
      async (path: string, body: unknown) => {
        postCalls.push({ path, body })
        const r = responses[callIndex++]
        return r === undefined ? null : r
      },
    )
    ;(hubClients.walletClient.writeContract as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      '0xpaytx' as Hex,
    )

    const stop = startAuthorizationSettler({
      config: baseConfig,
      hubClients,
      api,
      logger: mockLogger as never,
    })
    await vi.advanceTimersByTimeAsync(5_001)
    await Promise.resolve()
    await Promise.resolve()
    stop()

    // Only one writeContract: payIntentWithAuthorization (no register)
    expect(hubClients.walletClient.writeContract).toHaveBeenCalledTimes(1)
    expect(
      (
        (hubClients.walletClient.writeContract as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
          functionName: string
        }
      ).functionName,
    ).toBe('payIntentWithAuthorization')

    // API path: only the claim. Nothing about the registration is reported.
    expect(postCalls.map((c) => c.path)).toEqual([
      '/v1/internal/authorizations/claim-batch',
      '/v1/internal/authorizations/broadcast',
    ])
  })

  it('ERC-6492: deploys the counterfactual wallet, then settles with the inner sig', async () => {
    const FACTORY = '0x0BA5ED0c6AA8c49038F819E587E2633c4A9F428a' as Hex
    const FACTORY_CALLDATA = '0x3ffba36fdeadbeef' as Hex
    const INNER_SIG = `0x${'cd'.repeat(65)}` as Hex
    const MAGIC = '6492649264926492649264926492649264926492649264926492649264926492'
    const sig6492 = (encodeAbiParameters(
      [{ type: 'address' }, { type: 'bytes' }, { type: 'bytes' }],
      [FACTORY, FACTORY_CALLDATA, INNER_SIG],
    ) + MAGIC) as Hex

    const hubClients = buildHubClients({
      publicClient: {
        getBalance: vi.fn().mockResolvedValue(10n ** 18n),
        readContract: vi.fn().mockResolvedValue({
          merchant: MERCHANT, // already registered → only the pay tx
          amount: 5_000_000n,
          operator: OPERATOR,
          expiresAt: 9999999999n,
          status: 0,
        }),
        // counterfactual before deploy (1st call), has code after (2nd call)
        getCode: vi.fn().mockResolvedValueOnce('0x').mockResolvedValue('0x6080604052'),
        waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: 'success' }),
      } as never,
      walletClient: {
        writeContract: vi.fn().mockResolvedValue('0xpaytx' as Hex),
        sendTransaction: vi.fn().mockResolvedValue('0xdeploytx' as Hex),
      } as never,
    })

    const { api, postCalls } = buildApiMock()
    const responses = [batchOf(makeClaimResponse({ signature: sig6492 }))]
    let i = 0
    ;(api as unknown as { post: (p: string, b: unknown) => Promise<unknown> }).post = vi.fn(
      async (path: string, body: unknown) => {
        postCalls.push({ path, body })
        return responses[i++] ?? null
      },
    )

    const stop = startAuthorizationSettler({
      config: baseConfig,
      hubClients,
      api,
      logger: mockLogger as never,
    })
    await vi.advanceTimersByTimeAsync(5_001)
    await Promise.resolve()
    await Promise.resolve()
    stop()

    // Deployed the wallet via its factory (operator-paid), with the wrapper's calldata.
    expect(hubClients.walletClient.sendTransaction).toHaveBeenCalledTimes(1)
    const deployArg = (hubClients.walletClient.sendTransaction as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as { to: string; data: string }
    expect(deployArg.to.toLowerCase()).toBe(FACTORY.toLowerCase())
    expect(deployArg.data).toBe(FACTORY_CALLDATA)

    // Settled with the UNWRAPPED inner signature, not the 6492 blob.
    const payArg = (hubClients.walletClient.writeContract as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as { functionName: string; args: [{ signature: string }] }
    expect(payArg.functionName).toBe('payIntentWithAuthorization')
    expect(payArg.args[0].signature).toBe(INNER_SIG)
  })

  it('ERC-6492: unwraps the Coinbase Multicall3 wrapper and calls the real factory directly', async () => {
    // Coinbase wraps the deploy in Multicall3.aggregate3 (allowFailure swallows
    // reverts). The settler must call the INNER factory directly, not Multicall3.
    const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11' as Hex
    const REAL_FACTORY = '0x0BA5ED0c6AA8c49038F819E587E2633c4A9F428a' as Hex
    const CREATE_CALLDATA = '0x3ffba36fdeadbeef' as Hex
    const INNER_SIG = `0x${'cd'.repeat(80)}` as Hex // Coinbase 1271 sig (≠ 65 bytes)
    const MAGIC = '6492649264926492649264926492649264926492649264926492649264926492'

    const aggregate3Params = encodeAbiParameters(
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
      [[{ target: REAL_FACTORY, allowFailure: false, callData: CREATE_CALLDATA }]],
    )
    const aggregate3Calldata = `0x82ad56cb${aggregate3Params.slice(2)}` as Hex

    const sig6492 = (encodeAbiParameters(
      [{ type: 'address' }, { type: 'bytes' }, { type: 'bytes' }],
      [MULTICALL3, aggregate3Calldata, INNER_SIG],
    ) + MAGIC) as Hex

    const hubClients = buildHubClients({
      publicClient: {
        getBalance: vi.fn().mockResolvedValue(10n ** 18n),
        readContract: vi.fn().mockResolvedValue({
          merchant: MERCHANT,
          amount: 5_000_000n,
          operator: OPERATOR,
          expiresAt: 9999999999n,
          status: 0,
        }),
        getCode: vi.fn().mockResolvedValueOnce('0x').mockResolvedValue('0x6080604052'),
        waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: 'success' }),
      } as never,
      walletClient: {
        writeContract: vi.fn().mockResolvedValue('0xpaytx' as Hex),
        sendTransaction: vi.fn().mockResolvedValue('0xdeploytx' as Hex),
      } as never,
    })

    const { api, postCalls } = buildApiMock()
    const responses = [batchOf(makeClaimResponse({ signature: sig6492 }))]
    let i = 0
    ;(api as unknown as { post: (p: string, b: unknown) => Promise<unknown> }).post = vi.fn(
      async (path: string, body: unknown) => {
        postCalls.push({ path, body })
        return responses[i++] ?? null
      },
    )

    const stop = startAuthorizationSettler({
      config: baseConfig,
      hubClients,
      api,
      logger: mockLogger as never,
    })
    await vi.advanceTimersByTimeAsync(5_001)
    await Promise.resolve()
    await Promise.resolve()
    stop()

    // Deployed by calling the REAL factory directly (NOT Multicall3, NOT allowFailure).
    const deployArg = (hubClients.walletClient.sendTransaction as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as { to: string; data: string }
    expect(deployArg.to.toLowerCase()).toBe(REAL_FACTORY.toLowerCase())
    expect(deployArg.data).toBe(CREATE_CALLDATA)
    expect(deployArg.to.toLowerCase()).not.toBe(MULTICALL3.toLowerCase())

    const payArg = (hubClients.walletClient.writeContract as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as { args: [{ signature: string }] }
    expect(payArg.args[0].signature).toBe(INNER_SIG)
  })

  it('ERC-6492: skips the deploy when the smart wallet already has code', async () => {
    const INNER_SIG = `0x${'ef'.repeat(65)}` as Hex
    const MAGIC = '6492649264926492649264926492649264926492649264926492649264926492'
    const sig6492 = (encodeAbiParameters(
      [{ type: 'address' }, { type: 'bytes' }, { type: 'bytes' }],
      ['0x0BA5ED0c6AA8c49038F819E587E2633c4A9F428a', '0x3ffba36fdeadbeef', INNER_SIG],
    ) + MAGIC) as Hex

    const hubClients = buildHubClients({
      publicClient: {
        getBalance: vi.fn().mockResolvedValue(10n ** 18n),
        readContract: vi.fn().mockResolvedValue({
          merchant: MERCHANT,
          amount: 5_000_000n,
          operator: OPERATOR,
          expiresAt: 9999999999n,
          status: 0,
        }),
        getCode: vi.fn().mockResolvedValue('0x6080604052'), // already deployed
        waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: 'success' }),
      } as never,
      walletClient: {
        writeContract: vi.fn().mockResolvedValue('0xpaytx' as Hex),
        sendTransaction: vi.fn(),
      } as never,
    })

    const { api, postCalls } = buildApiMock()
    const responses = [batchOf(makeClaimResponse({ signature: sig6492 }))]
    let i = 0
    ;(api as unknown as { post: (p: string, b: unknown) => Promise<unknown> }).post = vi.fn(
      async (path: string, body: unknown) => {
        postCalls.push({ path, body })
        return responses[i++] ?? null
      },
    )

    const stop = startAuthorizationSettler({
      config: baseConfig,
      hubClients,
      api,
      logger: mockLogger as never,
    })
    await vi.advanceTimersByTimeAsync(5_001)
    await Promise.resolve()
    await Promise.resolve()
    stop()

    // No deploy tx (already has code), but still settles with the inner sig.
    expect(hubClients.walletClient.sendTransaction).not.toHaveBeenCalled()
    const payArg = (hubClients.walletClient.writeContract as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as { args: [{ signature: string }] }
    expect(payArg.args[0].signature).toBe(INNER_SIG)
  })

  it('skips cycle when ETH balance is below threshold', async () => {
    const hubClients = buildHubClients({
      publicClient: {
        getBalance: vi.fn().mockResolvedValue(1_000n),
        readContract: vi.fn(),
        waitForTransactionReceipt: vi.fn(),
      } as never,
    })
    const { api, postCalls } = buildApiMock()

    const stop = startAuthorizationSettler({
      config: baseConfig,
      hubClients,
      api,
      logger: mockLogger as never,
    })
    await vi.advanceTimersByTimeAsync(5_001)
    await Promise.resolve()
    stop()

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ balance_eth: expect.any(String) }),
      expect.stringContaining('ETH balance below warn threshold'),
    )
    expect(postCalls).toHaveLength(0) // didn't even claim
  })

  it('reports rejected when payIntentWithAuthorization reverts', async () => {
    const hubClients = buildHubClients({
      publicClient: {
        getBalance: vi.fn().mockResolvedValue(10n ** 18n),
        readContract: vi.fn().mockResolvedValue({
          merchant: MERCHANT, // already registered
          amount: 5_000_000n,
          operator: OPERATOR,
          expiresAt: 9999999999n,
          status: 0,
        }),
        // First waitForTransactionReceipt call (for payIntentWithAuth) reverts
        waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: 'reverted' }),
      } as never,
    })

    const { api, postCalls } = buildApiMock()
    let idx = 0
    const responses = [batchOf(makeClaimResponse()), null] // claim-batch + rejected
    ;(api as unknown as { post: (p: string, b: unknown) => Promise<unknown> }).post = vi.fn(
      async (path: string, body: unknown) => {
        postCalls.push({ path, body })
        const r = responses[idx++]
        return r === undefined ? null : r
      },
    )
    ;(hubClients.walletClient.writeContract as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      '0xrevert' as Hex,
    )

    const stop = startAuthorizationSettler({
      config: baseConfig,
      hubClients,
      api,
      logger: mockLogger as never,
    })
    await vi.advanceTimersByTimeAsync(5_001)
    await Promise.resolve()
    await Promise.resolve()
    stop()

    const rejectCall = postCalls.find((c) =>
      c.path.startsWith('/v1/internal/authorizations/pa_1/rejected'),
    )
    expect(rejectCall).toBeDefined()
    expect((rejectCall!.body as { reason: string }).reason).toContain(
      'payIntentWithAuthorization_reverted',
    )
  })

  it('does NOT reject on a transient error — leaves the claim for the sweeper', async () => {
    const hubClients = buildHubClients({
      publicClient: {
        getBalance: vi.fn().mockResolvedValue(10n ** 18n),
        readContract: vi.fn().mockResolvedValue({
          merchant: MERCHANT, // already registered → goes straight to submitPayment
          amount: 5_000_000n,
          operator: OPERATOR,
          expiresAt: 9999999999n,
          status: 0,
        }),
        waitForTransactionReceipt: vi.fn(),
      } as never,
    })

    const { api, postCalls } = buildApiMock()
    let idx = 0
    const responses = [batchOf(makeClaimResponse())]
    ;(api as unknown as { post: (p: string, b: unknown) => Promise<unknown> }).post = vi.fn(
      async (path: string, body: unknown) => {
        postCalls.push({ path, body })
        const r = responses[idx++]
        return r === undefined ? null : r
      },
    )
    // writeContract fails with a transient RPC/network error — not a contract
    // revert, not a `_reverted:` signal → classified transient.
    ;(hubClients.walletClient.writeContract as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('fetch failed: connect ECONNREFUSED'),
    )

    const stop = startAuthorizationSettler({
      config: baseConfig,
      hubClients,
      api,
      logger: mockLogger as never,
    })
    await vi.advanceTimersByTimeAsync(5_001)
    await Promise.resolve()
    await Promise.resolve()
    stop()

    // No /rejected call — the row stays `claimed` for the sweeper to re-queue.
    expect(postCalls.some((c) => c.path.includes('/rejected'))).toBe(false)
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ auth_id: 'pa_1' }),
      expect.stringContaining('Transient failure'),
    )
  })

  it('does nothing when queue is empty (empty array from API)', async () => {
    const hubClients = buildHubClients()
    const { api, postCalls } = buildApiMock()
    ;(api as unknown as { post: (p: string, b: unknown) => Promise<unknown> }).post = vi.fn(
      async (path: string, body: unknown) => {
        postCalls.push({ path, body })
        return batchOf() // empty batch
      },
    )

    const stop = startAuthorizationSettler({
      config: baseConfig,
      hubClients,
      api,
      logger: mockLogger as never,
    })
    await vi.advanceTimersByTimeAsync(5_001)
    await Promise.resolve()
    stop()

    // Only claim-batch was attempted — no submission
    expect(postCalls).toHaveLength(1)
    expect(postCalls[0]?.path).toBe('/v1/internal/authorizations/claim-batch')
    expect(hubClients.walletClient.writeContract).not.toHaveBeenCalled()
  })

  it('batch path: claims 2+ → registerIntentBatch + payIntentBatchWithAuthorization', async () => {
    const hubClients = buildHubClients()
    // getIntent: not-registered on the pre-check, registered afterwards on the
    // waitForIntentVisible poll.
    // Lo que decide qué registrar es la cadena: los dos getIntent previos
    // dicen «no está», y el sondeo tras el registro, que ya está.
    const noRegistrado = {
      merchant: '0x0000000000000000000000000000000000000000',
      amount: 0n,
      operator: '0x0000000000000000000000000000000000000000',
      expiresAt: 0n,
      status: 0,
    }
    ;(hubClients.publicClient.readContract as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(noRegistrado)
      .mockResolvedValueOnce(noRegistrado)
      .mockResolvedValue({
        merchant: MERCHANT,
        amount: 0n,
        operator: OPERATOR,
        expiresAt: 0n,
        status: 0,
      })
    const { api, postCalls } = buildApiMock()
    let callIndex = 0
    const responses = [
      batchOf(
        makeClaimResponse({ id: 'pa_1', intentId: 'pi_1' }),
        makeClaimResponse({ id: 'pa_2', intentId: 'pi_2' }),
      ),
    ]
    ;(api as unknown as { post: (p: string, b: unknown) => Promise<unknown> }).post = vi.fn(
      async (path: string, body: unknown) => {
        postCalls.push({ path, body })
        const r = responses[callIndex++]
        return r === undefined ? null : r
      },
    )
    ;(hubClients.walletClient.writeContract as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce('0xreg' as Hex)
      .mockResolvedValueOnce('0xpay' as Hex)

    const stop = startAuthorizationSettler({
      config: baseConfig,
      hubClients,
      api,
      logger: mockLogger as never,
    })
    await vi.advanceTimersByTimeAsync(5_001)
    for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(0)
    stop()

    const writeCalls = (hubClients.walletClient.writeContract as ReturnType<typeof vi.fn>).mock
      .calls
    expect(writeCalls).toHaveLength(2)
    expect((writeCalls[0]![0] as { functionName: string }).functionName).toBe('registerIntentBatch')
    expect((writeCalls[1]![0] as { functionName: string }).functionName).toBe(
      'payIntentBatchWithAuthorization',
    )
    // registerIntentBatch got parallel arrays of length 2
    const regArgs = (writeCalls[0]![0] as { args: unknown[] }).args
    expect((regArgs[0] as unknown[]).length).toBe(2) // intentIds
    // payIntentBatchWithAuthorization got 2 auths
    const payArgs = (writeCalls[1]![0] as { args: unknown[] }).args
    expect((payArgs[0] as unknown[]).length).toBe(2)

    expect(postCalls[0]?.path).toBe('/v1/internal/authorizations/claim-batch')
    expect(postCalls.some((c) => c.path.includes('/rejected'))).toBe(false)
  })

  it('batch path: registra aunque el claim traiga on_chain_id, si la cadena no tiene el intent', async () => {
    // Desde F-5 la API rellena on_chain_id al crear el intent: ya no significa
    // «registrado». Si el settler decidiera por él, nunca registraría nada y
    // cada lote revertiría con IntentNotFound.
    const hubClients = buildHubClients()
    const noRegistrado = {
      merchant: '0x0000000000000000000000000000000000000000',
      amount: 0n,
      operator: '0x0000000000000000000000000000000000000000',
      expiresAt: 0n,
      status: 0,
    }
    ;(hubClients.publicClient.readContract as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(noRegistrado)
      .mockResolvedValueOnce(noRegistrado)
      .mockResolvedValue({
        merchant: MERCHANT,
        amount: 0n,
        operator: OPERATOR,
        expiresAt: 0n,
        status: 0,
      })
    const { api, postCalls } = buildApiMock()
    let entregado = false
    ;(api as unknown as { post: (p: string, b: unknown) => Promise<unknown> }).post = vi.fn(
      async (path: string, body: unknown) => {
        postCalls.push({ path, body })
        if (entregado) return null
        entregado = true
        return batchOf(
          makeClaimResponse({ id: 'pa_1', intentId: 'pi_1', onChainId: idDe('pi_1') }),
          makeClaimResponse({ id: 'pa_2', intentId: 'pi_2', onChainId: idDe('pi_2') }),
        )
      },
    )
    ;(hubClients.walletClient.writeContract as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce('0xreg' as Hex)
      .mockResolvedValueOnce('0xpay' as Hex)

    const stop = startAuthorizationSettler({
      config: baseConfig,
      hubClients,
      api,
      logger: mockLogger as never,
    })
    await vi.advanceTimersByTimeAsync(5_001)
    for (let k = 0; k < 4; k++) await Promise.resolve()
    stop()

    const funciones = (
      hubClients.walletClient.writeContract as ReturnType<typeof vi.fn>
    ).mock.calls.map((c) => (c[0] as { functionName: string }).functionName)
    expect(funciones).toEqual(['registerIntentBatch', 'payIntentBatchWithAuthorization'])
  })

  it('batch path: skips registerIntentBatch when all intents already on-chain', async () => {
    const hubClients = buildHubClients()
    // «Ya en la cadena» lo dice getIntent, no el on_chain_id del claim.
    ;(hubClients.publicClient.readContract as ReturnType<typeof vi.fn>).mockResolvedValue({
      merchant: MERCHANT,
      amount: 5_000_000n,
      operator: OPERATOR,
      expiresAt: 9999999999n,
      status: 0,
    })
    const { api, postCalls } = buildApiMock()
    ;(api as unknown as { post: (p: string, b: unknown) => Promise<unknown> }).post = vi.fn(
      async (path: string, body: unknown) => {
        postCalls.push({ path, body })
        return batchOf(
          makeClaimResponse({ id: 'pa_1', intentId: 'pi_1', onChainId: `0x${'a'.repeat(64)}` }),
          makeClaimResponse({ id: 'pa_2', intentId: 'pi_2', onChainId: `0x${'b'.repeat(64)}` }),
        )
      },
    )
    ;(hubClients.walletClient.writeContract as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      '0xpay' as Hex,
    )

    const stop = startAuthorizationSettler({
      config: baseConfig,
      hubClients,
      api,
      logger: mockLogger as never,
    })
    await vi.advanceTimersByTimeAsync(5_001)
    await Promise.resolve()
    await Promise.resolve()
    stop()

    const writeCalls = (hubClients.walletClient.writeContract as ReturnType<typeof vi.fn>).mock
      .calls
    expect(writeCalls).toHaveLength(1)
    expect((writeCalls[0]![0] as { functionName: string }).functionName).toBe(
      'payIntentBatchWithAuthorization',
    )
  })

  it('batch path: batch error does NOT call /rejected — leaves claims for sweeper', async () => {
    const hubClients = buildHubClients({
      publicClient: {
        getBalance: vi.fn().mockResolvedValue(10n ** 18n),
        readContract: vi.fn().mockResolvedValue({
          merchant: MERCHANT,
          amount: 5_000_000n,
          operator: OPERATOR,
          expiresAt: 9999999999n,
          status: 0,
        }),
        // batch pay tx reverts
        waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: 'reverted' }),
      } as never,
    })
    const { api, postCalls } = buildApiMock()
    ;(api as unknown as { post: (p: string, b: unknown) => Promise<unknown> }).post = vi.fn(
      async (path: string, body: unknown) => {
        postCalls.push({ path, body })
        return batchOf(
          makeClaimResponse({ id: 'pa_1', intentId: 'pi_1', onChainId: `0x${'a'.repeat(64)}` }),
          makeClaimResponse({ id: 'pa_2', intentId: 'pi_2', onChainId: `0x${'b'.repeat(64)}` }),
        )
      },
    )
    ;(hubClients.walletClient.writeContract as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      '0xpay' as Hex,
    )

    const stop = startAuthorizationSettler({
      config: baseConfig,
      hubClients,
      api,
      logger: mockLogger as never,
    })
    await vi.advanceTimersByTimeAsync(5_001)
    await Promise.resolve()
    await Promise.resolve()
    stop()

    // No /rejected call — every row stays `claimed` for the sweeper.
    expect(postCalls.some((c) => c.path.includes('/rejected'))).toBe(false)
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ count: 2 }),
      expect.stringContaining('Batch settle failed'),
    )
  })

  it('no overlap: an in-flight runOnce blocks the next tick from being scheduled', async () => {
    // The scheduler is a chained setTimeout, not setInterval — the next
    // tick is only scheduled AFTER runOnce returns. So a hung runOnce
    // never produces a concurrent second invocation, eliminating the
    // nonce-collision race (two writeContract calls from the same
    // operator wallet racing for the same eth_getTransactionCount).
    const hubClients = buildHubClients({
      publicClient: {
        // Never resolves — simulates a runOnce that takes > POLL_INTERVAL_MS.
        getBalance: vi.fn().mockReturnValue(new Promise<bigint>(() => {})),
        readContract: vi.fn(),
        waitForTransactionReceipt: vi.fn(),
      } as never,
    })
    const { api, postCalls } = buildApiMock()

    const stop = startAuthorizationSettler({
      config: baseConfig,
      hubClients,
      api,
      logger: mockLogger as never,
    })

    // Advance through 3 interval cycles' worth of wall-clock time. The
    // first tick fires at +5s, hangs in getBalance, never returns —
    // and therefore never schedules tick #2. So only one runOnce ever ran.
    await vi.advanceTimersByTimeAsync(5_001 * 3)
    await Promise.resolve()
    stop()

    expect(hubClients.publicClient.getBalance).toHaveBeenCalledTimes(1)
    // No API calls reached (we're stuck inside getBalance).
    expect(postCalls).toHaveLength(0)
  })

  it('backs off when the queue stays empty, but never waits more than 10 s', async () => {
    // Idle, it backs off 5 s → 10 s so it does not hammer the API and RPC every
    // 5 s. The cap is the latency guarantee (punto 6, #38): with a 60 s cap, a
    // payment after a quiet spell waited up to a minute to be claimed.
    const hubClients = buildHubClients()
    const { api, postCalls } = buildApiMock()
    const instantes: number[] = []
    ;(api as unknown as { post: (p: string, b: unknown) => Promise<unknown> }).post = vi.fn(
      async (path: string, body: unknown) => {
        postCalls.push({ path, body })
        instantes.push(Date.now())
        return batchOf() // always empty — drives the backoff
      },
    )

    const stop = startAuthorizationSettler({
      config: baseConfig,
      hubClients,
      api,
      logger: mockLogger as never,
    })

    // Five idle minutes: ticks at +5 s, +15 s, +25 s… every 10 s.
    await vi.advanceTimersByTimeAsync(300_001)
    await Promise.resolve()
    stop()

    const huecos = instantes.slice(1).map((t, i) => t - (instantes[i] as number))
    expect(Math.max(...huecos)).toBeLessThanOrEqual(10_000)
    // Fewer calls than a fixed 5 s cadence (60 in five minutes).
    expect(postCalls.length).toBeLessThanOrEqual(31)
  })

  it('resets to base interval when a cycle finds work after a backoff', async () => {
    // First two ticks: empty → backoff to 10 s (the cap).
    // Third tick (at +25 s): returns 1 claim → backoff must reset.
    // Fourth tick should fire at +25 s + 5 s = +30 s, not +25 s + 10 s = +35 s.
    const hubClients = buildHubClients()
    const { api, postCalls } = buildApiMock()
    let callCount = 0
    ;(api as unknown as { post: (p: string, b: unknown) => Promise<unknown> }).post = vi.fn(
      async (path: string, body: unknown) => {
        postCalls.push({ path, body })
        callCount++
        if (callCount === 3) {
          // Return one claim — settler will try to settle it. We mock the
          // hubClients above to make the settle a no-op (no real chain calls).
          return batchOf(
            makeClaimResponse({
              id: 'pa_reset',
              intentId: 'pi_reset',
              onChainId: `0x${'1'.repeat(64)}`,
            }),
          )
        }
        return batchOf() // empty otherwise
      },
    )
    // Make the settle path harmless so we don't have to mock the whole chain.
    ;(hubClients.walletClient.writeContract as ReturnType<typeof vi.fn>).mockResolvedValue(
      '0xpay' as Hex,
    )
    ;(
      hubClients.publicClient.waitForTransactionReceipt as ReturnType<typeof vi.fn>
    ).mockResolvedValue({ status: 'success' })
    ;(hubClients.publicClient.readContract as ReturnType<typeof vi.fn>).mockResolvedValue({
      merchant: MERCHANT,
      amount: 5_000_000n,
      operator: OPERATOR,
      expiresAt: 9999999999n,
      status: 0,
    })

    const stop = startAuthorizationSettler({
      config: baseConfig,
      hubClients,
      api,
      logger: mockLogger as never,
    })

    // Advance to +31 s: at +5 s empty, +15 s empty, +25 s WORK → reset to
    // base, next tick at +30 s should fire — bringing claim-batch posts to 4.
    await vi.advanceTimersByTimeAsync(31_001)
    await Promise.resolve()
    await Promise.resolve()
    stop()

    const claimPosts = postCalls.filter((c) => c.path === '/v1/internal/authorizations/claim-batch')
    // Without the reset: +5 s, +15 s, +25 s, +35 s → only 3 within 31 s.
    // With reset on cycle 3 (work found): +5 s, +15 s, +25 s, +30 s → 4.
    expect(claimPosts.length).toBeGreaterThanOrEqual(4)
  })
})

describe('economic guard (never settle at a loss)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  /// Builds a claim with a custom amount + valid_before (the guard reads both).
  function claimWith(amount: string, validBefore: number) {
    return {
      authorization: {
        id: 'pa_low',
        intent_id: 'pi_low',
        payer_address: PAYER,
        valid_after: '0',
        valid_before: String(validBefore),
        nonce: idDe('pi_low') as Hex,
        signature: `0x${'ab'.repeat(65)}`,
      },
      registration: {
        ref: intentRef('pi_low'),
        intent_id: idDe('pi_low'),
        merchant: MERCHANT,
        operator: OPERATOR,
        amount,
        expires_at: String(validBefore),
        signature: `0x${'cd'.repeat(65)}` as `0x${string}`,
      },
      intent: {
        intent_id: 'pi_low',
        merchant_address: MERCHANT,
        amount,
        expires_at: String(validBefore),
        on_chain_id: null as string | null,
      },
    }
  }

  // 0.02 gwei = 2e7 wei → equals gasPriceRefGwei → scale = 1 → effectiveMin = min.
  function hubWithGas() {
    return buildHubClients({
      publicClient: {
        getBalance: vi.fn().mockResolvedValue(10n ** 18n),
        getGasPrice: vi.fn().mockResolvedValue(20_000_000n),
        readContract: vi.fn(),
        waitForTransactionReceipt: vi.fn(),
      } as never,
    })
  }

  it('rejects a sub-economic payment near expiry (uneconomical) without settling', async () => {
    const hubClients = hubWithGas()
    const { api, postCalls } = buildApiMock()
    const nowSec = Math.floor(Date.now() / 1000)
    const responses = [batchOf(claimWith('1000', nowSec + 60))] // $0.001, expires in 60s
    let i = 0
    ;(api as unknown as { post: (p: string, b: unknown) => Promise<unknown> }).post = vi.fn(
      async (path: string, body: unknown) => {
        postCalls.push({ path, body })
        return responses[i++] ?? null
      },
    )

    const stop = startAuthorizationSettler({
      config: { ...baseConfig, minPaymentAmount: 1_000_000 }, // floor $1
      hubClients,
      api,
      logger: mockLogger as never,
    })
    await vi.advanceTimersByTimeAsync(5_001)
    await Promise.resolve()
    stop()

    // Rejected as uneconomical, and NEVER settled on-chain.
    expect(postCalls.some((c) => c.path === '/v1/internal/authorizations/pa_low/rejected')).toBe(
      true,
    )
    expect(hubClients.walletClient.writeContract).not.toHaveBeenCalled()
  })

  it('holds a sub-economic payment far from expiry (no settle, no reject)', async () => {
    const hubClients = hubWithGas()
    const { api, postCalls } = buildApiMock()
    const nowSec = Math.floor(Date.now() / 1000)
    const responses = [batchOf(claimWith('1000', nowSec + 36_000))] // far from expiry
    let i = 0
    ;(api as unknown as { post: (p: string, b: unknown) => Promise<unknown> }).post = vi.fn(
      async (path: string, body: unknown) => {
        postCalls.push({ path, body })
        return responses[i++] ?? null
      },
    )

    const stop = startAuthorizationSettler({
      config: { ...baseConfig, minPaymentAmount: 1_000_000 },
      hubClients,
      api,
      logger: mockLogger as never,
    })
    await vi.advanceTimersByTimeAsync(5_001)
    await Promise.resolve()
    stop()

    // Held: not settled, not rejected (sweeper will re-queue it).
    expect(postCalls.some((c) => c.path.endsWith('/rejected'))).toBe(false)
    expect(hubClients.walletClient.writeContract).not.toHaveBeenCalled()
  })
})

/**
 * Regresión — el settler ya no ejecuta la «fábrica» ERC-6492 que elige el pagador.
 *
 * Reproducido antes del arreglo contra un fork de Base Sepolia: con fábrica =
 * USDC y datos = transfer(atacante, …), el nodeit transfería sus propios USDC;
 * y por Multicall3 además se desactivaba a sí mismo del registro. Ahora solo va
 * a la fábrica permitida con `createAccount`, y lo comprueba antes de cualquier
 * transacción.
 */
describe('regresión · el settler solo despliega con la fábrica permitida', () => {
  const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as Hex
  const REGISTRY = '0xaaCc18e5585e8Da0C9c1afD0B73255A73E40DC62' as Hex
  const FABRICA = '0x0BA5ED0c6AA8c49038F819E587E2633c4A9F428a' as Hex
  const ATACANTE = '0xa77ac0000000000000000000000000000000beef' as Hex
  const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11' as Hex
  const MAGIC = '6492649264926492649264926492649264926492649264926492649264926492'
  const FIRMA_INTERNA = `0x${'cd'.repeat(65)}` as Hex

  const robo = encodeFunctionData({
    abi: erc20Abi,
    functionName: 'transfer',
    args: [ATACANTE, 40_000_000n],
  })
  const crear = '0x3ffba36fdeadbeef' as Hex
  const envolver = (fabrica: Hex, datos: Hex) =>
    (encodeAbiParameters(
      [{ type: 'address' }, { type: 'bytes' }, { type: 'bytes' }],
      [fabrica, datos, FIRMA_INTERNA],
    ) + MAGIC) as Hex
  const aggregate3 = (calls: { target: Hex; callData: Hex }[]) =>
    encodeFunctionData({
      abi: [
        {
          type: 'function',
          name: 'aggregate3',
          stateMutability: 'payable',
          inputs: [
            {
              name: 'calls',
              type: 'tuple[]',
              components: [
                { name: 'target', type: 'address' },
                { name: 'allowFailure', type: 'bool' },
                { name: 'callData', type: 'bytes' },
              ],
            },
          ],
          outputs: [],
        },
      ],
      functionName: 'aggregate3',
      args: [calls.map((c) => ({ ...c, allowFailure: false }))],
    })

  async function ejecutar(...claims: ReturnType<typeof makeClaimResponse>[]) {
    const hubClients = buildHubClients({
      publicClient: {
        getBalance: vi.fn().mockResolvedValue(10n ** 18n),
        // Por función: `authorizationState` (nonce de USDC) es un booleano. Un
        // objeto aquí se leería como «nonce ya usado» y rechazaría la buena.
        readContract: vi.fn(async ({ functionName }: { functionName: string }) =>
          functionName === 'authorizationState' || functionName === 'isBlacklisted'
            ? false
            : functionName === 'balanceOf'
              ? 10n ** 12n
              : {
                  merchant: MERCHANT,
                  amount: 5_000_000n,
                  operator: OPERATOR,
                  expiresAt: 9999999999n,
                  status: 0,
                },
        ),
        // Sin código: si la política dejara pasar algo, el settler intentaría
        // «desplegar» y esa sendTransaction sería la llamada del atacante.
        getCode: vi.fn().mockResolvedValue('0x'),
        waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: 'success', logs: [] }),
        simulateContract: vi.fn().mockResolvedValue({ result: 1n }),
        getContractEvents: vi.fn().mockResolvedValue([]),
      } as never,
      walletClient: {
        writeContract: vi.fn().mockResolvedValue('0xpaytx' as Hex),
        sendTransaction: vi.fn().mockResolvedValue('0xtx' as Hex),
      } as never,
    })
    const { api, postCalls } = buildApiMock()
    let entregado = false
    ;(api as unknown as { post: (p: string, b: unknown) => Promise<unknown> }).post = vi.fn(
      async (path: string, body: unknown) => {
        postCalls.push({ path, body })
        if (!path.endsWith('/claim-batch') || entregado) return null
        entregado = true
        return batchOf(...claims)
      },
    )
    const stop = startAuthorizationSettler({
      config: baseConfig,
      hubClients,
      api,
      logger: mockLogger as never,
    })
    await vi.advanceTimersByTimeAsync(5_001)
    for (let k = 0; k < 6; k++) await Promise.resolve()
    stop()
    const enviadas = (hubClients.walletClient.sendTransaction as ReturnType<typeof vi.fn>).mock
      .calls
    const escrituras = (
      hubClients.walletClient.writeContract as ReturnType<typeof vi.fn>
    ).mock.calls.map((c) => c[0] as { functionName: string; args: unknown[] })
    const rechazos = postCalls.filter((c) => c.path.endsWith('/rejected'))
    return { enviadas, escrituras, rechazos }
  }

  it('fábrica = USDC con transfer(atacante): no envía NADA y rechaza la autorización', async () => {
    const r = await ejecutar(makeClaimResponse({ signature: envolver(USDC, robo) }))
    expect(r.enviadas).toHaveLength(0)
    // Ni siquiera registra el intent: el rechazo va antes de gastar gas.
    expect(r.escrituras).toHaveLength(0)
    expect(r.rechazos.map((c) => c.path)).toEqual(['/v1/internal/authorizations/pa_1/rejected'])
    expect(JSON.stringify(r.rechazos[0]?.body)).toContain('erc6492_deploy_refused')
  })

  it('Multicall3 con un createAccount LEGÍTIMO más un transfer: rechaza el conjunto', async () => {
    // La sutileza: esta firma podría validar de verdad (el createAccount crea un
    // monedero real), así que verificarla no basta. Cada llamada desempaquetada
    // tiene que pasar la política por sí sola.
    const mixto = aggregate3([
      { target: FABRICA, callData: crear },
      { target: USDC, callData: robo },
    ])
    const r = await ejecutar(makeClaimResponse({ signature: envolver(MULTICALL3, mixto) }))
    expect(r.enviadas).toHaveLength(0)
    expect(r.escrituras).toHaveLength(0)
    expect(r.rechazos).toHaveLength(1)
  })

  it('Multicall3 con deactivate() del registro: rechaza', async () => {
    const desactivar = encodeFunctionData({
      abi: [
        {
          type: 'function',
          name: 'deactivate',
          inputs: [],
          outputs: [],
          stateMutability: 'nonpayable',
        },
      ],
      functionName: 'deactivate',
    })
    const r = await ejecutar(
      makeClaimResponse({
        signature: envolver(MULTICALL3, aggregate3([{ target: REGISTRY, callData: desactivar }])),
      }),
    )
    expect(r.enviadas).toHaveLength(0)
    expect(r.rechazos).toHaveLength(1)
  })

  it('acepta las dos versiones de la fábrica de Coinbase (v1 y v1.1)', async () => {
    // v1.1 es la que usa viem por defecto para monederos nuevos: dejarla fuera
    // rechazaría pagos legítimos.
    for (const fabrica of [FABRICA, '0xba5ed110efdba3d005bfc882d75358acbbb85842' as Hex]) {
      const r = await ejecutar(makeClaimResponse({ signature: envolver(fabrica, crear) }))
      expect(r.enviadas).toHaveLength(1)
      const envio = r.enviadas[0]?.[0] as { to: string } | undefined
      expect(envio?.to.toLowerCase()).toBe(fabrica.toLowerCase())
      // El mock no tiene código tras el despliegue, así que acaba rechazada —
      // pero por esa comprobación posterior, no por la política.
      expect(JSON.stringify(r.rechazos)).not.toContain('erc6492_deploy_refused')
    }
  })

  it('la fábrica permitida con otra función: rechaza', async () => {
    const r = await ejecutar(
      makeClaimResponse({ signature: envolver(FABRICA, '0x12345678' as Hex) }),
    )
    expect(r.enviadas).toHaveLength(0)
    expect(r.rechazos).toHaveLength(1)
  })

  it('un envoltorio ilegible es rechazo permanente, no un reintento eterno', async () => {
    const roto = `0x${'00'.repeat(20)}${MAGIC}` as Hex
    const r = await ejecutar(makeClaimResponse({ signature: roto }))
    expect(r.enviadas).toHaveLength(0)
    expect(r.rechazos).toHaveLength(1)
  })

  it('en un lote, la autorización rechazada NO envenena a las demás', async () => {
    // Un fallo dentro del lote deja TODAS las filas para reintentar. Si la
    // mala siguiera dentro, volvería en cada lote y lo tumbaría otra vez hasta
    // que caducaran las legítimas que iban con ella.
    const r = await ejecutar(
      makeClaimResponse({ id: 'pa_malo', intentId: 'pi_malo', signature: envolver(USDC, robo) }),
      makeClaimResponse({ id: 'pa_bueno', intentId: 'pi_bueno' }),
    )
    expect(r.enviadas).toHaveLength(0)
    expect(r.rechazos.map((c) => c.path)).toEqual(['/v1/internal/authorizations/pa_malo/rejected'])
    const pago = r.escrituras.find((e) => e.functionName === 'payIntentBatchWithAuthorization')
    expect(pago).toBeDefined()
    expect(pago?.args[0]).toHaveLength(1)
  })
})

describe('un registro que no pasa no hunde el lote (OCT-01, ADR-009 §2)', () => {
  type NombreDeError =
    | 'InvalidExpiry'
    | 'ZeroAddress'
    | 'EnforcedPause'
    | 'InvalidIntentSignature'
    | 'AmountTooLarge'

  /// La reversión tal como la entrega viem cuando el contrato revierte con un
  /// error de su ABI.
  const revertDelHub = (
    errorName: NombreDeError,
    functionName: 'registerIntent' | 'registerIntentBatch',
  ) =>
    new ContractFunctionExecutionError(
      new ContractFunctionRevertedError({
        abi: SETTLEMENT_HUB_ABI,
        data: encodeErrorResult({ abi: SETTLEMENT_HUB_ABI, errorName }),
        functionName,
      }),
      { abi: SETTLEMENT_HUB_ABI, functionName, args: [], contractAddress: HUB },
    )

  /// El evento con que el hub dice que saltó un registro, tal como llega en el
  /// recibo.
  const saltado = (intentId: Hex, errorName: NombreDeError) => ({
    address: HUB,
    topics: encodeEventTopics({
      abi: SETTLEMENT_HUB_ABI,
      eventName: 'IntentRegistrationSkipped',
      args: { intentId },
    }),
    data: encodeAbiParameters(
      [{ type: 'bytes' }],
      [encodeErrorResult({ abi: SETTLEMENT_HUB_ABI, errorName })],
    ),
  })

  /// El evento de un pago liquidado, tal como llega en el recibo.
  const liquidado = (intentId: Hex) => ({
    address: HUB,
    topics: encodeEventTopics({
      abi: SETTLEMENT_HUB_ABI,
      eventName: 'IntentSettled',
      args: { intentId, payer: PAYER },
    }),
    data: encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }],
      [4_925_000n, 52_500n, 22_500n],
    ),
  })

  const noRegistrado = {
    merchant: '0x0000000000000000000000000000000000000000',
    amount: 0n,
    operator: '0x0000000000000000000000000000000000000000',
    expiresAt: 0n,
    status: 0,
  }

  /// El id que calcula el hub para un registro: `intentIdOf(merchant, ref)`.
  const idDelRegistro = (r: { merchant: Hex; ref: Hex }) =>
    keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [r.merchant, r.ref]))

  /// Un hub de mentira que se comporta como el de ADR-009 en lo que importa
  /// aquí: `registerIntentBatch` salta el registro que no pasa —con su
  /// evento— y registra los demás; solo lo que es de todos (la pausa) lo hace
  /// revertir entero. `registerIntent` se puede simular uno a uno.
  function hubDeAdr009(malos: Record<string, NombreDeError | 'rpc'>, yaRegistrados: string[] = []) {
    const registrados = new Set<string>(yaRegistrados.map((id) => idDe(id).toLowerCase()))
    const malosPorId = new Map<string, NombreDeError | 'rpc'>(
      Object.entries(malos).map(([id, e]) => [idDe(id).toLowerCase(), e]),
    )
    const lotesDeRegistro: string[][] = []
    const lotesDePago: string[][] = []
    let saltadosDelUltimo: ReturnType<typeof saltado>[] = []
    let pagadosDelUltimo: ReturnType<typeof liquidado>[] = []
    const deTodos = (ids: string[]) =>
      ids.map((id) => malosPorId.get(id)).find((e) => e === 'EnforcedPause' || e === 'rpc')
    const hubClients = buildHubClients({
      publicClient: {
        getBalance: vi.fn().mockResolvedValue(10n ** 18n),
        readContract: vi.fn(async ({ args }: { args: [string] }) =>
          registrados.has(args[0].toLowerCase())
            ? { ...noRegistrado, merchant: MERCHANT, operator: OPERATOR }
            : noRegistrado,
        ),
        waitForTransactionReceipt: vi.fn(async ({ hash }: { hash: string }) =>
          hash === '0xreg'
            ? { status: 'success', logs: saltadosDelUltimo }
            : { status: 'success', logs: pagadosDelUltimo },
        ),
        simulateContract: vi.fn(
          async ({ functionName, args }: { functionName: string; args: [unknown] }) => {
            if (functionName === 'registerIntentBatch') {
              const ids = (args[0] as { merchant: Hex; ref: Hex }[]).map((r) =>
                idDelRegistro(r).toLowerCase(),
              )
              const comun = deTodos(ids)
              if (comun === 'rpc') throw new Error('fetch failed')
              if (comun) throw revertDelHub(comun, 'registerIntentBatch')
              return { result: BigInt(ids.filter((id) => !malosPorId.has(id)).length) }
            }
            if (functionName === 'registerIntent') {
              const malo = malosPorId.get(
                idDelRegistro(args[0] as { merchant: Hex; ref: Hex }).toLowerCase(),
              )
              if (malo === 'rpc') throw new Error('fetch failed')
              if (malo) throw revertDelHub(malo, 'registerIntent')
              return { result: undefined }
            }
            return { result: 1n } // el lote de pagos liquidaría
          },
        ),
      } as never,
      walletClient: {
        writeContract: vi.fn(
          async ({ functionName, args }: { functionName: string; args: [unknown[]] }) => {
            if (functionName === 'registerIntentBatch') {
              const ids = (args[0] as { merchant: Hex; ref: Hex }[]).map((r) =>
                idDelRegistro(r).toLowerCase(),
              )
              lotesDeRegistro.push(ids)
              saltadosDelUltimo = []
              for (const id of ids) {
                const malo = malosPorId.get(id)
                if (malo && malo !== 'rpc' && malo !== 'EnforcedPause') {
                  saltadosDelUltimo.push(saltado(id as Hex, malo))
                } else {
                  registrados.add(id)
                }
              }
              return '0xreg' as Hex
            }
            const pagados = (args[0] as { intentId: string }[]).map((a) => a.intentId.toLowerCase())
            lotesDePago.push(pagados)
            pagadosDelUltimo = pagados.map((p) => liquidado(p as Hex))
            return '0xpay' as Hex
          },
        ),
      } as never,
    })
    return { hubClients, lotesDeRegistro, lotesDePago }
  }

  async function unaVuelta(
    hubClients: DaemonChainClients,
    ...claims: ReturnType<typeof makeClaimResponse>[]
  ) {
    const { api, postCalls } = buildApiMock()
    let primera = true
    ;(api as unknown as { post: (p: string, b: unknown) => Promise<unknown> }).post = vi.fn(
      async (path: string, body: unknown) => {
        postCalls.push({ path, body })
        if (primera && path.endsWith('/claim-batch')) {
          primera = false
          return batchOf(...claims)
        }
        return path.endsWith('/claim-batch') ? { authorizations: [] } : null
      },
    )
    const stop = startAuthorizationSettler({
      config: baseConfig,
      hubClients,
      api,
      logger: mockLogger as never,
    })
    await vi.advanceTimersByTimeAsync(5_001)
    for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(0)
    stop()
    return postCalls.filter((c) => c.path.endsWith('/rejected'))
  }

  const claim = (n: string) => makeClaimResponse({ id: `pa_${n}`, intentId: `pi_${n}` })
  const id = (n: string) => idDe(`pi_${n}`).toLowerCase()

  it('el hub salta el registro que nunca aceptará: se rechaza; los demás se registran en el mismo lote y se cobran', async () => {
    const { hubClients, lotesDeRegistro, lotesDePago } = hubDeAdr009({ pi_malo: 'InvalidExpiry' })

    const rechazos = await unaVuelta(hubClients, claim('1'), claim('malo'), claim('2'))

    expect(rechazos).toEqual([
      {
        path: '/v1/internal/authorizations/pa_malo/rejected',
        body: { reason: 'registration_refused: InvalidExpiry' },
      },
    ])
    // Un solo lote de registro: el hub ya no revierte entero.
    expect(lotesDeRegistro).toEqual([[id('1'), id('malo'), id('2')]])
    expect(lotesDePago).toEqual([[id('1'), id('2')]])
  })

  it('las demás causas propias del registro también son rechazo: dirección cero, importe excesivo', async () => {
    const { hubClients, lotesDePago } = hubDeAdr009({
      pi_a: 'ZeroAddress',
      pi_b: 'AmountTooLarge',
    })

    const rechazos = await unaVuelta(hubClients, claim('a'), claim('1'), claim('b'))

    expect(rechazos.map((r) => r.path).sort()).toEqual([
      '/v1/internal/authorizations/pa_a/rejected',
      '/v1/internal/authorizations/pa_b/rejected',
    ])
    expect(lotesDePago).toEqual([[id('1')]])
  })

  it('una firma de registro que el gate no acepta no se rechaza: sale de esta vuelta y los demás se cobran', async () => {
    const { hubClients, lotesDePago } = hubDeAdr009({ pi_malo: 'InvalidIntentSignature' })

    const rechazos = await unaVuelta(hubClients, claim('1'), claim('malo'))

    expect(rechazos).toEqual([])
    expect(lotesDePago).toEqual([[id('1')]])
  })

  it('con el hub en pausa no se envía el lote de registro, no se rechaza a nadie, y lo ya registrado se cobra igual', async () => {
    const { hubClients, lotesDeRegistro, lotesDePago } = hubDeAdr009(
      { pi_nuevo: 'EnforcedPause' },
      ['pi_viejo'],
    )

    const rechazos = await unaVuelta(hubClients, claim('viejo'), claim('nuevo'))

    expect(rechazos).toEqual([])
    expect(lotesDeRegistro).toEqual([])
    // La pausa bloquea registros, no pagos.
    expect(lotesDePago).toEqual([[id('viejo')]])
  })

  it('si la simulación del lote falla (RPC), tampoco se rechaza, y lo ya registrado se cobra', async () => {
    const { hubClients, lotesDePago } = hubDeAdr009({ pi_malo: 'rpc' }, ['pi_1'])

    const rechazos = await unaVuelta(hubClients, claim('1'), claim('malo'))

    expect(rechazos).toEqual([])
    expect(lotesDePago).toEqual([[id('1')]])
  })

  it('si el lote no registraría ninguno, no se envía: se nombra el motivo de cada uno, sin gastar gas', async () => {
    const { hubClients, lotesDeRegistro, lotesDePago } = hubDeAdr009({
      pi_a: 'InvalidExpiry',
      pi_b: 'InvalidIntentSignature',
    })

    const rechazos = await unaVuelta(hubClients, claim('a'), claim('b'))

    expect(lotesDeRegistro).toEqual([])
    expect(lotesDePago).toEqual([])
    // El que nunca pasará se rechaza; el de la firma, no.
    expect(rechazos.map((r) => r.path)).toEqual(['/v1/internal/authorizations/pa_a/rejected'])
  })

  it('si el lote falla al enviarse, se reintenta entero y no se rechaza a nadie', async () => {
    const { hubClients, lotesDePago } = hubDeAdr009({})
    ;(hubClients.walletClient.writeContract as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('nonce too low'),
    )

    const rechazos = await unaVuelta(hubClients, claim('1'), claim('2'))

    expect(rechazos).toEqual([])
    expect(lotesDePago).toEqual([])
  })
})

describe('lo que la API entrega tiene que cuadrar (ADR-009 §3)', () => {
  async function conUnReclamo(c: ReturnType<typeof makeClaimResponse>) {
    const hubClients = buildHubClients()
    const { api, postCalls } = buildApiMock()
    let primera = true
    ;(api as unknown as { post: (p: string, b: unknown) => Promise<unknown> }).post = vi.fn(
      async (path: string, body: unknown) => {
        postCalls.push({ path, body })
        if (primera && path.endsWith('/claim-batch')) {
          primera = false
          return batchOf(c)
        }
        return path.endsWith('/claim-batch') ? { authorizations: [] } : null
      },
    )
    const stop = startAuthorizationSettler({
      config: baseConfig,
      hubClients,
      api,
      logger: mockLogger as never,
    })
    await vi.advanceTimersByTimeAsync(5_001)
    for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(0)
    stop()
    return { rechazos: postCalls.filter((p) => p.path.endsWith('/rejected')), hubClients }
  }

  it('un intent_id que no es intentIdOf(comercio, id): se rechaza sin enviar nada', async () => {
    const c = makeClaimResponse()
    c.registration.intent_id = intentIdOf('0x5555555555555555555555555555555555555555', 'pi_test')
    const { rechazos, hubClients } = await conUnReclamo(c)
    expect(rechazos.map((r) => (r.body as { reason: string }).reason)).toEqual([
      'incoherent_claim: intent_id',
    ])
    expect(hubClients.walletClient.writeContract).not.toHaveBeenCalled()
  })

  it('un nonce que no es ese id: se rechaza sin enviar nada', async () => {
    const c = makeClaimResponse()
    c.authorization.nonce = idDe('pi_otro') as Hex
    const { rechazos, hubClients } = await conUnReclamo(c)
    expect(rechazos.map((r) => (r.body as { reason: string }).reason)).toEqual([
      'incoherent_claim: nonce',
    ])
    expect(hubClients.walletClient.writeContract).not.toHaveBeenCalled()
  })

  it('un ref que no es el del id: se rechaza sin enviar nada', async () => {
    const c = makeClaimResponse()
    c.registration.ref = intentRef('pi_otro')
    const { rechazos } = await conUnReclamo(c)
    expect(rechazos.map((r) => (r.body as { reason: string }).reason)).toEqual([
      'incoherent_claim: ref',
    ])
  })

  it('lo coherente se registra con ref, y se paga con ese id', async () => {
    const { rechazos, hubClients } = await conUnReclamo(makeClaimResponse())
    expect(rechazos).toEqual([])
    const llamadas = (hubClients.walletClient.writeContract as ReturnType<typeof vi.fn>).mock.calls
    const registro = llamadas.find(
      (l) => (l[0] as { functionName: string }).functionName === 'registerIntent',
    )
    expect(registro).toBeDefined()
    const [{ args }] = registro as [{ args: [{ ref: Hex }] }]
    expect(args[0].ref).toBe(intentRef('pi_test'))
  })
})

describe('un lote que no liquida nada no se envía, y lo saltado se clasifica (OCT-04)', () => {
  const PAGADOR_POBRE = '0x5555555555555555555555555555555555555555'

  /// Una cadena que contesta como la real a lo que el settler pregunta para
  /// clasificar: el nonce de USDC, el saldo, la lista negra y el intent.
  function cadena(o: {
    liquidaria: bigint
    saldos?: Record<string, bigint>
    bloqueadas?: string[]
    lecturaFalla?: boolean
    logs?: unknown[]
  }) {
    const hubClients = buildHubClients({
      publicClient: {
        getBalance: vi.fn().mockResolvedValue(10n ** 18n),
        readContract: vi.fn(
          async ({ functionName, args }: { functionName: string; args?: string[] }) => {
            if (o.lecturaFalla && functionName !== 'getIntent') throw new Error('rpc caído')
            const a = String(args?.[0] ?? '').toLowerCase()
            if (functionName === 'authorizationState') return false
            if (functionName === 'balanceOf') return o.saldos?.[a] ?? 10n ** 12n
            if (functionName === 'isBlacklisted') return (o.bloqueadas ?? []).includes(a)
            // getIntent: registrado, con su comercio y su operador.
            return {
              merchant: MERCHANT,
              amount: 5_000_000n,
              operator: OPERATOR,
              expiresAt: 9999999999n,
              status: 0,
            }
          },
        ),
        waitForTransactionReceipt: vi
          .fn()
          .mockResolvedValue({ status: 'success', logs: o.logs ?? [] }),
        simulateContract: vi.fn().mockResolvedValue({ result: o.liquidaria }),
      } as never,
      walletClient: { writeContract: vi.fn().mockResolvedValue('0xpay' as Hex) } as never,
    })
    return hubClients
  }

  async function vuelta(
    hubClients: DaemonChainClients,
    ...claims: ReturnType<typeof makeClaimResponse>[]
  ) {
    const { api, postCalls } = buildApiMock()
    let primera = true
    ;(api as unknown as { post: (p: string, b: unknown) => Promise<unknown> }).post = vi.fn(
      async (path: string, body: unknown) => {
        postCalls.push({ path, body })
        if (primera && path.endsWith('/claim-batch')) {
          primera = false
          return batchOf(...claims)
        }
        return path.endsWith('/claim-batch') ? { authorizations: [] } : null
      },
    )
    const stop = startAuthorizationSettler({
      config: baseConfig,
      hubClients,
      api,
      logger: mockLogger as never,
    })
    await vi.advanceTimersByTimeAsync(5_001)
    for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(0)
    stop()
    const pagos = (
      hubClients.walletClient.writeContract as ReturnType<typeof vi.fn>
    ).mock.calls.filter(
      (c) => (c[0] as { functionName: string }).functionName === 'payIntentBatchWithAuthorization',
    )
    return { rechazos: postCalls.filter((c) => c.path.endsWith('/rejected')), pagos }
  }

  const claim = (n: string, payer = PAYER) => {
    const c = makeClaimResponse({ id: `pa_${n}`, intentId: `pi_${n}` })
    c.authorization.payer_address = payer
    return c
  }

  it('si el contrato no liquidaría ninguno, no se envía: no se paga gas por nada', async () => {
    const r = await vuelta(cadena({ liquidaria: 0n }), claim('1'), claim('2'))
    expect(r.pagos).toHaveLength(0)
    // Nada propio de ninguno (p. ej., la tesorería bloqueada): no se rechaza a nadie.
    expect(r.rechazos).toEqual([])
  })

  it('sin saldo: se rechaza con un motivo que el checkout entiende (que cargue USDC)', async () => {
    const r = await vuelta(
      cadena({ liquidaria: 0n, saldos: { [PAGADOR_POBRE.toLowerCase()]: 1_000_000n } }),
      claim('pobre', PAGADOR_POBRE),
      claim('1'),
    )
    expect(r.rechazos).toHaveLength(1)
    const [rechazo] = r.rechazos
    expect(rechazo?.path).toBe('/v1/internal/authorizations/pa_pobre/rejected')
    expect((rechazo?.body as { reason: string } | undefined)?.reason).toMatch(
      /^insufficient balance/,
    )
  })

  it('el comercio en la lista negra de USDC: se rechaza', async () => {
    // Dos: con uno solo, el nodeit va por el camino individual, no por el lote.
    const r = await vuelta(
      cadena({ liquidaria: 0n, bloqueadas: [MERCHANT.toLowerCase()] }),
      claim('1'),
      claim('2'),
    )
    expect(r.rechazos.map((c) => (c.body as { reason: string }).reason)).toEqual([
      'usdc_blacklisted: merchant',
      'usdc_blacklisted: merchant',
    ])
  })

  it('el operador en la lista negra ya no es motivo: su comisión se acredita, no se le transfiere (ADR-009)', async () => {
    const r = await vuelta(
      cadena({ liquidaria: 0n, bloqueadas: [OPERATOR.toLowerCase()] }),
      claim('1'),
      claim('2'),
    )
    expect(r.rechazos).toEqual([])
  })

  it('si una lectura falla, no se rechaza: ante la duda, se reintenta', async () => {
    const r = await vuelta(cadena({ liquidaria: 0n, lecturaFalla: true }), claim('1'), claim('2'))
    expect(r.rechazos).toEqual([])
  })

  it('un lote que sí se envía clasifica igual lo que saltó', async () => {
    const r = await vuelta(
      cadena({ liquidaria: 1n, saldos: { [PAGADOR_POBRE.toLowerCase()]: 0n } }),
      claim('pobre', PAGADOR_POBRE),
      claim('1'),
    )
    expect(r.pagos).toHaveLength(1)
    // El recibo no trae eventos: ninguno consta como liquidado. El pobre se
    // rechaza; el otro queda para otra vuelta.
    expect(r.rechazos.map((c) => c.path)).toEqual(['/v1/internal/authorizations/pa_pobre/rejected'])
  })
})

describe('un solo pago: una reversión de todos no se castiga a uno', () => {
  async function pagoSolo(error: Error) {
    const hubClients = buildHubClients()
    ;(hubClients.walletClient.writeContract as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      error,
    )
    const { api, postCalls } = buildApiMock()
    let primera = true
    ;(api as unknown as { post: (p: string, b: unknown) => Promise<unknown> }).post = vi.fn(
      async (path: string, body: unknown) => {
        postCalls.push({ path, body })
        if (primera) {
          primera = false
          return batchOf(makeClaimResponse())
        }
        return path.endsWith('/claim-batch') ? { authorizations: [] } : null
      },
    )
    const stop = startAuthorizationSettler({
      config: baseConfig,
      hubClients,
      api,
      logger: mockLogger as never,
    })
    await vi.advanceTimersByTimeAsync(5_001)
    for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(0)
    stop()
    return postCalls.filter((c) => c.path.endsWith('/rejected'))
  }

  const revert = (errorName: 'EnforcedPause' | 'InvalidIntentSignature' | 'InvalidExpiry') =>
    new ContractFunctionExecutionError(
      new ContractFunctionRevertedError({
        abi: SETTLEMENT_HUB_ABI,
        data: encodeErrorResult({ abi: SETTLEMENT_HUB_ABI, errorName }),
        functionName: 'registerIntent',
      }),
      { abi: SETTLEMENT_HUB_ABI, functionName: 'registerIntent', args: [], contractAddress: HUB },
    )

  it('el hub en pausa: la autorización queda para otra vuelta, no se rechaza', async () => {
    expect(await pagoSolo(revert('EnforcedPause'))).toEqual([])
  })

  it('la firma del registro no cuadra con el firmante: tampoco se rechaza', async () => {
    expect(await pagoSolo(revert('InvalidIntentSignature'))).toEqual([])
  })

  it('un registro que no pasará nunca sí se rechaza, como antes', async () => {
    const rechazos = await pagoSolo(revert('InvalidExpiry'))
    expect(rechazos).toHaveLength(1)
    expect(rechazos[0]?.path).toBe('/v1/internal/authorizations/pa_1/rejected')
  })
})

describe('/health sabe si la API deja trabajar al nodo', () => {
  /// Una vuelta del settler con la respuesta indicada de /claim-batch.
  async function vueltaCon(respuesta: () => Promise<unknown>) {
    initNodeStatus({ enabled: true, chain: 'base-sepolia' })
    const { api } = buildApiMock()
    ;(api as unknown as { post: (p: string, b: unknown) => Promise<unknown> }).post =
      vi.fn(respuesta)
    const stop = startAuthorizationSettler({
      config: baseConfig,
      hubClients: buildHubClients(),
      api,
      logger: mockLogger as never,
    })
    await vi.advanceTimersByTimeAsync(5_001)
    stop()
    return computeHealth()
  }

  it('un 403 es «rechazado»: el nodeit no está activo para la API', async () => {
    const h = await vueltaCon(async () => {
      throw new InternalApiError(403, '/v1/internal/authorizations/claim-batch', 'inactive')
    })
    expect(h.api).toBe('rejected')
    expect(h.status).toBe('down')
  })

  it('la API habla otra versión del canal: «incompatible», no un rechazo cualquiera', async () => {
    const h = await vueltaCon(async () => {
      throw new InternalApiError(403, '/v1/internal/authorizations/claim-batch', 'forbidden', '3')
    })
    expect(h.api).toBe('incompatible')
    expect(h.status).toBe('down')
  })

  it('cualquier otro fallo es «caída»', async () => {
    const h = await vueltaCon(async () => {
      throw new Error('fetch failed')
    })
    expect(h.api).toBe('down')
    expect(h.status).toBe('down')
  })

  it('una respuesta, aunque venga vacía, es «ok»', async () => {
    const h = await vueltaCon(async () => batchOf())
    expect(h.api).toBe('ok')
  })
})
