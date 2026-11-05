# 01 — Primeros Pasos, Roles y Navegación

Este módulo explica cómo iniciar el sistema, comprender los niveles de acceso del personal y navegar por la interfaz de manera fluida.

---

## 1. Inicio del Sistema

Al abrir la aplicación, el sistema se conecta automáticamente a su **Base de Datos Local**, permitiendo operar inmediatamente incluso si el comercio no cuenta con conexión a internet.

<div align="center">
  <img src="imagenes/01_pantalla_principal.png" alt="Descripción" style="border: 3px solid #ccc; padding: 5px; background-color: white; max-width: 100%;">
</div>

> Vista general de la aplicación con la barra superior de navegación, el logo del comercio, el indicador de base de datos local y el menú principal.

### Elementos clave de la barra superior:
- **Identificador de Comercio y Base de Datos:** Muestra el nombre del local y el estado de la base de datos local.
- **Selector de Modo Claro / Oscuro:** Un botón con ícono de sol/luna para alternar entre la vista diurna y nocturna para menor cansancio visual.
- **Usuario y Rol Activo:** Indica quién está operando el puesto en ese momento (ej. `Admin`, `Cajero`).
- **Pestañas de Navegación:** Acceso rápido a Punto de Venta, Caja, Productos, Compras, Clientes, Informes, Usuarios y Configuración.

---

## 2. Niveles de Acceso y Roles de Usuario

El sistema cuenta con un modelo estricto de seguridad basado en roles para proteger información sensible (como los costos de compra y las ganancias):

| Rol | Objetivo Principal | Pantallas Habilitadas | ¿Puede ver costos de compra y ganancias? |
|---|---|---|---|
| **Cajero** | Atención al público y cobro | Venta POS y Caja | ❌ **No**. Solo ve precio de venta final. |
| **Encargado** | Gestión operativa del local | Venta POS, Caja, Productos, Compras, Clientes, Informes y Configuración básica | ✅ **Sí**. Ve costos y administra precios y proveedores. |
| **Superadmin** | Dueño / Auditor general | Acceso ilimitado a todas las funciones + Auditoría inmutable de base de datos | ✅ **Sí**. Acceso completo y control de usuarios. |

> [!IMPORTANT]
> **Regla de oro de confidencialidad:** El rol **Cajero** y la pantalla de venta móvil jamás muestran los márgenes de ganancia ni el costo de adquisición de los productos. Esto previene filtraciones ante clientes o personal eventual.

---

## 3. Cambio de Usuario y Modo Visual

<div align="center">
  <img src="imagenes/01_cambio_rol_tema.png" alt="Descripción" style="border: 3px solid #ccc; padding: 5px; background-color: white; max-width: 100%;">
</div>

> Detalle del selector de usuario en la esquina superior derecha y la aplicación visualizada en modo oscuro de alto contraste.

1. **Para cambiar de operador:**
   - En el selector de usuario activo ubicado en la barra superior, seleccioná tu usuario.
   - Si cambiás a un rol con menores permisos (ej. de Superadmin a Cajero), las pestañas de Compras, Informes y Auditoría se ocultarán automáticamente.
2. **Para alternar tema visual:**
   - Hacé clic en el botón con ícono de Sol/Luna.
   - El tema oscuro utiliza fondos oscuros descansados (`#0f172a` / `#1e293b`), ideal para comercios con poca luz o turnos nocturnos.
