# 10 — Configuración del Sistema y Bases de Datos Remotas (Supabase y Firebase)

Este documento es una guía paso a paso para configurar la sincronización en la nube, crear tus proyectos en **Supabase** y/o **Google Firebase**, aplicar sus respectivas reglas de seguridad obligatorias y configurar copias de seguridad automáticas para proteger tu comercio contra roturas de equipo o robos.

---

## 1. Filosofía Offline-First y Sincronización

El sistema trabaja con una arquitectura **Offline-First**:
1. **La Base de Datos Local es el motor de verdad:** Toda venta, cobro o ingreso se graba primero localmente en tu computadora. La caja **nunca se traba** ni depende de la velocidad de internet.
2. **Sincronización en segundo plano:** Cuando hay conexión a internet, un motor silencioso envía las ventas a la nube y descarga los cambios realizados desde otros puestos o desde la venta móvil.
3. **Dos colas separadas:** Primero viajan los datos críticos de ventas e inventario; luego, en una cola secundaria y más lenta, viajan las imágenes WebP de los productos para no saturar el ancho de banda.

<div align="center">
  <img src="imagenes/10_panel_configuracion_sync.png" alt="Descripción" style="border: 3px solid #ccc; padding: 5px; background-color: white; max-width: 100%;">
</div>

> Vista general de la pestaña Configuración con el selector de proveedor de nube, los contadores de sincronización y los botones de acción manual.

---

## 2. Configuración Paso a Paso de Supabase (Proveedor Principal)

Supabase proporciona una base de datos PostgreSQL de nivel empresarial con soporte de almacenamiento seguro para imágenes y funciones en la nube.

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
  <img src="imagenes/10_supabase_nuevo_proyecto.png" alt="Descripción" style="border: 3px solid #ccc; padding: 5px; background-color: white; max-width: 100%;">
</div>

> Formulario de creación de proyecto en el dashboard de Supabase indicando nombre y región São Paulo.

---

### Paso 2: Obtener las claves de conexión seguras
1. En el panel izquierdo de Supabase, andá a **Project Settings** (ícono de engranaje) -> **API**.
2. Encontrarás dos valores indispensables:
   - **Project URL:** Tiene la forma `https://abcdefghijkl.supabase.co`.
   - **Project API Keys — `anon` / `public`:** Una clave larga que comienza con `eyJhbGciOiJIUzI1Ni...`.

> [!CAUTION]
> **REGLA DE SEGURIDAD INVIOLABLE (Regla 8 del sistema):**
> En la aplicación POS utilizá **ÚNICAMENTE** la clave pública **`anon`**.
> **JAMÁS** copies ni pegues en el programa la clave **`service_role`** ni secretos (`sb_secret_`). La clave `service_role` elude las reglas de seguridad y nunca debe residir en computadoras cliente.

<div align="center">
  <img src="imagenes/10_supabase_api_keys_1.png" alt="Descripción" style="border: 3px solid #ccc; padding: 5px; background-color: white; max-width: 100%;">
</div>
-
<div align="center">
  <img src="imagenes/10_supabase_api_keys_2.png" alt="Descripción" style="border: 3px solid #ccc; padding: 5px; background-color: white; max-width: 100%;">
</div>

> Sección API de Supabase destacando la URL del proyecto y la clave pública `anon` (ocultando u ofuscando la clave privada `service_role`).

---

### Paso 3: Crear las Tablas y la Seguridad RLS (SQL Editor)
Para que Supabase entienda la estructura de tus datos y bloquee accesos indebidos:
1. En el menú izquierdo de Supabase, hacé clic en **SQL Editor** -> **New Query**.
2. Podés cargar los scripts ubicados en la carpeta `supabase/migrations/` de este proyecto:
   - `001_esquema_supabase_rls.sql` (crea las tablas de ventas, productos, caja, auditoría y activa **Row Level Security**).
   - `002_venta_movil_rpc.sql` (habilita la función segura para venta desde celulares).
   - `003_arca_y_extras_fase4.sql` (combos, variantes y facturación).
3. **Atajo rápido desde el POS:** En la pestaña **Configuración** del sistema, podés presionar el botón **"📋 Copiar script actualización Supabase"**. Luego pegás ese contenido en el SQL Editor de Supabase y presionás **Run**.

<div align="center">
  <img src="imagenes/10_supabase_sql_editor.png" alt="Descripción" style="border: 3px solid #ccc; padding: 5px; background-color: white; max-width: 100%;">
</div>

> Ventana del SQL Editor con el script pegado y el mensaje en verde "Success. No rows returned".

---

### Paso 4: Crear el Bucket de Imágenes en Supabase Storage
1. En el menú izquierdo, hacé clic en **Storage**.
2. Hacé clic en **New Bucket**.
3. Nombre exacto del bucket: `productos-imagenes`.
4. Dejá la opción **Public Bucket** **DESACTIVADA** (Privado): el sistema maneja la seguridad mediante políticas RLS para que solo tu comercio pueda gestionar sus fotografías.
5. Guardá los cambios.

<div align="center">
  <img src="imagenes/10_supabase_storage_bucket.png" alt="Descripción" style="border: 3px solid #ccc; padding: 5px; background-color: white; max-width: 100%;">
</div>

> Modal de creación de bucket con el nombre `productos-imagenes` en modo privado.

---

## 3. Configuración Paso a Paso de Google Firebase (Proveedor Opcional / Espejo)

Si deseás utilizar **Google Cloud Firebase** como proveedor alternativo o mantener una réplica en espejo simultánea:

### Paso 1: Crear el proyecto en Firebase Console
1. Ingresá a [https://console.firebase.google.com](https://console.firebase.google.com).
2. Hacé clic en **Crear un proyecto**.
3. Asigná un nombre (ej. `mi-pos-comercio`) y finalizá la creación (podés omitir Google Analytics si no lo necesitás).

---

### Paso 2: Habilitar Cloud Firestore
1. En el menú lateral, andá a **Bases de datos y almacenamiento** -> **Firestore**.
2. Hacé clic en **Crear base de datos** -> **Edición Standard**.
3. Seleccioná la ubicación geográfica (ej. `southamerica-east1` - São Paulo).
4. En la configuración de reglas iniciales, seleccioná **Iniciar en modo de producción**.

---

### Paso 3: Aplicar Reglas de Seguridad en Cloud Firestore
Para evitar que personas ajenas lean o modifiquen tus datos, hacé clic en la pestaña **Reglas** (*Rules*) de Firestore y reemplazá el contenido por estas reglas de seguridad estrictas:

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // Prohibir acceso anónimo no identificado a colecciones del sistema
    match /{document=**} {
      allow read, write: if false;
    }
    
    // Reglas de sincronización por comercio identificado
    match /comercios/{comercioId}/{coleccion}/{documentoId} {
      // Solo permite escritura y lectura si coincide el comercio y la clave es válida
      allow read: if request.auth != null || request.headers.apikey != null;
      allow create, update: if request.resource.data.comercio_id == comercioId;
      // Las ventas y auditoría son inmutables (no se permite borrar)
      allow delete: if coleccion != 'ventas' && coleccion != 'auditoria';
    }
  }
}
```

Hacé clic en **Publicar** (*Publish*).

<div align="center">
  <img src="imagenes/10_firebase_security_rules.png" alt="Descripción" style="border: 3px solid #ccc; padding: 5px; background-color: white; max-width: 100%;">
</div>

> Editor de reglas de Cloud Firestore con el código de reglas publicado correctamente.

---

### Paso 4: Obtener el Project ID y la Web API Key de Firebase
1. Hacé clic en el ícono de engranaje (arriba a la izquierda) -> **Configuración del proyecto**.
2. En la pestaña **General**:
   - Copiá el **ID del proyecto** (*Project ID*, ej. `mi-pos-comercio-12345`).
   - Copiá la **Clave de API web** pública (*Web API Key*, empieza con `AIzaSy...`).

> [!CAUTION]
> **REGLA DE SEGURIDAD EN FIREBASE:**
> Nunca uses ni pegues en el programa el archivo JSON de *Cuentas de Servicio* (`service_account.json` o credenciales con `"private_key"`). La aplicación está diseñada para usar la API REST pública con Web API Key.

---

## 4. Configurar la Sincronización en el POS

Una vez que tengas tus credenciales de Supabase o Firebase:

<div align="center">
  <img src="imagenes/10_parametros_nube_pos.png" alt="Descripción" style="border: 3px solid #ccc; padding: 5px; background-color: white; max-width: 100%;">
</div>

> Formulario de configuración en el POS con la URL de Supabase, clave pública anon, casilla de sincronización automática tildada e intervalo de 5 minutos.

1. Abrí la aplicación POS en la PC y andá a **Configuración**.
2. En **Proveedor de sincronización en la nube**, seleccioná:
   - **Supabase (Recomendado)**
   - **Firebase**
   - **Ambos en paralelo (Espejo redundante)**
3. Pegá la **URL del Proyecto** y la **Clave pública**.
4. Tildá la casilla **"Sincronizar automáticamente en segundo plano"**.
5. Indicá el intervalo deseado (por ejemplo, cada `5` minutos).
6. Presioná **Guardar configuración**.
7. Podés presionar **"⟳ Sincronizar datos ahora"** para hacer la primera prueba de conexión.

---

## 5. Copias de Respaldo Locales (Backups) y Recuperación de Desastres

Para garantizar que tus datos jamás se pierdan ante una rotura del disco rígido o robo:

<div align="center">
  <img src="imagenes/10_backups_restauracion.png" alt="Descripción" style="border: 3px solid #ccc; padding: 5px; background-color: white; max-width: 100%;">
</div>

> Sección inferior de Backups con la lista de copias fechadas, botón "Crear copia de respaldo ahora" y botón "Exportar todo a Excel".

### A. Copias Diarias Automáticas
- Activá la casilla **"Realizar copia diaria automática de la base de datos"**.
- El sistema generará una copia de seguridad comprimida fechada (ej. `pos_backup_2026-10-28_18-00.db.bak`) en la carpeta de respaldos.
- **Recomendación:** Podés apuntar la carpeta de backups a un pendrive USB o a tu carpeta sincronizada de Google Drive / Dropbox para tener resguardo fuera de la máquina.

### B. Recuperación Inmediata desde la Nube (Disaster Recovery)
Si tu computadora se rompe por completo o instalás una máquina nueva:
1. Instalá el sistema POS en la nueva PC.
2. Ingresá a **Configuración** y colocá la URL y clave de tu proyecto Supabase existente.
3. El sistema reconocerá automáticamente la identidad de tu comercio y descargará todo el catálogo, clientes, historial y configuración desde la nube a la nueva base de datos local en cuestión de segundos.
