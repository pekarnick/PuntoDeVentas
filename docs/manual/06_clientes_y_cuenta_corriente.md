# 06 — Clientes y Cuentas Corrientes ("Fiado")

El módulo de Clientes permite administrar los datos de tus compradores habituales, ofrecer venta en cuenta corriente ("fiado"), fijar límites de crédito preventivos y registrar pagos a cuenta con sus respectivos recibos.

---

## 1. Alta y Administración de Clientes

<div align="center">
  <img src="imagenes/06_padron_clientes.png" alt="Descripción" style="border: 3px solid #ccc; padding: 5px; background-color: white; max-width: 100%;">
</div>

> Formulario de registro de cliente con nombre, DNI/CUIT, teléfono, límite de cuenta corriente y tabla con saldos adeudados.

### Datos del cliente:
- **Nombre o Razón Social:** Nombre completo del cliente o empresa.
- **Tipo y Número de Documento (DNI o CUIT):** Verificado automáticamente con algoritmo Módulo 11 para comprobantes fiscales oficiales.
- **Condición Fiscal:** Consumidor Final, Monotributo, Responsable Inscripto o Exento.
- **Límite de Cuenta Corriente ($):** Monto máximo de deuda que permitís que acumule (ej. `$ 50.000,00`). Si se establece en `$ 0,00`, el cliente solo podrá comprar de contado.

---

## 2. Venta en Cuenta Corriente desde el Punto de Venta

Cuando un cliente habitual solicita llevar mercadería a plazo:

<div align="center">
  <img src="imagenes/06_pos_cuenta_corriente.png" alt="Descripción" style="border: 3px solid #ccc; padding: 5px; background-color: white; max-width: 100%;">
</div>

> Selector de cliente en el Punto de Venta mostrando el saldo actual del cliente y la opción "Cuenta Corriente" seleccionada.

1. En el Punto de Venta, seleccioná el cliente en la lista desplegable de clientes.
2. Inmediatamente el sistema muestra su **Saldo Actual** y su **Límite Disponible**.
3. Seleccioná el medio de pago **Cuenta Corriente**.
4. Al presionar **Confirmar Venta (`F4`)**:
   - Si la compra no supera el límite de crédito, se aprueba la venta y el saldo adeudado del cliente se incrementa en el acto.
   - Si supera el límite acordado, el sistema alerta al cajero e impide la operación a menos que se abone una parte al contado o se amplíe el límite.

---

## 3. Cobros a Cuenta y Cancelación de Deuda

Cuando el cliente viene al local a cancelar o abonar parte de su saldo:

<div align="center">
  <img src="imagenes/06_cobro_a_cuenta.png" alt="Descripción" style="border: 3px solid #ccc; padding: 5px; background-color: white; max-width: 100%;">
</div>

> Ventana de cobro de cuenta corriente, importe a abonar, medio de recepción (Efectivo / Transferencia) y botón de emisión de recibo.

1. Ingresá a la pestaña **Clientes**.
2. Buscá al cliente y hacé clic en **Cobrar a Cuenta**.
3. Ingresá el importe que entrega el cliente (ej. `$ 10.000,00`).
4. Seleccioná el medio de recepción (*Efectivo*, *Mercado Pago* o *Transferencia*).
5. Confirmá la operación:
   - El saldo adeudado del cliente se reduce al instante.
   - Si pagó en efectivo, el dinero ingresa automáticamente a la **Caja** del turno activo.
   - Podés imprimir o entregar un recibo firmado como constancia de pago.
