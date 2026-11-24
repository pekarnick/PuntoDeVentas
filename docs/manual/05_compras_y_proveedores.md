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
3. En la sección **Agregar producto al comprobante**, utilizá el **buscador de artículos en vivo (`🔍 Buscar artículo por nombre, código interno o código de barras...`)** para filtrar y autoseleccionar el producto de inmediato, e indicá:
   - **Cantidad recibida.**
   - **Nuevo costo unitario de compra ($):** Si el precio del proveedor subió, el sistema actualizará el costo histórico para calcular la rentabilidad real de las ventas futuras.
4. Presioná **+ Agregar ítem** por cada artículo del remito/factura y finalmente **Confirmar Compra**.

---

## 3. Efectos Automáticos del Registro de Compra

Al confirmar la factura de compra, el sistema ejecuta de manera segura:
1. **Ingreso Automático al Stock:** Se genera un movimiento de stock de tipo `compra` por cada ítem, aumentando el stock disponible sin necesidad de intervención manual.
2. **Actualización de Costos:** Se guarda el nuevo costo de reposición del producto.
3. **Libro IVA Compras:** El comprobante queda listo para exportar a la planilla oficial fiscal de tu contador.
4. **Registro en Auditoría:** Queda trazado qué usuario cargó el comprobante y en qué fecha/hora.

---

## 4. Lista Automática de Productos con Stock Bajo y Pedidos en Excel (.xlsx) y PDF (por Proveedor, Marca y Categoría)

En la pestaña **Compras y Proveedores**, el sistema analiza en tiempo real todos los artículos cuyo stock actual es menor o igual a su `stock_minimo` y arma automáticamente la **Lista de Pedido de Reposición** (paginada de a **10 registros por página** para una lectura ágil):

1. **Tres modos de agrupación instantánea:**
   - **Por Proveedor:** Ideal para generar la orden de compra exacta que se le enviará a cada distribuidor.
   - **Por Marca:** Agrupa los faltantes según el fabricante o línea comercial.
   - **Por Categoría:** Agrupa los productos bajo mínimo según el rubro del comercio (ej. *Bebidas*, *Almacén*, *Ferretería*).
2. **Ajuste de cantidades sugeridas:** El sistema sugiere automáticamente la cantidad necesaria para recuperar el nivel óptimo de stock, permitiendo modificar manualmente la cantidad a pedir de cualquier ítem en la grilla.
3. **Exportación automática a Excel (.xlsx) y PDF (eligiendo Proveedores, Categorías o Marcas):**
   - **Selector "Exportar de:":** Permite elegir directamente si deseás exportar el listado agrupado de **Proveedores**, de **Categorías** o de **Marcas**.
   - **Exportar Excel (.xlsx):** Genera un libro Excel multipágina con una hoja detallada (*Pedido por Proveedor/Categoría/Marca*), una hoja de totales (*Resumen Proveedores/Categorías/Marcas*) y hojas individuales por grupo, dejando constancia en la auditoría SHA-256.
   - **Exportar PDF Completo:** Genera y descarga un documento PDF listo para imprimir o enviar por WhatsApp/correo con todos los grupos.
   - **Exportar Excel o PDF de un grupo individual:** Cada tarjeta de Proveedor, Marca o Categoría cuenta con sus propios botones **📊 Exportar Excel de este...** y **📄 Exportar PDF de este...** para emitir únicamente el pedido de ese proveedor, marca o categoría.
4. **Carga en 1 clic a Factura de Compra:** Cuando el proveedor entrega el pedido, presioná **🛒 Cargar en formulario de compra** en el grupo correspondiente para volcar todos los artículos y sus costos directamente en el formulario de registro de compra.
