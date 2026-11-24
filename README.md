# Punto de Ventas (POS) — Offline-First para Argentina

> **Sistema de Punto de Venta y Administración Comercial de Alto Rendimiento**  
> Diseñado para el comercio minorista argentino: kioscos, librerías, ferreterías, almacenes y tiendas de conveniencia.  
> Marca y autoría: **GAR - Guillermo Adolfo Rohde**.

[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue.svg)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/React-19.0-61dafb.svg)](https://react.dev/)
[![Tauri](https://img.shields.io/badge/Tauri-2.2-yellowgreen.svg)](https://tauri.app/)
[![SQLite](https://img.shields.io/badge/SQLite-WAL-lightblue.svg)](https://www.sqlite.org/)
[![Supabase](https://img.shields.io/badge/Supabase-Postgres_&_RLS-emerald.svg)](https://supabase.com/)
[![Vitest](https://img.shields.io/badge/Tests-85%20passing-brightgreen.svg)](https://vitest.dev/)

---

## 📋 Tabla de Contenidos

1. [Visión General](#-visión-general)
2. [Características Principales](#-características-principales)
3. [Reglas Inviolables de Arquitectura y Negocio](#-reglas-inviolables-de-arquitectura-y-negocio)
4. [Stack Tecnológico](#-stack-tecnológico)
5. [Estructura del Proyecto](#-estructura-del-proyecto)
6. [Instalación y Puesta en Marcha](#-instalación-y-puesta-en-marcha)
7. [Atajos de Teclado (POS de Escritorio)](#-atajos-de-teclado-pos-de-escritorio)
8. [Configuraciones Avanzadas](#-configuraciones-avanzadas)
   - [Sincronización con Supabase](#sincronización-con-supabase)
   - [Venta Móvil Web PWA (`/web-pos`)](#venta-móvil-web-pwa-web-pos)
   - [Facturación Electrónica ARCA (ex-AFIP)](#facturación-electrónica-arca-ex-afip)
   - [Multinube Opcional (Firebase Firestore / Storage)](#multinube-opcional-firebase-firestore--storage)
   - [Copias de Seguridad y Restauración](#copias-de-seguridad-y-restauración)
9. [Pruebas Automatizadas y Calidad](#-pruebas-automatizadas-y-calidad)
10. [Licencia y Autoría](#-licencia-y-autoría)

---

## 🌟 Visión General

Este sistema fue concebido como una solución integral y robusta para resolver las particularidades operativas, financieras y regulatorias del comercio minorista en la República Argentina:

- **100% Offline-First:** La caja cobra y opera a máxima velocidad directamente contra un archivo SQLite local (`data/pos_local.db`). La falta de internet jamás detiene la atención al cliente.
- **Sincronización en la Nube:** Replicación en segundo plano contra Supabase Postgres con Row Level Security (RLS) y storage de imágenes WebP en cola separada. Permite sincronizar múltiples terminales y sucursales.
- **Venta Móvil Web (`/web-pos`):** Permite usar cualquier celular como terminal de cobro escaneando un código QR público, sin instalar aplicaciones ni certificados locales.
- **Facturación Electrónica ARCA (opcional):** Emisión nativa de Facturas A, B, C y Notas de Crédito con CAE y código QR oficial RG 4892/2020 en SVG puro, procesada en Edge Functions sin exponer certificados en las terminales.
- **Protección de Costos y Rentabilidad (Regla 20):** La pantalla de venta, tickets térmicos, comprobantes digitales, WhatsApp y la app móvil muestran exclusivamente el `precio_venta`. Los costos y márgenes son de acceso reservado para encargados y superadministradores.

---

## 🚀 Características Principales

### 🛒 Caja y Ventas
- **Operación ultra rápida:** Optimizado para lectores de código de barras y teclado sin ratón (`F1` a `F9`, `Escape`).
- **Control intuitivo de Caja Abierta / Cerrada:** La sección **Caja y Arqueo** está ubicada junto a **Venta (Mostrador)** con indicador en vivo (`🟢 Caja y Arqueo` / `🔴 Caja y Arqueo (Cerrada)`). Si la caja está cerrada, se bloquean los cobros, movimientos manuales y arqueos, ofreciendo en la pantalla de venta un formulario directo para abrir el turno en el acto.
- **Pagos múltiples combinados (`F9`):** Cobro fraccionado en varios medios (Efectivo, Mercado Pago, Transferencia, Débito, Crédito, QR, Cuenta Corriente u Otros) con botón *"Completar resto"* y validación matemática de suma exacta.
- **Lectura de balanzas comerciales EAN-13:** Decodificación automática de etiquetas con prefijo `20` (peso en gramos) y prefijo `21` (importe en pesos).
- **Ventas inmutables (Append-Only):** Las ventas no se editan ni se eliminan; se anulan mediante transacciones compensatorias auditadas.
- **Tickets y comprobantes:** Emisión en formato térmico ESC/POS y comprobante digital compartible por WhatsApp.

### 📦 Gestión de Stock, Sucursales y Catálogo
- **Stock derivado de movimientos:** El stock no es un campo modificable a mano; se calcula dinámicamente como la suma estricta de sus movimientos (compras, ventas, anulaciones, transferencias y ajustes auditados).
- **Administración de Sucursales y Migración de Mercadería:** Creación de múltiples sucursales o depósitos (con *"Casa Central"* por defecto), selector de sucursal activa por terminal, visualización exacta de dónde se encuentran las unidades de cada producto (`📍 Casa Central: X · Sucursal 2: Y`) y migración atómica de productos entre sucursales (individual o todo el stock de origen en 1 clic).
- **Panel de Armado de Combos con Stock Inteligente:** Configuración de combos/promociones con componentes, cantidades requeridas y precio especial de venta. El stock disponible del combo se calcula automáticamente en base al componente de menor existencia, y cada venta descuenta automáticamente las unidades correspondientes de cada componente.
- **Imágenes WebP optimizadas:** Compresión automática local con Sharp (imagen principal `≤ 150 KB` y miniatura `_thumb.webp ≤ 25 KB`), eliminación de metadatos GPS/EXIF y sincronización asíncrona hacia Supabase Storage.
- **Edición ágil de catálogo:** Actualización rápida de precios, costos, nombres y `stock_minimo` directamente desde la grilla.
- **Múltiples listas de precios:** Manejo de precios mayoristas, minoristas y promocionales.
- **Importación masiva CSV:** Tolerante a códigos compartidos, omisión de códigos inexistentes (`0`, `-`, `S/C`) y reactivación automática de productos dados de baja.

### 💼 Compras, Pedidos Automáticos en PDF, Proveedores y Clientes
- **Listas automáticas de pedido por Stock Bajo (Exportación PDF):** Detección automática de artículos con `stock_actual <= stock_minimo`, agrupados **por Proveedor**, **por Marca** y **por Categoría**, con exportación automática en **PDF** lista para enviar al proveedor y botón de carga en 1 clic al formulario de compra.
- **Cuentas corrientes:** Control de saldo deudor/acreedor y validación de límite de crédito para clientes.
- **Validación CUIT Módulo 11:** Verificación algorítmica de CUIT/CUIL tanto de clientes como de proveedores.
- **Actualización masiva de precios:** Ajustes porcentuales o por importe fijo con reglas de redondeo rioplatense configurables (al entero, decenas o cientos).
- **Informes de Gestión y Libros de IVA en Excel (.xlsx):** Tablero en tiempo real filtrable por sucursal o consolidado (Total Facturado, Ganancia Bruta Real con costo histórico, Margen de Rentabilidad, Ticket Promedio, Distribución de Cobranza, Stock Valorizado con Ganancia Proyectada y Libro IVA Ventas/Compras exportable a `.xlsx`).

### 📱 Terminal Móvil Web (`/web-pos`)
- **PWA sin instalación y publicación en 1 clic en Netlify:** Aplicación ligera accesible desde navegador móvil mediante QR público seguro, con bloqueo automático de indexación en buscadores (`robots.txt` + `X-Robots-Tag: noindex`).
- **Comprobante en ventana modal instantánea y barra rápida de cobro:** Al confirmar una venta, la vista sube automáticamente y muestra el ticket en un modal centrado a pantalla completa (con botones para WhatsApp, Imprimir y Nueva Venta), además de una barra flotante superior (`🛒 N ítems · $ Total` + *"Ir a Cobrar ↓"*).
- **Escáner de código de barras:** Lectura por cámara mediante API nativa `BarcodeDetector` con linterna integrada.
- **Seguridad perimetral:** RLS en servidor, catálogo proyectado sin costos (`productos_venta`), autorización individual `puede_vender_movil` y cierre forzado ante revocación de sesión.
- **Idempotencia transaccional:** Cada venta genera un UUIDv7 en el dispositivo para impedir duplicaciones por cortes de red.

### 🔒 Auditoría Criptográfica y Seguridad
- **Hash encadenado SHA-256:** Cada cambio en el sistema genera un registro inmutable en la tabla `auditoria` encadenando `hash = SHA-256(hash_prev + payload)`.
- **Autenticación robusta y Asistente de Primer Uso:** En instalaciones nuevas, un asistente guiado permite al dueño crear su comercio y contraseña personal (`superadmin`) sin claves de fábrica hardcodeadas. Las contraseñas se derivan con **Argon2id**, el sistema aplica bloqueo temporal ante intentos fallidos y revoca automáticamente las sesiones móviles al cambiar claves, roles o estados.
- **Roles y Permisos:** `superadmin` (control total y auditoría), `encargado` (gestión de stock, precios, compras y límites de crédito) y `cajero` (operación exclusiva de venta y su propia caja).
- **Integridad y Exportaciones Seguras:** Neutralización de fórmulas en `.xlsx` (`=`, `+`, `-`, `@`), eliminación de bytes de control en tickets ESC/POS, validación SHA-256 + `limitInputPixels` en imágenes y copias de seguridad sanitizadas (sin tokens ni hashes de PIN).

### 🖥️ Experiencia de Usuario
- **Paginación inteligente:** Listados de 10 elementos por página en todas las pantallas operativas para máxima fluidez.
- **Modo Oscuro / Claro:** Selector persistido de tema visual en escritorio y venta móvil.
- **Marca institucional:** Firma permanente `GAR - Guillermo Adolfo Rohde`.

---

## 🛡️ Reglas Inviolables de Arquitectura y Negocio

El proyecto sigue 20 principios rectores definidos en `PLAN.md`:

1. **IDs UUID:** Se utiliza UUIDv7 (ordenable temporalmente) en todas las tablas; nunca autoincrementales.
2. **Dinero en Centavos:** Todos los importes monetarios son números enteros (`INTEGER` en centavos). Formato rioplatense: `$ 1.234,56`.
3. **Ventas Inmutables:** Append-only. Se anulan mediante un registro compensatorio; jamás se modifican ni se eliminan.
4. **Stock Calculado:** El stock es siempre el resultado de `SUM(movimientos_stock)`.
5. **Borrado Lógico:** Las entidades maestras sincronizables utilizan `deleted_at`.
6. **Campos de Control:** Todas las tablas sincronizables poseen `id`, `created_at`, `updated_at`, `deleted_at`, `device_id` y `sync_status`.
7. **Offline-First:** Ninguna función de cobro o caja depende de internet.
8. **Seguridad de Claves:** Jamás se exponen claves de servicio (`service_role`) en el cliente; todo acceso se protege con RLS.
9. **Zonas Horarias:** Fechas en UTC en base de datos y formateadas a `America/Argentina/Buenos_Aires` al renderizar.
10. **Idioma y Localización:** Español rioplatense y moneda de curso legal ARS.
11. **Permisos de Cajero:** El cajero nunca ve costos de compra ni márgenes de ganancia.
12. **Imágenes Fuera de la BD:** Los archivos se conservan en disco local y Supabase Storage; nunca blobs en la base de datos.
13. **Auditoría Transaccional:** Cada mutación de datos escribe un registro en `auditoria` en la misma transacción SQLite.
14. **Auditoría Inmutable:** La tabla `auditoria` no permite `UPDATE` ni `DELETE` (protegida por triggers a nivel motor).
15. **Usuarios Trazables:** Los usuarios no se borran; se desactivan. Siempre debe haber al menos un `superadmin` activo.
16. **Criptografía de Contraseñas:** Hash Argon2id sin excepción.
17. **Aislamiento de Venta Móvil:** La terminal `/web-pos` solo vende y sus restricciones se validan en el backend/Postgres.
18. **ARCA Opcional:** Viene deshabilitada por defecto y funciona con tickets no fiscales sin requerir certificados.
19. **QR sin Secretos:** El código QR contiene exclusivamente la URL pública del comercio.
20. **Protección Total de Costos:** Lo que ve el cliente (pantalla, tickets, facturas, WhatsApp) muestra exclusivamente `precio_venta`.

---

## 🛠️ Stack Tecnológico

| Capa | Tecnología | Función |
|---|---|---|
| **Contenedor de Escritorio** | [Tauri 2](https://tauri.app/) | Empaquetado nativo ultra liviano para Windows (Rust backend). |
| **Frontend** | [React 19](https://react.dev/) + [TypeScript](https://www.typescriptlang.org/) + [Vite](https://vitejs.dev/) | Interfaz rápida y reactiva con tipado estático estricto. |
| **Base de Datos Local** | [SQLite](https://www.sqlite.org/) (`node:sqlite` / Tauri Plugin) | Persistencia local en `data/pos_local.db` con triggers de integridad. |
| **Nube y Sincronización** | [Supabase](https://supabase.com/) | Base Postgres remota, Row Level Security, Storage privado y Edge Functions. |
| **Multinube (Opcional)** | [Firebase](https://firebase.google.com/) | Conector REST para Firestore y Firebase Storage como espejo redundante. |
| **Tratamiento de Imágenes** | [Sharp](https://sharp.pixelplumbing.com/) | Conversión a WebP, miniaturas automáticas y remoción de metadatos GPS. |
| **Criptografía** | [@noble/hashes](https://github.com/paulmillr/noble-hashes) | Hashes seguros SHA-256 para auditoría y derivación Argon2id para autenticación. |
| **Lógica Compartida** | Paquete `@pos/domain` (`packages/domain`) | Funciones puras independientes del framework (totales, IVA, CUIT, ARCA, QR). |
| **Pruebas** | [Vitest](https://vitest.dev/) | Suite de tests unitarios y de integración end-to-end sobre base real SQLite. |

---

## 📁 Estructura del Proyecto

```text
PuntoDeVentas/
├── data/                             # Base de datos SQLite local (pos_local.db) e identidad
├── docs/                             # Documentación técnica y Manual de Usuario modular
│   ├── decisiones.md                 # Registro de decisiones de arquitectura
│   └── manual/                       # Manual de Usuario completo (10 módulos + índice)
├── migrations/                       # Migraciones SQL versionadas para SQLite local
│   ├── 001_esquema_inicial.sql
│   ├── 002_sync_imagenes_y_config_backup.sql
│   ├── 003_venta_movil_sesiones.sql
│   ├── 004_arca_y_extras_fase4.sql
│   ├── 005_firebase_multinube.sql
│   ├── 006_netlify_despliegue.sql
│   ├── 007_sucursales_y_transferencias.sql
│   ├── 008_endurecimiento_seguridad_p0.sql
│   └── 009_endurecimiento_seguridad_p1.sql
├── packages/
│   └── domain/                       # Biblioteca de lógica pura de negocio (@pos/domain)
│       └── src/
│           ├── arca_fase4.ts         # Facturación ARCA, QR oficial RG 4892/2020 y balanzas EAN-13
│           ├── despliegue_web.ts     # Publicación segura de /web-pos y bloqueo anti-indexación
│           ├── gestion_fase3.ts      # CUIT módulo 11, redondeo y listas de precio
│           ├── totales.ts            # Cálculo de totales, IVA, descuentos y pagos combinados
│           └── venta_movil.ts        # QR SVG, validación de URLs públicas y comprobantes
├── src/                              # Aplicación de escritorio React + TypeScript
│   ├── components/                   # Componentes reutilizables (PaginadorTabla, etc.)
│   ├── db/                           # Capa de repositorios y acceso a datos SQLite
│   │   ├── arca_fase4_repo.ts
│   │   ├── backup_repo.ts
│   │   ├── gestion_fase3_repo.ts
│   │   ├── informes_repo.ts
│   │   ├── repositorios.ts
│   │   ├── sucursales_repo.ts
│   │   └── venta_movil_repo.ts
│   ├── domain/                       # Exportaciones y funciones puras (sucursales, PDF, pedidos, informes)
│   ├── features/                     # Módulos y pantallas del sistema
│   │   ├── auditoria/                # Registro inmutable con verificación de hash encadenado
│   │   ├── auth/                     # Asistente de Primer Uso, Login Argon2id y cambio de clave
│   │   ├── caja/                     # Apertura obligatoria, ingresos/egresos y arqueo por medio
│   │   ├── clientes/                 # Padrón de clientes y cuentas corrientes
│   │   ├── compras/                  # Compras, proveedores y pedidos PDF de stock bajo
│   │   ├── configuracion/            # Sincronización, backups, QR móvil, Netlify, ARCA y multinube
│   │   ├── informes/                 # Tablero en tiempo real, stock valorizado, sucursales y Libro IVA
│   │   ├── productos/                # Catálogo, sucursales, migración de stock, combos y fotos WebP
│   │   ├── usuarios/                 # Usuarios, roles Argon2id y permisos móviles
│   │   └── venta/                    # Pantalla principal de caja POS con pagos F9 y combos
│   ├── sync/                         # Motor de sincronización (Supabase / Firebase) y desplegador Netlify
│   │   ├── adaptador_firebase.ts
│   │   ├── desplegador_netlify.ts
│   │   ├── motor_sync.ts
│   │   └── zip_ligero.ts
│   ├── App.tsx                       # Contenedor raíz con selector de sucursal, estado de caja y temas
│   └── styles.css                    # Estilos globales y paleta de modo oscuro/claro
├── src-tauri/                        # Configuración y backend nativo de Tauri 2 (Rust)
├── supabase/                         # Recursos para la nube de Supabase
│   ├── config.toml                   # Configuración de Edge Functions (verify_jwt = true)
│   ├── esquema_completo_unificado.sql # Script único idempotente (001 a 005) para SQL Editor
│   ├── functions/                    # Edge Functions aisladas (ej. emisión ARCA)
│   └── migrations/                   # Migraciones SQL para Postgres con RLS (001 a 005)
├── firestore.rules                   # Reglas estrictas de Cloud Firestore (Firebase Auth + claims)
├── storage.rules                     # Reglas estrictas de Firebase Storage (WebP <= 200 KB)
├── web-pos/                          # Aplicación Web Progresiva (PWA) de Venta Móvil
│   ├── index.html
│   ├── manifest.webmanifest
│   └── src/
│       ├── WebPosApp.tsx             # Terminal móvil con escáner, modal de ticket, WhatsApp y caja
│       └── estilos_web_pos.css
├── AGENTS.md                         # Guía de desarrollo y reglas inviolables para agentes IA
├── PLAN.md                           # Plan maestro y especificación técnica por fases
├── PROMPT_BASE.md                    # Estado de avance del proyecto y guía de continuidad
├── package.json
├── tsconfig.json
└── vite.config.ts                    # Configuración Vite multi-página (escritorio + web-pos)
```

---

## 💻 Instalación y Puesta en Marcha

### Opción A — Para Comercios (Instalador de Windows, sin conocimientos técnicos)
1. Descargá el instalador para Windows (`.msi` o `-setup.exe`) desde la sección **Releases** de GitHub.
2. Ejecutá el instalador (**Siguiente → Instalar**). No necesitás instalar Node.js, bases de datos ni programas adicionales.
3. Al abrir el sistema por primera vez, el **Asistente de Primer Uso** te pedirá:
   - El nombre de tu comercio (y CUIT/condición fiscal opcional).
   - Tu usuario y contraseña segura de dueño (**Superadmin**, mínimo 8 caracteres).
4. ¡Listo! Ya podés cargar productos, abrir la caja y vender **100% sin internet**. Podés consultar el paso a paso completo en [docs/manual/01_primeros_pasos_y_login.md](docs/manual/01_primeros_pasos_y_login.md).

---

### Opción B — Para Desarrolladores (desde código fuente)

#### Requisitos Previos
- **Node.js:** Versión 20 o 22 LTS (se recomienda 22+ para soporte nativo de `node:sqlite`).
- **NPM:** Incluido con Node.js.
- **Rust y Cargo:** (Opcional, únicamente requerido para compilar el instalador nativo de Tauri 2 en Windows).

#### 1. Clonar el Repositorio e Instalar Dependencias
```bash
git clone https://github.com/tu-usuario/punto-de-ventas.git
cd punto-de-ventas
npm install
```

#### 2. Iniciar en Modo Desarrollo (Navegador / Servidor Local)
El proyecto incluye un servidor de desarrollo integrado que gestiona la base SQLite local y el procesamiento de imágenes:
```bash
npm run dev
```
- La aplicación de escritorio estará disponible en: `http://localhost:5173`
- La terminal móvil estará disponible en: `http://localhost:5173/web-pos`

#### 3. Ejecutar Pruebas Automatizadas
Verifica que las 85 pruebas unitarias y de integración (16 archivos) se ejecuten con éxito:
```bash
npm test
```

#### 4. Compilar para Producción (Web / Dist)
Valida los tipos TypeScript y genera los archivos estáticos optimizados tanto para el POS de escritorio como para la PWA de `/web-pos`:
```bash
npm run build
```

#### 5. Compilar la Aplicación de Escritorio con Tauri 2 (Windows)
```bash
npm run tauri dev      # Para ejecutar la ventana nativa de Tauri en desarrollo
npm run tauri build    # Para generar el ejecutable .exe / instalador de Windows
```

---

## ⌨️ Atajos de Teclado (POS de Escritorio)

La pantalla principal de caja fue diseñada para operarse al 100% mediante teclado y lector de códigos:

| Tecla / Atajo | Acción |
|---|---|
| `F1` | Enfocar inmediatamente el buscador / lector de código de barras. |
| `F2` | Cobro directo en **Efectivo** (solicita monto entregado y calcula vuelto). |
| `F3` | Cobro directo mediante **Mercado Pago**. |
| `F4` | Cobro directo por **Transferencia Bancaria**. |
| `F5` | Cobro directo con **Tarjeta de Débito**. |
| `F6` | Cobro directo con **Tarjeta de Crédito**. |
| `F7` | Cobro directo mediante código **QR**. |
| `F8` | Imputar la venta a **Cuenta Corriente** del cliente seleccionado. |
| `F9` | Abrir modal de **Pagos Combinados** (permite ingresar 2 o más medios con *"Completar resto"*). |
| `Escape` | Cerrar cualquier ventana emergente / Cancelar la operación en curso. |

---

## ⚙️ Configuraciones Avanzadas

### Sincronización con Supabase (Segura con RLS + Supabase Auth)
1. Ingresá a la sección **Configuración** en el menú superior del POS.
2. Ingresá la **URL del proyecto Supabase** (ej. `https://xxxx.supabase.co`) y la **Anon Key (clave pública)** — nunca la `service_role`.
3. Ejecutá en el **SQL Editor** de Supabase el script unificado (`supabase/esquema_completo_unificado.sql`, migraciones `001` a `005`) que podés copiar en 1 clic desde **📖 Ayuda y Manual** o **Configuración**. Las políticas RLS exigen usuarios autenticados (`TO authenticated`) y validan `comercio_id` y `rol` desde los claims firmados del JWT (`app_metadata`).
4. Creá tu usuario en **Supabase Authentication → Users** (asignando `comercio_id` y `rol` en `raw_app_meta_data`) e iniciá sesión en la nube desde **Configuración** (el token JWT queda únicamente en memoria; la contraseña de la nube nunca se guarda en SQLite y la PC sigue operando 100% offline).
5. Podés activar la **Sincronización Automática** (intervalo configurable entre 10 y 600 segundos). Guía completa en [docs/manual/10_configuracion_y_bases_remotas.md](docs/manual/10_configuracion_y_bases_remotas.md).

### Venta Móvil Web PWA (`/web-pos`)
1. En **Configuración -> Venta Móvil**, activá la casilla *"Habilitar venta móvil web"*.
2. Podés publicar la PWA en Netlify en 1 clic (el token de Netlify se mantiene únicamente en memoria efímera durante la sesión y nunca se guarda en SQLite ni en backups) o configurar tu **URL pública HTTPS** (sin tokens ni secretos en la URL).
3. El sistema generará automáticamente el **Código QR SVG** oficial para que el personal lo escanee desde su celular.
4. En **Administración de Usuarios**, asigná el permiso *"Puede vender por móvil"* a los usuarios autorizados. En `/web-pos`, el vendedor autentica contra **Supabase Auth** (nunca se descargan hashes ni tablas de usuarios).
5. El panel muestra todas las sesiones móviles activas en tiempo real y revoca automáticamente las sesiones si cambia la contraseña, el rol o se desactiva el usuario.

### Facturación Electrónica ARCA (ex-AFIP)
1. ARCA se encuentra **desactivada por defecto**.
2. Para activarla, habilitá el interruptor en **Configuración -> Facturación Electrónica**.
3. Seleccioná el entorno (**Homologación / Testing** o **Producción**) e ingresá el Punto de Venta fiscal y CUIT del comercio.
4. Las llamadas de autorización se despachan con JWT verificado (`verify_jwt = true` y validación de pertenencia a `comercio_id`) hacia la Edge Function de Supabase (`supabase/functions/emitir_comprobante_arca`), prohibiendo simuladores en `produccion` y evitando que certificados privados residan en las terminales.
5. Si se produce un corte de internet, el sistema guarda la venta como *"Pendiente"* y la reintenta automáticamente con backoff exponencial hasta `MAX_REINTENTOS_ARCA = 5`.

### Multinube Opcional (Firebase Firestore / Storage)
El sistema incluye arquitectura multinube configurable:
- Permite operar en modo `supabase`, `firebase` o `ambos` (espejo redundante).
- Para Firebase, se configuran el `Project ID`, `Storage Bucket` y la `API Key Web Pública`, iniciando sesión con **Firebase Auth** (el proyecto incluye las reglas estrictas en `firestore.rules` y `storage.rules` con validación de `request.auth != null` y custom claims `comercio_id`/`rol`).

### Copias de Seguridad y Restauración
- **Backups Atómicos y Sanitizados:** Generación de copias completas mediante `VACUUM INTO` de SQLite sobre archivo temporal y limpieza automática de datos sensibles (`netlify_token`, `sesiones_moviles`, `pin_hash`) antes de guardar el `.db.bak`.
- **Backups Automáticos:** Resguardo diario programado y copia de seguridad preventiva antes de cualquier restauración.
- **Verificación Estricta de Integridad:** Cada restauración abre el archivo en solo lectura (`PRAGMA query_only = ON`, `trusted_schema = OFF`), valida el encabezado SQLite, `PRAGMA integrity_check`, coincidencia de `comercio_id`, cadena criptográfica SHA-256 de auditoría no vacía, supervivencia de al menos un `superadmin` activo y `PRAGMA foreign_key_check`.

---

## 🧪 Pruebas Automatizadas y Calidad

El proyecto posee una suite completa de pruebas unitarias y de integración que verifican la lógica de negocio y la base de datos:

```bash
npm test
```

### Cobertura de Pruebas (12 suites / 58 tests):
- `packages/domain/src/__tests__/zip.test.ts`: Empaquetado ZIP nativo y archivos anti-indexación (`robots.txt`, `_headers`, `_redirects`).
- `src/domain/__tests__/dominio.test.ts`: Totales, IVA, redondeos, CUIT módulo 11 y pagos combinados.
- `src/db/__tests__/esquema_y_stock.test.ts`: Verificación de esquema SQLite y cálculo estricto de stock mediante movimientos.
- `src/db/__tests__/usuarios_auth_y_caja.test.ts`: Autenticación Argon2id, roles y control de caja.
- `src/db/__tests__/sync_y_backups.test.ts`: Motor de sincronización, integridad de backups y recuperación ante desastres.
- `src/db/__tests__/gestion_fase3.test.ts`: Proveedores, compras, cuentas corrientes y listas de precio.
- `src/db/__tests__/venta_movil.test.ts`: Generación de QR, RPC de venta móvil y control de sesiones.
- `src/db/__tests__/arca_fase4.test.ts`: Comprobantes fiscales ARCA, notas de crédito, balanzas EAN-13, combos con stock inteligente y descuento de componentes.
- `src/db/__tests__/informes_y_excel.test.ts`: Tablero de métricas, Libro IVA, pedidos de reposición de stock bajo en PDF (por proveedor, marca y categoría) y reportes contables.
- `src/db/__tests__/venta_imagenes_y_productos.test.ts`: Procesamiento WebP con Sharp y miniaturas.
- `src/db/__tests__/desplegador_netlify.test.ts`: Publicación automática de `/web-pos` en Netlify y seguridad perimetral.
- `src/db/__tests__/sucursales_caja_y_movil.test.ts`: Administración de sucursales, stock por ubicación, migración atómica entre locales e informes filtrados por sucursal.

---

## 📄 Licencia y Autoría

Desarrollado y mantenido por **GAR - Guillermo Adolfo Rohde**.  
Todos los derechos reservados. Proyecto concebido bajo estándares de alta disponibilidad, integridad criptográfica y rendimiento para el comercio argentino.
