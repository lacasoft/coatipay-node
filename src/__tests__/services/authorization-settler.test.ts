import { encodeAbiParameters, type Hex } from 'viem'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DaemonChainClients } from '../../lib/chain-client'
import { InternalApiClient } from '../../lib/internal-api-client'
import { startAuthorizationSettler } from '../../services/authorization-settler'

const HUB = '0x1111111111111111111111111111111111111111' as `0x${string}`
const OPERATOR = '0x2222222222222222222222222222222222222222' as `0x${string}`
const PAYER = '0x3333333333333333333333333333333333333333' as `0x${string}`
const MERCHANT = '0x4444444444444444444444444444444444444444' as `0x${string}`

const baseConfig = {
  port: 4000,
  operatorAddress: OPERATOR,
  privateKey: `0x${'01'.repeat(32)}` as Hex,
  endpoint: 'http://localhost:4000',
  baseRpcUrl: 'https://sepolia.base.org',
  baseRpcFallbackUrls: [],
  nodeRegistryAddress: '0xRegistry',
  stakeManagerAddress: '0xStake',
  settlementHubAddress: HUB,
  usdcAddress: '0xUSDC',
  apiUrl: 'http://localhost:3000',
  eventMaxBlockRange: 9,
  eventPollIntervalMs: 4000,
  eventLookbackBlocks: 2000,
  minPaymentAmount: 0, // floor disabled by default; specific tests override
  gasPriceRefGwei: 0.02,
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
      nonce: '0xabcd000000000000000000000000000000000000000000000000000000000000',
      signature: overrides.signature ?? `0x${'ab'.repeat(65)}`,
    },
    intent: {
      intent_id: intentId,
      merchant_address: MERCHANT,
      amount: '5000000',
      expires_at: String(Math.floor(Date.now() / 1000) + 1800),
      on_chain_id: (overrides.onChainId ?? null) as string | null,
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

  it('happy path: claim → registerIntent → submit → no callback (event watcher does the rest)', async () => {
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

    // Sequence of API responses:
    //   call 1 = /claim-batch → returns one-element batch envelope
    //   call 2 = /intents/:id/registered → returns null (ok)
    let callIndex = 0
    const responses = [batchOf(makeClaimResponse()), null] // claim-batch + registered
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

    // API calls: claim-batch + intents/registered (NO settled callback)
    expect(postCalls.map((c) => c.path)).toEqual([
      '/v1/internal/authorizations/claim-batch',
      '/v1/internal/intents/pi_test/registered',
    ])
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

    // API path: only claim + on_chain_id race recovery (since DB had null)
    expect(postCalls.some((c) => c.path === '/v1/internal/intents/pi_test/registered')).toBe(true)
  })

  it('ERC-6492: deploys the counterfactual wallet, then settles with the inner sig', async () => {
    const FACTORY = '0x5555555555555555555555555555555555555555' as Hex
    const FACTORY_CALLDATA = '0xdeadbeef' as Hex
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
    const REAL_FACTORY = '0xba5ed1f7ee9c56e12a0e2c90cdc0ae93ef8d2f00' as Hex
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
      ['0x5555555555555555555555555555555555555555', '0xdeadbeef', INNER_SIG],
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
    ;(hubClients.publicClient.readContract as ReturnType<typeof vi.fn>).mockResolvedValue({
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
      null, // intents/pi_1/registered
      null, // intents/pi_2/registered
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
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
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

  it('batch path: skips registerIntentBatch when all intents already on-chain', async () => {
    const hubClients = buildHubClients()
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

  it('backs off polling cadence when the queue stays empty', async () => {
    // With setInterval at 5s, an idle settler hammered the API and RPC
    // 12 times per minute even when there was nothing to settle. The
    // backoff (5 → 10 → 20 → 40 → 60s cap) cuts that to ~4 ticks per
    // 75 seconds. We assert the upper bound here — under setInterval
    // the same window would have produced ~15 ticks.
    const hubClients = buildHubClients()
    const { api, postCalls } = buildApiMock()
    ;(api as unknown as { post: (p: string, b: unknown) => Promise<unknown> }).post = vi.fn(
      async (path: string, body: unknown) => {
        postCalls.push({ path, body })
        return batchOf() // always empty — drives the backoff
      },
    )

    const stop = startAuthorizationSettler({
      config: baseConfig,
      hubClients,
      api,
      logger: mockLogger as never,
    })

    // 75 seconds: schedule should produce ticks at +5s, +15s, +35s, +75s.
    await vi.advanceTimersByTimeAsync(75_001)
    await Promise.resolve()
    stop()

    // Under setInterval(5s) this would be 15. Backed-off settler: at most 5.
    expect(postCalls.length).toBeGreaterThanOrEqual(3)
    expect(postCalls.length).toBeLessThanOrEqual(5)
  })

  it('resets to base interval when a cycle finds work after a backoff', async () => {
    // First two ticks: empty → backoff to 10s and 20s.
    // Third tick (at +35s): returns 1 claim → backoff must reset.
    // Fourth tick should fire at +35s + 5s = +40s, not +35s + 40s = +75s.
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

    // Advance to +45s: at +5s empty, +15s empty, +35s WORK → reset to base,
    // next tick at +40s should fire — bringing claim-batch posts to 4.
    await vi.advanceTimersByTimeAsync(45_001)
    await Promise.resolve()
    await Promise.resolve()
    stop()

    const claimPosts = postCalls.filter((c) => c.path === '/v1/internal/authorizations/claim-batch')
    // Without the reset: +5s, +15s, +35s, +75s → only 3 within 45s.
    // With reset on cycle 3 (work found): +5s, +15s, +35s, +40s → 4 within 45s.
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
        nonce: '0xabcd000000000000000000000000000000000000000000000000000000000000',
        signature: `0x${'ab'.repeat(65)}`,
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
