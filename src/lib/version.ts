/// La versión de este daemon. La dicen /health y /info, y viaja en cada
/// petición a la API (`X-Node-Version`) para que quien opera la API sepa qué
/// corre cada nodeit.
export const VERSION = '0.2.0'

/// La versión del canal con la API que habla este daemon: qué firma y con qué
/// cabeceras (`X-Operator-Channel`). La API solo atiende la suya. Si la API
/// pasa a otra, este nodo deja de recibir trabajo hasta que se actualice, y
/// /health lo dice: `api: incompatible`.
export const CANAL = 2
