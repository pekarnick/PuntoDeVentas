# Decisiones de diseño y supuestos (`/docs/decisiones.md`)

Este documento registra las decisiones técnicas, refinamientos del modelo de datos y justificación de dependencias adoptadas durante el desarrollo, siguiendo las reglas de `PLAN.md` y `AGENTS.md`.

---

## 1. Decisiones de arquitectura y modelo de datos (Fase 1)

### 1.1 Identificadores UUIDv7
- **Decisión:** Se utilizan identificadores **UUIDv7** (RFC 9562) generados localmente en `/src/domain/uuid.ts` sin dependencias externas.
- **Motivo:** Cumple la Regla 1 (`PLAN.md §3`) y, al tener prefijo temporal de 48 bits en milisegundos, mantiene el orden cronológico natural en índices B-Tree de SQLite y Postgres.

### 1.2 Dinero en centavos (enteros) y cantidades con hasta 3 decimales exactos
- **Decisión:**
  - Todos los importes monetarios (`costo_compra`, `precio_venta`, `subtotal`, `descuento`, `total`, `monto`, `costo_unitario`, `precio_unitario`, `limite_credito`) son `INTEGER` en centavos (`$ 1.234,56` = `123456`).
  - Las cantidades (`cantidad`, `stock_minimo`) aceptan enteros para productos por unidad (`permite_decimales = 0`) y hasta 3 decimales exactos (miliunidades: gramos, mililitros, milímetros) para productos pesables o fraccionables (`permite_decimales = 1`).
  - Toda aritmética de cantidades y subtotales en `/src/domain` opera internamente en **miliunidades enteras** (`Math.round(cantidad * 1000)`) para evitar errores de punto flotante IEEE 754 (`0.1 + 0.2 === 0.3`), y en SQLite el cálculo de stock usa `ROUND(COALESCE(SUM(cantidad), 0), 3)`.

### 1.3 Inmutabilidad en base de datos (Triggers SQLite)
- **Decisión:** Además de las validaciones en TypeScript/Rust, la migración `001_esquema_inicial.sql` instala triggers en SQLite para garantizar a nivel motor:
  1. `auditoria`: prohibido `UPDATE` y `DELETE` (Regla 14).
  2. `movimientos_stock`, `ventas_items`, `ventas_pagos`: prohibido `UPDATE` y `DELETE` (Reglas 3 y 4).
  3. `ventas`: prohibido `DELETE` físico y prohibido modificar importes/fecha/usuario; solo se permite la transición controlada de `estado` (`completada` -> `anulada` con motivo y referencia de anulación) y de los campos de facturación diferida (`estado_facturacion`, `cae`, `cae_vencimiento`, `numero_comprobante`).
  4. `usuarios`: prohibido `DELETE` físico (Regla 15) y prohibido desactivar, borrar lógicamente o cambiar de rol al último `superadmin` activo de un comercio (`PLAN.md §6.1`).

### 1.4 Cadena de hash en `auditoria`
- **Decisión:** Cada registro de `auditoria` calcula `hash = SHA-256(hash_prev + payload_canonico)` donde `hash_prev` es el `hash` del último registro insertado en la tabla (o `'GENESIS'` para el primer registro).
- **Motivo:** Permite detectar cualquier manipulación directa del archivo SQLite mediante la función de verificación de integridad (`verificarIntegridadAuditoria`).

### 1.5 Adaptador SQLite para tests y desarrollo local
- **Decisión:** En el entorno de tests (Vitest sobre Node 22+) se utiliza el módulo nativo `node:sqlite` (`DatabaseSync`) ejecutando exactamente los mismos archivos SQL de `/migrations` que usa el backend de Tauri.
- **Motivo:** Permite correr tests de integración reales contra SQLite en milisegundos sin requerir compilación de addons C++ externos en Node, manteniendo compatibilidad total con Tauri 2 (`rusqlite` / `tauri-plugin-sql`).

---

## 2. Justificación de dependencias (`package.json`)

| Paquete | Tipo | Justificación (1 línea según `AGENTS.md`) |
|---|---|---|
| `react`, `react-dom` | prod | Librería de interfaz de usuario definida en el stack oficial (`PLAN.md §2`). |
| `@tauri-apps/api` | prod | Puente oficial de comunicación entre el frontend React y el proceso nativo de Tauri 2. |
| `@noble/hashes` | prod | Implementación auditada sin dependencias de Argon2id para el hash seguro de claves de usuario (`PLAN.md §3` regla 16). |
| `sharp` | prod | Procesamiento local de imágenes de productos: corrección de orientación EXIF, borrado de metadatos GPS/EXIF y compresión a WebP (`<= 150 KB`) y miniatura (`PLAN.md §5.1`). |
| `typescript` | dev | Tipado estático obligatorio definido en el stack (`PLAN.md §2`). |
| `vite`, `@vitejs/plugin-react` | dev | Empaquetador y servidor de desarrollo rápido para React + Tauri 2 (`PLAN.md §2`). |
| `vitest` | dev | Runner de tests unitarios y de integración para TypeScript (`PLAN.md §2`). |
| `@types/react`, `@types/react-dom`, `@types/node` | dev | Definiciones de tipos TypeScript para React y APIs nativas de Node en tests. |
| `@tauri-apps/cli` | dev | CLI oficial para compilar y ejecutar el contenedor de escritorio Tauri 2. |

---

## 3. Decisiones de Sincronización y Backups (Fase 2)

### 3.1 Cadena de hash de `auditoria` por terminal (`device_id`) en sincronización multi-terminal
- **Decisión:** Cada terminal (`device_id`) encadena su propio `hash_prev` sobre el último registro emitido por esa misma terminal (iniciando en `'GENESIS'`), y `verificarCadenaAuditoria` valida la secuencia de eslabones por cada `device_id`.
- **Motivo:** Como cada terminal opera offline y la tabla `auditoria` es estrictamente inmutable (`BEFORE UPDATE` prohibido en SQLite y Postgres), mantener el eslabón criptográfico por `device_id` permite que cualquier terminal verifique la integridad completa de los registros propios y de los descargados desde otras terminales sin re-hashear ni modificar registros existentes.

### 3.2 Cola de imágenes separada (`sync_imagenes_cola`)
- **Decisión:** La migración `002_sync_imagenes_y_config_backup.sql` introduce la tabla `sync_imagenes_cola` separada de `sync_cola`, almacenando `ultimo_hash_sincronizado`.
- **Motivo:** Cumple `PLAN.md §5.1`: primero viajan todos los datos transaccionales/maestros y recién después se transfieren los archivos `.webp` y `_thumb.webp` al bucket privado `productos` de Supabase Storage, evitando re-subir imágenes cuyo hash SHA-256 no cambió.

### 3.3 Backups locales consistentes mediante `VACUUM INTO`
- **Decisión:** Las copias de seguridad diarias automáticas, manuales y previas a una restauración se generan mediante la sentencia nativa `VACUUM INTO` de SQLite.
- **Motivo:** Garantiza una copia atómica e íntegra en un único archivo `.db` incluso cuando la base activa está operando en modo `WAL` con transacciones concurrentes. Antes de aplicar cualquier restauración se valida el encabezado binario SQLite, `PRAGMA integrity_check` y la cadena de hash de `auditoria`, generando además un backup automático `previo_restauracion`.

---

## 4. Decisiones de Facturación Electrónica ARCA y Extras (Fase 4)

### 4.1 Facturación ARCA vía Edge Function y Cola de Reintento Offline
- **Decisión:**
  - ARCA viene apagada por defecto (`arca_habilitada = 0`). Cuando está apagada, las ventas son `ticket_no_fiscal` con `estado_facturacion = 'no_aplica'` y la interfaz de caja no muestra ninguna opción fiscal (`PLAN.md §6.3` y `§14`).
  - Las credenciales y certificados digitales (`.crt` / `.key` o token de proveedor como Afip SDK / TusFacturas) **nunca** se guardan en SQLite, ni en el cliente React, ni en `/web-pos`, ni en el repositorio (Reglas 8, 18 y 19). Residen exclusivamente como secretos en la Edge Function `supabase/functions/emitir_comprobante_arca/index.ts`.
  - Si se vende sin conexión a internet con ARCA activa, la venta se completa localmente con `estado_facturacion = 'pendiente'` sin bloquear jamás la caja y se reintenta automáticamente al recuperar la conexión (`reintentarComprobantesArcaPendientes`).
  - Anular una venta ya facturada en ARCA emite automáticamente la **Nota de Crédito A/B/C** asociada (`nota_credito_tipo`, `nota_credito_numero`, `nota_credito_cae`, `nota_credito_cae_vencimiento`).
  - Los comprobantes fiscales incluyen el **QR oficial RG 4892/2020** (`https://www.afip.gob.ar/fe/qr/?p=<base64>`) generado en SVG puro sin exponer costos (`Regla 20`).

### 4.2 Balanzas EAN-13, Múltiples Listas de Precio, Variantes y Combos
- **Decisión:**
  - Las etiquetas EAN-13 de balanzas comerciales con prefijo `20` (`20PPPPPPGGGGV`, peso en gramos) y `21` (`21PPPPPPIIIIV`, importe en pesos) se decodifican en `/packages/domain/src/arca_fase4.ts` validando el dígito verificador EAN-13.
  - Los combos (`combos` y `combos_items`) calculan su stock disponible dinámicamente a partir del stock actual de sus productos componentes (`Math.floor(min(stock / cantidad_requerida))`) y, al venderse, registran los movimientos de stock negativos sobre cada componente, respetando estrictamente la Regla 4 (el stock nunca es un campo editable).

---

## 5. Administración de Sucursales, Migración de Stock, Pedidos PDF y Mejoras Operativas de Caja y Móvil

### 5.1 Modelo Multi-Sucursal con Movimientos Append-Only (`007_sucursales_y_transferencias.sql`)
- **Decisión:**
  - Cada comercio posee una sucursal principal por defecto (`Casa Central`, `es_principal = 1`) en la tabla `sucursales`.
  - Los movimientos de stock (`movimientos_stock`), ventas (`ventas`), compras (`compras`) y sesiones de caja (`caja_sesiones`) incorporan `sucursal_id` (con fallback automático a la sucursal principal para registros previos, preservando el 100% de compatibilidad hacia atrás).
  - La migración/transferencia de mercadería entre sucursales se asienta en la tabla append-only `transferencias_sucursales` y genera, dentro de la misma transacción atómica, un movimiento negativo (`ajuste` de salida) en la sucursal de origen y un movimiento positivo (`ajuste` de entrada) en la sucursal de destino, manteniendo invariante la suma global de `movimientos_stock` (Regla 4) y escribiendo el eslabón SHA-256 en `auditoria` (Reglas 13 y 14).

### 5.2 Generación Nativa de PDFs de Pedidos por Stock Bajo (`src/domain/pdf.ts` y `src/domain/pedidos_reposicion.ts`)
- **Decisión:**
  - Las listas de pedido para productos con `stock_actual <= stock_minimo` se calculan con funciones puras agrupadas por **Proveedor**, por **Marca** y por **Categoría**, y se exportan mediante un generador `%PDF-1.4` nativo en TypeScript sin dependencias externas pesadas.

### 5.3 Bloqueo Operativo en Caja Cerrada y Modal Instantáneo en Cajero Móvil (`/web-pos`)
- **Decisión:**
  - El acceso a **Caja y Arqueo** se ubica en el segundo lugar del menú principal (al lado de **Venta (Mostrador)**) con indicador de estado en vivo (`🟢 Abierta` / `🔴 Cerrada`). Mientras la caja está cerrada, se bloquean los cobros de ventas, movimientos manuales y arqueos, ofreciendo apertura rápida desde la propia pantalla de venta.
  - En `/web-pos`, al confirmar una venta se hace scroll automático hacia arriba y el comprobante se presenta en una ventana modal centrada a pantalla completa (`role="dialog"`), evitando que el operador tenga que desplazarse manualmente para ver o compartir el ticket por WhatsApp.

---

## 6. Pantalla de Login, Cambio Directo de Clave, Combos en Buscador y Cajero Móvil, Sincronización Dual y Actualizaciones Tauri

### 6.1 Login Obligatorio, Cambio Directo de Contraseña y Selector de Rol Exclusivo para Superadmin
- **Decisión:**
  - Al iniciar la aplicación se exige iniciar sesión con usuario y clave validados offline contra el hash Argon2id local (`autenticarUsuarioOffline` / `iniciar_sesion_operador`).
  - El selector del encabezado **`🧪 Probar rol`** se muestra **únicamente** cuando el operador autenticado real tiene rol `superadmin` (`operadorAutenticado.rol === 'superadmin'`). Para `encargado` y `cajero`, dicho selector permanece oculto.
  - En la gestión de usuarios (`PanelUsuarios.tsx`), además del reseteo con clave temporal, se incorpora `establecerClaveUsuarioDirecta` (`cambiar_clave_usuario`), que permite escribir directamente la nueva contraseña en la fila del usuario (o al hacer clic en `"Pendiente al ingresar"`), actualizando el hash Argon2id y dejando `debe_cambiar_clave = 0` (`"Al día"`).

### 6.2 Búsqueda y Cálculo Exacto en Centavos de Combos en Escritorio y Cajero Móvil (`/web-pos`)
- **Decisión:**
  - En **Venta (POS)** de escritorio (`PanelVentaPOS.tsx`), el desplegable de autocompletado (`opcionesDesplegable`) incluye tanto productos individuales como **combos activos** coincidentes por nombre, descripción, código de barras o nombre de cualquiera de sus componentes.
  - En **Venta Móvil Web (`/web-pos`)**, `obtener_catalogo_movil` entrega los combos activos sin `costo_compra` (Regla 20). Al agregar un combo al carrito móvil o de escritorio, se suman sus productos componentes (para descontar su stock por movimientos según la Regla 4) y se calcula la bonificación exacta en centavos (`sumaComponentesEnCatalogo - combo.precio_venta`) convirtiendo los importes mediante `pesosACentavos`, garantizando que el total a cobrar por el combo sea siempre exactamente `combo.precio_venta`.

### 6.3 Script SQL Unificado de Supabase, Normalización UUID Nullable y Copia Completa a Firebase
- **Decisión:**
  - Se unifican las migraciones `001` a `004` de PostgreSQL en un único archivo idempotente `supabase/esquema_completo_unificado.sql` accesible desde la pestaña **📖 Ayuda y Manual** y **Configuración**.
  - En `serializarRegistroParaPostgres` (`src/sync/motor_sync.ts`), las columnas UUID nullables (`CAMPOS_UUID_NULLABLES_POSTGRES`, incluyendo `auditoria.usuario_id` en intentos de login con usuario inexistente) convierten cadenas vacías `""` a `null` antes de hacer push a PostgreSQL (evitando el error `22P02`), mientras que los campos de tipo `TEXT` terminados en `_id` (`CAMPOS_TEXTO_ID_POSTGRES`: `device_id`, `dispositivo_id`, `entidad_id`, `referencia_id`) se preservan como texto para no anular `dispositivo_id` en `ventas` o `sesiones_moviles`. Asimismo, `recolectarPendientesLocalesEnCola` desbloquea y re-encola automáticamente cualquier ítem en estado `error` por `PGRST205`, `22P02`, `23502` o `23503`.
  - Se incorpora `copiarBaseCompletaAFirebaseSinDuplicados` para volcar bajo demanda todas las tablas locales sincronizables a Cloud Firestore usando el UUIDv7 de cada registro como ID de documento, garantizando cero duplicados.




## Endurecimiento de Seguridad P0 (Auditoría)
- **Asistente de Primer Uso sin credenciales por defecto:** En bases nuevas sin `superadmin` activo, la aplicación muestra `PantallaConfiguracionInicial` para que el dueño cree su comercio y contraseña inicial con Argon2id, eliminando contraseñas hardcodeadas (`Admin1234`, `Encargado1234`, `Cajero1234`, `Temporal2026!`) y `asegurarOperadoresPorDefecto`.
- **Autenticación en la nube opcional sin romper modo offline:** El POS de escritorio continúa operando 100% offline contra SQLite con sesiones locales emitidas por `iniciar_sesion_operador` (`X-POS-Session`). Para sincronizar con las reglas estrictas `TO authenticated` de Supabase y `request.auth != null` de Firebase, `PanelConfiguracionSync` permite iniciar sesión en Supabase Auth / Firebase Auth manteniendo únicamente el token JWT en memoria.

## Endurecimiento de Seguridad P1 (Auditoría)
- **Token de Netlify en memoria efímera:** `netlify_token` dejó de persistirse en `configuracion_sistema` (SQLite) y en backups; si se reinicia la aplicación, el superadmin lo ingresa nuevamente en Configuración cuando desea publicar `/web-pos`.
- **Configuración de `/web-pos` en producción:** `window.__POS_CONFIG__` tiene precedencia sobre `localStorage` y bloquea la edición manual del endpoint de Supabase cuando la app está desplegada oficialmente.

## Endurecimiento de Seguridad P2 (Auditoría)
- **Identificador único de terminal:** cada instalación genera un `device_id` único (`terminal-<uuidv7>`) persistido en `comercio_identidad.json` mediante `obtenerODefinirDeviceIdTerminal` para evitar colisiones en LWW entre terminales.
- **Cuarentena y aislamiento en sincronización:** los ítems en `sync_cola` con `intentos >= MAX_INTENTOS_SYNC_COLA` (5) quedan en cuarentena para no bloquear la cola; la adopción de un comercio remoto requiere confirmación explícita (`permitirAdopcionRemota: true`) y cada fila de pull se aplica dentro de su propio `SAVEPOINT`.

## Endurecimiento de Seguridad P3 (Auditoría)
- **Límite de crédito `$ 0,00` sin fiado:** `limite_credito = 0` en `clientes` significa explícitamente sin crédito habilitado (`$ 0,00`), requiriendo un límite positivo autorizado por `encargado`/`superadmin` para vender en cuenta corriente.
- **Saneamiento de exportaciones e imágenes:** las celdas de texto de Excel neutralizan fórmulas (`=`, `+`, `-`, `@`, `\t`, `\r`), los tickets ESC/POS eliminan bytes de control y las imágenes descargadas validan SHA-256 y se re-codifican con Sharp bajo `limitInputPixels = 25 MP`.
