# Política de seguridad

Este daemon **firma transacciones que mueven dinero** y custodia la llave de tu
operador. Si encuentras una vulnerabilidad, queremos saberlo antes que nadie.

## Cómo reportar

**📧 security@coatipay.com**

En español o inglés, como prefieras. Incluye qué falla, cómo reproducirlo y qué
impacto le ves. Un reporte parcial es mejor que ninguno.

- Acusamos recibo en **48 horas**.
- **Reconocimiento público** cuando el fix esté desplegado, y sitio en el [hall
  of fame](https://github.com/lacasoft/coatipay-protocol/blob/master/SECURITY.md#hall-of-fame) del protocolo.
- **Recompensa en USDC** por hallazgos críticos, discrecional y acordada caso
  por caso, **cuando el treasury tenga flujo sostenido**. Somos early-stage y
  hoy no lo tiene: preferimos decírtelo antes de que inviertas tu tiempo, no
  después. Un programa formal con tabla de pagos llegará junto con la auditoría
  externa.
- Te damos crédito público al desplegar el fix, salvo que prefieras el anonimato.

## Divulgación responsable

**No publiques la vulnerabilidad** en redes ni foros hasta que esté corregida.
Mientras el fallo siga vivo, difundirlo pone en riesgo el stake y los fondos de
otros operadores.

## Especialmente relevante aquí

- **Fuga de `NODE_OPERATOR_PRIVATE_KEY`.** Es la identidad del nodo y firma
  transacciones. Cualquier camino por el que el daemon la exponga —logs,
  respuestas HTTP, mensajes de error— es crítico.
- **Suplantación de operador.** Cualquier forma de conseguir que el API acepte
  una llamada como si viniera de otro operador es crítica.
- **Firmas de liquidación.** Un error que haga presentar on-chain algo distinto
  de lo que el pagador autorizó es crítico.
- **Endpoints públicos.** `/health` e `/info` son públicos a propósito y deben
  seguir sin exponer llaves, saldos exactos ni direcciones privadas.

## Alcance

**Dentro:** el código de `src/` de este repositorio.

**Fuera:** los contratos (en
[`coatipay-protocol`](https://github.com/lacasoft/coatipay-protocol)) y la
infraestructura que opera CoatiPay. Escríbenos igual y lo encaminamos.
