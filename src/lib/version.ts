/// La versión de este daemon. La dicen /health y /info, y viaja en cada
/// petición a la API (`X-Node-Version`) para que quien opera la API sepa qué
/// corre cada nodeit.
export const VERSION = '0.3.0'

/// La versión del canal con la API que habla este daemon: qué firma y con qué
/// cabeceras (`X-Operator-Channel`). La API solo atiende la suya. Si la API
/// pasa a otra, este nodo deja de recibir trabajo hasta que se actualice, y
/// /health lo dice: `api: incompatible`.
///
/// v3 (ADR-009): el registro que entrega la API lleva `ref`, para el hub nuevo.
export const CANAL = 3
