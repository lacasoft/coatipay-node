// Minimal SettlementHub ABI — only the surface the daemon touches.
// Hand-typed so we can `as const` for viem's type inference at call sites.
//
// Source of truth: packages/contracts/src/SettlementHub.sol
//   - registerIntent: AuthorizationSettler (lazy, on first claim)
//   - payIntentWithAuthorization: AuthorizationSettler (after register)
//   - getIntent: AuthorizationSettler (check if intent already on-chain)
//   - IntentSettled event: SettlementEventWatcher (source of truth for
//     settlement state — drives the webhook)
import { keccak256, toHex } from 'viem'

export const SETTLEMENT_HUB_ABI = [
  {
    type: 'function',
    name: 'registerIntent',
    inputs: [
      { name: 'intentId', type: 'bytes32' },
      { name: 'merchant', type: 'address' },
      { name: 'operator', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'expiresAt', type: 'uint64' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'payIntentWithAuthorization',
    inputs: [
      {
        name: 'auth',
        type: 'tuple',
        components: [
          { name: 'intentId', type: 'bytes32' },
          { name: 'payer', type: 'address' },
          { name: 'validAfter', type: 'uint256' },
          { name: 'validBefore', type: 'uint256' },
          { name: 'nonce', type: 'bytes32' },
          { name: 'signature', type: 'bytes' },
        ],
      },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'registerIntentBatch',
    inputs: [
      { name: 'intentIds', type: 'bytes32[]' },
      { name: 'merchants', type: 'address[]' },
      { name: 'operators', type: 'address[]' },
      { name: 'amounts', type: 'uint256[]' },
      { name: 'expirations', type: 'uint64[]' },
    ],
    outputs: [{ name: 'registered', type: 'uint256' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'payIntentBatchWithAuthorization',
    inputs: [
      {
        name: 'auths',
        type: 'tuple[]',
        components: [
          { name: 'intentId', type: 'bytes32' },
          { name: 'payer', type: 'address' },
          { name: 'validAfter', type: 'uint256' },
          { name: 'validBefore', type: 'uint256' },
          { name: 'nonce', type: 'bytes32' },
          { name: 'signature', type: 'bytes' },
        ],
      },
    ],
    outputs: [{ name: 'paid', type: 'uint256' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'getIntent',
    inputs: [{ name: 'intentId', type: 'bytes32' }],
    outputs: [
      {
        type: 'tuple',
        components: [
          { name: 'merchant', type: 'address' },
          { name: 'amount', type: 'uint96' },
          { name: 'operator', type: 'address' },
          { name: 'expiresAt', type: 'uint64' },
          { name: 'status', type: 'uint8' },
        ],
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'event',
    name: 'IntentSettled',
    inputs: [
      { name: 'intentId', type: 'bytes32', indexed: true },
      { name: 'payer', type: 'address', indexed: true },
      { name: 'merchantAmount', type: 'uint256', indexed: false },
      { name: 'operatorFee', type: 'uint256', indexed: false },
      { name: 'treasuryFee', type: 'uint256', indexed: false },
    ],
    anonymous: false,
  },
] as const

/// Convert an off-chain intent id (e.g. `pi_abc123`) into the bytes32
/// key used on-chain. SettlementHub.sol §84 documents this convention:
///   "Keys are keccak256 of off-chain identifiers
///    (e.g. the API's `pi_xxx` string converted to bytes32)."
export function intentIdToBytes32(intentId: string): `0x${string}` {
  return keccak256(toHex(intentId))
}

/// Sentinel value returned by getIntent for a never-registered key —
/// the merchant address slot is zero. Daemon uses this to decide whether
/// it needs to call registerIntent before submitting payment.
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const
