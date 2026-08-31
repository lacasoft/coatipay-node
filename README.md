# CoatiPay — daemon del nodeit

El programa que liquida pagos en la red CoatiPay. Recibe autorizaciones
**ERC-3009** firmadas por los pagadores, las presenta on-chain pagando el gas, y
cobra el **1.05% de cada pago que liquida**, en USDC.

**Apache-2.0** · cualquiera puede correrlo · sin whitelist.

---

## Cómo te autentica la red

No hay secreto compartido ni alta que aprobar. El daemon **firma cada llamada
con la llave del operador** —la misma con la que te registraste on-chain— y el
API recupera tu dirección de esa firma y la comprueba contra `NodeRegistry`.

```
tu daemon                          el API
    │  firma  ${timestamp}.${body}
    │  con NODE_OPERATOR_PRIVATE_KEY
    ├──────────────────────────────────▶
    │                                  recupera la dirección de la firma
    │                                  ¿está en NodeRegistry?  ¿activa?
    │                                  ¿stake ≥ mínimo?
    │                                          │
    ◀──────────────────────────────────────────┘
```

Tu identidad **se demuestra, no se declara**. No puedes actuar como otro
operador porque no puedes firmar con su llave — y nadie puede actuar como tú.

---

## Requisitos

| Recurso | Mínimo | Recomendado |
|---|---|---|
| CPU · RAM | 1 vCPU · 512 MB | 2 vCPU · 2 GB |
| Disco | 10 GB SSD | 50 GB SSD |
| Uptime | 99% | 99.9% |
| Stake | 40 USDC (testnet) · 100 USDC (mainnet) | más |
| RPC de Base | público | dedicado + respaldos |
| ETH para gas | sí — tú pagas el gas de cada liquidación | |

Necesitas además un **endpoint HTTPS público** apuntando al daemon.

---

## Ponerlo a correr

### 1. Regístrate on-chain

El registro **no tiene permisos ni whitelist**. Desde tu wallet de operador:

```solidity
USDC.approve(StakeManager, 40_000_000)   // 40 USDC (testnet)
StakeManager.deposit(40_000_000)
NodeRegistry.register("https://nodeit.tudominio.com")
```

`register()` **no transfiere USDC por ti**: comprueba que ya tengas el stake
depositado. Direcciones canónicas en
[`coatipay-protocol`](https://github.com/lacasoft/coatipay-protocol/blob/master/contracts/deployments/sepolia.json).

### 2. Levanta el daemon

```bash
cp .env.example .env    # rellena tu llave y tu endpoint
npm install && npm run build && npm start
```

O con Docker:

```bash
docker run -d --name coatipay-node \
  -p 4000:4000 -v coatipay_node_data:/data \
  --env-file .env \
  ghcr.io/lacasoft/node:latest
```

### 3. Comprueba

```bash
curl https://nodeit.tudominio.com/health
```

Debe responder `settler: running` y `watcher: synced`. Aparecerás en
`GET /v1/nodes` del API.

> **`/health` no basta para saber si estás liquidando.** El proceso puede estar
> `running` con todas sus llamadas rechazadas. Mira también los logs: si ves
> `tick failed`, algo va mal aunque el health diga que sí.

---

## Cuánto ganas, y qué arriesgas

De cada pago que liquidas te llevas el **1.05%** (el 70% de la comisión del
protocolo, que es del 1.5%). En USDC y on-chain, en la misma transacción.

Pagas el **gas** de cada liquidación. Por eso el daemon **rechaza pagos
demasiado pequeños**: liquidar por debajo del coste sería perder dinero. Ese
umbral se escala solo con el gas en vivo (ver `MIN_PAYMENT_AMOUNT`).

Tu **stake es la garantía**. Enrutar bien construye reputación; comportarse mal
cuesta stake. Y si retiras el stake por debajo del mínimo, **el API deja de
darte trabajo** aunque sigas registrado: sin nada que perder no hay garantía.

---

## Qué hace por dentro

| Servicio | Responsabilidad |
|---|---|
| **Settler** | Toma autorizaciones de la cola y las liquida on-chain |
| **Watcher** | Sigue los eventos `IntentSettled` y confirma al API |
| **Health** | Expone `/health` con el estado de cada subsistema |

Varios nodeits pueden trabajar a la vez: la cola usa `FOR UPDATE SKIP LOCKED`,
así que nunca dos toman la misma autorización.

---

## Desarrollo

```bash
npm install
npm test          # 48 tests
npm run typecheck
npm run dev       # recarga en caliente
```

## Enlaces

- [`coatipay-protocol`](https://github.com/lacasoft/coatipay-protocol) — contratos, especificación y economía
- [SDKs](https://github.com/lacasoft/coatipay-protocol#sdks) — para integrar pagos, no para operar un nodo

## Contribuir y seguridad

Lee [CONTRIBUTING.md](CONTRIBUTING.md). Para vulnerabilidades **no abras un
issue**: escribe a **security@coatipay.com** ([SECURITY.md](SECURITY.md)).

Issues y PRs en **español o inglés**.

## Licencia

Apache-2.0 — ver [LICENSE](LICENSE).
