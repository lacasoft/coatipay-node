import type { Hex } from 'viem'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DaemonChainClients } from '../../lib/chain-client'
import { InternalApiClient, InternalApiError } from '../../lib/internal-api-client'
import { startSettlementEventWatcher } from '../../services/settlement-event-watcher'

const HUB = '0x1111111111111111111111111111111111111111' as `0x${string}`
const OPERATOR = '0x2222222222222222222222222222222222222222' as `0x${string}`
const PAYER = '0x3333333333333333333333333333333333333333' as `0x${string}`

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
  minPaymentAmount: 0,
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

interface EventLog {
  args: {
    intentId: Hex
    payer: `0x${string}`
    merchantAmount: bigint
    operatorFee: bigint
    treasuryFee: bigint
  }
  transactionHash: Hex
}

/**
 * Build mock chain clients with controllable getBlockNumber + getContractEvents.
 * `headByCall` lets a test return a fixed head; `eventsByWindow` is a queue of
 * log batches returned by successive getContractEvents calls.
 */
function buildHubClients(opts: {
  head: bigint
  getContractEvents?: ReturnType<typeof vi.fn>
}): DaemonChainClients {
  return {
    publicClient: {
      getBlockNumber: vi.fn().mockResolvedValue(opts.head),
      getContractEvents: opts.getContractEvents ?? vi.fn().mockResolvedValue([]),
    } as never,
    walletClient: {} as never,
    account: { address: OPERATOR } as never,
    settlementHubAddress: HUB,
    chainName: 'base-sepolia',
  } as DaemonChainClients
}

function buildApiMock(): { api: InternalApiClient; calls: unknown[] } {
  const calls: unknown[] = []
  const api = new InternalApiClient({
    apiUrl: 'http://localhost:3000',
    privateKey: `0x${'01'.repeat(32)}`,
  })
  ;(api as unknown as { post: (p: string, b: unknown) => Promise<unknown> }).post = vi.fn(
    async (_path: string, body: unknown) => {
      calls.push(body)
      return { ok: true, applied: true }
    },
  )
  return { api, calls }
}

function makeLog(intentId: Hex, txHash: Hex): EventLog {
  return {
    args: {
      intentId,
      payer: PAYER,
      merchantAmount: 990_000n,
      operatorFee: 7_000n,
      treasuryFee: 3_000n,
    },
    transactionHash: txHash,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('startSettlementEventWatcher', () => {
  it('no-op in dev mode', () => {
    const { api } = buildApiMock()
    const stop = startSettlementEventWatcher({
      config: { ...baseConfig, settlementHubAddress: '0x0000000000000000000000000000000000000000' },
      hubClients: null,
      api,
      logger: mockLogger as never,
    })
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('Disabled'))
    stop()
  })

  it('on IntentSettled event → calls API /settlements/by-on-chain-id with correct payload', async () => {
    const onChainId = `0x${'a'.repeat(64)}` as Hex
    const txHash = `0x${'b'.repeat(64)}` as Hex
    // Head is within lookback so a single window covers it.
    const getEvents = vi.fn().mockResolvedValue([makeLog(onChainId, txHash)])
    const hubClients = buildHubClients({ head: 100n, getContractEvents: getEvents })
    const { api, calls } = buildApiMock()

    const stop = startSettlementEventWatcher({
      config: baseConfig,
      hubClients,
      api,
      logger: mockLogger as never,
    })

    await vi.advanceTimersByTimeAsync(1)
    await vi.waitFor(() => expect(calls.length).toBeGreaterThan(0))

    expect(calls[0]).toEqual(
      expect.objectContaining({ on_chain_id: onChainId, tx_hash: txHash, payer_address: PAYER }),
    )
    stop()
  })

  it('chunks getContractEvents into windows of at most eventMaxBlockRange', async () => {
    // Head far enough ahead of the lookback start that multiple windows are
    // needed. lookback=2000, head=2000 → cursor starts at 0, must scan
    // [0..2000] in windows of ≤9 → at least ceil(2001/9) calls, and NO
    // single call may exceed a 9-block span.
    const getEvents = vi.fn().mockResolvedValue([])
    const hubClients = buildHubClients({ head: 2000n, getContractEvents: getEvents })
    const { api } = buildApiMock()

    const stop = startSettlementEventWatcher({
      config: baseConfig,
      hubClients,
      api,
      logger: mockLogger as never,
    })

    await vi.advanceTimersByTimeAsync(1)
    await vi.waitFor(() => expect(getEvents.mock.calls.length).toBeGreaterThan(100))

    // Every window must fit the provider cap (≤ 9 blocks → to-from ≤ 8).
    for (const call of getEvents.mock.calls) {
      const { fromBlock, toBlock } = call[0] as { fromBlock: bigint; toBlock: bigint }
      expect(toBlock - fromBlock).toBeLessThanOrEqual(8n)
    }
    stop()
  })

  it('warns + continues when API returns 404 (race with /registered)', async () => {
    const getEvents = vi
      .fn()
      .mockResolvedValue([makeLog(`0x${'c'.repeat(64)}` as Hex, `0x${'d'.repeat(64)}` as Hex)])
    const hubClients = buildHubClients({ head: 50n, getContractEvents: getEvents })
    const api = new InternalApiClient({
      apiUrl: 'http://localhost:3000',
      privateKey: `0x${'01'.repeat(32)}` as `0x${string}`,
    })
    ;(api as unknown as { post: (p: string, b: unknown) => Promise<unknown> }).post = vi.fn(
      async () => {
        throw new InternalApiError(404, '/v1/internal/settlements/by-on-chain-id', 'not found')
      },
    )

    const stop = startSettlementEventWatcher({
      config: baseConfig,
      hubClients,
      api,
      logger: mockLogger as never,
    })

    await vi.advanceTimersByTimeAsync(1)
    await vi.waitFor(() =>
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ on_chain_id: expect.any(String) }),
        expect.stringContaining('intent not found in DB yet'),
      ),
    )
    // 404 is swallowed → no poll-error logged for it.
    expect(mockLogger.error).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('poll error'),
    )
    stop()
  })

  it('logs poll error + retries when getContractEvents throws (provider blip)', async () => {
    const getEvents = vi
      .fn()
      .mockRejectedValueOnce(new Error('range too wide'))
      .mockResolvedValue([])
    const hubClients = buildHubClients({ head: 50n, getContractEvents: getEvents })
    const { api } = buildApiMock()

    const stop = startSettlementEventWatcher({
      config: baseConfig,
      hubClients,
      api,
      logger: mockLogger as never,
    })

    await vi.advanceTimersByTimeAsync(1)
    await vi.waitFor(() =>
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.stringContaining('range too wide') }),
        expect.stringContaining('poll error'),
      ),
    )

    // Next tick retries (cursor not advanced past the failed window).
    await vi.advanceTimersByTimeAsync(baseConfig.eventPollIntervalMs)
    expect(getEvents.mock.calls.length).toBeGreaterThan(1)
    stop()
  })
})
