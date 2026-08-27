# Contribuir

Gracias por querer aportar. Escribe en **español o inglés**, lo que te resulte
natural — ambos son bienvenidos en issues y pull requests.

## Poner en marcha

```bash
npm install
npm test          # 48 tests
npm run typecheck
npm run dev       # recarga en caliente
```

Requiere Node **22+**. El daemon depende de
[`@lacasoft/coatipay-protocol`](https://github.com/lacasoft/coatipay-protocol),
que se instala desde npm.

## Antes de abrir el PR

```bash
npm run typecheck && npm test && npm run build
```

Si arreglas un fallo, añade el test que lo reproduce.

## Dos cosas que conviene saber

**El canal con el API va firmado.** Cada llamada lleva
`X-Operator-Signature` sobre `${timestamp}.${body}`, firmada con la llave del
operador. Si tocas `lib/internal-api-client.ts`, recuerda que el API **recupera
la dirección de esa firma** para autenticarte: cambiar lo que se firma rompe la
autenticación.

**Las cabeceras son neutrales a propósito.** `X-Operator-*`, no el nombre del
producto: son contrato con operadores externos y no deben romperse si la marca
cambia.

## Seguridad

¿Encontraste una vulnerabilidad? **No abras un issue.** Escribe a
**security@coatipay.com** — ver [SECURITY.md](SECURITY.md).
