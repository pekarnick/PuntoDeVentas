# 10 — Configuración del Sistema y Bases de Datos Remotas Seguras (Supabase y Firebase)

Este documento es una guía paso a paso para configurar la sincronización en la nube, crear tus proyectos en **Supabase** y/o **Google Firebase**, dejar **100% protegida tu base de datos en internet** (sin que nadie ajeno pueda ver tus ventas o precios) y configurar copias de seguridad automáticas.

---

## 1. Filosofía Offline-First: Uso 100% Local en PC vs. Sincronización en la Nube (Opcional)

El sistema trabaja con una arquitectura **Offline-First**:
1. **Podés usar el programa 100% local en tu PC (Instalador Windows) sin configurar ninguna nube:** Si tenés una sola computadora en el mostrador y no necesitás conectar otras PCs ni celulares, **no hace falta crear cuentas en Supabase ni en Firebase**. Todo se guarda en el disco de tu computadora (`data/pos_local.db`) y podés actualizar el programa descargando el nuevo instalador desde **GitHub Releases** sin perder ningún dato.
2. **La Base de Datos Local es siempre el motor de verdad:** Toda venta, cobro o ingreso se graba primero localmente en tu computadora. La caja **nunca se traba** ni depende de la velocidad de internet.
3. **Sincronización en segundo plano (Opcional):** Si configurás Supabase y/o Firebase, cuando hay conexión a internet un motor silencioso envía las ventas a la nube y descarga los cambios realizados desde otros puestos o desde la venta móvil (`/web-pos`).
4. **Dos colas separadas:** Primero viajan los datos críticos de ventas e inventario; luego, en una cola secundaria y más lenta, viajan las imágenes WebP de los productos para no saturar el ancho de banda.

<div align="center">
  <img src="imagenes/10_panel_configuracion_sync.png" alt="Panel de Configuración y Sincronización" style="border: 3px solid #ccc; padding: 5px; background-color: white; max-width: 100%;">
</div>

> Vista general de la pestaña Configuración con el selector de proveedor de nube, los contadores de sincronización y los botones de acción manual.

---

## 2. Configuración Paso a Paso y Segura de Supabase (Proveedor Principal)

Supabase te da una base de datos PostgreSQL gratuita en la nube. Para que **solo vos y tus empleados autorizados puedan acceder a los datos de tu comercio**, seguí estos 5 pasos en orden:

### Paso 1: Crear la cuenta y el proyecto
1. Ingresá en [https://supabase.com](https://supabase.com) y creá una cuenta gratuita o iniciá sesión con GitHub.
2. Hacé clic en **New Project**.
3. Completá los campos:
   - **Name:** Nombre de tu comercio (ej. `pos-kiosco-central`).
   - **Database Password:** Creá una contraseña fuerte y guardala en un lugar seguro.
   - **Region:** Seleccioná `South America (São Paulo)` para la menor latencia desde Argentina.
   - **Plan:** Free Plan (suficiente para la gran mayoría de comercios).
4. Esperá unos minutos hasta que el proyecto termine de aprovisionarse.

<div align="center">
  <img src="imagenes/10_supabase_nuevo_proyecto.png" alt="Nuevo proyecto en Supabase" style="border: 3px solid #ccc; padding: 5px; background-color: white; max-width: 100%;">
</div>

---

### Paso 2: Obtener las claves públicas seguras
1. En el panel izquierdo de Supabase, andá a **Project Settings** (ícono de engranaje) -> **API**.
2. Copiá únicamente estos dos valores:
   - **Project URL:** Tiene la forma `https://abcdefghijkl.supabase.co`.
   - **Project API Keys — `anon` / `public`:** La clave pública que comienza con `eyJhbGciOiJIUzI1Ni...`.

> [!CAUTION]
> **REGLA DE SEGURIDAD INVIOLABLE (Regla 8):**
> En la aplicación POS utilizá **ÚNICAMENTE** la clave pública **`anon`**.
> **JAMÁS** copies ni pegues en el programa la clave privada **`service_role`** ni secretos (`sb_secret_`).

<div align="center">
  <img src="imagenes/10_supabase_api_keys_1.png" alt="Claves API de Supabase" style="border: 3px solid #ccc; padding: 5px; background-color: white; max-width: 100%;">
</div>

---

### Paso 3: Crear las Tablas y Blindar la Seguridad RLS (Script SQL Unificado `001` a `005`)
El sistema ya incluye toda la seguridad configurada en un único archivo listo para copiar:
1. En el menú izquierdo de Supabase, hacé clic en **SQL Editor** -> **+ New query**.
2. En tu programa POS, andá a **📖 Ayuda y Manual → Script SQL Supabase** (o en **Configuración**) y presioná **"📋 Copiar Script SQL Completo de Supabase"** (corresponde a `supabase/esquema_completo_unificado.sql`, migraciones `001` a `005`).
3. Pegá ese contenido en el SQL Editor de Supabase y presioná **Run**. El script es 100% idempotente: crea tablas, bloquea acceso anónimo, activa Row Level Security (`TO authenticated`), protege ventas/stock/auditoría contra borrados y oculta costos y hashes de contraseñas.

<div align="center">
  <img src="imagenes/10_supabase_sql_editor.png" alt="SQL Editor de Supabase" style="border: 3px solid #ccc; padding: 5px; background-color: white; max-width: 100%;">
</div>

---

### Paso 4: Crear tu Usuario de Acceso en la Nube (Supabase Authentication)
Por seguridad, Supabase **rechaza cualquier conexión anónima**. Tenés que crear al menos un usuario en la nube para que tu POS (y opcionalmente `/web-pos`) puedan sincronizar:
1. En el menú izquierdo de Supabase, entrá a **Authentication** -> **Users**.
2. Hacé clic en **Add user** -> **Create new user**.
3. Ingresá un **Email** (ej. `dueno@micomercio.com`) y una **Contraseña segura**, dejá marcada la casilla **Auto Confirm User** y confirmá.
4. Ahora vinculá ese usuario a tu comercio ejecutando esta pequeña consulta en **SQL Editor -> New Query** (reemplazando el email y el `comercio_id` que figura en la pantalla **Configuración** de tu POS):

```sql
-- Reemplazá 'dueno@micomercio.com' por tu email real
-- y 'TU-COMERCIO-ID-UUID' por el ID de tu comercio que ves en Configuración del POS.
-- Roles válidos: 'superadmin', 'encargado' o 'cajero'
UPDATE auth.users
SET raw_app_meta_data = COALESCE(raw_app_meta_data, '{}'::jsonb) || jsonb_build_object(
  'comercio_id', 'TU-COMERCIO-ID-UUID',
  'rol', 'superadmin'
)
WHERE email = 'dueno@micomercio.com';
```

> [!TIP]
> **¿Por qué hacemos esto?** Porque `raw_app_meta_data` solo puede modificarse desde el panel de administración de Supabase y queda firmado dentro del token de sesión (JWT). De esta forma, ninguna persona externa ni otro comercio puede leer ni modificar tus datos.

---

### Paso 5: Crear el Bucket Privado de Imágenes en Supabase Storage
1. En el menú izquierdo de Supabase, hacé clic en **Storage** -> **New Bucket**.
2. Nombre exacto del bucket: `productos`.
3. Dejá la opción **Public Bucket** **DESACTIVADA** (Privado): las políticas RLS incluidas en el Script SQL del Paso 3 permiten que únicamente los usuarios autenticados de tu comercio suban y descarguen sus fotos `.webp`.

<div align="center">
  <img src="imagenes/10_supabase_storage_bucket.png" alt="Bucket privado de Storage en Supabase" style="border: 3px solid #ccc; padding: 5px; background-color: white; max-width: 100%;">
</div>

---

## 3. Configuración Paso a Paso y Segura de Google Firebase (Opcional / Espejo)

Si deseás utilizar **Google Firebase** como nube alternativa o mantener un espejo simultáneo:

### Paso 1: Crear el proyecto y activar Authentication
1. Ingresá a [https://console.firebase.google.com](https://console.firebase.google.com) y creá un proyecto (ej. `mi-pos-comercio`).
2. En el menú lateral, entrá a **Compilación → Authentication** -> **Comenzar**.
3. En **Sign-in method**, activá el proveedor **Correo electrónico/contraseña** y creá tu usuario en la pestaña **Users**.
4. Asignale al usuario los custom claims `comercio_id` (tu UUID de comercio) y `rol` (`"superadmin"`, `"encargado"` o `"cajero"`).

### Paso 2: Habilitar Cloud Firestore y pegar Reglas Estrictas
1. Andá a **Compilación → Firestore Database** -> **Crear base de datos** (ubicación `southamerica-east1` - São Paulo, **Iniciar en modo de producción**).
2. Abrí la pestaña **Reglas (Rules)** y reemplazá todo el contenido por el archivo `firestore.rules` del proyecto (también disponible en **📖 Ayuda y Manual → Reglas Firebase**), que exige usuario autenticado (`request.auth != null`), valida `comercio_id` y `rol` en el token y prohíbe borrar registros inmutables (`ventas`, `movimientos_stock`, `auditoria`):

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function estaAutenticado() {
      return request.auth != null && request.auth.token.comercio_id != null;
    }
    function esMismoComercio(comercioId) {
      return estaAutenticado() && request.auth.token.comercio_id == comercioId;
    }
    function esAdminOEncargado() {
      return request.auth.token.rol in ['superadmin', 'encargado'];
    }
    function esSuperadmin() {
      return request.auth.token.rol == 'superadmin';
    }

    match /{document=**} {
      allow read, write: if false;
    }

    match /comercios/{comercioId} {
      allow read: if esMismoComercio(comercioId);
      allow create, update: if esMismoComercio(comercioId) && esSuperadmin();
      allow delete: if false;

      match /{coleccionAppend}/{docId} {
        allow read: if esMismoComercio(comercioId)
          && coleccionAppend in ['ventas', 'ventas_items', 'ventas_pagos', 'movimientos_stock', 'cuenta_corriente_movimientos', 'transferencias_sucursales', 'auditoria']
          && (coleccionAppend != 'auditoria' || esSuperadmin());
        allow create: if esMismoComercio(comercioId)
          && coleccionAppend in ['ventas', 'ventas_items', 'ventas_pagos', 'movimientos_stock', 'cuenta_corriente_movimientos', 'transferencias_sucursales', 'auditoria']
          && request.resource.data.comercio_id == comercioId;
        allow update, delete: if false;
      }

      match /usuarios/{usuarioId} {
        allow read: if esMismoComercio(comercioId) && esSuperadmin();
        allow create, update: if esMismoComercio(comercioId) && esSuperadmin()
          && !('clave_hash' in request.resource.data)
          && !('pin_hash' in request.resource.data);
        allow delete: if false;
      }

      match /{coleccion}/{docId} {
        allow read: if esMismoComercio(comercioId)
          && coleccion in ['productos', 'precios', 'listas_precio', 'codigos_barras', 'categorias', 'marcas', 'proveedores', 'clientes', 'caja_sesiones', 'caja_movimientos', 'sucursales', 'variantes', 'combos', 'combos_items'];
        allow create, update: if esMismoComercio(comercioId)
          && coleccion in ['productos', 'precios', 'listas_precio', 'codigos_barras', 'categorias', 'marcas', 'proveedores', 'clientes', 'caja_sesiones', 'caja_movimientos', 'sucursales', 'variantes', 'combos', 'combos_items']
          && (coleccion in ['clientes', 'caja_sesiones', 'caja_movimientos'] || esAdminOEncargado())
          && request.resource.data.comercio_id == comercioId;
        allow delete: if false;
      }
    }
  }
}
```
3. Si también habilitás **Storage**, pegá el contenido de `storage.rules` (restringe subidas a imágenes `.webp` de hasta `200 KB` dentro de `/productos/{comercioId}/`).
4. Hacé clic en **Publicar** (*Publish*).

<div align="center">
  <img src="imagenes/10_firebase_security_rules.png" alt="Reglas de Seguridad de Firestore" style="border: 3px solid #ccc; padding: 5px; background-color: white; max-width: 100%;">
</div>

### Paso 3: Obtener Project ID y Web API Key
1. Hacé clic en el ícono de engranaje -> **Configuración del proyecto** -> pestaña **General**.
2. Copiá el **ID del proyecto** (*Project ID*) y la **Clave de API web** pública (*Web API Key*, empieza con `AIzaSy...`).

> [!CAUTION]
> **REGLA DE SEGURIDAD EN FIREBASE:**
> Nunca uses ni pegues en el programa el archivo JSON de *Cuentas de Servicio* (`service_account.json` o credenciales con `"private_key"`).

---

## 4. Conectar e Iniciar Sesión en la Nube desde el POS

1. Abrí el POS en tu PC y andá a **Configuración** (requiere rol *Superadmin*).
2. Seleccioná tu proveedor (**Supabase**, **Firebase** o **Ambos en paralelo**), pegá la URL/Project ID y la clave pública.
3. En la sección de **Sesión en la Nube**, ingresá el **Email y Contraseña** del usuario de nube que creaste en Supabase Auth o Firebase Auth y presioná **Iniciar sesión en la nube**.
   - Por seguridad, la contraseña de la nube **jamás se guarda en SQLite**; solo se mantiene el token temporal en memoria mientras sincronizás.
   - Si no iniciás sesión en la nube, **tu caja sigue funcionando igual al 100% en modo local offline**.
4. Tildá **"Sincronizar automáticamente en segundo plano"** y presioná **Guardar configuración**.
5. Podés presionar **"⟳ Sincronizar datos ahora"** (o **"🔥 Copiar toda la base local a Firebase ahora (sin repetidos)"** si agregaste Firebase más adelante).

<div align="center">
  <img src="imagenes/10_parametros_nube_pos.png" alt="Parámetros de nube en el POS" style="border: 3px solid #ccc; padding: 5px; background-color: white; max-width: 100%;">
</div>

---

## 5. Copias de Respaldo Locales (Backups) y Recuperación de Desastres

<div align="center">
  <img src="imagenes/10_backups_restauracion.png" alt="Backups y exportación a Excel" style="border: 3px solid #ccc; padding: 5px; background-color: white; max-width: 100%;">
</div>

### A. Copias Diarias Automáticas y Sanitizadas
- Activá la casilla **"Realizar copia diaria automática de la base de datos"**.
- Cada copia `.db.bak` se genera de forma atómica (`VACUUM INTO`) y **elimina automáticamente secretos efímeros** (como sesiones móviles y hashes de PIN) antes de guardarse en disco.
- **Recomendación:** Apuntá la carpeta de backups a un pendrive USB o a tu carpeta de Google Drive / Dropbox para resguardo externo.

### B. Restauración Verificada desde Archivo `.db.bak`
Al restaurar un respaldo, el sistema ejecuta controles estrictos antes de aceptar el archivo:
- Verifica que sea un archivo SQLite íntegro (`PRAGMA integrity_check`), sin enlaces simbólicos (`symlinks`).
- Exige que pertenezca a **tu mismo comercio** (`comercio_id`), que tenga cadena de auditoría SHA-256 íntegra y no vacía, al menos un `superadmin` activo sobreviviente y cero errores de claves foráneas (`PRAGMA foreign_key_check`).

### C. Recuperación desde la Nube en una PC Nueva (Disaster Recovery)
Si tu computadora se rompe o instalás una PC nueva:
1. Instalá el programa POS en la PC nueva y completá el Asistente de Primer Uso.
2. Ingresá a **Configuración**, colocá la URL y clave pública de tu proyecto Supabase existente e iniciá sesión con tu usuario de **Supabase Auth**.
3. Confirmá explícitamente la **vinculación / adopción del comercio remoto** para descargar todo tu catálogo, clientes, ventas e historial en segundos (el sistema nunca adopta un comercio remoto en silencio sin tu confirmación).
