# 📖 Manual de Usuario y Guía de Operaciones — Punto de Ventas POS

¡Bienvenido al manual oficial del sistema de **Punto de Ventas (POS) Offline-First**!

Este sistema está diseñado específicamente para comercios de Argentina (kioscos, librerías, ferreterías, almacenes, minimercados), permitiendo operar **100% desconectado de internet** en tu computadora Windows (mediante el instalador empaquetado **Tauri**) sin frenar nunca la caja. Además, de manera opcional, incluye sincronización en la nube (Supabase / Firebase), venta móvil web para celulares (`/web-pos`) y facturación electrónica ARCA.

> [!TIP]
> **Manual integrado dentro del programa:** Recordá que todas estas guías, junto con los scripts SQL listos para copiar en 1 clic, también están disponibles directamente dentro de la aplicación en la pestaña **`📖 Ayuda y Manual`**.

---

## 🗂️ Índice de Contenidos

El manual está dividido en módulos específicos para facilitar su lectura y consulta:

| Módulo | Documento | Descripción |
|---|---|---|
| **01** | [Primeros Pasos, Login y Actualizaciones](./01_primeros_pasos_y_login.md) | **Instalación en Windows sin conocimientos técnicos**, **Asistente de Primer Uso** (creación segura del dueño sin claves de fábrica), **pantalla de inicio de sesión (`🔐 Iniciar Sesión`)**, selector de prueba de rol (exclusivo Superadmin) y **cómo actualizar desde GitHub Releases sin perder datos**. |
| **02** | [Punto de Venta y Cobro](./02_punto_de_venta.md) | Pantalla principal de caja, lector de barras, **búsqueda en vivo de productos y combos (`F2`)**, quita rápida de combos (`✕ Quitar combo`), **buscador de clientes en el cobro** (iniciando en *Consumidor Final*), balanzas, atajos (`F4`), pagos mixtos y tickets. |
| **03** | [Gestión de Caja y Turnos](./03_caja_y_turnos.md) | Indicador vivo en menú (`🟢 Abierta` / `🔴 Cerrada`), bloqueo de operaciones con caja cerrada, apertura rápida, **titularidad de caja por operador**, retiros/ingresos manuales y arqueo. |
| **04** | [Productos, Sucursales, Stock y Combos](./04_productos_y_stock.md) | Alta y edición de productos, **buscadores rápidos en movimientos de stock, transferencia entre sucursales y componentes de combos**, armado de combos con stock inteligente, actualización masiva e importación CSV. |
| **05** | [Compras, Proveedores y Pedidos PDF](./05_compras_y_proveedores.md) | Gestión de proveedores, **buscador de artículos al registrar facturas de compra**, listas automáticas de productos con stock bajo exportables a Excel y PDF (por proveedor, marca y categoría). |
| **06** | [Clientes y Cuenta Corriente](./06_clientes_y_cuenta_corriente.md) | **Buscador instantáneo en el Padrón de Clientes y Cuentas Corrientes**, validación de CUIT, **reglas de límite de crédito (`$ 0,00` = solo contado, control de sobrepagos y permisos)**, cobros a cuenta y recibos. |
| **07** | [Venta Móvil Web PWA y Android](./07_venta_movil_web_pos.md) | Cobro desde celulares por QR seguro, **autenticación segura en la nube**, **catálogo y buscador de productos y combos promocionales**, barra rápida de carrito, **instalación como App en Android**, ventana modal automática de comprobante y envío por WhatsApp. |
| **08** | [Informes de Gestión y Fiscal](./08_informes_y_fiscal.md) | Tablero en tiempo real filtrable por sucursal, ganancia bruta histórica, **control de operaciones de todos los vendedores/cajeros**, stock valorizado, Libro IVA Ventas y Compras, y exportaciones `.xlsx`. |
| **09** | [Usuarios y Auditoría Inmutable](./09_usuarios_y_auditoria.md) | Creación de personal con clave inicial, **botón `🔑 Cambiar clave` directo en el listado (estado `"Al día"`)**, **revocación automática de sesiones móviles** y verificación de integridad criptográfica (SHA-256). |
| **10** | [Bases Remotas Opcionales (Supabase y Firebase)](./10_configuracion_y_bases_remotas.md) | Uso 100% local en PC vs. nube opcional, **guía paso a paso para dejar Supabase y Firebase 100% seguros** (script SQL `001 a 005`, usuarios de acceso en la nube, reglas RLS/Firestore/Storage) y backups verificados. |


