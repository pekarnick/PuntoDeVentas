# 01 — Primeros Pasos, Pantalla de Inicio de Sesión, Roles y Actualizaciones

Este módulo explica cómo ingresar al sistema con usuario y contraseña, comprender los niveles de acceso del personal, navegar por la interfaz y actualizar el programa en tu computadora sin perder datos.

---

## 1. Instalación y Asistente de Primer Uso (Solo la primera vez)

### Paso 1: Instalar el programa en tu computadora Windows
1. Descargá el instalador para Windows (`.msi` o `-setup.exe`) desde la sección **Releases** de GitHub.
2. Hacé doble clic y seguí los pasos habituales (**Siguiente → Instalar**). No necesitás instalar ningún otro programa ni configurar servidores.

### Paso 2: Completar el Asistente de Primer Uso
La primera vez que abrís el programa recién instalado, aparece una pantalla de bienvenida para configurar tu negocio de forma segura:
1. Escribí el **Nombre de tu comercio** (y opcionalmente tu CUIT y condición frente al IVA).
2. Elegí tu **Nombre completo**, tu **Nombre de usuario** (ej. `maria` o `dueno`) y una **Contraseña segura propia** (mínimo 8 caracteres).
3. Presioná **Crear comercio y comenzar**.

> [!IMPORTANT]
> **Sin contraseñas de fábrica:** Por tu seguridad, el sistema **no trae claves preestablecidas** que cualquiera pueda adivinar. Vos definís la contraseña del dueño (**Superadmin**) desde el primer minuto.

### Paso 3: Ingreso Diario (`🔐 Iniciar Sesión`)
Cada vez que abrís el programa (o después de presionar `🚪 Cerrar sesión`), aparece la **Pantalla de Inicio de Sesión** conectada a la **Base de Datos Local (`SQLite`)**, funcionando **100% sin internet**.
- Cada persona ingresa con su **usuario** y **contraseña personal** (el dueño puede dar de alta a encargados y cajeros en la pestaña **Usuarios y Roles**).
- Si se ingresa la clave incorrecta varias veces seguidas, el sistema aplica un **bloqueo temporal** preventivo para proteger la cuenta.

> [!TIP]
> Si un administrador reseteó tu clave o te asignó una contraseña temporal de primer ingreso, luego de poner tu usuario y clave el sistema te mostrará en el acto el formulario **"🔑 Cambio de contraseña requerido"** para que elijas tu nueva contraseña personal antes de entrar.

---

## 2. Barra Superior y Navegación Principal

<div align="center">
  <img src="imagenes/01_pantalla_principal.png" alt="Descripción" style="border: 3px solid #ccc; padding: 5px; background-color: white; max-width: 100%;">
</div>

> Vista general de la aplicación con la barra superior de navegación, el logo del comercio, el indicador de base de datos local y el menú principal.

### Elementos clave de la barra superior:
- **Identificador de Comercio y Sucursal Activa (`📍 Sucursal`):** Muestra el nombre del local y te permite elegir en qué sucursal o depósito está operando esta computadora.
- **Estado de Sincronización:** Indica si trabajás `Sin conexión (modo local)`, `Sincronizado` o con cambios `Pendientes`.
- **Selector de Modo Claro / Oscuro (`☀️ Claro` / `🌙 Oscuro`):** Alterna entre la vista diurna y el tema oscuro descansado para turnos nocturnos.
- **Operador Autenticado y Botón `🚪 Cerrar sesión`:** Muestra el nombre real y el rol del usuario que inició sesión. Al terminar tu turno o cambiar de cajero, presioná **`🚪 Cerrar sesión`** para volver a la pantalla de login.
- **Selector `🧪 Probar rol` (Exclusivo para `superadmin`):** Este selector aparece **únicamente cuando quien inició sesión es un `superadmin`** (dueño/administrador) para que pueda verificar cómo ven el sistema un `encargado` o un `cajero`. Cuando inicia sesión un Encargado o un Cajero, este selector **no aparece**.
- **Pestañas de Navegación:** Acceso rápido a `Venta (Mostrador)`, `🟢/🔴 Caja y Arqueo`, `Productos y Stock`, `Compras y Proveedores`, `Clientes y Cta. Cte.`, `Informes`, `Usuarios y Roles`, `Auditoría`, `Configuración` y `📖 Ayuda y Manual`.

---

## 3. Niveles de Acceso y Roles de Usuario

El sistema cuenta con un modelo estricto de seguridad basado en roles para proteger información sensible (como los costos de compra y las ganancias):

| Rol | Objetivo Principal | Pantallas Habilitadas | ¿Puede ver costos de compra y ganancias? |
|---|---|---|---|
| **Cajero** | Atención al público y cobro | Venta POS, Caja y Ayuda | ❌ **No**. Solo ve precio de venta final. |
| **Encargado** | Gestión operativa del local | Venta POS, Caja, Productos, Compras, Clientes, Informes y Ayuda | ✅ **Sí**. Ve costos y administra precios y proveedores. |
| **Superadmin** | Dueño / Administrador general | Acceso total a todas las funciones + Usuarios, Auditoría, Configuración y Selector `🧪 Probar rol` | ✅ **Sí**. Acceso completo y control de personal. |

> [!IMPORTANT]
> **Regla de oro de confidencialidad (Regla 20):** El rol **Cajero**, los tickets/facturas y la pantalla de venta móvil jamás muestran los márgenes de ganancia ni el costo de adquisición de los productos.

---

## 4. Uso 100% Local en PC (Instalador Tauri) y Cómo Actualizar desde GitHub Releases

Podés usar este sistema **100% en tu computadora Windows sin configurar ninguna base de datos en internet** (sin Supabase ni Firebase). Toda tu información se guarda en el disco de tu PC (`data/pos_local.db`).

### ¿Cómo actualizar el programa cuando sale una versión nueva en GitHub Releases?
1. **Hacé un respaldo preventivo (recomendado):** Entrá a **Configuración → Copias de Seguridad** y hacé clic en **"Crear copia de respaldo ahora"**.
2. **Cerrá el programa Punto de Venta.**
3. **Descargá el instalador nuevo desde GitHub Releases:** Entrá a la página de **Releases** del repositorio en GitHub y descargá el instalador para Windows (`.msi` o `-setup.exe`) de la última versión.
4. **Ejecutá el instalador normalmente (Siguiente → Instalar):** No desinstales la versión anterior; instalá la nueva encima.
5. **Tus datos se conservan intactos:** Al abrir la nueva versión, el programa detecta tu base de datos local existente y aplica automáticamente las mejoras nuevas **sin borrar ningún producto, cliente, usuario, caja ni venta histórica**.

