# 07 — Venta Móvil Web (`/web-pos`)

El módulo de Venta Móvil Web permite a los vendedores o repositores atender clientes directamente desde cualquier teléfono móvil o tablet (Android / iPhone) sin necesidad de instalar aplicaciones desde tiendas ni configurar certificados complejos.

---

## 1. ¿Cómo Funciona la Venta Móvil?

- **PWA Ligera y Directa:** Funciona en el navegador web del celular accediendo a la dirección pública configurada (por ejemplo: `https://tupos.netlify.app/web-pos`).
- **Seguridad en la Nube:** Las ventas generadas en el celular impactan directamente en la nube y se reflejan en la computadora principal del local en tiempo real.
- **Protección Total de Costos (Regla 20):** El celular solo tiene acceso a los precios de venta al público. Los costos de compra y los márgenes de ganancia jamás viajan al teléfono móvil ni se muestran en su pantalla.

---

## 2. Habilitar la Venta Móvil en la Computadora Principal

<div align="center">
  <img src="imagenes/07_qr_venta_movil_pc.png" alt="Descripción" style="border: 3px solid #ccc; padding: 5px; background-color: white; max-width: 100%;">
</div>

> Sección "Venta Móvil Web (/web-pos)" en Configuración, mostrando el código QR generado, los botones "Copiar dirección" e "Imprimir QR" y la lista de sesiones activas.

### Pasos para conectar un teléfono:
1. En la computadora principal, andá a **Configuración** -> sección **Venta Móvil Web (`/web-pos`)**.
2. Verificá que el interruptor esté en **Activado**.
3. El vendedor abre la cámara de su celular y escanea el **Código QR** que aparece en pantalla (o ingresa la dirección web proporcionada).
4. El teléfono abre la aplicación web móvil al instante.

---

## 3. Inicio de Sesión y Permisos del Vendedor

<div align="center">
  <img src="imagenes/07_login_movil.png" alt="Descripción" style="border: 3px solid #ccc; padding: 5px; background-color: white; max-width: 100%;">
</div>

> Pantalla de bienvenida en el celular solicitando usuario y contraseña del vendedor.

- Para que un empleado pueda vender desde su teléfono, un Encargado debe marcar la casilla **"Puede vender desde celular"** en la pestaña de **Usuarios** de la computadora principal.
- El vendedor ingresa su usuario y contraseña personal.
- Cada venta quedará debidamente firmada con el nombre del vendedor que la realizó.

---

## 4. Cobro y Escáner con la Cámara del Celular

<div align="center">
  <img src="imagenes/07_pos_camara_movil.png" alt="Descripción" style="border: 3px solid #ccc; padding: 5px; background-color: white; max-width: 100%;">
</div>

> Vista móvil con el botón de escaneo de cámara activo apuntando a un código de barras y los productos cargados en el carrito táctil.

### Funcionalidades de la pantalla móvil:
- **Cámara Escáner:** Presioná el botón de cámara para utilizar el lente del celular como lector de código de barras físico. También incluye botón de linterna para lugares con poca luz.
- **Buscador de Artículos:** Podés tipear el nombre o código para buscar productos rápidamente.
- **Carrito Táctil:** Modificá cantidades o aplicá descuentos con botones táctiles grandes.
- **Cliente y Cuenta Corriente:** Podés seleccionar clientes registrados y cargar la venta a su cuenta si tienen crédito disponible.
- **Idempotencia Anti-Duplicación:** Si la conexión a internet en el celular es inestable, el sistema genera un identificador único por venta para evitar cobros repetidos.

---

## 5. Envío de Comprobante por WhatsApp

Al confirmar el cobro:

<div align="center">
  <img src="imagenes/07_ticket_whatsapp.png" alt="Descripción" style="border: 3px solid #ccc; padding: 5px; background-color: white; max-width: 100%;">
</div>

> Ticket digital finalizado en el celular con el botón verde "Compartir por WhatsApp" y el resumen de la compra.

1. La pantalla muestra el ticket digital sin costos ni datos internos.
2. Presioná el botón **Compartir por WhatsApp**.
3. El celular abrirá WhatsApp con el mensaje preformateado con el detalle de la compra para enviárselo directamente al número del cliente.

---

## 6. Control de Sesiones y Seguridad Remota

Si un empleado pierde su celular o termina su jornada laboral:
- Desde la computadora principal (en **Configuración** -> **Sesiones Móviles Activas**), podés ver todos los teléfonos conectados.
- Hacé clic en **Revocar Sesión** sobre cualquier dispositivo.
- El teléfono móvil perderá acceso inmediatamente, cerrando la sesión en el acto.
