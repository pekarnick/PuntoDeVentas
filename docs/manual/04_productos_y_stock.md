# 04 — Productos, Control de Stock y Combos

Este módulo explica cómo gestionar el inventario del comercio, dar de alta artículos, organizar combos y promociones, ajustar existencias y actualizar precios masivamente.

---

## 1. Alta y Edición de Productos

<div align="center">
  <img src="imagenes/04_alta_producto.png" alt="Descripción" style="border: 3px solid #ccc; padding: 5px; background-color: white; max-width: 100%;">
</div>

> Formulario de carga con campos de nombre, código interno, código de barras, costo de compra, precio de venta, alícuota de IVA, botón rápido y selector de foto.

### Campos principales:
- **Nombre del Producto:** Denominación clara que aparecerá en pantalla y tickets.
- **Código Interno y Código de Barras:** Identificadores únicos. Si el producto tiene código de barras de fábrica, podés pistolearlo directamente sobre este campo.
- **Costo de Compra ($):** Precio al que le compraste el artículo a tu proveedor (solo visible para Encargado y Superadmin).
- **Precio de Venta ($):** Precio final que abona el cliente.
- **Alícuota de IVA:** 21%, 10.5%, 27% o Exento (utilizado para facturación fiscal y Libro IVA).
- **Botón Rápido:** Tildá esta casilla si es un producto muy vendido sin código de barras (ej. medialuna, fotocopia, bolsa) para que figure como tarjeta en la pantalla de cobro.
- **Fotografía del Producto:** Podés asociar una imagen; el sistema la optimiza automáticamente a formato WebP para no ocupar espacio de más.

---

## 2. El Stock se Calcula por Movimientos (Regla de Oro)

En este sistema, **el stock nunca se tipea a mano** para evitar inconsistencias y hurtos no registrados. El stock actual de cualquier producto es siempre el resultado matemático exacto de sus movimientos:

$$\text{Stock Actual} = \sum \text{Entradas (Compras/Ajustes)} - \sum \text{Salidas (Ventas/Mermas)}$$

> 📷 **[IMAGEN 02 - Registro de Ajuste de Stock]**
> *Ruta sugerida:* `docs/manual/imagenes/04_ajuste_stock.png`
> *Qué mostrar en la imagen:* Formulario de movimiento manual de stock seleccionando un producto, el tipo de ajuste (Positivo / Negativo / Merma) y el motivo del cambio.

### Para corregir o ajustar el stock (con buscador rápido de artículos):
1. Dirigite a la sección **Movimiento de Stock (Suma de Movimientos — Regla 4)**.
2. Usá el **buscador en vivo (`🔍 Buscar artículo por nombre, código interno o código de barras...`)** ubicado encima del selector para filtrar y autoseleccionar el producto al instante sin tener que recorrer toda la lista.
3. Indicá el tipo de movimiento:
   - **Ajuste Positivo / Compra / Devolución:** Si ingresó mercadería o encontraste unidades no registradas.
   - **Ajuste Negativo / Merma:** Por vencimiento, rotura o pérdida.
4. Escribí el **Motivo** obligatorio (ej. *Rotura en depósito* o *Recuento de inventario trimestral*).
5. Hacé clic en **Registrar movimiento**.

---

## 3. Combos y Promociones (Buscador de Componentes, Stock Inteligente y Descuento Automático)

Permite crear paquetes de productos (ej. *Promo Fernet Branca 750ml + 2 Coca-Cola 1.5L*):

<div align="center">
  <img src="imagenes/04_combos_promociones.png" alt="Descripción" style="border: 3px solid #ccc; padding: 5px; background-color: white; max-width: 100%;">
</div>

> Panel de armado de combo con buscador de productos componentes, cantidades requeridas y precio especial de venta.

- **Buscador de Componentes integrado:** En la sección **Componentes y cantidades requeridas por cada combo**, contás con un cuadro de búsqueda en vivo (`🔍 Filtrar producto por nombre, código interno o código de barras...`) encima de cada selector de **Producto componente**, facilitando armar combos incluso en catálogos de miles de artículos.
- **Disponibilidad en Escritorio y Cajero Móvil (`/web-pos`):** Una vez creado el combo, aparece inmediatamente tanto en los botones rápidos como en el buscador de **Venta (POS)** de la PC y en el catálogo/buscador del **Cajero Móvil (`/web-pos`)**.
- Cada vez que se vende el combo, el sistema cobra exactamente el **precio promocional del combo** y descuenta automáticamente del inventario la cantidad correspondiente de cada uno de sus componentes individuales.
- El stock disponible del combo se calcula de manera inteligente en base al componente que tenga menor existencia en el local.
- En el panel de armado podés ver en vivo el **Precio normal sumado**, el **Ahorro real para el cliente ($ y %)** y el **Factor limitante de stock** antes de guardar el combo.

---

## 3b. Administración de Sucursales, Ubicación de Stock y Migración entre Locales

Si el comercio cuenta con más de un local de atención o con un depósito separado, el sistema gestiona múltiples sucursales de forma óptima sin romper la regla de stock por movimientos:

1. **Sucursal Principal ("Casa Central") y Selector Rápido:**
   - Todo comercio nace con su sucursal principal (`Casa Central / SUC-01`).
   - En la barra superior del sistema (y dentro de **Productos y Stock**), podés seleccionar en qué **📍 Sucursal** está operando la terminal actual.
2. **Ubicación Exacta de los Productos:**
   - En la tabla principal de productos, debajo del stock total, se muestra el desglose exacto por ubicación (ej. `📍 Casa Central: 18 · Sucursal Norte: 12`).
3. **Migración / Transferencia de Productos entre Sucursales (con Buscador de Productos):**
   - Seleccioná la **Sucursal Origen** (de donde sale la mercadería) y la **Sucursal Destino** (adonde ingresa).
   - En cada fila de **Producto a migrar**, utilizá el **buscador rápido (`🔍 Filtrar producto por nombre, código interno o código de barras...`)** para localizar el artículo en segundos, o presioná **"Cargar todo el stock de origen"** para migrar todo el inventario disponible de un local a otro en un solo paso.
   - Al confirmar la migración con su motivo/remito interno, el sistema registra en una única transacción atómica y auditada la salida en el origen y el ingreso en el destino.

---

## 4. Balanzas Comerciales (Carnicería, Fiambrería, Panadería)

Si utilizás balanzas comerciales emisoras de tickets con código de barras EAN-13:
- **Prefijo 20 (Por Peso):** Los dígitos intermedios identifican el código del producto y los últimos indican los gramos pesados.
- **Prefijo 21 (Por Importe):** Los dígitos intermedios identifican el artículo y los últimos indican el importe total etiquetado por la balanza.
- El sistema detecta el prefijo automáticamente al pasarlo por el escáner y calcula el cobro al instante.

---

## 5. Actualización Masiva de Precios con Redondeo

Cuando los proveedores envían una nueva lista de precios, no necesitás modificar artículo por artículo:

<div align="center">
  <img src="imagenes/04_actualizacion_precios.png" alt="Descripción" style="border: 3px solid #ccc; padding: 5px; background-color: white; max-width: 100%;">
</div>

> Tarjeta de actualización masiva con selector de porcentaje (+15%), criterio de redondeo ($10 / $50 / $100) y botón de aplicación.

1. Ingresá el **porcentaje de aumento o disminución** (ej. `12.5%`).
2. Podés filtrar por proveedor o categoría si solo querés aumentar una marca o rubro.
3. Seleccioná el **criterio de redondeo** deseado:
   - Redondeo a peso entero.
   - Múltiplos de `$ 10,00` o `$ 50,00` (evita tener que dar vueltos difíciles en monedas).
4. Presioná **Aplicar Actualización Masiva**. Todos los productos seleccionados actualizarán su precio de venta inmediatamente.

---

## 6. Importación y Exportación Masiva vía Excel / CSV

Si tenés una planilla previa de mercadería:
- **Descargar Plantilla:** Descargá el archivo modelo `.csv`.
- **Carga Idempotente:** Completá las columnas (código, nombre, costo, precio, stock inicial). Al importar, el sistema detecta los códigos existentes y actualiza sus datos sin duplicar registros.
