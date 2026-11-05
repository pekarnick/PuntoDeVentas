# 08 — Informes de Gestión, Rentabilidad y Fiscal

El módulo de Informes proporciona al dueño del negocio y al encargado una visión clara de la salud financiera del comercio, la ganancia real obtenida y los reportes fiscales listos para enviar al contador.

---

## 1. Informes de Gestión en Tiempo Real

<div align="center">
  <img src="imagenes/08_tablero_informes.png" alt="Descripción" style="border: 3px solid #ccc; padding: 5px; background-color: white; max-width: 100%;">
</div>

> Tablero superior de métricas con Total Facturado, Ganancia Bruta Real, Margen Porcentual, Ticket Promedio y selector de fechas.

### Métricas clave del panel:
- **Total de Ventas ($):** Ingreso bruto total del período seleccionado.
- **Ganancia Bruta ($):** Calculada de manera exacta utilizando el **costo histórico** guardado al momento de cada venta. Esto garantiza que si un producto aumentó de costo hoy, no altere la ganancia calculada de las ventas del mes pasado.
- **Margen de Rentabilidad (%):** Porcentaje de ganancia sobre el costo.
- **Cantidad de Operaciones y Ticket Promedio:** Cantidad de clientes atendidos y promedio de gasto por ticket.

---

## 2. Desglose de Medios de Pago y Top Productos

<div align="center">
  <img src="imagenes/08_graficos_desglose_pagos.png" alt="Descripción" style="border: 3px solid #ccc; padding: 5px; background-color: white; max-width: 100%;">
</div>

> Grilla de recaudación dividida por Efectivo, Mercado Pago y Tarjetas, junto al ranking de los productos más vendidos.

- **Distribución de Cobranza:** Permite conciliar lo que ingresó físicamente por caja contra las acreditaciones de Mercado Pago y terminales bancarias de tarjeta.
- **Ranking de Productos Más Vendidos:** Identifica cuáles son tus productos estrella en cantidad de unidades despachadas y en volumen de facturación.

---

## 3. Stock Valorizado

El sistema calcula el valor total de tu inventario en un instante:
- **Valor al Costo de Reposición:** Cuánto dinero tenés invertido en mercadería parada en depósito y estanterías.
- **Valor al Precio de Venta:** Cuánto dinero recaudarás cuando se venda la totalidad del stock actual.
- **Ganancia Proyectada:** Diferencia esperada entre la venta total y el costo.

---

## 4. Libro IVA Ventas y Libro IVA Compras (Excel Oficial)

Para facilitar la liquidación mensual de impuestos sin errores:

<div align="center">
  <img src="imagenes/08_libro_iva_excel.png" alt="Descripción" style="border: 3px solid #ccc; padding: 5px; background-color: white; max-width: 100%;">
</div>

> Sección de Libro IVA con selector de mes/año y botones de descarga de archivo Excel (.xlsx).

### Funcionalidades fiscales:
1. Seleccioná el período fiscal (mes y año).
2. El sistema clasifica automáticamente los comprobantes por tipo (Factura A, B, C, Tickets, Notas de Crédito).
3. Discrimina con exactitud el Neto Gravado, el Débito Fiscal al 21%, al 10.5%, al 27% y los importes exentos.
4. Presioná **Exportar Libro IVA (.xlsx)** para descargar la planilla en formato compatible con los sistemas contables más usados de Argentina (Holistor, Bejerman, AFIP Libro de IVA Digital).
