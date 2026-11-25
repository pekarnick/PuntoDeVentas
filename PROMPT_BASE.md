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

10. **Etapa 10 — Armado de Combos con Stock Inteligente, Informes Completos (`08_informes_y_fiscal.md`) y Pedidos Automáticos de Stock Bajo en PDF (por Proveedor, Marca y Categoría)**:
   - **Productos (`src/features/productos/PanelProductosStock.tsx`, `src/features/venta/PanelVentaPOS.tsx`, `src/db/arca_fase4_repo.ts`)**:
     - Panel de armado de combos con sus componentes, cantidades requeridas y precio especial de venta (`crearComboPromocion`, `eliminarComboPromocion`, `calcularPrecioYStockCombo`).
     - El stock disponible de cada combo se calcula automáticamente en base al componente limitante con menor existencia en el local (`min(floor(stock_actual_i / cantidad_requerida_i))`).
     - Al vender un combo (desde botones rápidos o escaneando su código de barras en `PanelVentaPOS.tsx`), el sistema descuenta automáticamente del inventario la cantidad correspondiente de cada uno de sus componentes individuales mediante movimientos append-only en `movimientos_stock`.
   - **Informes (`src/features/informes/PanelInformes.tsx`, `src/domain/informes.ts`, `src/db/informes_repo.ts`)**:
     - Completado según `docs/manual/08_informes_y_fiscal.md`: (1) Tablero superior de métricas en tiempo real con Total Facturado, Ganancia Bruta Real con costo histórico (`costo_unitario`), Margen de Rentabilidad sobre costo y sobre facturación, Cantidad de Operaciones y Ticket Promedio; (2) Desglose de Medios de Pago (Distribución de Cobranza en Efectivo, Mercado Pago, Tarjetas y otros medios) y Top Productos; (3) Stock Valorizado con Valor al Costo de Reposición, Valor al Precio de Venta y Ganancia Proyectada; (4) Libro IVA Ventas y Compras con selector de Año y Mes fiscal, clasificación por tipo de comprobante y exportación `.xlsx`.
   - **Compras (`src/features/compras/PanelComprasProveedores.tsx`, `src/domain/pedidos_reposicion.ts`, `src/domain/pdf.ts`, `src/db/informes_repo.ts`)**:
     - Generación automática de listas de pedido para productos con stock bajo (`stock_actual <= stock_minimo`) agrupadas **por Proveedor**, **por Marca** y **por Categoría**, con ajuste de cantidades a pedir, carga en 1 clic al formulario de compra y exportación directa a **PDF** (`%PDF-1.4` nativo en `generarDocumentoPdf` y auditado con `exportarPedidoReposicionBajoStockAPdf`), tanto para el listado completo como por proveedor, marca o categoría individual.

11. **Etapa 11 — Administración de Sucursales, Ubicación de Stock, Migración de Productos entre Locales, Bloqueo y Acceso Rápido de Caja Cerrada y Modal de Ticket en Cajero Móvil (`/web-pos`)**:
   - **Sucursales y Migración de Mercadería (`migrations/007_sucursales_y_transferencias.sql`, `supabase/migrations/004_sucursales_y_transferencias.sql`, `src/domain/sucursales.ts`, `src/db/sucursales_repo.ts`, `src/features/productos/PanelProductosStock.tsx`, `src/features/informes/PanelInformes.tsx`)**:
     - Creación y gestión de múltiples sucursales/depósitos (`sucursales`) con asignación automática de **"Casa Central"** (`es_principal = 1`) por defecto y selector rápido de **Sucursal Activa** en la barra superior (`src/App.tsx`).
     - Desglose de ubicación del stock por sucursal en la tabla de catálogo (`📍 Casa Central: X · Sucursal 2: Y`), manteniendo el stock como suma inmutable de `movimientos_stock` (Regla 4).
     - Migración/transferencia atómica de productos entre sucursales (`transferencias_sucursales` + par de movimientos compensados en `movimientos_stock` y registro en `auditoria` con hash encadenado SHA-256), incluyendo botón **"Cargar todo el stock de origen"** para migrar el inventario completo de un local a otro.
     - Filtro por sucursal (`🏢 Sucursal: Todas las sucursales (Consolidado)` o sucursal individual) en `PanelInformes.tsx` tanto en pantalla como al exportar a Excel (`.xlsx`).
   - **Sección Caja y Protección de Turno Cerrado (`src/App.tsx`, `src/features/caja/PanelCaja.tsx`, `src/features/venta/PanelVentaPOS.tsx`)**:
     - El botón **Caja y Arqueo** fue reubicado en la 2.ª posición del menú principal (inmediatamente al lado de **Venta (Mostrador)**) con indicador en vivo (`🟢 Caja y Arqueo` / `🔴 Caja y Arqueo (Cerrada)`).
     - En `PanelCaja.tsx`, cuando la caja está cerrada se ocultan y bloquean los formularios de movimientos manuales y arqueo/cierre, mostrando únicamente el cuadro de apertura de turno.
     - En `PanelVentaPOS.tsx`, cuando la caja está cerrada se bloquea el cobro de ventas y se muestra en la parte superior un aviso destacado con formulario rápido para **abrir la caja en el acto** sin cambiar de pestaña.
   - **Cajero Móvil (`/web-pos` en `web-pos/src/WebPosApp.tsx`)**:
     - Al confirmar una venta, el sistema hace scroll automático hacia arriba y despliega el **comprobante/ticket en una ventana modal centrada a pantalla completa** (`role="dialog"`), permitiendo compartir por WhatsApp, imprimir o iniciar una nueva venta sin necesidad de desplazarse manualmente hacia arriba.
     - Además, incorpora una **barra flotante superior** (`🛒 N ítems · $ Total` + botón **"Ir a Cobrar ↓"**) cuando hay productos en el carrito.
   - **Suite de Pruebas (`src/db/__tests__/sucursales_caja_y_movil.test.ts`)**:
     - 12 archivos de test y 58 tests pasando al 100% (`npm test`), `npx tsc --noEmit` sin errores y `npm run build` compilando escritorio y `/web-pos`.

12. **Etapa 12 — Buscadores en Compras, Movimientos de Stock, Transferencia entre Sucursales, Armado de Combos y Clientes, Corrección de Quita de Combos, Script SQL Unificado de Supabase (001–004), Copia Completa Idempotente a Firebase, Pantalla de Login de Usuarios con Selector de Rol Exclusivo para Superadmin y Manual para Usuarios No Técnicos (Tauri + GitHub Releases)**:
   - **Buscadores de Artículos en Compras, Movimientos de Stock, Transferencias entre Sucursales y Componentes de Combos (`src/features/compras/PanelComprasProveedores.tsx`, `src/features/productos/PanelProductosStock.tsx`)**:
     - En *Compras y Proveedores → Registrar Compra a Proveedor → Agregar producto al comprobante*: buscador en vivo por nombre, código interno o código de barras EAN que filtra y autoselecciona el artículo.
     - En *Productos y Stock → Movimiento de Stock (Suma de Movimientos — Regla 4)*: buscador en vivo por nombre, código interno o código de barras EAN.
     - En *Productos y Stock → 🚚 Migrar / Transferir Productos entre Sucursales*: buscador en vivo (`busquedaProdTransferencia`) encima del selector `Producto a migrar:`.
     - En *Productos y Stock → Componentes y cantidades requeridas por cada combo*: buscador en vivo (`busquedaProdCombo`) encima del selector `Producto componente:`.
   - **Buscadores de Clientes en el Cobro y en Padrón de Clientes y Cuentas Corrientes (`src/features/venta/PanelVentaPOS.tsx`, `src/features/clientes/PanelClientesCuentaCorriente.tsx`)**:
     - En *Cobro y Emisión de Ticket*, buscador de clientes por nombre, DNI o CUIT que inicia siempre en **"Consumidor Final (Anónimo)"** por defecto e incluye botón rápido para volver a `"Consumidor Final"`.
     - En *Clientes y Cta. Cte. → Padrón de Clientes y Cuentas Corrientes*, buscador instantáneo (`busquedaClientesPadron`) por nombre, CUIT/CUIL/DNI, teléfono, domicilio o condición frente al IVA con reinicio automático de paginación.
   - **Corrección de Quita y Búsqueda de Combos en Venta de Escritorio y Cajero Móvil (`src/domain/escaner.ts`, `src/features/venta/PanelVentaPOS.tsx`, `web-pos/src/WebPosApp.tsx`, `src/db/servidor_local_dev.ts`, `src/sync/desplegador_netlify.ts`)**:
     - `calcularResumenCarritoPOS` y `actualizarCantidadEnCarrito` acotan de forma segura los descuentos de ítem y el descuento global al subtotal disponible sin lanzar excepción durante el render de React.
     - Barra de combos aplicados en el carrito con botón **"✕ Quitar combo"** (`quitarComponentesDeCarrito`) y reconciliación automática del ahorro del combo al quitar un producto individual o vaciar el carrito.
     - En el buscador principal de **Venta (POS)** (`F2`), los combos aparecen también dentro del **desplegable de sugerencias en vivo** (`opcionesDesplegable`) al escribir parte del nombre del combo, descripción, código de barras o el nombre de cualquiera de sus productos componentes, permitiendo seleccionarlos con `↑`/`↓` + `Enter` o clic.
     - En el **Cajero Móvil (`/web-pos`)**, `obtener_catalogo_movil` entrega los combos activos (sin exponer `costo_compra`, Regla 20), que se muestran y filtran en el buscador por nombre, código o componente, permiten agregarse con un toque sumando sus componentes y calculando el ahorro promocional exacto en centavos mediante `pesosACentavos` (`parsearInputPesosACentavos` / `calcularAhorroEfectivoComboMovil`) para que `TOTAL A COBRAR` sea siempre exactamente `combo.precio_venta`, mostrando el desglose (`Subtotal artículos` - `Bonificación combo` = `TOTAL A COBRAR`) y su botón **"✕ Quitar combo"**.
   - **Documentación y Manuales Oficiales Actualizados (`PLAN.md`, `docs/decisiones.md`, `docs/manual/README.md`, `docs/manual/01` a `10`)**:
     - Todos los manuales de usuario en `/docs/manual/`, el documento maestro `PLAN.md` y el registro de arquitectura `docs/decisiones.md` se encuentran actualizados con la pantalla de login obligatorio, cambio directo de contraseña, buscadores integrados, combos en escritorio y móvil, script SQL unificado de Supabase, copia completa a Firebase y guía de actualización con instalador Tauri desde GitHub Releases.
   - **Normalización de Columnas UUID Nullables y Preservación de `dispositivo_id` (TEXT) al Sincronizar con PostgreSQL (`src/sync/motor_sync.ts`)**:
     - `serializarRegistroParaPostgres` convierte cadenas vacías `""` o valores no UUID en `auditoria.usuario_id` y demás columnas UUID nullables (`CAMPOS_UUID_NULLABLES_POSTGRES`) a `null` antes de hacer push a Supabase (evitando el error `22P02: invalid input syntax for type uuid: ""`), y excluye explícitamente a `CAMPOS_TEXTO_ID_POSTGRES` (`device_id`, `dispositivo_id`, `entidad_id`, `referencia_id`) de la validación UUID para que `ventas.dispositivo_id` y `sesiones_moviles.dispositivo_id` conserven su identificador de terminal (evitando `23502` y fallos en cascada `23503` en `ventas_items` / `ventas_pagos`). Además, `recolectarPendientesLocalesEnCola` compacta entradas repetidas y auto-recupera errores transitorios (`PGRST205`, `PGRST204`, `22P02`, `23502`, `23503`).
   - **Script SQL Unificado Completo de Supabase (`supabase/esquema_completo_unificado.sql`, `src/db/servidor_local_dev.ts`, `src/features/configuracion/PanelConfiguracionSync.tsx`)**:
     - Documento único e idempotente (`supabase/esquema_completo_unificado.sql`) que unifica las migraciones `001_esquema_supabase_rls.sql`, `002_venta_movil_rpc.sql`, `003_arca_y_extras_fase4.sql` y `004_sucursales_y_transferencias.sql`, entregado por `obtener_sql_migracion_supabase`.
   - **Sincronización y Copia Completa a Firebase Firestore sin Duplicados (`src/sync/adaptador_firebase.ts`, `src/sync/motor_sync.ts`, `src/features/configuracion/PanelConfiguracionSync.tsx`)**:
     - Ejecución paralela con `Promise.allSettled` en `AdaptadorNubeMultiProveedor`, deduplicación por UUID en cada lote `:commit`, Reglas de Seguridad de Firestore actualizadas (`REGLAS_SEGURIDAD_FIRESTORE_RECOMENDADAS` cubriendo `/comercios/{comercioId}` y sus subcolecciones) y función `copiarBaseCompletaAFirebaseSinDuplicados` (`copiar_todo_firebase`) para copiar toda la base local a Firestore sin generar repetidos.
   - **Pantalla de Inicio de Sesión (Login) Obligatoria para Acceder, Cambio Directo de Contraseña, Selector de Prueba de Roles Exclusivo para Superadmin y Control de Operaciones por Usuario (`src/db/usuarios_auth_repo.ts`, `src/db/servidor_local_dev.ts`, `src/features/usuarios/PanelUsuarios.tsx`, `src/App.tsx`)**:
     - Al abrir el sistema se presenta la **Pantalla de Inicio de Sesión (`🔐 Iniciar Sesión`)** validada contra la base local con Argon2id (`iniciar_sesion_operador`), con botones de autocompletado rápido para las 3 cuentas iniciales (`maria` / `Admin1234`, `carlos` / `Encargado1234`, `lucas` / `Cajero1234`).
     - En **Usuarios y Roles** (`PanelUsuarios.tsx`), se puede definir la contraseña inicial al crear un usuario y cada fila del listado cuenta con el botón **`🔑 Cambiar clave`** (o clic en el estado `"Pendiente al ingresar"`) que despliega el campo para escribir la nueva contraseña y guardarla (`establecerClaveUsuarioDirecta` / `cambiar_clave_usuario`), actualizando el hash Argon2id y pasando el estado de `"Pendiente al ingresar"` a **`"Al día"`** (`debe_cambiar_clave = 0`). Además, si un usuario ingresa con una clave temporal reseteada (`debe_cambiar_clave = true`), el login le permite definir su nueva contraseña en el acto.
     - Una vez iniciada la sesión, el selector del encabezado **`🧪 Probar rol`** se muestra **únicamente cuando el usuario autenticado real es `superadmin`** (`operadorAutenticado.rol === 'superadmin'`). Cuando ingresa un `encargado` o un `cajero`, dicho selector permanece oculto y solo ve su credencial activa y el botón **`🚪 Cerrar sesión`**.
     - Consulta `LEFT JOIN` en `ventasPorUsuario` para mostrar a todos los vendedores del comercio en *Control de Operaciones por Usuario / Cajero*.
   - **Manual Integrado para Personas No Técnicas (Uso 100% Local en PC Empaquetado Tauri, Actualizaciones desde GitHub Releases y Android) (`src/features/ayuda/PanelAyudaManual.tsx`, `src/App.tsx`)**:
     - Pestaña **"📖 Ayuda y Manual"** redactada en lenguaje claro y sin tecnicismos: explica que el comercio puede usar únicamente el programa instalable en su PC (Tauri) sin configurar ninguna nube, y detalla en 4 pasos simples cómo actualizar descargando el nuevo instalador (`.msi` / `-setup.exe`) desde **GitHub Releases** conservando todos los productos, clientes, caja y ventas.
   - **Suite de Pruebas**:
     - 12 archivos de test y 60 tests pasando al 100% (`npm test`), `npx tsc --noEmit` sin errores y `npm run build` compilando escritorio y `/web-pos`.

13. **Etapa 13 — Componentización y Refactorización de `src/App.tsx` (Organización Modular en `src/`)**:
   - **`src/types/estado_app.ts`**: Tipos compartidos de la aplicación (`PestaniaActiva`, `ModoTemaVisual`, `OperadorItemUI`, `EstadoInicialServidor`, `PermisosModulosUI`, `NOMBRES_OPERADOR`) y funciones puras de control de permisos por pestaña (`calcularPermisosModulosPorRol`, `esPestaniaPermitidaParaRol`).
   - **`src/hooks/`**:
     - `useTemaVisual.ts`: Gestión y persistencia de Modo Claro / Modo Oscuro en `localStorage` y atributo `data-theme`.
     - `useSesionOperador.ts`: Gestión de sesión autenticada (`sessionStorage`), cambio obligatorio de clave inicial, cierre de sesión y selector de prueba de roles exclusivo para `superadmin`.
     - `useEstadoServidorPos.ts`: Carga del estado inicial desde la base local, cambio rápido de sucursal activa y los 5 disparadores de sincronización en segundo plano (al abrir, reconexión `online`/`offline`, intervalo periódico, cierre `pagehide` y botones manuales Subir/Bajar).
   - **`src/features/auth/`**:
     - `PantallaLoginOperador.tsx`: Pantalla de inicio de sesión Argon2id con autocompletado rápido de cuentas por defecto.
     - `PantallaCambioClaveInicial.tsx`: Pantalla de cambio obligatorio de contraseña temporal al primer ingreso.
   - **`src/components/layout/`**:
     - `EncabezadoPrincipalPos.tsx`: Barra superior con marca, selector de sucursal activa, selector de tema, credencial del operador, selector `🧪 Probar rol` (solo `superadmin`), indicador de sincronización y acciones rápidas.
     - `BarraNavegacionModulos.tsx`: Navegación principal por pestañas con indicador en vivo del estado de caja (`🟢 Caja y Arqueo` / `🔴 Caja y Arqueo (Cerrada)`) y visibilidad por permisos.
     - `ContenedorModuloActivo.tsx`: Orquestador del panel activo según la pestaña seleccionada.
     - `PiePaginaInstitucional.tsx`: Pie de página institucional reutilizable (`GAR - Guillermo Adolfo Rohde`).
   - **`src/App.tsx`**: Reducido de ~1.240 líneas a ~145 líneas declarativas que integran los hooks y componentes de layout.


14. **Correcciones de Seguridad — Lote P0 Completado (Auditoría `auditoria/PLAN-CORRECCIONES.md`)**:
    - **Supabase RLS, Auth, RPCs y Storage (`supabase/migrations/005_endurecimiento_seguridad_rls.sql`, `supabase/esquema_completo_unificado.sql`, `src/sync/motor_sync.ts`, `src/db/cliente_pos_api.ts`, `web-pos/src/WebPosApp.tsx`)**:
      - Reescritura de `public.mi_comercio_id()`, `public.mi_rol()` y `public.mi_usuario_id()` exclusivamente desde `auth.uid()` y claims JWT firmados (`app_metadata`), eliminando `TO anon`, cabeceras falsificables y fallback al primer comercio.
      - Triggers append-only en `ventas`, `cuenta_corriente_movimientos`, `compras`, `compras_items` y `transferencias_sucursales` (sin `DISABLE TRIGGER USER` global en `resetear_comercio_a_fabrica`), `REVOKE SELECT (clave_hash, pin_hash)` en `usuarios`, `productos_venta` y `ventas_items_venta` con `security_invoker = true` sin costos (Regla 20), y `crear_venta_movil` endurecida con `sesiones_moviles`, `permite_decimales`, validación de cliente/caja y `auth.uid()`.
      - `serializarRegistroParaPostgres` omite `clave_hash` y `pin_hash`; login de `/web-pos` autentica contra Supabase Auth (`/auth/v1/token?grant_type=password`) sin descargar `usuarios?select=*`.
    - **Firebase Firestore, Storage y Auth (`firestore.rules`, `storage.rules`, `src/sync/adaptador_firebase.ts`, `src/features/configuracion/PanelConfiguracionSync.tsx`)**:
      - Reglas estrictas con `request.auth != null`, custom claims `comercio_id`/`rol`, prohibición de `update`/`delete` en colecciones append-only y validación WebP en Storage; exclusión de `pin_hash`, validación de `comercio_id` al deserializar y `:runQuery` (`structuredQuery`) paginado en `bajarRegistrosTabla`.
      - Inicio de sesión opcional en la nube (Supabase Auth / Firebase Auth) desde Configuración sin guardar contraseñas en SQLite.
    - **Edge Function ARCA y Backoff (`supabase/config.toml`, `supabase/functions/emitir_comprobante_arca/index.ts`, `migrations/008_endurecimiento_seguridad_p0.sql`, `src/db/arca_fase4_repo.ts`)**:
      - `verify_jwt = true`, validación de JWT y pertenencia a `comercio_id` en la Edge Function, prohibición de `simulador_homologacion` y CAE `74...` en `produccion`, y `MAX_REINTENTOS_ARCA = 5` con backoff exponencial (`arca_proximo_reintento_at`).
    - **Servidor HTTP Local `/api/pos`, Argon2id y Asistente de Primer Uso (`vite.config.ts`, `src/domain/claves.ts`, `src/db/usuarios_auth_repo.ts`, `src/db/repositorios.ts`, `src/db/servidor_local_dev.ts`, `src/features/auth/PantallaConfiguracionInicial.tsx`)**:
      - Validación `Content-Type: application/json`, `Origin`/`Sec-Fetch-Site`, límite de tamaño en stream (2 MB / 26 MB), `X-POS-Session` por request y `TAURI_DEV_HOST` loopback.
      - Cotas PHC en `verificarClaveArgon2id` (`m <= 65536`, `t <= 4`, `p <= 4`, clave `<= 256` bytes), revocación automática de `sesiones_moviles` al cambiar/resetear clave o rol/estado, eliminación de credenciales hardcodeadas y creación del primer superadmin mediante Asistente de Primer Uso.
    - **Suite de Pruebas (`src/db/__tests__/seguridad_p0.test.ts`)**: 13 archivos de test y 64 tests pasando al 100% (`npm test`), `npx tsc --noEmit` sin errores y `npm run build` compilando escritorio y `/web-pos`.

15. **Correcciones de Seguridad — Lote P1 Completado (Auditoría `auditoria/PLAN-CORRECCIONES.md`)**:
    - **Secretos, Migración 009 y Backups (`migrations/009_endurecimiento_seguridad_p1.sql`, `src/db/venta_movil_repo.ts`, `src/db/backup_repo.ts`)**:
      - Retirado `netlify_token` de SQLite (mantenido únicamente en memoria efímera) y agregados triggers append-only en `cuenta_corriente_movimientos`, `compras`, `compras_items` y `ventas` (`DELETE`).
      - `crearBackupBaseDatosLocal` verifica ausencia de symlinks, vuelca a archivo temporal aleatorio y sanitiza `netlify_token`, `sesiones_moviles` y `pin_hash` antes de renombrar.
      - `restaurarDesdeBackupLocal` abre el backup con `readOnly: true`, `PRAGMA trusted_schema = OFF`, `PRAGMA query_only = ON`, valida `sqlite_master.type = 'table'`, exige coincidencia de `comercio_id`, auditoría no vacía e íntegra, supervivencia de al menos un `superadmin` activo y `PRAGMA foreign_key_check`.
    - **Build, Cliente y Despliegue Netlify (`vite.config.ts`, `src/db/cliente_pos_api.ts`, `src/sync/desplegador_netlify.ts`)**:
      - Eliminados los defaults hardcodeados (`sb_publishable_...`, `dspvjhnqmgjzpjzxvmhg`, lectura de `data/comercio_identidad.json` en `closeBundle`), priorizando `window.__POS_CONFIG__` sobre `localStorage`.
      - En `desplegador_netlify.ts`: eliminado mock `usr-movil-1` y cabeceras falsificables en `netlify/functions/pos.mjs` (autenticación real contra Supabase Auth y passthrough de `Authorization: Bearer`), validación de firma/tamaño del ZIP con hash `zipSha256` y validación estricta de `siteId`.
    - **UI, Tauri CSP y `/web-pos` (`src-tauri/tauri.conf.json`, `src/features/configuracion/PanelConfiguracionSync.tsx`, `src/features/informes/PanelInformes.tsx`, `web-pos/src/WebPosApp.tsx`)**:
      - CSP estricta configurada en `src-tauri/tauri.conf.json` (reemplazando `csp: null`), reemplazo de `win.document.write` por construcción segura vía DOM (`textContent` + `DOMParser` SVG) con `noopener,noreferrer`, `rolActivo` por defecto `'cajero'` en `PanelInformes`, validación de `expira_at` al restaurar sesión y limpieza completa de caché/estado al cerrar sesión en `/web-pos`.
    - **Suite de Pruebas (`src/db/__tests__/seguridad_p1.test.ts`)**: 14 archivos de test y 68 tests pasando al 100% (`npm test`), `npx tsc --noEmit` sin errores y `npm run build` compilando escritorio y `/web-pos`.

16. **Correcciones de Seguridad — Lote P2 Completado (Auditoría `auditoria/PLAN-CORRECCIONES.md`)**:
    - **Resolución de Conflictos y Tablas Append-Only (`src/domain/sync.ts`)**:
      - Agregadas `cuenta_corriente_movimientos`, `compras` y `compras_items` a `TABLAS_APPEND_ONLY`.
      - En `resolverConflictoRegistro`, las reglas restrictivas de `usuarios` (rol, `activo`, `debe_cambiar_clave`, `puede_vender_movil`, `clave_hash`, invalidación monótona de `pin_hash`, `max(intentos_fallidos)`, `bloqueado_hasta` y `deleted_at`) se aplican siempre, incluso cuando `localEstabaPendiente === false`.
      - Precedencia monótona para `sesiones_moviles` en estado `'revocada'`, precedencia monótona de `deleted_at` en tablas maestras y fusión no destructiva en `ventas` entre `estado = 'anulada'` y `cae`/`arca_*`/`nota_credito_*`.
    - **Motor de Sincronización Offline-First (`src/sync/motor_sync.ts`, `src/db/servidor_local_dev.ts`)**:
      - Agregado `obtenerODefinirDeviceIdTerminal` persistiendo un `terminal-<uuidv7>` único en `comercio_identidad.json` (reemplazando `'terminal-local-1'` en `servidor_local_dev.ts`).
      - Eliminado `COMERCIO_ID_RESPALDO_CONOCIDO`; `ejecutarPullDatos` exige `permitirAdopcionRemota === true` para adoptar un comercio remoto, filtra filas entrantes por `comercioIdActivo`, usa `SAVEPOINT sp_pull_fila` por registro y acota `bajarRegistrosTabla` a 50 páginas; `actualizarFilaRemotaEnSQLite` excluye `comercio_id` y filtra por `WHERE id = ? AND ${colComercio} = ?`; `insertarFilaRemotaEnSQLite` corrige `usuario_id`/`usuario_cierre_id` en `caja_sesiones`.
      - `ejecutarPushDatos` filtra por `comercio_id`, aplica cuarentena en `sync_cola` a partir de `MAX_INTENTOS_SYNC_COLA = 5` y aísla fallos de lote fila a fila.
    - **Suite de Pruebas (`src/db/__tests__/seguridad_p2.test.ts`)**: tests unitarios y de integración verificando conflictos, cuarentena, aislamiento de tenant y `SAVEPOINT` por fila.

17. **Correcciones de Seguridad — Lote P3 Completado (Auditoría `auditoria/PLAN-CORRECCIONES.md` Cerrada)**:
    - **Imágenes (`src/db/imagenes_repo.ts`, `src/sync/imagenes_sync.ts`)**:
      - Validación estricta de UUID (`REGEX_UUID_ESTRICTO`), confinamiento canónico (`resolverRutaSeguraImagen`) y rechazo de symlinks; `limitInputPixels: 25_000_000` y tope de iteraciones en Sharp; verificación SHA-256 contra `imagen_hash` y re-codificación sanitaria al bajar imágenes remotas.
    - **ESC/POS, XLSX y CSV (`src/domain/gestion_fase3.ts`, `src/domain/xlsx.ts`, `src/db/backup_repo.ts`, `src/db/gestion_fase3_repo.ts`)**:
      - `sanitizarTextoEscPos` elimina caracteres de control ASCII (`0x00–0x1F`, `0x7F`); `neutralizarFormulaXlsx` antepone `'` a prefijos de fórmula (`=`, `+`, `-`, `@`, `\t`, `\r`); `MAX_FILAS_HOJA_EXCEL = 10_000` en `exportarTodoAExcel`; cotas de tamaño/filas/no-negatividad en `parsearCsvImportacionCatalogo` y lotes transaccionales de 250 filas en `importarProductosDesdeCsv` sin reactivar bajas cuando `actualizarSiExisteCodigo === false`.
    - **Integridad SQLite, RBAC y Lógica de Negocio (`repositorios.ts`, `productos_repo.ts`, `caja_repo.ts`, `sucursales_repo.ts`, `gestion_fase3_repo.ts`, `arca_fase4_repo.ts`)**:
      - Validación de tenant, `activo = 1` y `deleted_at IS NULL` en referencias (`categoriaId`, `marcaId`, `proveedorId`, `sucursalId`, `padreId`, `listaPrecioId`, `cajaSesionId`, `varianteId`, `productoId`); cascada de `deleted_at` en `eliminarProductoLogico`; inserción de precio faltante en `actualizarProductoYPrecio`; consolidación de cantidades repetidas en `transferirProductosEntreSucursales`.
      - Separación de `limite_credito = 0` ($ 0,00) vs crédito habilitado, RBAC en `crearCliente` con crédito y `registrarMovimientoCuentaCorriente` con `proveedor`, bloqueo de sobrepagos y vínculo opcional con `caja_movimientos`; bloqueo de operación/cierre de caja ajena por cajeros; corrección de doble IVA en `registrarCompraProveedor` y validación de `permite_decimales`.
    - **Suite de Pruebas (`src/db/__tests__/seguridad_p3.test.ts`)**: tests de regresión cubriendo todo el Lote P3.

18. **Etapa 18 — Backend Local SQLite Embebido en el Instalador Tauri (`.msi` / `-setup.exe`), Puente IPC Rust y Firma de Desarrollador**:
    - **Servidor HTTP Standalone (`src/db/servidor_http_standalone.ts`, `src/db/migrator.ts`, `src/db/servidor_local_dev.ts`, `src/sync/desplegador_netlify.ts`)**:
      - Servidor HTTP local en `127.0.0.1` con puerto dinámico (`POS_PORT=0`), protegido por origen local (`tauri.localhost`, `tauri:`, `localhost`, `127.0.0.1` compatible con `Sec-Fetch-Site: cross-site` y `Access-Control-Allow-Private-Network: true` de WebView2), `X-POS-Boot-Token` (`crypto.timingSafeEqual`) y `X-POS-Session`.
      - Rutas configurables vía `POS_DATA_DIR` (en producción `%LOCALAPPDATA%\ar.com.puntodeventas.pos\data` con verificación activa de escritura y fallback automático) y `POS_RESOURCES_DIR` (para `migrations/` y `supabase/`), manteniendo compatibilidad total con `npm run dev` y tests.
    - **Empaquetado Automático e Identidad del Desarrollador (`scripts/build_backend_tauri.mjs`, `scripts/firmar_instaladores_windows.ps1`, `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`)**:
      - `npm run build:backend` genera `src-tauri/backend-bundle/` con `server.mjs` (ESM vía `esbuild`), `node.exe`, el subconjunto mínimo de `sharp` (`@img/sharp-win32-x64`), `migrations/` y `supabase/`.
      - `tauri.conf.json` define `"publisher": "GAR - Guillermo Adolfo Rohde"`, `"copyright": "Copyright © GAR - Guillermo Adolfo Rohde"`, idioma español (`es-ES` en WiX `.msi` y `Spanish` en NSIS `-setup.exe`), ejecuta `npm run build:tauri-prep`, incluye `backend-bundle/**/*` en `bundle.resources` y habilita `http://127.0.0.1:*` en `img-src` de la CSP.
      - `scripts/firmar_instaladores_windows.ps1` permite aplicar firma digital Authenticode (`Set-AuthenticodeSignature`) al `.exe`, `.msi` y `-setup.exe` con certificado comercial o autofirmado local (`CN=GAR - Guillermo Adolfo Rohde`).
    - **Sidecar Nativo Tauri, Puente IPC en Rust y Conexión Frontend (`src-tauri/src/lib.rs`, `src-tauri/Cargo.toml`, `src/db/cliente_pos_api.ts`, `src/hooks/useEstadoServidorPos.ts`, `src/App.tsx`, `PanelProductosStock.tsx`, `PanelVentaPOS.tsx`)**:
      - En builds release, `src-tauri/src/lib.rs` inicia `node.exe server.mjs` con `CREATE_NO_WINDOW`, genera un `boot_token` aleatorio (`getrandom`), expone `obtener_config_backend_local` e `invocar_pos_backend_local` (puente IPC directo en Rust por `TcpStream` a `127.0.0.1:<port>` que evita cualquier bloqueo de red/CORS/PNA en WebView2) y cierra ordenadamente el proceso hijo al salir.
      - `cliente_pos_api.ts` usa `invocar_pos_backend_local` vía Tauri IPC cuando corre en el ejecutable de escritorio, y `App.tsx` muestra estado de arranque y error visible con botón **Reintentar conexión** si el backend falla en lugar de silenciarlo.
    - **Suite de Pruebas (`src/db/__tests__/servidor_standalone.test.ts`)**: 17 archivos de test y 86 tests pasando al 100% (`npm test`), `npm run typecheck` sin errores, smoke test del bundle y compilación de instaladores Tauri (`.msi` / `-setup.exe`).
