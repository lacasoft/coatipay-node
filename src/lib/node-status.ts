// Shared, in-memory node health snapshot.
//
// The settler loop records raw observations here each cycle
// (last tick time, last ETH balance, whether the last RPC read succeeded).
// The public `/health` route derives a coarse, non-sensitive status from
// those facts via `computeHealth()`.
//
// Design: the loops record FACTS; `deriveHealth` is a PURE function of a
// state snapshot + the current time, so the coarse buckets are unit-testable
// without a running daemon. Nothing here exposes exact balances, block
// numbers, or addresses — only health buckets safe for a public endpoint.

import { VERSION } from './version'

/// ETH balance at/below which the settler pauses settling → gas `critical`.
/// SSOT: the AuthorizationSettler imports this as its skip threshold, so the
/// gauge boundary and the actual pause condition can never drift apart.
export const GAS_CRITICAL_WEI = 1_000_000_000_000_000n // 0.001 ETH
/// Comfortable buffer above the critical floor. Between the two → `warning`
/// (still settling, but the operator should top up soon). 5× the floor.
export const GAS_WARNING_WEI = 5n * GAS_CRITICAL_WEI // 0.005 ETH

/// No settler tick in this long ⇒ the loop is hung/dead. Idle, the settler
/// ticks at least every 10 s; a tick with work (register, pay, wait for the
/// receipt) can take 30-60 s on a slow chain. 150 s can't false-positive on
/// either.
const SETTLER_STALE_MS = 150_000

export type GasStatus = 'healthy' | 'warning' | 'critical' | 'offline'
export type RpcStatus = 'ok' | 'down'
export type SettlerStatus = 'running' | 'stalled' | 'disabled'
/// Si la API acepta al nodo. `rejected` = 403 (no autorizado: stake por debajo
/// del mínimo, dado de baja…); `incompatible` = la API habla otra versión del
/// canal y hay que actualizar el nodo; `down` = no responde; `unknown` = aún no
/// se ha llamado.
export type ApiStatus = 'ok' | 'rejected' | 'incompatible' | 'down' | 'unknown' | 'disabled'
export type OverallStatus = 'ok' | 'degraded' | 'down'

export interface HealthReport {
  /// Rollup of the fields below — the single value a simple monitor checks.
  status: OverallStatus
  version: string
  uptime_seconds: number
  chain: string
  gas: GasStatus
  rpc: RpcStatus
  settler: SettlerStatus
  api: ApiStatus
}

export interface NodeStatusState {
  startedAt: number
  /// false in dev (no SettlementHub) — the settler is a no-op.
  enabled: boolean
  chain: string
  balanceWei: bigint | null
  balanceAt: number | null
  rpcOk: boolean
  settlerLastTickAt: number | null
  api: Exclude<ApiStatus, 'disabled'>
}

function freshState(now: number): NodeStatusState {
  return {
    startedAt: now,
    enabled: false,
    chain: 'dev',
    balanceWei: null,
    balanceAt: null,
    rpcOk: true, // optimistic until the first failure
    settlerLastTickAt: null,
    api: 'unknown',
  }
}

// Module singleton. Replaced by initNodeStatus() at daemon boot.
let state: NodeStatusState = freshState(Date.now())

export function initNodeStatus(opts: { enabled: boolean; chain: string }, now = Date.now()): void {
  state = { ...freshState(now), enabled: opts.enabled, chain: opts.chain }
}

/// Settler read the operator ETH balance successfully (RPC is up).
export function recordBalance(wei: bigint, now = Date.now()): void {
  state.balanceWei = wei
  state.balanceAt = now
  state.rpcOk = true
}

/// An RPC/transport read failed (settler getBalance).
export function recordRpcError(): void {
  state.rpcOk = false
}

/// Resultado de la última llamada a la API. Antes el settler marcaba su vuelta
/// aunque la API lo rechazara, y /health decía `ok` con el nodo sin poder
/// trabajar.
export function recordApiResult(resultado: 'ok' | 'rejected' | 'incompatible' | 'down'): void {
  state.api = resultado
}

/// The settler loop completed a tick (alive), regardless of outcome.
export function markSettlerTick(now = Date.now()): void {
  state.settlerLastTickAt = now
}

function deriveGas(s: NodeStatusState): GasStatus {
  if (!s.rpcOk || s.balanceWei === null) return 'offline'
  if (s.balanceWei < GAS_CRITICAL_WEI) return 'critical'
  if (s.balanceWei < GAS_WARNING_WEI) return 'warning'
  return 'healthy'
}

function deriveSettler(s: NodeStatusState, now: number): SettlerStatus {
  if (!s.enabled) return 'disabled'
  // Grace: until the first tick, measure staleness from boot.
  const last = s.settlerLastTickAt ?? s.startedAt
  return now - last > SETTLER_STALE_MS ? 'stalled' : 'running'
}

function rollup(
  s: NodeStatusState,
  gas: GasStatus,
  rpc: RpcStatus,
  settler: SettlerStatus,
  api: ApiStatus,
): OverallStatus {
  // `offline` before the first balance read is boot warm-up (degraded), not
  // an outage; `offline` after a real reading means RPC is down.
  const gasNeverRead = s.balanceAt === null
  const gasDown = gas === 'critical' || (gas === 'offline' && !gasNeverRead)
  // Un nodo que no puede hablar con la API no puede trabajar.
  if (
    gasDown ||
    rpc === 'down' ||
    settler === 'stalled' ||
    api === 'down' ||
    api === 'rejected' ||
    api === 'incompatible'
  ) {
    return 'down'
  }
  if (gas === 'warning' || (gas === 'offline' && gasNeverRead)) {
    return 'degraded'
  }
  return 'ok'
}

/// Pure: derive the public health report from a state snapshot + clock.
/// Exported for unit tests.
export function deriveHealth(s: NodeStatusState, now: number): HealthReport {
  const uptime = Math.max(0, Math.floor((now - s.startedAt) / 1000))
  // Dev/disabled (no SettlementHub): not settling by design — not an
  // incident. Report `ok` with the services flagged `disabled` so a monitor
  // can tell "intentionally off" from "broken".
  if (!s.enabled) {
    return {
      status: 'ok',
      version: VERSION,
      uptime_seconds: uptime,
      chain: s.chain,
      gas: 'offline',
      rpc: 'down',
      settler: 'disabled',
      api: 'disabled',
    }
  }
  const gas = deriveGas(s)
  const rpc: RpcStatus = s.rpcOk ? 'ok' : 'down'
  const settler = deriveSettler(s, now)
  return {
    status: rollup(s, gas, rpc, settler, s.api),
    version: VERSION,
    uptime_seconds: uptime,
    chain: s.chain,
    gas,
    rpc,
    settler,
    api: s.api,
  }
}

export function computeHealth(now = Date.now()): HealthReport {
  return deriveHealth(state, now)
}
