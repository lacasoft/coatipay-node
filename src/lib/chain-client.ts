// Wallet + public client factory for daemon → SettlementHub interactions.
// Shared between the AuthorizationSettler (writes), the
// SettlementEventWatcher (reads + event subscription), and the
// AuthorizationSweeper (no chain access — but pulls config consistency).
import { buildRpcTransport, resolveRpcUrls } from '@lacasoft/coatipay-protocol'
import { type Address, createPublicClient, createWalletClient, type Hex } from 'viem'
import type { PrivateKeyAccount } from 'viem/accounts'
import { privateKeyToAccount } from 'viem/accounts'
import { base, baseSepolia } from 'viem/chains'

export interface ChainClientConfig {
  privateKey: Hex
  baseRpcUrl: string
  /// Optional backup RPC endpoints (failover). The chain's public RPC is
  /// always appended as a last-resort backup.
  baseRpcFallbackUrls?: string[]
  settlementHubAddress: Address
}

// Loose typings: viem's parameterized client types blow past the
// TypeScript serializer (TS7056) on this codebase, and the strict types
// collide across viem internal versions when chained through transitive
// deps. We use broad return types (cast at construction) and the call
// sites get type inference at the method level via the ABI `as const`.
export interface DaemonChainClients {
  publicClient: ReturnType<typeof createPublicClient>
  walletClient: ReturnType<typeof createWalletClient>
  account: PrivateKeyAccount
  settlementHubAddress: Address
  /// Normalized network name for the /health report ('base' | 'base-sepolia').
  chainName: string
}

export function createDaemonChainClients(cfg: ChainClientConfig): DaemonChainClients {
  const account = privateKeyToAccount(cfg.privateKey)
  const isTestnet = cfg.baseRpcUrl.includes('sepolia')
  const chain = isTestnet ? baseSepolia : base
  const transport = buildRpcTransport(
    resolveRpcUrls(cfg.baseRpcUrl, cfg.baseRpcFallbackUrls, isTestnet),
  )

  const publicClient = createPublicClient({ chain, transport }) as ReturnType<
    typeof createPublicClient
  >
  const walletClient = createWalletClient({ account, chain, transport }) as ReturnType<
    typeof createWalletClient
  >

  return {
    publicClient,
    walletClient,
    account,
    settlementHubAddress: cfg.settlementHubAddress,
    chainName: isTestnet ? 'base-sepolia' : 'base',
  }
}

/// Returns true if the daemon is in dev mode (SettlementHub not configured).
/// In dev, on-chain services are no-ops: settler skips its loop, watcher
/// doesn't subscribe, sweeper still runs (housekeeping doesn't need chain).
export function isDevChainConfig(settlementHubAddress: string): boolean {
  return settlementHubAddress === '0x0000000000000000000000000000000000000000'
}
