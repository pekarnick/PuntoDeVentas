# 09 — Usuarios, Permisos y Auditoría Criptográfica

Este módulo está destinado exclusivamente a dueños y administradores del comercio para gestionar el acceso del personal y verificar la transparencia inalterable de las operaciones mediante criptografía.

---

## 1. Gestión de Usuarios y Permisos

<div align="center">
  <img src="imagenes/09_panel_usuarios.png" alt="Descripción" style="border: 3px solid #ccc; padding: 5px; background-color: white; max-width: 100%;">
</div>

> Formulario de alta de usuario con nombre, nombre de usuario, rol asignado, tilde "Puede vender desde celular" y lista de usuarios del comercio.

### Cómo crear un nuevo usuario:
1. Dirigite a la pestaña **Usuarios y Roles** (requiere rol *Superadmin*).
2. Ingresá el **Nombre Completo** del empleado y su **Nombre de Usuario** (en minúsculas, sin espacios).
3. Asigná el **Rol**:
   - **Cajero:** Solo cobra y opera la caja de su turno. No ve costos ni informes.
   - **Encargado:** Gestiona catálogo, compras, clientes y ve informes.
   - **Superadmin:** Acceso total a usuarios, auditoría y configuración de sincronización.
4. En **Contraseña inicial (opcional, mín. 8 caracteres)**:
   - Si escribís una contraseña ahí mismo, el usuario queda creado con el estado **`"Al día"`** listo para entrar con esa clave.
   - Si lo dejás vacío, el sistema genera automáticamente una contraseña temporal de primer acceso (`"Pendiente al ingresar"`).
5. Si el empleado atenderá en el salón con su teléfono móvil, podés habilitarle la casilla **Venta Móvil (`/web-pos`)**.
6. Presioná **Crear usuario**.

### Cambiar Clave Directamente (`🔑 Cambiar clave`), Reseteo y Desactivación:
- **Botón `🔑 Cambiar clave` (Recomendado para asignar una contraseña definitiva):** En cada fila del listado de usuarios (o haciendo clic directamente sobre el cartel `"Pendiente al ingresar"`), presioná **`🔑 Cambiar clave`**. Se desplegará ahí mismo un campo para escribir la **nueva contraseña (mín. 8 caracteres)** y el botón **`Guardar clave`**. Al guardarla, se actualiza el hash Argon2id en la base de datos y el estado de la clave pasa inmediatamente de `"Pendiente al ingresar"` a **`"Al día"`**.
- **Botón `Generar temporal`:** Genera una clave aleatoria provisoria y marca al usuario como `"Pendiente al ingresar"` para que el sistema le pida elegir una clave nueva la próxima vez que inicie sesión.
- **Revocación automática de sesiones móviles:** Cada vez que cambiás la clave, reseteás la clave, modificás el rol o desactivás a un empleado, el sistema **revoca automáticamente todas sus sesiones activas en `/web-pos`** para evitar accesos residuales.
- **Los usuarios no se borran y el último Superadmin está protegido:** Para preservar el historial histórico de ventas y compras, un empleado que deja de trabajar se desactiva mediante el botón **Desactivar / Reactivar**. Un usuario inactivo no puede iniciar sesión, y el sistema impide desactivar o degradar al último `superadmin` activo del comercio.
- **Bloqueo ante intentos fallidos:** Tras varios intentos erróneos de contraseña, la cuenta aplica un bloqueo temporal automático.

> [!IMPORTANT]
> **Seguridad de contraseñas:** El sistema procesa las contraseñas utilizando el algoritmo militar **Argon2id**. Las claves jamás se almacenan en texto plano en ninguna base de datos ni archivo del sistema.

---

## 2. Auditoría Inmutable en Base de Datos

Cada acción que altera la información del comercio (una venta, una anulación, un cambio de precio, un retiro de dinero, un ajuste de stock o un inicio de sesión) se escribe de manera obligatoria en una tabla especial de **Auditoría**.

<div align="center">
  <img src="imagenes/09_auditoria_sha256.png" alt="Descripción" style="border: 3px solid #ccc; padding: 5px; background-color: white; max-width: 100%;">
</div>

> Grilla de registros de auditoría mostrando fecha, usuario, acción y hash criptográfico, con el cartel verde de "Cadena íntegra verificada".

### ¿Cómo funciona la cadena de custodia (Hash Encadenado)?
- La tabla de auditoría es **estrictamente de solo agregación (append-only)**: ningún usuario ni administrador puede editar ni borrar un registro.
- Cada registro contiene un **Hash SHA-256** generado matemáticamente a partir del registro anterior:
  $$\text{Hash}_N = \text{SHA-256}(\text{Hash}_{N-1} + \text{Datos del Evento})$$
- Si una persona intentara abrir la base de datos con un programa externo para alterar una venta o borrar un retiro, la cadena matemática se romperá inmediatamente.

### Verificación de Integridad:
1. En la pestaña **Auditoría**, presioná el botón **Verificar integridad de la auditoría**.
2. El sistema recorrerá eslabón por eslabón desde el bloque inicial *GENESIS*.
3. Si no hubo alteraciones, mostrará el mensaje en verde confirmando que la base de datos es 100% legítima e íntegra.
