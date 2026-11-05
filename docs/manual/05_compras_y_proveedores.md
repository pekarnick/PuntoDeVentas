# 05 — Compras y Proveedores

El módulo de Compras permite gestionar el padrón de proveedores comerciales, cargar remitos y facturas de adquisición de mercadería, y actualizar automáticamente los costos y el stock disponible.

---

## 1. Padrón de Proveedores

<div align="center">
  <img src="imagenes/05_padron_proveedores.png" alt="Descripción" style="border: 3px solid #ccc; padding: 5px; background-color: white; max-width: 100%;">
</div>

> Formulario de alta de proveedor con Razón Social, CUIT, contacto telefónico y la grilla de proveedores registrados.

### Carga de nuevo proveedor:
1. Dirigite a la pestaña **Compras**.
2. Completá los datos del proveedor:
   - **Razón Social / Nombre Comercial:** (ej. *Distribuidora Central S.A.*).
   - **CUIT:** El sistema valida automáticamente el CUIT utilizando el algoritmo oficial de AFIP (Módulo 11) para evitar números erróneos.
   - **Condición IVA:** Responsable Inscripto, Monotributista, etc.
   - **Contacto:** Teléfono, dirección y correo electrónico para pedidos.
3. Hacé clic en **Guardar Proveedor**.

---

## 2. Carga de Facturas y Remitos de Compra

Cada vez que recibís un pedido de mercadería en el local:

<div align="center">
  <img src="imagenes/05_factura_compra.png" alt="Descripción" style="border: 3px solid #ccc; padding: 5px; background-color: white; max-width: 100%;">
</div>

> Formulario de compra cargando productos recibidos, cantidades, costo unitario y total del comprobante.

### Pasos para asentar una compra:
1. Seleccioná el **Proveedor**.
2. Indicá el **Tipo de Comprobante** (Factura A, B, C o Remito) y el **Número de Comprobante** (ej. `0001-00045231`).
3. Agregá cada producto recibido indicando:
   - **Cantidad recibida.**
   - **Nuevo costo unitario de compra ($):** Si el precio del proveedor subió, el sistema actualizará el costo histórico para calcular la rentabilidad real de las ventas futuras.
4. Presioná **Confirmar Compra**.

---

## 3. Efectos Automáticos del Registro de Compra

Al confirmar la factura de compra, el sistema ejecuta de manera segura:
1. **Ingreso Automático al Stock:** Se genera un movimiento de stock de tipo `compra` por cada ítem, aumentando el stock disponible sin necesidad de intervención manual.
2. **Actualización de Costos:** Se guarda el nuevo costo de reposición del producto.
3. **Libro IVA Compras:** El comprobante queda listo para exportar a la planilla oficial fiscal de tu contador.
4. **Registro en Auditoría:** Queda trazado qué usuario cargó el comprobante y en qué fecha/hora.
