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
2. Verificá que el interruptor esté en **Activado**. (Si deseás publicar la página en internet con **Netlify**, pegá tu token personal de Netlify en el acto; por seguridad ese token vive únicamente en la memoria mientras la ventana está abierta y **jamás se guarda en la base de datos ni en backups**).
3. El vendedor abre la cámara de su celular y escanea el **Código QR** que aparece en pantalla (o ingresa la dirección web HTTPS proporcionada).
4. El teléfono abre la aplicación web móvil al instante.

> [!NOTE]
> El código QR contiene únicamente la dirección web pública de tu comercio; no incluye contraseñas ni claves secretas.

---

## 3. Inicio de Sesión y Permisos del Vendedor

<div align="center">
  <img src="imagenes/07_login_movil.png" alt="Descripción" style="border: 3px solid #ccc; padding: 5px; background-color: white; max-width: 100%;">
</div>

> Pantalla de bienvenida en el celular solicitando usuario y contraseña del vendedor.

- Para que un empleado pueda vender desde su teléfono, un Encargado o Superadmin debe marcar la casilla **"Puede vender desde celular"** en la pestaña de **Usuarios** de la computadora principal, y crearle su acceso en **Supabase Authentication** (ver [Módulo 10 — Bases Remotas Seguras](./10_configuracion_y_bases_remotas.md)).
- El vendedor ingresa con su correo y contraseña en `/web-pos` (autenticación segura directa contra **Supabase Auth**, sin descargar listados de usuarios ni contraseñas al celular).
- Cada venta quedará debidamente firmada con el nombre del vendedor que la realizó.
- Si se cambia la contraseña, el rol o se desactiva al usuario en la PC, **todas sus sesiones móviles se revocan automáticamente**.

---

## 4. Cobro y Escáner con la Cámara del Celular

<div align="center">
  <img src="imagenes/07_pos_camara_movil.png" alt="Descripción" style="border: 3px solid #ccc; padding: 5px; background-color: white; max-width: 100%;">
</div>

> Vista móvil con el botón de escaneo de cámara activo apuntando a un código de barras y los productos cargados en el carrito táctil.

### Funcionalidades de la pantalla móvil:
- **Barra Flotante de Carrito Rápido:** En cuanto agregás el primer artículo o combo al carrito, aparece en la parte superior una barra azul fija con la cantidad de ítems, el importe total acumulado y el botón **"Ir a Cobrar ↓"** que te lleva directamente a la sección de cobro sin necesidad de desplazarte por todo el catálogo.
- **Cámara Escáner:** Presioná el botón de cámara para utilizar el lente del celular como lector de código de barras físico. También incluye botón de linterna para lugares con poca luz.
- **Buscador de Artículos y Combos Promocionales (`🎁 Combos y Promociones`):**
  - El catálogo móvil muestra tanto los **productos individuales** como todos los **🎁 Combos y Promociones** activos (sin exponer jamás ningún costo de compra, Regla 20).
  - Podés escribir en **"Buscar por nombre o código..."** el nombre del combo, su código de barras o el nombre de cualquiera de sus artículos componentes para encontrarlo al instante.
  - Al tocar un combo (o escanear su código en **"+ Código"**), el cajero móvil agrega sus artículos componentes al carrito y aplica automáticamente la bonificación exacta en centavos (`pesosACentavos`) para que el **`TOTAL A COBRAR` sea exactamente el precio promocional del combo**.
  - Dentro de **Carrito Actual**, verás la tarjeta **`🎁 Combos aplicados en esta venta`** con el precio del combo, la bonificación aplicada y el botón **`✕ Quitar combo`**, además del desglose claro de `Subtotal artículos (precio individual)` menos `Bonificación combo / descuento` = `TOTAL A COBRAR`.
- **Carrito Táctil:** Modificá cantidades o aplicá descuentos con botones táctiles grandes.
- **Cliente y Cuenta Corriente:** Podés seleccionar clientes registrados y cargar la venta a su cuenta si tienen crédito disponible.
- **Idempotencia Anti-Duplicación:** Si la conexión a internet en el celular es inestable, el sistema genera un identificador único por venta para evitar cobros repetidos.

---

## 4b. Cómo Instalar el Cajero Móvil como Aplicación en Android

No necesitás subir nada a Google Play Store ni instalar certificados en los celulares:
1. **Opción 1 — Instalación directa como App desde Chrome en Android (Recomendada):**
   - Escaneá el código QR desde la pestaña **Configuración → Venta Móvil Web** con el navegador Chrome del celular Android.
   - Tocá el menú **`⋮`** de Chrome (arriba a la derecha) y elegí **"Instalar aplicación"** o **"Agregar a la pantalla principal"**.
   - Android instala `/web-pos` con su propio ícono en el escritorio del teléfono, abriendo a pantalla completa igual que una app nativa y actualizándose sola.
2. **Opción 2 — Empaquetado como APK nativo (Capacitor / Tauri Mobile):**
   - Si en el futuro deseás distribuir un archivo `.apk` instalable, la carpeta `/web-pos` es 100% compatible para envolverse con Capacitor o Tauri Mobile sin tocar la lógica de negocio.

---

## 5. Ventana Modal Automática de Ticket y Envío por WhatsApp

Al confirmar el cobro:

<div align="center">
  <img src="imagenes/07_ticket_whatsapp.png" alt="Descripción" style="border: 3px solid #ccc; padding: 5px; background-color: white; max-width: 100%;">
</div>

> Ticket digital finalizado en el celular con el botón verde "Compartir por WhatsApp" y el resumen de la compra.

1. El sistema desplaza automáticamente la vista hacia arriba y abre de inmediato una **ventana modal centrada a pantalla completa** con el comprobante digital (sin costos ni datos internos), para que el cajero no tenga que subir manualmente a buscar el ticket.
2. Presioná el botón **Compartir por WhatsApp** para abrir WhatsApp con el mensaje preformateado listo para enviar al cliente, o **Imprimir** si tenés impresora conectada.
3. Al tocar **Nueva venta**, la ventana del comprobante se cierra y el celular queda enfocado arriba listo para atender al siguiente cliente.

---

## 6. Control de Sesiones y Seguridad Remota

Si un empleado pierde su celular o termina su jornada laboral:
- Desde la computadora principal (en **Configuración** -> **Sesiones Móviles Activas**), podés ver todos los teléfonos conectados.
- Hacé clic en **Revocar Sesión** sobre cualquier dispositivo.
- El teléfono móvil perderá acceso inmediatamente, cerrando la sesión en el acto.
