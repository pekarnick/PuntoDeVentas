# PROMPT_BASE.md — Contexto Base y Guía de Continuación del Proyecto

> [!IMPORTANT]
> **REGLA OBLIGATORIA PARA EL ASISTENTE / AGENTE IA:**
> 1. Al iniciar una **nueva conversación o ventana de chat**, leé este archivo completo junto con `AGENTS.md` y `PLAN.md`.
> 2. **Mantené este archivo actualizado:** Cada vez que completes o avances significativamente una fase (o subfase), **actualizá este documento (`PROMPT_BASE.md`)** reflejando el nuevo estado, los archivos creados/modificados, las pruebas que pasan y las tareas que quedan pendientes para la siguiente fase.

---

## 1. Identidad y Propósito del Proyecto

Sistema de **Punto de Venta (POS) genérico offline-first** para comercios minoristas de Argentina (kioscos, librerías, ferreterías, almacenes).
- **Stack principal:** Tauri 2 + React 18 + TypeScript + SQLite (Node `node:sqlite` DatabaseSync / Tauri) + Supabase (Postgres, RLS, Storage y Edge Functions).
- **Base de datos local:** SQLite en `data/pos_local.db` (migraciones versionadas en `/migrations`).
- **Nube:** Supabase Postgres (migraciones versionadas en `/supabase/migrations`).

---

## 2. Reglas Inviolables de Arquitectura y Negocio (Resumen)

1. **Moneda e Importes:** Siempre en **enteros (centavos)**; nunca valores de punto flotante (`float`) para importes monetarios. Formato rioplatense: `$ 1.234,56`.
2. **Identificadores:** Siempre UUID (UUIDv7 ordenable por tiempo), nunca IDs numéricos autoincrementales.
3. **Ventas Inmutables (Append-Only):** Las ventas **nunca** se editan ni se borran físicamente; únicamente se anulan mediante una transacción auditada y compensatoria.
4. **Stock Calculado:** El stock **nunca** es un campo que se edite a mano: es siempre la **suma de movimientos de stock** (`movimientos_stock`).
5. **Auditoría Obligatoria y Hash Encadenado:** Toda operación que mute datos escribe en `auditoria` en la misma transacción atómica con hash encadenado SHA-256 (`hash = SHA-256(hash_prev + contenido)`). La tabla es estrictamente append-only (sin UPDATE ni DELETE). Nunca se registran contraseñas ni hashes de contraseñas.
6. **Regla 20 — El cliente y el cajero NUNCA ven costos:** Pantallas de venta, tickets, facturas, PDF y venta móvil muestran exclusivamente `precio_venta`. `costo_compra` solo es visible para `superadmin` y `encargado` en administración de productos, compras e informes de ganancia.
7. **Regla 19 — QR de Venta Móvil:** El código QR contiene **únicamente la URL pública**, jamás claves, tokens, secretos ni parámetros de sesión.
8. **Seguridad Supabase (Regla 8):** Nunca claves secretas (`service_role` o `sb_secret_`) en el cliente. RLS habilitado en todas las tablas.
9. **Offline-First Real:** El POS de escritorio opera 100% desconectado a internet. La sincronización es en segundo plano y jamás bloquea la caja.
10. **Lógica Pura Compartida:** Toda la lógica de negocio vive en `/packages/domain` como funciones puras con tests (totales, IVA, redondeo, stock, CUIT módulo 11, QR de venta móvil).

---

## 3. Estado de Avance por Fases

| Fase | Descripción | Estado | Notas / Commits |
|---|---|---|---|
| **Fase 1** | MVP local sin nube | **100% Completada** | Esquema inicial SQLite, ventas, stock por movimientos, caja, usuarios Argon2id, auditoría SHA-256, informes básicos y Excel. |
| **Fase 2** | Sincronización y backup | **100% Completada** | Esquema Supabase con RLS, Storage de imágenes WebP en cola separada, motor sync push/pull, backup automático local y restauración. |
| **Fase 3** | Gestión completa | **100% Completada** | Compras, proveedores, clientes, cuenta corriente con validación CUIT módulo 11, actualización masiva de precios con redondeo configurable, importación CSV, Libro IVA Ventas/Compras en Excel (.xlsx) y tickets ESC/POS térmicos sin costos. Commit `b4939ab`. |
| **Fase 3b** | Venta móvil web (`/web-pos`) | **100% Completada** | Paquete compartido `@pos/domain`, migraciones SQLite (`003_venta_movil_sesiones.sql`) y Supabase (`002_venta_movil_rpc.sql`), repositorio `src/db/venta_movil_repo.ts`, UI de configuración QR y sesiones en escritorio, PWA móvil `/web-pos` con cámara `BarcodeDetector`, idempotencia UUIDv7, WhatsApp y Caja Móvil, más suite de tests `src/db/__tests__/venta_movil.test.ts`. |
| **Fase 4** | Facturación electrónica ARCA y extras | **100% Completada** | Migraciones `migrations/004_arca_y_extras_fase4.sql` y `supabase/migrations/003_arca_y_extras_fase4.sql`, Edge Function `supabase/functions/emitir_comprobante_arca/index.ts`, lógica pura en `packages/domain/src/arca_fase4.ts`, repositorio `src/db/arca_fase4_repo.ts`, CAE y vencimiento en homologación/producción, Nota de Crédito A/B/C al anular, QR oficial RG 4892/2020 sin costos (Regla 20), cola de reintento offline, múltiples listas de precio, variantes, combos y lectura de códigos de balanza EAN-13, con suite de tests `src/db/__tests__/arca_fase4.test.ts`. |

---

## 4. Detalle de la Fase 3b Completada (Venta Móvil Web `/web-pos`)

1. **Paquete Compartido de Dominio (`/packages/domain`)**:
   - `packages/domain/src/venta_movil.ts`:
     - `validarUrlPublicaVentaMovil`: exige HTTPS (o `localhost` en desarrollo) y bloquea tokens, credenciales o claves en la URL (Regla 19).
     - `generarQrSvgUrlPublica`: generador determinístico ISO/IEC 18004 de códigos QR en SVG puro sin dependencias externas.
     - `calcularVentaMovilDesdeCatalogo`: recálculo seguro de precios, descuentos, IVA y medios de pago desde el catálogo oficial.
     - `formatearComprobanteMovilWhatsApp`: comprobante listo para compartir por WhatsApp (`https://wa.me/?text=...`) o imprimir sin exponer costos (Regla 20).

2. **Migraciones y Seguridad en Servidor**:
   - SQLite: `migrations/003_venta_movil_sesiones.sql` (columna `venta_movil_url` en `configuracion_sistema` y tabla `sesiones_moviles` sincronizable).
   - Supabase: `supabase/migrations/002_venta_movil_rpc.sql` (tabla `sesiones_moviles` con RLS, vista `productos_venta` sin `costo_compra`, y RPC `crear_venta_movil` transaccional e idempotente).
   - Repositorio local: `src/db/venta_movil_repo.ts` y endpoints RPC en `src/db/servidor_local_dev.ts`.

3. **Interfaz de Escritorio (Configuración -> Venta Móvil y Usuarios)**:
   - `src/features/configuracion/PanelConfiguracionSync.tsx`: tarjeta **"Venta Móvil Web (`/web-pos`) — QR y Sesiones Activas (§6.2)"** con interruptor general, URL pública validada, vista previa del QR SVG, botones **"Copiar dirección"**, **"Imprimir QR"** y **"Abrir `/web-pos`"**, tabla de permisos `puede_vender_movil` por usuario y tabla de sesiones móviles activas con botón **"Revocar sesión"** (auditado).
   - `src/features/usuarios/PanelUsuarios.tsx`: columna y casilla `puede_vender_movil` en la administración de usuarios.

4. **Aplicación Web Móvil PWA (`/web-pos`)**:
   - Archivos: `web-pos/index.html`, `web-pos/manifest.webmanifest`, `web-pos/src/main.tsx`, `web-pos/src/WebPosApp.tsx` y `web-pos/src/estilos_web_pos.css` (integrados en `vite.config.ts` como multi-page app).
   - Funcionalidades: login individual (`puede_vender_movil`), cierre inmediato ante expiración o revocación remota, catálogo proyectado sin costos (Regla 20), escáner de cámara con `BarcodeDetector` + linterna + carga manual de código, carrito con cantidades y descuento, cobro con pagos mixtos y cliente opcional (con control de límite en cuenta corriente), UUIDv7 de idempotencia generado en el celular, ticket con botón de compartir por WhatsApp, y pestañas de **Caja Móvil** y **Mis Ventas de Hoy**.

5. **Suite de Pruebas (`src/db/__tests__/venta_movil.test.ts`)**:
   - 8 archivos de test y 38 tests pasando al 100% (`npm test`), `npx tsc --noEmit` sin errores y `npm run build` generando `dist/index.html` y `dist/web-pos/index.html`.

---

## 5. Detalle de la Fase 4 Completada — Facturación Electrónica ARCA y Extras

1. **Lógica Pura Compartida (`packages/domain/src/arca_fase4.ts`)**:
   - `determinarTipoComprobanteArca` y `determinarNotaCreditoArca`: resuelve `ticket_no_fiscal`, `factura_a`, `factura_b`, `factura_c` y sus Notas de Crédito (`nota_credito_a/b/c`) según condición IVA del emisor y del cliente.
   - `validarReceptorComprobanteArca`: exige CUIT módulo 11 en Factura A y DNI/CUIT cuando supera el tope reglamentario de Consumidor Final.
   - `construirUrlQrOficialArca` y `generarQrOficialArcaSvg`: genera el código QR oficial RG 4892/2020 (`https://www.afip.gob.ar/fe/qr/?p=<base64>`) en SVG puro sin dependencias externas.
   - `formatearComprobanteFiscalImprimible`: comprobante fiscal HTML/PDF y térmico con CAE, vencimiento CAE y QR oficial sin exponer jamás `costo_compra` ni ganancias (Regla 20).
   - `parsearCodigoBarrasBalanza` y `construirCodigoBarrasBalanzaEan13`: lectura de etiquetas EAN-13 de balanzas comerciales con peso en gramos (prefijo `20`) o importe (prefijo `21`).
   - `calcularPrecioYStockCombo` y `resolverPrecioProductoEnLista`: cálculo de combos (con stock derivado de sus componentes según Regla 4), múltiples listas de precio y variantes.

2. **Migraciones y Edge Function de Supabase**:
   - SQLite: `migrations/004_arca_y_extras_fase4.sql` (columnas de configuración pública ARCA en `comercios`, campos de cola y Nota de Crédito en `ventas`, y tablas sincronizables `variantes`, `combos` y `combos_items`).
   - Supabase Postgres: `supabase/migrations/003_arca_y_extras_fase4.sql` (espejo con RLS por `comercio_id`).
   - Edge Function: `supabase/functions/emitir_comprobante_arca/index.ts` (las credenciales y certificados viven exclusivamente en variables de entorno del servidor, nunca en el cliente ni en el repositorio).

3. **Repositorio, UI y Suite de Pruebas (`src/db/arca_fase4_repo.ts` y `src/db/__tests__/arca_fase4.test.ts`)**:
   - 9 archivos de test y 45 tests pasando al 100% (`npm test`), `npx tsc --noEmit` sin errores y `npm run build` compilando escritorio y `/web-pos`.

---

## 6. Mejoras Post-Fase 4 Completadas (Etapas 1 a 6)

1. **Etapa 1 — Sincronización Supabase Resiliente, Recuperación tras Borrar Base Local y Vaciado Remoto**:
   - `src/sync/motor_sync.ts` y `src/db/servidor_local_dev.ts`:
     - Persistencia de identidad del comercio en `data/comercio_identidad.json` y descubrimiento automático del `comercio_id` remoto cuando `data/pos_local.db` es eliminada o está vacía (`descubrirComercioRemoto` + resolución de colisiones de claves únicas en `insertarFilaRemotaEnSQLite`).
     - Tolerancia a diferencias de esquema en Supabase (`PGRST204` columnas nuevas de Fase 4 y `PGRST205` tablas opcionales `sesiones_moviles`, `variantes`, `combos`, `combos_items`) y botón **"📋 Copiar SQL actualización Supabase"** en `src/features/configuracion/PanelConfiguracionSync.tsx`.
     - Vaciado remoto sincronizado al ejecutar **"Resetear base de datos a cero"** (`vaciarDatosComercioRemoto` y RPC `resetear_comercio_a_fabrica` en `supabase/migrations/003_arca_y_extras_fase4.sql`).
2. **Etapa 2 — Importación CSV Idempotente y Códigos de Barras Repetidos**:
   - `src/domain/gestion_fase3.ts`, `src/db/repositorios.ts` y `src/db/gestion_fase3_repo.ts`:
     - Ignora marcadores vacíos (`0`, `-`, `S/C`, `N/A`) en `codigo_barras`.
     - Reactiva productos/códigos con `deleted_at` y evita abortar toda la importación cuando dos artículos distintos comparten el mismo EAN en una planilla (importa el producto y registra una advertencia clara).
3. **Etapa 3 — Edición de `stock_minimo` y Carga/Visualización de Imágenes WebP de Productos**:
   - `src/features/productos/PanelProductosStock.tsx`, `src/db/servidor_local_dev.ts`, `vite.config.ts` y `src/features/venta/PanelVentaPOS.tsx`:
     - Carga de imagen al crear producto o desde cada fila de la tabla (**"📷 Foto"**), procesando con `guardarImagenProductoLocal` (WebP ≤ 150 KB + miniatura `_thumb.webp` ≤ 25 KB sin EXIF/GPS) y sirviendo miniaturas en `/api/pos-imagen/<id>_thumb.webp`.
     - Edición directa en la tabla de catálogo (**"✏️ Editar"** / **"💾 Guardar"**) para `stock_minimo`, `nombre`, `costo_compra`, `precio_venta` y `boton_rapido`.
4. **Etapa 4 — Soporte Multinube Opcional (Supabase + Firebase Firestore/Storage)**:
   - `migrations/005_firebase_multinube.sql`, `src/sync/adaptador_firebase.ts` y `src/features/configuracion/PanelConfiguracionSync.tsx`:
     - `AdaptadorFirebaseFirestoreHttp` (Firestore REST v1 + Firebase Storage REST) con validación de seguridad cliente (`validarConfiguracionFirebaseCliente`, Regla 8) y `AdaptadorNubeMultiProveedor` para operar con `'supabase'`, `'firebase'` o `'ambos'` (espejo redundante).
5. **Etapa 5 — Paginación de Listados (10 por página), Modo Oscuro / Claro y Marca al Pie**:
   - `src/domain/paginacion.ts` y `src/components/PaginadorTabla.tsx`:
     - Función pura `paginarListado` (`TAMANIO_PAGINA_POR_DEFECTO = 10`) y barra de paginación aplicada en todos los listados: catálogo de productos, últimas compras registradas, proveedores y movimientos de cuenta corriente, padrón de clientes, informes ("Stock Actual, Alertas Bajo Mínimo y Valorización" y ranking de rentabilidad), registro de auditoría, historial de backups, usuarios y sesiones móviles.
   - `src/App.tsx`, `src/styles.css` y `web-pos/src/WebPosApp.tsx`:
     - Selector de tema visual (**"🌙 Modo Oscuro"** / **"☀️ Modo Claro"**) persistido en `localStorage` (`pos_tema_visual`).
     - Pie de página institucional con la marca **`GAR - Guillermo Adolfo Rohde`**.
6. **Etapa 6 — Combinación de Múltiples Medios de Pago con Verificación de Suma**:
   - `packages/domain/src/totales.ts`, `src/features/venta/PanelVentaPOS.tsx` y `web-pos/src/WebPosApp.tsx`:
     - Función pura `evaluarPagosCombinados` y `validarPagosVenta` para evaluar en tiempo real N medios de pago (`efectivo`, `mercado_pago`, `transferencia`, `debito`, `credito`, `qr`, `cuenta_corriente`, `otro`), calculando la suma ingresada, faltante o excedente respecto al monto total a cobrar.
     - En la caja de escritorio y en `/web-pos`, **Combinar pagos (`F9`)** permite agregar 2, 3 o más filas de medios de pago (`+ Agregar medio de pago`), elegir cualquier medio en cada fila, usar **"Completar resto"** y verificar que la suma coincida exactamente con el monto a cobrar antes de confirmar la venta.
7. **Etapa 7 — Íconos Nativos y Compilación Windows de Tauri 2 (`src-tauri`)**:
   - `src-tauri/icons/` y `src-tauri/tauri.conf.json`:
     - Ícono base vectorial (`src-tauri/icons/app-icon.svg`) y paquete completo de íconos multiplataforma (`icon.ico`, `icon.icns`, `32x32.png`, `128x128.png`, `128x128@2x.png`, `icon.png`, etc.) requeridos por `tauri-build` para generar el archivo de recursos de Windows (`tauri-winres`).
8. **Etapa 8 — Publicación Automática del Cajero Móvil en Netlify con Bloqueo de Buscadores**:
   - Migración SQLite `migrations/006_netlify_despliegue.sql` (`netlify_token`, `netlify_site_id`, `netlify_site_name`, `netlify_site_url`, `netlify_ultimo_despliegue_at`).
   - Lógica pura en `packages/domain/src/despliegue_web.ts` (`validarTokenNetlify`, `generarRobotsTxtAntiIndexacion`, `generarNetlifyHeadersAntiIndexacion`, `generarNetlifyRedirects`, `generarIndexRaizRedireccion`) y empaquetador ZIP estándar nativo en `src/sync/zip_ligero.ts` (`crearArchivoZip` con `node:zlib`).
   - Desplegador automatizado en `src/sync/desplegador_netlify.ts` (`verificarTokenNetlifyApi`, `prepararPaqueteVentaMovilNetlify`, `desplegarSitioNetlify`): subida directa por ZIP a la API de Netlify (sin consumo de minutos de build), inyección segura de configuración pública Supabase (Regla 8 y 20) y Netlify Function serverless para `/api/pos`.
   - Bloqueo total de motores de búsqueda: `robots.txt` (`Disallow: /`), encabezado HTTP `X-Robots-Tag: noindex, nofollow, noarchive, nosnippet, noimageindex, nocache` y meta tags en `web-pos/index.html`.
   - Interfaz en `src/features/configuracion/PanelConfiguracionSync.tsx`: tarjeta con explicación de límites gratuitos permanentes (100 GB/mes), instructivo desplegable para extraer el Personal Access Token de Netlify, prueba de conexión en tiempo real, publicación en un clic y auto-configuración del QR para imprimir o escanear, con suite de tests `src/db/__tests__/desplegador_netlify.test.ts`.

9. **Etapa 9 — Interfaz Amigable sin Tecnicismos ("Base de Datos") y Manual de Usuario Modular**:
   - Limpieza de términos técnicos en la UI (`src/App.tsx`, `PanelVentaPOS.tsx`, `PanelCaja.tsx`, `PanelProductosStock.tsx`, `PanelAuditoria.tsx`, `PanelInformes.tsx`, `PanelUsuarios.tsx`, `PanelConfiguracionSync.tsx`): reemplazo de "SQLite" y tecnicismos por "Base de Datos", "Base de datos local", "Guardar Producto", "Registrar Movimiento", "Confirmar y Registrar Venta (F4)", etc.
   - Manual completo y modular en `docs/manual/`: índice general `README.md` y 10 módulos en Markdown con indicaciones y placeholders visuales para capturas de pantalla, incluyendo guía exhaustiva de configuración segura de Supabase (PostgreSQL + RLS + Storage) y Firebase (Cloud Firestore REST + Security Rules) en `10_configuracion_y_bases_remotas.md`.
