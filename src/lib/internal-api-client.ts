// Helper for daemon → API signed POSTs to /v1/internal/*.
// Used by the settler: claim work, hand back what it could not settle.
// Centralizes signing + 204 handling + error wrapping so the services can
// focus on their domain logic.
//
// The daemon signs each request with the SAME key it registered on-chain, so
// the API can recover the address and check it against NodeRegistry. It no
// longer sends its operator address in the body: the address is proven by the
// signature, not declared. Nothing here is a shared secret, so a node can only
// ever act as itself.
//
// Canal v2: lo firmado cubre la hora, un nonce de un solo uso, el método, la
// ruta y el cuerpo. Una firma capturada no vale en otra ruta ni se puede
// repetir.
import { createHash, randomBytes } from 'node:crypto'
import { privateKeyToAccount } from 'viem/accounts'
import { CANAL, VERSION } from './version'

export interface InternalApiClientConfig {
  apiUrl: string // base, e.g. http://localhost:3000
  /// The operator key. Same one used to register in NodeRegistry — that is
  /// what ties this daemon to its on-chain identity.
  privateKey: `0x${string}`
}

export interface PeticionFirmada {
  timestamp: number
  nonce: string
  /// En mayúsculas: `POST`.
  metodo: string
  /// Tal como se pide, sin consulta: `/v1/internal/authorizations/claim`.
  ruta: string
  /// El JSON del cuerpo, tal como se envía.
  cuerpo: string
}

/// Lo que firma el operador. Un campo por línea, y del cuerpo solo su hash:
/// ningún campo puede hacerse pasar por otro ni correrse de sitio. La API
/// reconstruye este mismo texto para comprobar la firma.
export function mensajeDelCanal(p: PeticionFirmada): string {
  return [
    `coatipay-operator-channel/${CANAL}`,
    p.timestamp,
    p.nonce,
    p.metodo,
    p.ruta,
    createHash('sha256').update(p.cuerpo).digest('hex'),
  ].join('\n')
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
    // Uno nuevo en cada petición: la API no atiende dos veces el mismo.
    const nonce = randomBytes(16).toString('hex')
    const signature = await this.account.signMessage({
      message: mensajeDelCanal({ timestamp, nonce, metodo: 'POST', ruta: path, cuerpo: bodyStr }),
    })

    const url = `${this.cfg.apiUrl}${path}`
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Operator-Channel': String(CANAL),
        'X-Operator-Signature': signature,
        'X-Operator-Timestamp': String(timestamp),
        'X-Operator-Nonce': nonce,
        'X-Node-Version': VERSION,
      },
      body: bodyStr,
    })

    if (res.status === 204) return null

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      // La API responde con su versión del canal cuando no atiende la nuestra.
      const canalDeLaApi = res.headers.get('x-operator-channel')
      throw new InternalApiError(
        res.status,
        path,
        text.slice(0, 500),
        canalDeLaApi !== null && canalDeLaApi !== String(CANAL) ? canalDeLaApi.slice(0, 8) : null,
      )
    }

    return (await res.json()) as T
  }
}

export class InternalApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly path: string,
    public readonly body: string,
    /// La versión del canal que habla la API, si no es la de este nodo: no nos
    /// atiende hasta que los dos hablen la misma. `null` en cualquier otro error.
    public readonly canalDeLaApi: string | null = null,
  ) {
    super(
      canalDeLaApi === null
        ? `Internal API ${path} → ${status}: ${body}`
        : `La API habla el canal v${canalDeLaApi} y este nodo el v${CANAL}: ${
            Number(canalDeLaApi) < CANAL
              ? `este nodo es más nuevo que la API; usa la versión del nodo que habla el canal v${canalDeLaApi}`
              : 'actualiza el nodo'
          }. (${path} → ${status})`,
    )
    this.name = 'InternalApiError'
  }
}
