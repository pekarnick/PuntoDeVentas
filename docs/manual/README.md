# 📖 Manual de Usuario y Guía de Operaciones — Punto de Ventas POS

¡Bienvenido al manual oficial del sistema de **Punto de Ventas (POS) Offline-First**!

Este sistema está diseñado específicamente para comercios de Argentina (kioscos, librerías, ferreterías, almacenes, minimercados), permitiendo operar **100% desconectado de internet** sin frenar la caja, con sincronización automática en la nube (Supabase / Firebase), venta móvil web para celulares y facturación electrónica ARCA.

---

## 🗂️ Índice de Contenidos

El manual está dividido en módulos específicos para facilitar su lectura y edición:

| Módulo | Documento | Descripción |
|---|---|---|
| **01** | [Primeros Pasos y Roles](./01_primeros_pasos_y_login.md) | Inicio de la aplicación, roles de usuario (Superadmin, Encargado, Cajero) y temas claro/oscuro. |
| **02** | [Punto de Venta y Cobro](./02_punto_de_venta.md) | Pantalla principal de caja, lector de barras, combos, balanzas, atajos de teclado (F4), pagos mixtos y tickets. |
| **03** | [Gestión de Caja y Turnos](./03_caja_y_turnos.md) | Apertura de turno con fondo inicial, retiros/ingresos manuales, arqueo y cierre de caja. |
| **04** | [Productos, Stock y Combos](./04_productos_y_stock.md) | Alta y edición de productos, combos, variantes, control de stock por movimientos, actualización masiva e importación CSV. |
| **05** | [Compras y Proveedores](./05_compras_y_proveedores.md) | Gestión de proveedores, carga de facturas de compra e ingreso automático a stock y auditoría. |
| **06** | [Clientes y Cuenta Corriente](./06_clientes_y_cuenta_corriente.md) | Padrón de clientes, validación de CUIT, límites de crédito ("fiado"), cobros a cuenta y recibos. |
| **07** | [Venta Móvil Web PWA](./07_venta_movil_web_pos.md) | Cobro desde celulares por escaneo de QR seguro, catálogo protegido sin costos y envío de tickets por WhatsApp. |
| **08** | [Informes de Gestión y Fiscal](./08_informes_y_fiscal.md) | Rentabilidad bruta, stock valorizado, Libro IVA Ventas y Compras, y exportaciones oficiales a Excel (.xlsx). |
| **09** | [Usuarios y Auditoría Inmutable](./09_usuarios_y_auditoria.md) | Creación de personal, contraseñas seguras y verificación de integridad criptográfica de la base de datos (SHA-256). |
| **10** | [Bases Remotas (Supabase y Firebase)](./10_configuracion_y_bases_remotas.md) | **Guía paso a paso para crear y blindar las bases de datos en la nube**, reglas RLS, Storage y backups automáticos. |

