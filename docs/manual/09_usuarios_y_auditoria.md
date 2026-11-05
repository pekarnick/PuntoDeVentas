# 09 — Usuarios, Permisos y Auditoría Criptográfica

Este módulo está destinado exclusivamente a dueños y administradores del comercio para gestionar el acceso del personal y verificar la transparencia inalterable de las operaciones mediante criptografía.

---

## 1. Gestión de Usuarios y Permisos

<div align="center">
  <img src="imagenes/09_panel_usuarios.png" alt="Descripción" style="border: 3px solid #ccc; padding: 5px; background-color: white; max-width: 100%;">
</div>

> Formulario de alta de usuario con nombre, nombre de usuario, rol asignado, tilde "Puede vender desde celular" y lista de usuarios del comercio.

### Cómo crear un nuevo usuario:
1. Dirigite a la pestaña **Usuarios** (requiere rol *Superadmin*).
2. Ingresá el **Nombre Completo** del empleado y su **Nombre de Usuario** (en minúsculas, sin espacios).
3. Asigná el **Rol**:
   - **Cajero:** Solo cobra y opera la caja de su turno. No ve costos ni informes.
   - **Encargado:** Gestiona catálogo, compras, clientes y ve informes.
   - **Superadmin:** Acceso total a usuarios, auditoría y configuración de sincronización.
4. Si el empleado atenderá en el salón con su teléfono móvil, tildá la casilla **Puede vender desde celular**.
5. Presioná **Crear Usuario**. El sistema generará una contraseña temporal de primer acceso.

### Desactivación y Reseteo de Clave:
- **Los usuarios no se borran:** Para preservar el historial histórico de ventas y compras, un empleado que deja de trabajar se desactiva mediante el interruptor **Activo / Inactivo**. Un usuario inactivo no puede iniciar sesión.
- **Reseteo de contraseña:** Si un cajero olvida su clave, el Superadmin puede presionar **Resetear Clave** para asignarle una nueva clave de acceso inmediato.

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
