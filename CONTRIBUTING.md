# Contribuir

Gracias por querer aportar. Escribe en **español o inglés**, lo que te resulte
natural — ambos son bienvenidos en issues y pull requests.

## Poner en marcha

```bash
npm install
npm test
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

## De dónde viene el código

`src/` se desarrolla junto a la API de CoatiPay, que no es pública: la mayoría
de los cambios al nodo tocan también el canal con la API, y así se pueden hacer
a la vez. De allí llega aquí mediante un pull request de sincronización, sin
transformaciones: lo que ejecutas es lo mismo que ejecuta el nodeit de
CoatiPay.

**Tus pull requests son bienvenidos igual.** Los revisamos aquí y, si entran,
los incorporamos en la fuente; la siguiente sincronización los trae de vuelta
con el resto. Un cambio que entrara solo aquí lo desharía la sincronización
siguiente, así que no lo mergeamos sin llevarlo antes a la fuente.

Lo que **no** se sincroniza es propio de este repositorio: este archivo, el
README, SECURITY, la licencia, `.env.example` y la configuración de CI.

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
