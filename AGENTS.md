# AGENTS.md — Instrucciones para el agente

> Si usás Claude Code, copiá este archivo como `CLAUDE.md` (o creá un `CLAUDE.md` que diga: "Leer AGENTS.md y PLAN.md").

## Proyecto
POS genérico offline-first para comercios argentinos (kiosco, librería, ferretería). Stack: **Tauri 2 + React + TypeScript + SQLite + Supabase**.

## Primer paso en cada sesión
1. Leé `PLAN.md` completo.
2. Revisá en qué fase estamos y qué falta antes de tocar código.
3. Si la tarea contradice el plan, **avisá y proponé la alternativa**; no la implementes en silencio.

## Reglas inviolables (resumen; detalle en PLAN.md §3)
- IDs UUID, nunca autoincrementales.
- Dinero siempre en **enteros (centavos)**; nunca `float`.
- Ventas **append-only**: se anulan, no se editan ni se borran.
- Stock = **suma de movimientos**, nunca un campo que se edita a mano.
- Borrado lógico (`deleted_at`) en datos sincronizables.
- La app **funciona sin internet**; la sincronización nunca bloquea la caja.
- Nunca claves secretas de Supabase en el cliente; usar RLS.
- UI en español rioplatense, formato `$ 1.234,56`, fechas `dd/mm/aaaa`.
- El cajero no ve costos ni ganancias.
- **El cliente nunca ve costos:** pantalla de venta, ticket, factura, PDF y venta móvil muestran solo `precio_venta`. `costo_compra` aparece únicamente en administración de productos, compras e informes, para superadmin y encargado (PLAN.md §3, regla 20).
- Roles: `superadmin` (gestiona usuarios y ve la auditoría), `encargado`, `cajero`. Permisos en PLAN.md §6.1. Siempre debe existir al menos un superadmin activo; los usuarios se desactivan, no se borran.
- **Auditoría obligatoria:** toda acción que cambie datos escribe un registro en `auditoria` en la misma transacción. La tabla es append-only (sin UPDATE ni DELETE, ni en SQLite ni en Supabase) y con hash encadenado. Nunca registrar claves ni hashes de clave.
- Claves de usuario solo como hash Argon2id.
- **Venta móvil web** (PLAN.md §6.2): PWA en `/web-pos`, **solo para vender**, publicada en HTTPS y contra Supabase. El cliente solo escanea un QR o abre una dirección: sin certificados ni instalaciones. Los permisos se aplican **en el servidor** (RLS, vista `productos_venta` sin `costo_compra`, ventas solo mediante la función `crear_venta_movil` que recalcula precios y totales), no solo en la UI. Cada venta lleva un UUID generado en el celular (idempotencia). El QR contiene solo la URL pública.
- **ARCA es opcional y viene apagada por defecto** (PLAN.md §6.3). Se emite desde una Edge Function de Supabase; credenciales y certificados nunca en el cliente ni en el repositorio. Siempre probar primero en homologación.
- Imágenes de productos: **nunca dentro de la base de datos**. Se guardan como archivo (local + Supabase Storage, bucket privado), se redimensionan a WebP antes de guardar y se sincronizan en una cola aparte, después de los datos (PLAN.md §5.1).

## Cómo trabajar
- **Una fase por vez**, empezando por la Fase 1. No adelantes funciones de fases posteriores.
- Antes de implementar algo no trivial, escribí un plan corto y esperá confirmación si afecta el modelo de datos o la sincronización.
- Lógica de negocio en `/src/domain` como **funciones puras con tests** (totales, IVA, stock, redondeo). Escribí los tests junto con el código.
- Toda modificación del esquema es una **migración versionada** (SQLite en `/migrations`, Postgres en `/supabase/migrations`). Nunca modificar el esquema a mano.
- Commits pequeños y descriptivos, uno por cambio lógico.
- Si instalás una dependencia, justificá por qué en una línea.
- Si encontrás ambigüedad, elegí el supuesto más simple, anotalo en `/docs/decisiones.md` y avisá.

## Calidad
- No dejes código muerto ni TODOs sin registrar.
- Manejá errores con mensajes claros para un usuario no técnico (nada de stack traces en pantalla).
- Antes de dar una tarea por terminada: corré tests y type-check, y verificá el criterio de aceptación correspondiente (PLAN.md §13 para Fase 1).

## Qué NO hacer
- No implementar facturación ARCA hasta la Fase 4.
- No pedir al cliente que instale certificados ni configure nada en el celular, y no levantar un servidor local para la venta móvil: el canal móvil es web en la nube (PLAN.md §6.2).
- No usar Google Drive como mecanismo de sincronización (solo como destino opcional de backups de archivos).
- No agregar servicios o dependencias pesadas sin consultarlo.
- No tocar el esquema de sync sin actualizar PLAN.md §5.

## Primera tarea sugerida
Inicializar el proyecto Tauri 2 + React + TypeScript, configurar SQLite con el sistema de migraciones, crear el esquema de la Fase 1 (PLAN.md §4) y un test que verifique que el stock coincide con la suma de movimientos.
