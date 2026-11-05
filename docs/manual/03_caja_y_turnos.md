# 03 — Gestión de Caja, Turnos y Arqueo

El módulo de Caja permite controlar el flujo de dinero en efectivo de cada turno, registrar extracciones y verificar que la recaudación física coincida con las ventas registradas.

---

## 1. Apertura de Turno de Caja

Al comenzar el turno o la jornada comercial, el cajero debe declarar el monto inicial disponible en el cajón para dar cambio.

<div align="center">
  <img src="imagenes/03_apertura_caja.png" alt="Descripción" style="border: 3px solid #ccc; padding: 5px; background-color: white; max-width: 100%;">
</div>

> Pantalla de caja en estado "Cerrada", con el campo "Monto inicial en efectivo ($)" y el botón "Abrir Caja".

### Pasos para abrir la caja:
1. Ingresá a la pestaña **Caja**.
2. Indicá el valor en pesos del cambio inicial (ej. `$ 15.000,00`).
3. Presioná el botón **Abrir Caja**.
4. La sesión queda abierta y habilitada para operar en el Punto de Venta.

---

## 2. Movimientos Manuales (Ingresos y Retiros)

Durante el turno pueden surgir movimientos que no provienen de una venta directa al cliente:

<div align="center">
  <img src="imagenes/03_movimientos_manuales.png" alt="Descripción" style="border: 3px solid #ccc; padding: 5px; background-color: white; max-width: 100%;">
</div>

> Formulario de ingreso/egreso con selector de tipo, concepto y monto, junto a la tabla con el historial de movimientos de la sesión.

### Tipos de movimientos:
- **Egreso / Retiro:** Para registrar pagos a proveedores de paso (ej. panadero, repartidor), compra de insumos de limpieza o retiros de seguridad hacia la caja fuerte.
- **Ingreso de cambio:** Cuando se agrega más dinero en billetes chicos o monedas al cajón.

**Cómo registrar un movimiento:**
1. Seleccioná el tipo (*Egreso* o *Ingreso*).
2. Describí el motivo exacto en el campo **Concepto** (ej. *Retiro parcial dueño* o *Pago de flete*).
3. Ingresá el monto y presioná **Registrar Movimiento**.
4. El saldo teórico de efectivo de la caja se actualizará automáticamente.

---

## 3. Resumen en Vivo del Turno

El panel central muestra en tiempo real cómo se compone la recaudación del turno:

| Medio de Cobro | Descripción |
|---|---|
| **Fondo Inicial** | Dinero con el que se abrió la caja. |
| **Ventas en Efectivo** | Total cobrado en billetes por ventas. |
| **Ingresos Manuales** | Entradas adicionales de cambio. |
| **Egresos Manuales** | Retiros y gastos de caja chica. |
| **Total Esperado en Efectivo** | Suma exacta que debe haber físicamente en el cajón. |
| **Mercado Pago / Transferencias** | Total cobrado de forma digital (no suma al cajón físico). |
| **Tarjetas (Débito / Crédito)** | Total cobrado por posnet. |
| **Cuentas Corrientes** | Total despachado a plazo a clientes. |

---

## 4. Arqueo y Cierre de Caja

Al terminar el turno o cerrar el negocio:

<div align="center">
  <img src="imagenes/03_cierre_arqueo.png" alt="Descripción" style="border: 3px solid #ccc; padding: 5px; background-color: white; max-width: 100%;">
</div>

> Panel de arqueo con el campo "Efectivo contado físicamente ($)", el indicador en verde/rojo de diferencia y el botón "Cerrar Caja y Guardar Arqueo".

1. El cajero realiza el recuento físico de todos los billetes y monedas que hay en el cajón.
2. Ingresa esa cifra en el campo **Efectivo contado físicamente ($)**.
3. El sistema calcula inmediatamente la diferencia:
   - **$ 0,00:** Caja perfecta (cuadrada).
   - **Saldo positivo (verde):** Sobrante de dinero.
   - **Saldo negativo (rojo):** Faltante de dinero.
4. Presioná el botón **Cerrar Caja y Guardar Arqueo**.
5. La sesión se cierra de forma definitiva, quedando asentada en el historial y en la auditoría del sistema para supervisión del encargado.
