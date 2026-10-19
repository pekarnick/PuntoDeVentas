# PLAN.md — POS genérico offline-first (Argentina)

> Documento maestro del proyecto. Leelo completo antes de escribir código. Las reglas inviolables están en la sección 3. Si algo de este plan te parece incorrecto o subóptimo, **avisá y proponé la alternativa antes de implementar**; no sigas ciegamente.

## 1. Objetivo

Sistema de punto de venta **para administrar un comercio** (no para el cliente final). Debe servir para cualquier rubro: kiosco, librería, ferretería, etc.

- Funciona **100% local** (base SQLite) y sin internet.
- Mantiene una **copia en la nube (Supabase)** y sincroniza para poder usarse en más de una terminal.
- Maneja **costos y ventas**, stock, caja, y todos los informes de gestión.
- Pensado para **Argentina** (ARS, IVA, ARCA, medios de pago locales).
- Usuario típico: dueño de un comercio chico, poco técnico. La interfaz debe ser **simple, rápida y usable con teclado y lector de códigos de barras**.

## 2. Stack (decidido)

| Capa | Tecnología |
|---|---|
| App de escritorio | **Tauri 2** (fallback: Electron si Tauri da problemas serios) |
| UI | **TypeScript + React** (Vite) |
| Base local | **SQLite** (un archivo por comercio) |
| Nube / sync | **Supabase** (Postgres + Auth + API) |
| Imágenes de productos | Archivos locales + **Supabase Storage** para la copia en la nube (ver §5.1) |
| Venta móvil (celular como punto de venta) | **App web PWA** (React + Vite) en hosting HTTPS gratuito (Cloudflare Pages o Netlify) que habla con Supabase. El cliente solo escanea un QR o abre una dirección, sin instalar nada (ver §6.2) |
| Facturación ARCA (**opcional**) | Servicio de terceros llamado desde una **Edge Function de Supabase** (ver §6.3) |
| Impresión | ESC/POS para tickets en impresora térmica (Fase 2 o 3) |
| Plataforma objetivo | **Windows 10+** (otras plataformas, más adelante) |

Notas:
- Acceso a SQLite desde Rust (rusqlite o `tauri-plugin-sql`), con migraciones versionadas.
- Toda la lógica de negocio (stock, totales, sync) en funciones puras y testeadas, separadas de la UI.
- Tests: Vitest para TypeScript; tests de Rust donde haya lógica en el backend nativo.

## 3. Reglas inviolables

1. **IDs UUID** (preferentemente UUIDv7) en todas las tablas. Nunca autoincrementales.
2. **Importes en enteros (centavos)**. Nunca `float` para dinero. Se formatean solo al mostrar: `$ 1.234,56`.
3. **Las ventas son append-only**: nunca se editan ni se borran. Una corrección es una **anulación** (registro nuevo) o una **nota de crédito**.
4. **El stock no es un campo editable**: es la suma de **movimientos de stock**. El stock actual se calcula (o se cachea y se puede recalcular siempre desde los movimientos).
5. **Borrado lógico** (`deleted_at`) en entidades maestras. Nunca `DELETE` físico de datos que se sincronizan.
6. Cada tabla sincronizable tiene: `id`, `created_at`, `updated_at`, `deleted_at`, `device_id`, `sync_status`.
7. **La app nunca debe bloquearse por falta de internet.** Toda operación de caja funciona offline.
8. **Nunca pedir ni guardar claves de servicio de Supabase en el cliente.** Solo la clave pública (anon) + autenticación de usuario + Row Level Security.
9. Fechas en **UTC** en la base, mostradas en `America/Argentina/Buenos_Aires`.
10. Todo texto de la UI en **español rioplatense**. Moneda: ARS.
11. El cajero **no ve costos ni ganancias** (permisos por rol).
12. **Las imágenes nunca se guardan dentro de la base de datos** (ni SQLite ni Postgres): solo su ruta y su hash. Los archivos viven en disco local y en Supabase Storage. La falta de una imagen nunca debe romper una pantalla ni una venta.
13. **Cada acción que cambia datos queda en la auditoría**, escrita en la **misma transacción** que el cambio: si no se puede auditar, no se hace (§6.1).
14. **La auditoría es append-only**: ninguna pantalla, API ni rol (ni el superadmin) puede editarla ni borrarla.
15. **Usuarios individuales y nunca compartidos.** Los usuarios no se borran: se desactivan, para no perder la trazabilidad.
16. Las claves se guardan solo como **hash Argon2id**; nunca en texto plano, ni en logs, ni en la auditoría.
17. **La venta móvil web es solo para vender.** Sus permisos se hacen cumplir en Supabase (RLS, vistas y funciones con validación en servidor), no solo en la interfaz (§6.2).
18. **La facturación ARCA es opcional y viene apagada por defecto.** Sin ella, el sistema funciona completo con tickets no fiscales (§6.3).
19. **Ningún QR, URL, código ni archivo del repositorio contiene claves privadas, tokens ni credenciales.** Los QR llevan solo direcciones públicas.
20. **Lo que ve el cliente nunca incluye costos.** La pantalla de venta, el ticket, la factura, los PDF y la venta móvil muestran **solo `precio_venta`**. `costo_compra` aparece únicamente en el listado de administración de productos, compras e informes de gestión, y solo para superadmin y encargado.

## 4. Modelo de datos (borrador; refinalo y justificá cambios)

Todas las tablas incluyen `id`, `comercio_id`, `created_at`, `updated_at`, `deleted_at`, `device_id`.

**Configuración y usuarios**
- `comercios`: nombre, razón social, CUIT, condición IVA, domicilio, rubro, moneda, `venta_movil_habilitada` (default falso), `arca_habilitada` (default falso).
- `usuarios`: nombre, usuario (único por comercio), hash de clave (Argon2id), rol (`superadmin`, `encargado`, `cajero`), `puede_vender_movil` (habilita el acceso a la venta móvil web), `activo`, `debe_cambiar_clave`, `intentos_fallidos`, `bloqueado_hasta`, `ultimo_ingreso`, `creado_por`.
- `dispositivos`: id de terminal, nombre, última sincronización.
- `auditoria` (**append-only**, ver §6.1): fecha_hora (UTC), usuario_id, usuario_nombre (copia), rol, device_id, accion, entidad, entidad_id, valores_antes (JSON), valores_despues (JSON), motivo, hash_prev, hash.

**Catálogo**
- `categorias`: nombre, padre opcional.
- `marcas`.
- `proveedores`: nombre, CUIT, contacto, condiciones de pago.
- `productos`: código interno, nombre, descripción, categoria_id, marca_id, proveedor_principal_id, unidad (`unidad`, `kg`, `m`, `l`, `caja`), `permite_decimales`, `costo_compra` (centavos; lo que pagó el comercio al proveedor), `alicuota_iva` (0 / 10.5 / 21 / 27 / exento), `stock_minimo`, `ubicacion`, `activo`, `fecha_ultimo_cambio_precio`, `imagen_path` (ruta relativa, nula si no tiene), `imagen_hash` (SHA-256 del archivo, para detectar cambios y evitar re-subidas).
- `codigos_barras`: producto_id, código (EAN-13/EAN-8/UPC/otro). **Un producto puede tener varios códigos.** Índice único por (comercio, código).
- `listas_precio`: nombre (ej. Mostrador, Mayorista).
- `precios`: producto_id, lista_precio_id, `precio_venta` (centavos; lo que paga el cliente), margen opcional.
- `variantes` (opcional, Fase 4): talle/color/etc.

**Stock**
- `movimientos_stock`: producto_id, tipo (`compra`, `venta`, `anulacion_venta`, `ajuste`, `devolucion`, `merma`), cantidad (positiva/negativa), costo_unitario, referencia (id de venta/compra/ajuste), motivo, usuario_id.

**Ventas**
- `ventas`: fecha, usuario_id, cliente_id (opcional), subtotal, descuento, total, estado (`completada`, `anulada`), caja_sesion_id, tipo_comprobante, punto_venta, numero, CAE y vencimiento CAE (nulos si ARCA no está habilitada), `canal` (`escritorio` o `web`), `dispositivo_id`, `estado_facturacion` (`no_aplica`, `pendiente`, `emitida`, `error`).
- `ventas_items`: venta_id, producto_id, descripcion (copia del nombre al momento), cantidad, precio_unitario, costo_unitario (**copia del costo al momento de la venta**, para calcular ganancia histórica), descuento, alicuota_iva.
- `ventas_pagos`: venta_id, medio (`efectivo`, `transferencia`, `mercado_pago`, `qr`, `debito`, `credito`, `cuenta_corriente`, `otro`), monto.

**Compras**
- `compras`: proveedor_id, fecha, comprobante del proveedor, subtotal, IVA, total, estado.
- `compras_items`: compra_id, producto_id, cantidad, costo_unitario.

**Clientes y cuenta corriente**
- `clientes`: nombre, CUIT/DNI, condición IVA, teléfono, email, domicilio, límite de crédito.
- `cuenta_corriente_movimientos`: entidad (cliente/proveedor), tipo (`cargo`, `pago`), monto, referencia.

**Caja**
- `caja_sesiones`: apertura (usuario, fecha, monto inicial), cierre (fecha, efectivo contado, diferencia).
- `caja_movimientos`: tipo (`ingreso`, `egreso`), concepto, monto, medio.

**Sincronización (solo local)**
- `sync_cola`: tabla, registro_id, operación, timestamp, estado.
- `sync_estado`: última sincronización de bajada y de subida por tabla.

## 5. Sincronización (parte crítica)

### Estrategia
- La base local es la **fuente de verdad de trabajo**. Supabase es el **punto de encuentro** entre terminales y la copia en la nube.
- Cada cambio local marca el registro como `pendiente` y lo agrega a la cola.
- **Subida (push):** envía registros pendientes a Supabase (upsert por `id`).
- **Bajada (pull):** pide a Supabase los registros con `updated_at` posterior a la última sincronización y los aplica localmente.

### Resolución de conflictos
- `ventas`, `ventas_items`, `ventas_pagos`, `movimientos_stock`, `caja_*`, `auditoria`: **append-only → no hay conflictos**. Los usuarios (`usuarios`) sincronizan como datos maestros, pero **los cambios de rol, desactivación y reseteo de clave tienen prioridad sobre ediciones concurrentes** (en caso de conflicto, gana el cambio más restrictivo).
- `productos`, `precios`, `clientes`, `proveedores`, etc.: **last-write-wins por `updated_at`** (si empatan, gana el `device_id` menor, de forma determinística).
- Ante cualquier conflicto resuelto, guardar un log para auditoría.

### Disparadores
1. **Al abrir la app:** sincroniza **en segundo plano**, sin bloquear la pantalla de venta. Si no hay internet, sigue offline y reintenta cada N minutos.
2. **Al cerrar la app:** si hay cambios pendientes, intenta subirlos (con timeout corto para no trabar el cierre; lo que no suba queda pendiente).
3. **Botón manual "Subir datos ahora".**
4. **Botón manual "Bajar datos ahora".**
5. (Opcional) cada X minutos mientras la app está abierta y hay conexión.

### Indicador de estado visible siempre
`Sincronizado` · `Pendiente (N cambios)` · `Sin conexión` · `Error (ver detalle)`.

### Supabase
- Tablas espejo de las locales, con Postgres y **Row Level Security** por `comercio_id`.
- Autenticación con Supabase Auth; cada usuario pertenece a un comercio.
- Las migraciones de Supabase también van versionadas en el repo (`/supabase/migrations`).

### 5.1 Imágenes de productos

- **Carga:** desde archivo o arrastrando; opcionalmente foto con cámara/webcam. Siempre opcional.
- **Procesamiento antes de guardar (obligatorio, nunca se guarda el original):** las fotos de celular llegan de 3 a 10 MB y 12+ megapíxeles; el original se descarta tras procesarlo.
  1. Aceptar JPG, PNG, WebP y HEIC (fotos de iPhone); si HEIC no se puede decodificar, mostrar mensaje claro.
  2. **Corregir la orientación EXIF** antes de redimensionar (si no, las fotos de celular quedan giradas).
  3. **Eliminar todos los metadatos EXIF** (incluye ubicación GPS) por privacidad y para ahorrar espacio.
  4. Redimensionar a un máximo de **800 px** de lado mayor, sin agrandar imágenes más chicas y manteniendo la proporción.
  5. Convertir a **WebP** (calidad ~80). Si el resultado supera **150 KB**, reintentar bajando la calidad de a pasos hasta cumplir; objetivo habitual: 40–100 KB.
  6. Generar una **miniatura** de ~200 px (WebP, ~10–20 KB) para listados y pantalla de venta.
  7. Calcular el `imagen_hash` sobre el archivo ya procesado.
  - Hacerlo en segundo plano (Web Worker o backend nativo) para no congelar la interfaz.
  - Rechazar archivos de entrada de más de ~25 MB o imágenes corruptas con un mensaje claro.
  - Debe haber **tests** con una imagen grande de ejemplo que verifiquen tamaño final, orientación y ausencia de EXIF.
  - Sin esto, 5.000 productos con fotos de celular agotan el plan gratuito.
- **Almacenamiento local:** carpeta `imagenes/` junto a la base SQLite, nombre de archivo = `<producto_id>.webp` y `<producto_id>_thumb.webp`. La base solo guarda `imagen_path` e `imagen_hash`.
- **Almacenamiento en la nube:** bucket **privado** en Supabase Storage (`productos`), con ruta `<comercio_id>/<producto_id>.webp` y políticas RLS por `comercio_id`. No usar bucket público.
- **Sincronización de imágenes (separada de la de datos):**
  - Primero sincronizan los datos; las imágenes se transfieren **después, en segundo plano**, con su propia cola. Una venta o un cambio de precio nunca espera a una imagen.
  - Subida: si `imagen_hash` local difiere del remoto, subir el archivo (upsert).
  - Bajada: al detectar un producto con imagen que no existe localmente, descargarla **bajo demanda o en segundo plano** y guardarla en la caché local.
  - Conservar el último hash sincronizado para no volver a transferir archivos idénticos.
- **Offline:** la UI siempre muestra la imagen local. Si no la tiene todavía, muestra un placeholder genérico (por categoría o ícono).
- **Importación masiva Excel/CSV (Fase 3):** soportar una columna con nombre de archivo o URL de imagen, procesada con la misma canalización de redimensionado.
- **Límites a vigilar:** el plan gratuito de Supabase tiene cuota de almacenamiento y de transferencia limitadas (verificar los valores vigentes al implementar). Registrar en Configuración el espacio usado por imágenes.
- **Borrado:** al borrar lógicamente un producto no se elimina su imagen; una tarea de mantenimiento opcional limpia huérfanas.

### Backup independiente de la sync
- Copia diaria automática del archivo SQLite a una carpeta configurable (el usuario puede apuntarla a Google Drive, Dropbox o un pendrive).
- Botón "Exportar todo a Excel".
- Botón "Restaurar desde backup".

## 6. Módulos

1. **Venta (pantalla de caja):** campo de entrada siempre enfocado para el lector; búsqueda por nombre/código; carrito con cantidades (decimales si corresponde); descuento por ítem y global; pagos mixtos; cliente opcional; ticket; anulación de venta. Atajos de teclado para todo.
2. **Productos y stock:** ABM; importación desde Excel/CSV; ajustes de stock con motivo; **actualización masiva de precios** (+X% o monto fijo por categoría, proveedor o selección), con vista previa.
3. **Compras:** ingreso de mercadería por proveedor; actualiza costo y stock.
4. **Clientes y proveedores:** ABM, cuenta corriente, validación de CUIT.
5. **Caja:** apertura, cierre con arqueo, ingresos/egresos manuales.
6. **Informes** (sección 7).
7. **Usuarios, roles y auditoría** (detalle en §6.1).
8. **Configuración:** datos del comercio, rubro, impresora, sincronización, backups.
9. **Venta móvil web** (opcional, detalle en §6.2): muestra la dirección y el QR de acceso.
10. **Facturación ARCA** (opcional, detalle en §6.3).

### 6.1 Usuarios, roles y auditoría

**Roles**

| Permiso | superadmin | encargado | cajero |
|---|:-:|:-:|:-:|
| Vender, cobrar, abrir/cerrar su caja | ✔ | ✔ | ✔ |
| Ver productos y precios de venta | ✔ | ✔ | ✔ |
| Ver costos, ganancias y márgenes | ✔ | ✔ | ✘ |
| Crear/editar productos, precios, stock, compras | ✔ | ✔ | ✘ |
| Anular una venta | ✔ | ✔ | Solo con autorización (clave de encargado o superadmin) |
| Informes de gestión | ✔ | ✔ | ✘ |
| **Gestionar usuarios** (crear, desactivar, cambiar rol, resetear clave) | ✔ | ✘ | ✘ |
| **Ver y exportar la auditoría** | ✔ | ✘ | ✘ |
| Configuración sensible (sincronización, backups, restaurar) | ✔ | ✘ | ✘ |
| Habilitar/deshabilitar la venta móvil y la facturación ARCA | ✔ | ✘ | ✘ |

**Reglas de usuarios**
- Siempre hay **al menos un superadmin activo**: el sistema no permite desactivar ni degradar al último.
- Un usuario por persona; nada de cuentas compartidas.
- Los usuarios no se eliminan, se **desactivan**.
- Al crear un usuario o resetear su clave, se genera una clave temporal y `debe_cambiar_clave = true`.
- Política de claves: largo mínimo, bloqueo temporal tras N intentos fallidos (cada intento queda auditado) y cierre de sesión por inactividad configurable.
- Login **offline** contra el hash local; en la nube, autenticación con Supabase Auth.
- **Limitación a documentar:** si a un usuario se lo desactiva, una terminal sin conexión puede seguir aceptándolo hasta su próxima sincronización. Mostrarlo en la pantalla de gestión de usuarios.
- **Costos en escritorio:** ninguna pantalla de venta, ticket ni factura muestra `costo_compra` (regla 20); solo se ve en administración de productos, compras e informes, con rol superadmin o encargado. Limitación técnica a conocer: la base local de una terminal de cajero contiene la tabla `productos` completa, incluido `costo_compra`; la restricción en escritorio es de interfaz. Si más adelante se necesita impedir que un empleado lo lea desde el archivo, se sincroniza a esas terminales una vista sin costo. En la venta móvil web la restricción **sí** se aplica en el servidor (§6.2).
- Para el cajero, considerar un **cambio rápido de usuario con PIN** (varios cajeros en la misma terminal), siempre atado a su usuario individual.

**Auditoría (registro de cada movimiento)**
- Se registra: login (exitoso y fallido), logout, ventas creadas y anuladas, altas/ediciones/bajas de productos, **cambios de precio y costo**, ajustes de stock, compras, apertura/cierre de caja, ingresos y egresos de caja, altas/cambios/desactivación de usuarios, cambios de rol, reseteos de clave, cambios de configuración, sincronizaciones, backups y restauraciones, **exportaciones de informes**, activación/desactivación de la venta móvil y de ARCA, **revocación de sesiones móviles**, y emisión de comprobantes.
- Cada registro guarda **quién, cuándo, desde qué terminal, qué acción, sobre qué entidad, valores antes y después, y motivo** (obligatorio en anulaciones y ajustes de stock).
- Se escribe en la misma transacción que el cambio (regla 13).
- **Append-only:** sin pantallas ni API para editar o borrar. En Supabase, RLS permite solo `INSERT` y `SELECT` sobre `auditoria`; nadie tiene `UPDATE` ni `DELETE`, ni siquiera el superadmin.
- **Hash encadenado:** `hash = SHA-256(hash_prev + contenido del registro)`. Hay una pantalla "Verificar integridad de la auditoría" que recorre la cadena y señala cualquier alteración.
- Nunca se registran claves ni hashes de clave en `valores_antes/despues`.
- Pantalla de consulta (solo superadmin) con filtros por usuario, acción, entidad y fechas, y exportación a Excel/PDF (la exportación también se audita).
- No se purga nunca; si el volumen crece, se archiva por año sin borrar.
- **Límite honesto:** quien tenga acceso al archivo SQLite de una terminal podría manipularlo. La cadena de hash y la copia en Supabase permiten **detectar** la alteración, no impedirla. Por eso es importante sincronizar seguido y proteger físicamente las terminales.

### 6.2 Venta móvil web (el celular como punto de venta)

**Objetivo:** usar la cámara del celular como lector de códigos de barras para armar una venta desde cualquier lugar del comercio. **Sirve solo para vender y facturar; no administra nada.** Para el cliente del sistema debe ser lo más simple posible: **escanea un QR (o escribe una dirección), inicia sesión y vende. No instala nada ni toca certificados.**

**Arquitectura (decidida)**
- App web (PWA) en `/web-pos`, publicada con **HTTPS** en un hosting gratuito (Cloudflare Pages o Netlify), que habla con Supabase. Es una única aplicación para todos los comercios: el comercio se determina por el usuario que inicia sesión.
- Los navegadores solo permiten usar la cámara en páginas HTTPS de confianza; con el hosting en la nube esto funciona sin configurar nada en el celular. Opcional: "Agregar a la pantalla de inicio" para abrirla como una app.
- **El celular necesita internet** (Wi-Fi o datos móviles). Las ventas llegan a la terminal de escritorio por la sincronización normal (§5): la terminal las descarga al abrir, de forma periódica mientras está abierta, y con el botón "Bajar datos ahora". No son instantáneas en escritorio.
- Venta móvil sin conexión queda fuera del alcance inicial (mejora futura: cola local en el celular).
- Requiere la Fase 2 (Supabase) terminada.
- Alternativa descartada: servidor local con certificado propio instalado en cada celular (funciona sin internet, pero es demasiado técnica para el cliente).

**Acceso**
- Configuración > "Venta móvil" (solo superadmin): interruptor para activarla, **dirección web y código QR** que apunta a esa dirección, botones "Copiar dirección" e "Imprimir QR", y lista de sesiones activas con botón **Revocar**.
- El QR contiene **solo la URL pública**, nunca claves ni tokens (regla 19).
- Inicio de sesión con el usuario y la clave individuales de cada persona (Supabase Auth). Solo entran usuarios con `puede_vender_movil`. Las sesiones vencen y se cierran por inactividad.

**Alcance funcional (solo esto)**
- Escanear con la cámara, escribir el código o buscar por nombre. Mostrar nombre, miniatura y **precio de venta** (nunca el costo).
- Armar el carrito: cantidades, quitar ítems.
- Cobrar: uno o varios medios de pago, cliente opcional (CUIT/DNI si se factura), confirmar.
- Comprobante: ticket en pantalla y opción de compartirlo (PDF o WhatsApp); factura ARCA si está habilitada (§6.3).
- Consultar las ventas propias del día.
- **Fuera de alcance:** editar productos, precios o stock; ver costos, ganancias o informes; compras; usuarios; configuración; anular ventas (se hace en escritorio con autorización). Los descuentos solo si el comercio los habilita.

**Seguridad (se aplica en Supabase, no solo en la interfaz)**
- RLS por `comercio_id` y por rol. El rol web **no tiene acceso directo a las tablas**: lee el catálogo a través de una **vista `productos_venta` sin la columna `costo_compra`** y crea ventas únicamente llamando a **una función (RPC) `crear_venta_movil`**.
- Esa función **valida y recalcula en el servidor** precios, descuentos y totales a partir de `precios`; el celular solo envía ids de producto, cantidades y medios de pago. Inserta venta, ítems, pagos, movimientos de stock y auditoría en **una sola transacción**.
- **Idempotencia:** cada venta lleva un UUID generado en el celular. Si se corta la conexión y se reintenta, no se duplica.
- Cada venta guarda `canal = 'web'`, usuario y dispositivo.
- Límite de intentos de login y HTTPS obligatorio.

**Escaneo**
- Usar `BarcodeDetector` donde exista y una librería de respaldo (por ejemplo ZXing) para iPhone/Safari y navegadores sin soporte. Incluir linterna y entrada manual. Probar en Android y iPhone reales.

**Catálogo en el celular**
- Se descarga el catálogo de venta (id, nombre, códigos de barras, precio de venta, miniatura) desde la vista `productos_venta` y se guarda en caché; se refresca al abrir la app. Nunca incluye costos.

**Stock y caja**
- Las ventas web generan movimientos de stock igual que las de escritorio (append-only), así que no hay conflictos. El stock mostrado puede estar levemente atrasado hasta sincronizar; si queda negativo se permite y se alerta (configurable).
- Supuesto a confirmar: cada usuario abre y cierra su **caja móvil** desde el celular (monto inicial configurable) y ve el resumen por medio de pago al cerrar.

**Código compartido**
- Mover la lógica de `/src/domain` (totales, IVA, redondeo de centavos) a un **paquete compartido** (`/packages/domain`) usado por escritorio y web, con los mismos tests, para que ambos calculen exactamente igual. La función `crear_venta_movil` debe producir los mismos resultados (test cruzado con casos de ejemplo).

### 6.3 Facturación ARCA (opcional)

- **Interruptor en Configuración** (solo superadmin), **apagado por defecto**. Con ARCA apagada no aparece ninguna opción fiscal y todo funciona con ticket no fiscal.
- Al activarla, un asistente pide: CUIT, condición frente al IVA, punto de venta electrónico habilitado en ARCA, ambiente (**homologación** o producción) y credenciales del servicio de terceros.
- **Integración vía servicio de terceros** (Afip SDK, TusFacturas u otro; elegir al implementar según costo, documentación y estabilidad), no webservices de ARCA a mano.
- **Las credenciales y certificados nunca van en el cliente, ni en la app web ni en el repositorio.** Viven como secretos de una **Edge Function de Supabase** que emite el comprobante. Escritorio y celular solo la invocan con su sesión autenticada y nunca ven las credenciales.
- El tipo de comprobante (A/B/C) sale de la condición IVA del emisor y del cliente, con reglas en `/domain` y tests. Los datos del cliente exigidos según el monto cambian con las normas: verificar valores vigentes al implementar.
- Se guarda en la venta: tipo, punto de venta, número, CAE, vencimiento y `estado_facturacion`. El comprobante incluye el QR oficial de ARCA.
- **Sin internet:** la emisión requiere conexión. Si falla, la venta queda `pendiente` y se reintenta sola al volver la conexión. **Si se puede diferir la emisión, por cuánto tiempo y qué se entrega al cliente mientras tanto, debe definirse con el contador** (hay plazos legales). La app muestra siempre los pendientes.
- Una venta facturada no se borra ni se edita: se anula con **nota de crédito**.
- Todo queda auditado. Informes: comprobantes emitidos, pendientes y con error.
- Probar siempre primero en homologación.

## 7. Informes

Todos filtrables por rango de fechas y exportables a **Excel (.xlsx) y PDF**.

- Ventas por día / semana / mes, por producto, categoría, marca, usuario y medio de pago.
- **Ganancia bruta y margen** (usa `costo_unitario` copiado en cada ítem vendido) por producto y por período.
- Ranking de productos más y menos vendidos.
- Stock actual, **stock bajo mínimo**, productos sin movimiento.
- **Stock valorizado** a costo y a precio de venta.
- Cierre de caja diario (por medio de pago).
- Cuentas corrientes: deudas de clientes y con proveedores.
- **Libro IVA Ventas y Libro IVA Compras** exportables (formato pensado para contador).
- Evolución de precios y costos de un producto.
- **Auditoría** (solo superadmin): actividad por usuario, por acción y por período; anulaciones y ajustes de stock con su motivo; intentos de login fallidos.
- Ventas, anulaciones y descuentos **por usuario** (para controlar la caja).
- Ventas **por canal** (escritorio / web móvil).
- Si ARCA está habilitada: comprobantes emitidos, pendientes y con error.
- Balance simple del período: ventas, costo de mercadería vendida, ganancia bruta, egresos de caja.

## 8. Particularidades de Argentina

- **ARCA (ex AFIP):** la facturación electrónica es **opcional** (ver §6.3) y **no se implementa hasta la Fase 4**, pero el modelo de datos ya contempla tipo de comprobante (A/B/C), punto de venta, número, CAE y vencimiento. Cuando llegue el momento, **integrar mediante un servicio de terceros** (por ejemplo Afip SDK o TusFacturas) en lugar de implementar los webservices de ARCA a mano. Evaluar opciones en ese momento.
- **IVA:** alícuotas 0, 10,5, 21, 27 y exento. Precios cargados con IVA incluido o discriminado según la condición del comercio (configurable).
- **Monotributo / Responsable Inscripto:** el comportamiento de los comprobantes depende de esto; dejar el campo en configuración.
- **Medios de pago:** efectivo, transferencia, Mercado Pago, QR, débito, crédito, cuenta corriente. Se registran **por separado** desde el día 1.
- **Inflación:** la actualización masiva de precios y el historial de precios son funciones de primera clase.
- **Formato:** `$ 1.234,56`, fechas `dd/mm/aaaa`, CUIT con validación del dígito verificador.
- Ticket **no fiscal** en las primeras fases. Controlador fiscal fuera del alcance.

## 9. Lector de códigos de barras

- Funciona como un teclado: envía los dígitos y un Enter. **No requiere driver.**
- Implementación: campo de entrada global en la pantalla de venta que siempre recupera el foco; detectar entrada rápida (varios caracteres en pocos milisegundos + Enter) como escaneo.
- Si el código no existe: ofrecer "crear producto con este código" sin salir de la venta (solo para superadmin o encargado).
- Productos sin código: **botones rápidos** configurables y búsqueda por nombre.
- (Opcional) soporte de códigos de balanza con precio/peso embebido.

## 10. Fases

**Fase 1 — MVP local (sin nube)**
Productos + códigos de barras + **imagen local del producto (procesada a WebP y miniatura, ver §5.1)**, venta con escáner, pagos mixtos, stock por movimientos, caja (apertura/cierre), **usuarios, roles y auditoría completa (§6.1)**, informes básicos (ventas, ganancia, stock), exportación a Excel. Base de datos ya diseñada con UUID, `updated_at`, `deleted_at`, `device_id` y cola de sync (aunque aún no se use).

**Fase 2 — Sincronización y backup**
Supabase (esquema, RLS, auth, **Storage para imágenes con su cola de sync propia**), push/pull, disparadores (abrir, cerrar, manual, periódico), indicador de estado, backup automático local, restaurar.

**Fase 3 — Gestión completa**
Compras y proveedores, clientes y cuenta corriente, importación Excel/CSV, actualización masiva de precios, Libro IVA, impresión de tickets ESC/POS.

**Fase 3b — Venta móvil web** (requiere Fase 2)
App web PWA en `/web-pos` con login, escaneo con cámara, carrito, cobro, ticket compartible y caja móvil; RLS, vista sin costos y función de venta con validación de precios en servidor; pantalla de Configuración con dirección y QR (§6.2). Paquete de dominio compartido.

**Fase 4 — Facturación y extras**
Facturación electrónica ARCA **opcional** (servicio de terceros + Edge Function, §6.3; funciona tanto en escritorio como en venta móvil), múltiples listas de precio, variantes, combos, balanzas.

## 11. Estructura sugerida del repositorio

```
/src                 # UI React
  /features          # venta, productos, stock, caja, informes, config
  /domain            # lógica pura: totales, stock, precios, IVA (con tests)
  /db                # acceso a SQLite y repositorios
  /sync              # cola, push, pull, conflictos
/src-tauri           # backend nativo (Rust)
/migrations          # migraciones SQLite versionadas
/supabase/migrations # migraciones Postgres versionadas
/supabase/functions  # Edge Functions (emisión ARCA, Fase 4)
/web-pos             # PWA de venta móvil, publicada en hosting HTTPS (Fase 3b)
/packages/domain     # lógica compartida escritorio + web (a partir de la Fase 3b)
/docs                # decisiones y notas
PLAN.md
AGENTS.md
```

## 12. Supuestos actuales y decisiones pendientes

Estos puntos **no están confirmados por el usuario**. Trabajá con el supuesto indicado y avisá si algo del código depende fuertemente de ellos:

| Tema | Supuesto actual |
|---|---|
| Terminales | Se diseña para multi-terminal, pero la Fase 1 corre en una sola |
| Comercios | Una instalación = un comercio; el esquema incluye `comercio_id` para no cerrar la puerta a multi-comercio |
| Plataforma | Solo Windows 10+ |
| Facturación electrónica | Opcional y apagada por defecto; no en Fase 1; esquema preparado |
| Venta móvil | Web en la nube con HTTPS contra Supabase; el cliente solo escanea un QR o abre la dirección; el celular necesita internet |
| Celulares | Chrome en Android y Safari en iPhone |
| Caja de la venta móvil | Cada usuario abre/cierra una "caja móvil" desde el celular (a confirmar) |
| Emisión ARCA sin conexión | Pendiente de definir con el contador |

## 13. Criterios de aceptación de la Fase 1

- Se puede cargar un producto con código de barras, escanearlo y venderlo en menos de 3 segundos por ítem.
- Con el lector y el teclado se puede completar una venta sin usar el mouse.
- El stock siempre coincide con la suma de movimientos; hay un test que lo verifica.
- Anular una venta devuelve el stock y deja rastro auditable.
- Cerrar la caja muestra el desglose por medio de pago y la diferencia de efectivo.
- Todos los informes de la sección 7 marcados como Fase 1 se exportan a Excel.
- La app abre y funciona sin conexión a internet.
- Cobertura de tests en `/domain` (totales, IVA, stock, redondeos de centavos).
- Un cajero no puede ver costos, ganancias ni la auditoría, ni gestionar usuarios (test por rol).
- No se puede desactivar ni degradar al último superadmin.
- Cada acción de §6.1 genera un registro de auditoría; si la escritura de la auditoría falla, el cambio se revierte (test).
- No existe ninguna ruta de código que edite o borre registros de `auditoria`; la verificación de la cadena de hash detecta un registro alterado a mano (test).
- Anular una venta como cajero pide autorización de un encargado o superadmin y ambos quedan registrados.
- En la pantalla de venta, el ticket y la factura **no aparece ningún costo de compra**, solo `precio_venta` (test de plantillas y pantallas). `costo_compra` solo se ve en administración de productos, compras e informes, para superadmin y encargado.

## 14. Criterios de aceptación: venta móvil (Fase 3b) y ARCA (Fase 4)

- Desde Android y desde iPhone se escanea un producto con la cámara y se agrega al carrito en menos de 2 segundos.
- Escanear el QR de Configuración abre la app web; su contenido es solo la URL y el cliente no instala ni configura nada en el celular.
- Revocar una sesión móvil desde Configuración corta su acceso de inmediato.
- Reintentar una venta tras un corte de conexión no la duplica (cada venta lleva un UUID generado en el celular).
- Un usuario de la venta móvil **no puede leer costos ni modificar productos aunque llame a la API directamente** (test de RLS).
- El celular no puede fijar precios: el servidor los recalcula y rechaza los que no coinciden (test).
- Las ventas hechas desde el celular aparecen en escritorio tras sincronizar, con `canal = 'web'`, stock descontado y registro de auditoría.
- Un usuario sin `puede_vender_movil`, o con la venta móvil desactivada, no puede iniciar sesión en la app web.
- Con ARCA apagada no aparece ninguna opción fiscal.
- Con ARCA encendida en homologación se obtiene un CAE de prueba y se guarda en la venta.
- Las credenciales de ARCA no están en el código del cliente ni en el repositorio (revisión explícita).
- Si falla la emisión, la venta queda `pendiente`, visible, y se reintenta sola.
