import {
  buildRpcTransport,
  PUBLIC_RPC_URLS,
  parseRpcUrlList,
  resolveRpcUrls,
} from '@lacasoft/coatipay-protocol'
import { describe, expect, it } from 'vitest'

describe('parseRpcUrlList', () => {
  it('returns [] for undefined or empty', () => {
    expect(parseRpcUrlList(undefined)).toEqual([])
    expect(parseRpcUrlList('')).toEqual([])
    expect(parseRpcUrlList('   ')).toEqual([])
  })

  it('splits on commas, trims, and drops blanks', () => {
    expect(parseRpcUrlList('https://a.example, https://b.example ,, https://c.example')).toEqual([
      'https://a.example',
      'https://b.example',
      'https://c.example',
    ])
  })
})

describe('resolveRpcUrls', () => {
  it('always appends the public testnet RPC as last-resort backup', () => {
    const urls = resolveRpcUrls('https://alchemy.example/v2/key', [], true)
    expect(urls[0]).toBe('https://alchemy.example/v2/key')
    expect(urls.at(-1)).toBe(PUBLIC_RPC_URLS.baseSepolia)
  })

  it('uses the mainnet public RPC when not testnet', () => {
    const urls = resolveRpcUrls('https://alchemy.example/v2/key', [], false)
    expect(urls.at(-1)).toBe(PUBLIC_RPC_URLS.base)
  })

  it('preserves order: primary, explicit fallbacks, public default', () => {
    const urls = resolveRpcUrls('https://primary.example', ['https://backup.example'], true)
    expect(urls).toEqual([
      'https://primary.example',
      'https://backup.example',
      PUBLIC_RPC_URLS.baseSepolia,
    ])
  })

  it('dedupes so the public RPC is not repeated when it is already the primary', () => {
    const urls = resolveRpcUrls(PUBLIC_RPC_URLS.baseSepolia, [], true)
    expect(urls).toEqual([PUBLIC_RPC_URLS.baseSepolia])
  })

  it('dedupes a fallback that equals the public default', () => {
    const urls = resolveRpcUrls('https://primary.example', [PUBLIC_RPC_URLS.base], false)
    expect(urls).toEqual(['https://primary.example', PUBLIC_RPC_URLS.base])
  })
})

describe('buildRpcTransport', () => {
  // viem transports are factory functions — assert the branch returns one for
  // both the single-endpoint (http) and multi-endpoint (fallback) cases.
  it('returns a transport for a single URL', () => {
    expect(typeof buildRpcTransport(['https://a.example'])).toBe('function')
  })

  it('returns a fallback transport for multiple URLs', () => {
    expect(typeof buildRpcTransport(['https://a.example', 'https://b.example'])).toBe('function')
  })
})
