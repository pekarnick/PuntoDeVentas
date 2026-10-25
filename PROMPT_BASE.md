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
10. **Lógica Pura Compartida:** Toda la lógica de negocio vive en `/packages/domain` como funciones puras con tests (totales, IVA, redondeo, stock, CUIT módulo 11).

---

## 3. Estado de Avance por Fases

| Fase | Descripción | Estado | Notas / Commits |
|---|---|---|---|
| **Fase 1** | MVP local sin nube | **100% Completada** | Esquema inicial SQLite, ventas, stock por movimientos, caja, usuarios Argon2id, auditoría SHA-256, informes básicos y Excel. |
| **Fase 2** | Sincronización y backup | **100% Completada** | Esquema Supabase con RLS, Storage de imágenes WebP en cola separada, motor sync push/pull, backup automático local y restauración. |
| **Fase 3** | Gestión completa | **100% Completada** | Compras, proveedores, clientes, cuenta corriente con validación CUIT módulo 11, actualización masiva de precios con redondeo configurable, importación CSV, Libro IVA Ventas/Compras en Excel (.xlsx) y tickets ESC/POS térmicos sin costos. Commit `b4939ab`. |
| **Fase 3b** | Venta móvil web (`/web-pos`) | **EN PROGRESO (~55%)** | Paquete compartido `@pos/domain`, migraciones SQLite y Supabase, repositorios de backend y sesiones listos (Commit `6925b35`). Falta UI desktop de configuración QR, endpoints RPC en servidor local y app PWA `/web-pos`. |
| **Fase 4** | Facturación electrónica ARCA y extras | **Pendiente** | Facturación electrónica opcional vía Edge Function y servicio de terceros (Afip SDK / TusFacturas), múltiples listas de precio, combos, variantes y balanzas. |

---

## 4. Detalle de la Fase 3b (Venta Móvil Web) — Dónde Quedó y Cómo Continuar

### A. Lo que YA está implementado y probado en Fase 3b
1. **Paquete Compartido de Dominio (`/packages/domain`)**:
   - `packages/domain/src/cantidades.ts`: aritmética exacta con miliunidades (escala 1/1000).
   - `packages/domain/src/dinero.ts`: centavos enteros, formateo `$ 1.234,56`, fechas argentinas.
   - `packages/domain/src/totales.ts`: cálculo de IVA (21%, 10.5%, 27%, exento), pagos mixtos, arqueo de caja y proyección segura de ítems (Regla 20).
   - `packages/domain/src/stock.ts`: normalización y cálculo de stock por movimientos.
   - `packages/domain/src/cuit.ts`: validación oficial módulo 11 de CUIT/CUIL y DNI.
   - `packages/domain/src/venta_movil.ts`:
     - `validarUrlPublicaVentaMovil`: valida que la URL sea HTTPS/localhost y prohíbe tokens/claves (Regla 19).
     - `generarQrSvgUrlPublica`: generador determinístico ISO/IEC 18004 de códigos QR en SVG puro sin librerías externas.
     - `calcularVentaMovilDesdeCatalogo`: recálculo seguro de totales en servidor.
     - `formatearComprobanteMovilWhatsApp`: formato de ticket para WhatsApp y pantalla sin costos (Regla 20).
   - Re-exportado de compatibilidad en `/src/domain/*`.

2. **Migraciones de Base de Datos**:
   - SQLite: `migrations/003_venta_movil_sesiones.sql` (agrega columna `venta_movil_url` en `configuracion_sistema` y tabla `sesiones_moviles`).
   - Supabase Postgres: `supabase/migrations/002_venta_movil_rpc.sql` (tabla `sesiones_moviles` con RLS, vista `productos_venta` sin `costo_compra`, y RPC transaccional e idempotente `crear_venta_movil`).

3. **Repositorio Backend (`src/db/venta_movil_repo.ts`)**:
   - `obtenerConfigVentaMovil`: estado, URL pública, QR SVG y sesiones activas.
   - `configurarVentaMovilComercio`: activación/desactivación y cambio de URL con auditoría.
   - `actualizarPermisoVentaMovilUsuario`: permiso `puede_vender_movil` por usuario con auditoría.
   - `iniciarSesionMovil`: login móvil individual con verificación de permisos y registro de sesión.
   - `validarYRenovarSesionMovil`: control de expiración por inactividad y estado de revocación.
   - `revocarSesionMovil`: revocación manual de sesiones desde escritorio (auditada).
   - `obtenerCatalogoVentaMovil`: catálogo proyectado exclusivamente desde `vista_productos_venta` (Regla 20).
   - `crearVentaMovilServidor`: RPC local con idempotencia por UUID, recálculo de precios, stock append-only, auditoría encadenada y respuesta sin costos.
   - `obtenerEstadoCajaMovilUsuario`, `abrirCajaMovilUsuario`, `cerrarCajaMovilUsuario` y `listarVentasPropiasDelDiaMovil`.

---

### B. Lo que FALTA para completar la Fase 3b

1. **Exposición de endpoints en `src/db/servidor_local_dev.ts`**:
   - Agregar rutas/RPC para que tanto el escritorio como la app `/web-pos` puedan interactuar en desarrollo y producción:
     - `obtener_config_venta_movil`
     - `configurar_venta_movil`
     - `actualizar_permiso_venta_movil`
     - `revocar_sesion_movil`
     - `login_movil`
     - `obtener_catalogo_movil`
     - `crear_venta_movil`
     - `abrir_caja_movil`
     - `cerrar_caja_movil`
     - `estado_caja_movil`
     - `listar_ventas_movil_dia`

2. **Interfaz de Escritorio (Desktop UI)**:
   - Panel de Configuración > **Venta Móvil**:
     - Interruptor general para activar/desactivar Venta Móvil.
     - Campo de URL pública configurada.
     - Visualización del código QR generado dinámicamente en SVG.
     - Botones **"Copiar dirección"** e **"Imprimir QR"** (para colocar en el mostrador).
     - Botón de acceso directo para previsualizar/abrir `/web-pos`.
     - Tabla de usuarios con selector rápido de permiso `puede_vender_movil`.
     - Lista de sesiones móviles activas con botón **"Revocar"** (auditado).

3. **Aplicación Web Móvil PWA (`/web-pos`)**:
   - Ubicación: `/web-pos/index.html` (servida por Vite como multi-page app para desarrollo y compilación estática para hosting HTTPS gratuito como Cloudflare Pages o Netlify).
   - Características:
     - **Login:** usuario y contraseña individuales; valida `puede_vender_movil` y cierra por inactividad o revocación.
     - **Catálogo y búsqueda:** descarga `productos_venta` en memoria/caché local (sin costos); buscador por nombre y códigos de barra.
     - **Escáner de cámara:** integración de `BarcodeDetector` con fallback compatible en Android / iPhone, botón de linterna y entrada manual rápida.
     - **Carrito y cobro:** cantidades, descuento opcional, cobro mixto (efectivo, Mercado Pago, débito, etc.), cliente opcional (con CUIT/DNI).
     - **Idempotencia:** genera UUIDv7 en el celular (`venta_id`) antes de invocar `crear_venta_movil`.
     - **Ticket y Compartir:** muestra el comprobante en pantalla y ofrece botón **Compartir por WhatsApp** (`https://wa.me/?text=...`) o imprimir.
     - **Caja móvil del vendedor:** apertura con fondo inicial, consulta de ventas propias del día y cierre de caja móvil.

4. **Tests Automatizados**:
   - Crear `src/db/__tests__/venta_movil.test.ts` que valide:
     - Generación y validación estricta de QR (Regla 19).
     - Creación de sesiones móviles, expiración y revocación auditada.
     - `crearVentaMovilServidor` con recálculo de precios, stock, auditoría y comprobación de que el cliente recibe 0 menciones de `costo_compra` (Regla 20).
     - Idempotencia por UUID: reintentar con el mismo `ventaId` no duplica movimientos ni registros.
     - Apertura y cierre de caja móvil.
   - Ejecución de `npx tsc --noEmit` y `npm test` verificando 100% de éxito.

---

## 5. Instrucciones para Continuar en una Nueva Sesión

Al abrir un nuevo chat:
1. **Comprobar el estado del código:**
   ```powershell
   git status
   npm test
   npx tsc --noEmit
   ```
2. **Revisar si hay archivos pendientes de confirmar o continuar.**
3. **Seguir el orden de implementación indicado en el apartado 4.B para finalizar la Fase 3b.**
4. **Al completar la Fase 3b:**
   - Correr toda la suite de tests (`npm test`) y el build (`npm run build`).
   - Realizar el commit correspondiente.
   - **Actualizar inmediatamente `PROMPT_BASE.md`** cambiando el estado de Fase 3b a `100% Completada` y detallando la planificación para iniciar la **Fase 4 (Facturación ARCA)**.
