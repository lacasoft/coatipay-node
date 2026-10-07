import { privateKeyToAccount } from 'viem/accounts'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../../lib/config'

const CLAVE = `0x${'01'.repeat(32)}` as const
const DIRECCION = privateKeyToAccount(CLAVE).address
const HUB = '0x4444444444444444444444444444444444444444'
const REGISTRO = '0x1111111111111111111111111111111111111111'

/// Un nodo de producción bien configurado.
const produccion = (extra: Record<string, string | undefined> = {}) => ({
  NODE_ENV: 'production',
  CHAIN: 'base-sepolia',
  NODE_OPERATOR_PRIVATE_KEY: CLAVE,
  SETTLEMENT_HUB_ADDRESS: HUB,
  NODE_REGISTRY_ADDRESS: REGISTRO,
  ...extra,
})

describe('loadConfig — la red se declara', () => {
  it('en producción, sin CHAIN no arranca', () => {
    expect(() => loadConfig(produccion({ CHAIN: undefined }))).toThrow(/CHAIN/)
  })

  it('una red que no existe no se acepta', () => {
    expect(() => loadConfig(produccion({ CHAIN: 'sepolia' }))).toThrow(/CHAIN/)
  })

  it('fuera de producción, Base Sepolia por defecto', () => {
    expect(loadConfig({}).chain).toBe('base-sepolia')
  })

  it('la red no se deduce de la URL del RPC', () => {
    // Antes, una URL sin «sepolia» en el texto se tomaba por mainnet.
    const c = loadConfig(
      produccion({ CHAIN: 'base-sepolia', BASE_RPC_URL: 'https://mi-proveedor.example/v2/k' }),
    )
    expect(c.chain).toBe('base-sepolia')
  })
})

describe('loadConfig — en producción no hay «modo dev»', () => {
  it('una configuración completa arranca', () => {
    const c = loadConfig(produccion())
    expect(c.isProduction).toBe(true)
    expect(c.settlementHubAddress).toBe(HUB)
  })

  it.each([['SETTLEMENT_HUB_ADDRESS'], ['NODE_REGISTRY_ADDRESS']])(
    '%s a cero no arranca, y el error nombra la variable',
    (variable) => {
      expect(() => loadConfig(produccion({ [variable]: undefined }))).toThrow(
        new RegExp(`${variable}: .*a cero`),
      )
    },
  )

  it('sin clave del operador no arranca', () => {
    expect(() => loadConfig(produccion({ NODE_OPERATOR_PRIVATE_KEY: undefined }))).toThrow(
      /NODE_OPERATOR_PRIVATE_KEY/,
    )
  })

  it('fuera de producción, las direcciones a cero siguen valiendo para desarrollo', () => {
    const c = loadConfig({})
    expect(c.isProduction).toBe(false)
    expect(c.settlementHubAddress).toBe('0x0000000000000000000000000000000000000000')
  })
})

describe('loadConfig — la dirección del operador sale de su clave', () => {
  it('sin NODE_OPERATOR_ADDRESS, se deriva de la clave', () => {
    expect(loadConfig(produccion()).operatorAddress).toBe(DIRECCION)
  })

  it('declarada y coincidente (en cualquier mayúscula), se acepta', () => {
    const c = loadConfig(produccion({ NODE_OPERATOR_ADDRESS: DIRECCION.toLowerCase() }))
    expect(c.operatorAddress).toBe(DIRECCION)
  })

  it('declarada y distinta de la de la clave, no arranca', () => {
    // Antes se aceptaba: la API identificaba al nodo por la clave, y el gas se
    // vigilaba en la otra cuenta.
    expect(() =>
      loadConfig(
        produccion({ NODE_OPERATOR_ADDRESS: '0x3333333333333333333333333333333333333333' }),
      ),
    ).toThrow(new RegExp(`NODE_OPERATOR_ADDRESS: no es la dirección .*${DIRECCION}`))
  })
})

describe('loadConfig — el USDC sale de la red', () => {
  it('sin USDC_ADDRESS, el USDC oficial de la red declarada', () => {
    expect(loadConfig(produccion({ CHAIN: 'base-sepolia' })).usdcAddress).toBe(
      '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    )
    // Antes el valor por defecto era el de Sepolia también en mainnet.
    expect(loadConfig(produccion({ CHAIN: 'base' })).usdcAddress).toBe(
      '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    )
  })

  it('USDC_ADDRESS explícita se respeta (el preflight comprueba que sea la del hub)', () => {
    const otro = '0x7777777777777777777777777777777777777777'
    expect(loadConfig(produccion({ USDC_ADDRESS: otro })).usdcAddress).toBe(otro)
  })

  it('USDC_ADDRESS vacía cuenta como no definida (docker compose la pasa así)', () => {
    expect(loadConfig(produccion({ USDC_ADDRESS: '' })).usdcAddress).toBe(
      '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    )
  })
})

describe('loadConfig — los errores nombran la variable de entorno', () => {
  it('sin CHAIN, dice qué valores admite', () => {
    expect(() => loadConfig(produccion({ CHAIN: undefined }))).toThrow(
      /CHAIN: declara la red: base-sepolia o base/,
    )
  })

  it('cada campo inválido sale con su variable, no con la clave interna', () => {
    // Pasó con Docker --env-file: un comentario al final de la línea llegó como
    // parte del valor, y el error decía «minPaymentAmount».
    const todoMal = produccion({
      PORT: 'x',
      CHAIN: 'x',
      NODE_OPERATOR_PRIVATE_KEY: 'x',
      BASE_RPC_URL: 'x',
      BASE_RPC_FALLBACK_URLS: 'x',
      API_INTERNAL_URL: 'x',
      MIN_PAYMENT_AMOUNT: '300000          # 0.30 USDC',
      GAS_PRICE_REF_GWEI: 'x',
      SETTLE_EXPIRY_BUFFER_SECONDS: 'x',
    })
    const mensaje = (() => {
      try {
        loadConfig(todoMal)
        return ''
      } catch (e) {
        return (e as Error).message
      }
    })()
    const lineas = mensaje.split('\n').slice(1)
    expect(lineas.length).toBeGreaterThanOrEqual(9)
    for (const linea of lineas) expect(linea).toMatch(/^ {2}[A-Z_]+: /)
    expect(mensaje).toContain('MIN_PAYMENT_AMOUNT:')
  })
})

describe('loadConfig — la firma del operador no viaja en claro', () => {
  it.each([
    'https://api.coatipay.com',
    'https://api.example.com:8443',
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'http://[::1]:3000',
    'http://api:3000', // el servicio de docker compose
    'http://10.0.0.5:3000',
    'http://172.16.3.4:3000',
    'http://192.168.1.20:3000',
    'http://api.internal:3000',
    'http://[fd00::1]:3000',
  ])('%s vale', (url) => {
    expect(loadConfig(produccion({ API_INTERNAL_URL: url })).apiUrl).toBe(url)
  })

  it.each([
    'http://api.coatipay.com',
    'http://api.example.com:3000',
    'http://203.0.113.7:3000',
    'http://172.32.0.1:3000', // fuera del rango privado 172.16/12
    'http://[2001:db8::1]:3000',
    'ftp://localhost',
  ])('%s no: el nodo no arranca, y dice qué hace falta', (url) => {
    expect(() => loadConfig(produccion({ API_INTERNAL_URL: url }))).toThrow(
      /API_INTERNAL_URL debe ser https/,
    )
  })

  it('por defecto, el servicio de docker compose', () => {
    expect(loadConfig(produccion()).apiUrl).toBe('http://api:3000')
  })

  it('tampoco fuera de producción: en desarrollo la API es local', () => {
    expect(() => loadConfig({ API_INTERNAL_URL: 'http://api.example.com' })).toThrow(
      /API_INTERNAL_URL debe ser https/,
    )
  })
})
