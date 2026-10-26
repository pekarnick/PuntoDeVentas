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
| **Fase 4** | Facturación electrónica ARCA y extras | **Pendiente (Siguiente)** | Facturación electrónica opcional vía Edge Function de Supabase (`emitir_comprobante_arca`), CAE y vencimiento, QR reglamentario de ARCA en PDF/ticket, homologación vs producción, múltiples listas de precio, combos y balanzas. |

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

## 5. Planificación para Iniciar la Fase 4 — Facturación Electrónica ARCA (ex-AFIP, Opcional)

Al comenzar la **Fase 4** (según `PLAN.md` §6.3 y §10):
1. **Reglas clave de ARCA (`PLAN.md` §3 Regla 18 y §6.3)**:
   - ARCA es **100% opcional** y viene **apagada por defecto** (`arca_habilitada = 0`).
   - Credenciales y certificados digitales nunca se guardan en el cliente ni en el repositorio: se emiten desde una **Edge Function de Supabase (`emitir_comprobante_arca`)**.
   - Siempre permitir elegir ambiente **`homologacion`** (pruebas, por defecto) o **`produccion`**.
   - Al emitir una venta sin internet con ARCA activo, la venta queda con `estado_facturacion = 'pendiente'` y se envía cuando vuelve la conexión sin bloquear jamás la caja.
   - Comprobantes soportados: Factura A, B y C, y Notas de Crédito A, B y C al anular una venta facturada.
   - Generar comprobante PDF y ticket térmico con CAE, fecha de vencimiento de CAE y código QR oficial exigido por ARCA (sin mostrar `costo_compra`, Regla 20).
