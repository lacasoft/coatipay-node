import { describe, expect, it } from 'vitest'
import {
  deriveHealth,
  GAS_CRITICAL_WEI,
  GAS_WARNING_WEI,
  type NodeStatusState,
} from '../../lib/node-status.js'

const NOW = 1_700_000_000_000

/// A fully-healthy enabled node, 60s uptime, everything fresh. Override
/// individual fields per test.
function healthyState(overrides: Partial<NodeStatusState> = {}): NodeStatusState {
  return {
    startedAt: NOW - 60_000,
    enabled: true,
    chain: 'base',
    balanceWei: 10n ** 18n, // 1 ETH
    balanceAt: NOW - 5_000,
    rpcOk: true,
    settlerLastTickAt: NOW - 5_000,
    watcherLastTickAt: NOW - 4_000,
    watcherErroring: false,
    ...overrides,
  }
}

describe('deriveHealth', () => {
  it('reports everything green when healthy', () => {
    const h = deriveHealth(healthyState(), NOW)
    expect(h).toMatchObject({
      status: 'ok',
      chain: 'base',
      gas: 'healthy',
      rpc: 'ok',
      settler: 'running',
      watcher: 'synced',
      version: '0.1.0',
    })
    expect(h.uptime_seconds).toBe(60)
  })

  it('gas → warning between the critical and warning thresholds (degraded)', () => {
    const balance = GAS_CRITICAL_WEI + (GAS_WARNING_WEI - GAS_CRITICAL_WEI) / 2n
    const h = deriveHealth(healthyState({ balanceWei: balance }), NOW)
    expect(h.gas).toBe('warning')
    expect(h.status).toBe('degraded')
  })

  it('gas → critical below the settle threshold (down — settling paused)', () => {
    const h = deriveHealth(healthyState({ balanceWei: GAS_CRITICAL_WEI - 1n }), NOW)
    expect(h.gas).toBe('critical')
    expect(h.status).toBe('down')
  })

  it('rpc → down after a read failure, gas → offline (down)', () => {
    const h = deriveHealth(healthyState({ rpcOk: false }), NOW)
    expect(h.rpc).toBe('down')
    expect(h.gas).toBe('offline') // can't see the chain
    expect(h.status).toBe('down')
  })

  it('settler → stalled when no tick within the staleness window (down)', () => {
    const h = deriveHealth(healthyState({ settlerLastTickAt: NOW - 200_000 }), NOW)
    expect(h.settler).toBe('stalled')
    expect(h.status).toBe('down')
  })

  it('watcher → stalled when no poll within the staleness window (down)', () => {
    const h = deriveHealth(healthyState({ watcherLastTickAt: NOW - 90_000 }), NOW)
    expect(h.watcher).toBe('stalled')
    expect(h.status).toBe('down')
  })

  it('watcher → lagging when the last poll errored but the loop is alive (degraded)', () => {
    const h = deriveHealth(healthyState({ watcherErroring: true }), NOW)
    expect(h.watcher).toBe('lagging')
    expect(h.status).toBe('degraded')
  })

  it('boot warm-up: no balance read yet is degraded, not down', () => {
    // rpc is up, loops are ticking, but the first getBalance hasn't resolved.
    const h = deriveHealth(healthyState({ balanceWei: null, balanceAt: null }), NOW)
    expect(h.gas).toBe('offline')
    expect(h.status).toBe('degraded') // NOT down — it's starting up
  })

  it('disabled (dev / no SettlementHub): ok with services flagged disabled', () => {
    const h = deriveHealth(healthyState({ enabled: false, chain: 'dev' }), NOW)
    expect(h).toMatchObject({
      status: 'ok',
      chain: 'dev',
      settler: 'disabled',
      watcher: 'disabled',
      gas: 'offline',
      rpc: 'down',
    })
  })

  it('uses boot time as the staleness baseline before the first tick', () => {
    // Just booted (5s ago), no ticks yet → not stalled (grace from boot).
    const h = deriveHealth(
      healthyState({
        startedAt: NOW - 5_000,
        settlerLastTickAt: null,
        watcherLastTickAt: null,
        balanceWei: null,
        balanceAt: null,
      }),
      NOW,
    )
    expect(h.settler).toBe('running')
    expect(h.watcher).toBe('synced')
  })
})
