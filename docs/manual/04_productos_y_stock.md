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

### Para corregir o ajustar el stock:
1. Dirigite a la sección **Ajuste de Stock**.
2. Buscá el producto en la lista.
3. Indicá el tipo de movimiento:
   - **Ajuste Positivo:** Si encontraste mercadería no registrada.
   - **Ajuste Negativo / Merma:** Por vencimiento, rotura o pérdida.
4. Escribí el **Motivo** (ej. *Rotura en depósito* o *Recuento de inventario trimestral*).
5. Hacé clic en **Registrar Movimiento**.

---

## 3. Combos y Promociones

Permite crear paquetes de productos (ej. *Promo Fernet Branca 750ml + 2 Coca-Cola 1.5L*):

<div align="center">
  <img src="imagenes/04_combos_promociones.png" alt="Descripción" style="border: 3px solid #ccc; padding: 5px; background-color: white; max-width: 100%;">
</div>

> Panel de armado de combo con sus componentes, cantidades requeridas y precio especial de venta.

- Cada vez que se vende el combo, el sistema descuenta automáticamente del inventario la cantidad correspondiente de cada uno de sus componentes individuales.
- El stock disponible del combo se calcula de manera inteligente en base al componente que tenga menor existencia en el local.

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
