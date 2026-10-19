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
| `typescript` | dev | Tipado estático obligatorio definido en el stack (`PLAN.md §2`). |
| `vite`, `@vitejs/plugin-react` | dev | Empaquetador y servidor de desarrollo rápido para React + Tauri 2 (`PLAN.md §2`). |
| `vitest` | dev | Runner de tests unitarios y de integración para TypeScript (`PLAN.md §2`). |
| `@types/react`, `@types/react-dom`, `@types/node` | dev | Definiciones de tipos TypeScript para React y APIs nativas de Node en tests. |
| `@tauri-apps/cli` | dev | CLI oficial para compilar y ejecutar el contenedor de escritorio Tauri 2. |
