# 02 — Punto de Venta y Cobro (POS)

El módulo de Punto de Venta es el corazón operativo del comercio, diseñado para despachar ventas a gran velocidad mediante teclado, lector de código de barras o pantalla táctil.

---

## 1. Interfaz General de Venta

<div align="center">
  <img src="imagenes/02_pantalla_pos_general.png" alt="Descripción" style="border: 3px solid #ccc; padding: 5px; background-color: white; max-width: 100%;">
</div>

> La pantalla completa de Venta con el buscador enfocado, un par de productos en el carrito y el resumen de totales a la derecha.

La pantalla está dividida en dos zonas:
- **Zona Izquierda (Catálogo y Carrito):** Entrada rápida del lector, lista de productos cargados a la venta y botones de acceso rápido.
- **Zona Derecha (Panel de Cobro):** Total a cobrar, selección de cliente, medios de pago (efectivo, Mercado Pago, etc.) y botón de confirmación.

---

## 2. Agregar Productos a la Venta

Podés sumar productos al carrito mediante cualquiera de estas tres formas:

### A. Con Lector de Código de Barras (Recomendado)
- El cursor siempre permanece automáticamente listo en el campo de lectura.
- Pasá el artículo por el escáner. Al leer el código, el producto se agrega al carrito al instante.
- Si pasás el mismo artículo varias veces, la cantidad se incrementa automáticamente.

### B. Búsqueda en Vivo por Nombre o Código (`F2` — Productos y Combos)
- Escribí parte del nombre, descripción o código interno en la barra de búsqueda (`F2`).
- El desplegable de sugerencias muestra al instante tanto **productos individuales** como **🎁 Combos y Promociones** (incluso si buscás por el nombre de alguno de los artículos que integran el combo).
- Podés elegir cualquier opción con las flechas `↑`/`↓` + `Enter` o haciendo clic con el mouse.
- Si el código no existe en el sistema, aparecerá una ventana rápida para darlo de alta en el momento sin abandonar la venta (para Superadmin y Encargado).

### C. Botones Rápidos y Combos Fijados
- En la parte inferior izquierda disponés de tarjetas visuales para **productos frecuentes** (ej. Pan Criollo, Bolsa de Hielo) y para todos los **🎁 Combos y Promociones** activos.
- Al tocarlos o hacerles clic, se añaden directamente al pedido.

<div align="center">
  <img src="imagenes/02_botones_rapidos_carrito.png" alt="Descripción" style="border: 3px solid #ccc; padding: 5px; background-color: white; max-width: 100%;">
</div>

> Detalle de los botones rápidos inferiores y los ítems cargados en la tabla del carrito con sus botones `+`, `-` y cesto de basura.

---

## 3. Balanzas Comerciales y Combos Promocionales

El sistema incluye compatibilidad avanzada para comercios de pesables y promociones:
- **Etiquetas de Balanza (EAN-13):** Si pesás fiambre, carne o pan en una balanza electrónica que emite código de barras (prefijo `20` con peso en gramos o prefijo `21` con importe), el sistema lo interpreta automáticamente, calculando el peso exacto y su importe.
- **Combos Promocionales (Búsqueda, Cobro Exacto y Quita en 1 Clic):**
  - Al escanear el código de un combo, buscarlo por nombre en el buscador (`F2`) o tocar su botón rápido, el sistema carga automáticamente sus productos componentes y aplica la bonificación exacta para que el total a cobrar por el combo sea exactamente su **precio promocional de combo**.
  - Arriba de la tabla del carrito aparece la barra **`🎁 Combos aplicados en esta venta`**, donde podés quitar un combo completo en un solo clic con el botón **`✕ Quitar combo`** (descontando sus componentes y revirtiendo su bonificación sin bloquear la pantalla). Si quitás manualmente un producto que formaba parte de un combo, el sistema recalcula automáticamente el descuento.

---

## 4. Selección de Cliente (Buscador Integrado) y Medios de Pago

<div align="center">
  <img src="imagenes/02_panel_cobro_pagos.png" alt="Descripción" style="border: 3px solid #ccc; padding: 5px; background-color: white; max-width: 100%;">
</div>

> Zona derecha de cobro con el buscador de clientes, las opciones de pago (Efectivo, Mercado Pago, Tarjeta, Cuenta Corriente) y el cálculo de vuelto en efectivo.

### Buscador de Clientes en el Cobro (Inicia siempre en "Consumidor Final"):
- Al iniciar cada venta, el selector de cliente arranca siempre por defecto en **`Consumidor Final (Anónimo)`** para cobrar rápido sin pasos extra.
- Si necesitás asignarle la venta a un cliente registrado (para **Cuenta Corriente / Fiado** o para emitir Factura A/B con CUIT/DNI), escribí parte de su nombre, DNI o CUIT en el cuadro **`🔍 Buscar cliente por nombre, DNI o CUIT...`** ubicado justo encima del selector y elegilo de la lista.
- También contás con el botón rápido **`↺ Volver a "Consumidor Final"`** para limpiar la búsqueda en un clic.

### Medios de pago soportados:
1. **Efectivo:** Ingresás el importe recibido con el billete del cliente y la pantalla calcula el vuelto exacto al instante.
2. **Mercado Pago / Transferencia:** Registra el cobro bancario o por billetera virtual.
3. **Tarjeta de Débito / Crédito:** Registra el pago por posnet o terminal bancaria.
4. **Cuenta Corriente ("Fiado"):** Disponible cuando se selecciona un cliente registrado. El sistema verifica que el saldo no supere su límite acordado de crédito.
5. **Pago Mixto / Combinado:** Podés tildar la opción de pago mixto para cobrar una parte en efectivo y el resto por Mercado Pago o tarjeta.

### Descuento Global
- Podés aplicar un descuento en pesos al total de la cuenta (por ejemplo, redondeo a favor del cliente o bonificación especial).

### Confirmar la Venta:
- Hacé clic en **Confirmar y Registrar Venta** o simplemente presioná la tecla rápida **`F4`** en el teclado.

---

## 5. Emisión de Tickets y Facturación ARCA

Una vez confirmada la venta:
- **Ticket Térmico:** Se genera el formato listo para impresora térmica de 80mm o 58mm.
- **Factura Electrónica ARCA (Opcional):** Si tu comercio tiene activada la facturación electrónica, el sistema genera el comprobante (Factura B, C o A según corresponda) con su código de autorización **CAE** y el **código QR oficial AFIP/ARCA** reglamentario.

<div align="center">
  <img src="imagenes/02_ticket_con_qr.png" alt="Descripción" style="border: 3px solid #ccc; padding: 5px; background-color: white; max-width: 100%;">
</div>

> Vista previa del ticket generado en pantalla, mostrando el detalle de productos, totales, medios de pago y el QR oficial.

---

## 6. Anulación de Ventas

Las ventas no se pueden alterar arbitrariamente para garantizar la transparencia contable y el control de inventario:
1. Si un cliente cancela o devuelve una compra, se presiona el botón **Anular Venta**.
2. Por seguridad, se solicita la clave de un **Encargado** o **Superadmin** y un motivo de anulación.
3. El sistema restituye inmediatamente los productos al stock, anula el comprobante y registra la operación en la auditoría inmutable.
