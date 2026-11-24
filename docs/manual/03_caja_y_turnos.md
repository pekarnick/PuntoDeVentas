# 03 — Gestión de Caja, Turnos y Arqueo

El módulo de Caja permite controlar el flujo de dinero en efectivo de cada turno, registrar extracciones y verificar que la recaudación física coincida con las ventas registradas.

---

## 1. Ubicación en el Menú, Bloqueo de Seguridad y Apertura de Turno

Para que la operación sea rápida e intuitiva, el botón **Caja y Arqueo** se encuentra ubicado en la **segunda posición de la barra superior** (inmediatamente al lado de **Venta (Mostrador)**) y muestra un indicador luminoso en tiempo real:
- **`🟢 Caja y Arqueo`**: El turno está abierto y se pueden cobrar ventas y registrar movimientos.
- **`🔴 Caja y Arqueo (Cerrada)`**: La caja se encuentra cerrada.

> [!IMPORTANT]
> **Protección de Caja Cerrada:** Mientras la caja esté cerrada, el sistema **bloquea automáticamente** el cobro de ventas, el registro de ingresos/egresos manuales y el arqueo de cierre. Si el operador entra a **Venta (Mostrador)** con la caja cerrada, verá en la parte superior un cuadro destacado que le permite ingresar el **Monto inicial en efectivo ($)** y hacer clic en **🟢 Abrir Caja Ahora y Habilitar Ventas** sin siquiera cambiar de pantalla.

<div align="center">
  <img src="imagenes/03_apertura_caja.png" alt="Descripción" style="border: 3px solid #ccc; padding: 5px; background-color: white; max-width: 100%;">
</div>

> Pantalla de caja en estado "Cerrada", con el bloqueo de operaciones manuales y el formulario directo "Monto inicial en efectivo ($)" y botón "Abrir Caja".

### Pasos para abrir la caja:
1. Ingresá a la pestaña **Caja y Arqueo** (o hacelo directamente desde el cartel superior en **Venta (Mostrador)**).
2. Indicá el valor en pesos del cambio inicial (ej. `$ 15.000,00`).
3. Presioná el botón **Abrir Caja**.
4. La sesión queda abierta y habilitada para cobrar ventas y registrar movimientos.

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

> [!NOTE]
> **Titularidad de caja por seguridad:** Un **Cajero** únicamente puede registrar ingresos/egresos manuales y cerrar **su propia sesión de caja**. No puede modificar ni cerrar la caja abierta por otro compañero; esa acción solo la puede realizar el titular del turno, un **Encargado** o el **Superadmin**.
