// Helper for daemon → API signed POSTs to /v1/internal/*.
// Used by all 3 ADR-003 Phase B4 services (settler, event-watcher, sweeper).
// Centralizes signing + 204 handling + error wrapping so the services can
// focus on their domain logic.
//
// The daemon signs each request with the SAME key it registered on-chain, so
// the API can recover the address and check it against NodeRegistry. It no
// longer sends its operator address in the body: the address is proven by the
// signature, not declared. Nothing here is a shared secret, so a node can only
// ever act as itself.
import { privateKeyToAccount } from 'viem/accounts'

export interface InternalApiClientConfig {
  apiUrl: string // base, e.g. http://localhost:3000
  /// The operator key. Same one used to register in NodeRegistry — that is
  /// what ties this daemon to its on-chain identity.
  privateKey: `0x${string}`
}

export class InternalApiClient {
  private readonly account: ReturnType<typeof privateKeyToAccount>

  constructor(private readonly cfg: InternalApiClientConfig) {
    this.account = privateKeyToAccount(cfg.privateKey)
  }

  /// The address the API will recover from our signatures.
  get operatorAddress(): string {
    return this.account.address
  }

  /// Signed POST. Returns the parsed JSON body, or null on 204.
  /// Throws on non-2xx with the response text in the error message.
  async post<T>(path: string, body: unknown): Promise<T | null> {
    const bodyStr = JSON.stringify(body)
    const timestamp = Math.floor(Date.now() / 1000)
    // Timestamp bound to the body: a captured signature can neither be
    // replayed later nor moved onto a different payload.
    const signature = await this.account.signMessage({ message: `${timestamp}.${bodyStr}` })

    const url = `${this.cfg.apiUrl}${path}`
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Operator-Signature': signature,
        'X-Operator-Timestamp': String(timestamp),
      },
      body: bodyStr,
    })

    if (res.status === 204) return null

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new InternalApiError(res.status, path, text.slice(0, 500))
    }

    return (await res.json()) as T
  }
}

export class InternalApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly path: string,
    public readonly body: string,
  ) {
    super(`Internal API ${path} → ${status}: ${body}`)
    this.name = 'InternalApiError'
  }
}
