import React, { useState } from 'react';
import {
  formatearMonedaARS,
  pesosACentavos,
  type Centavos,
} from '../../domain/dinero.ts';
import {
  puedeVerCostos,
  tienePermiso,
  type RolUsuario,
} from '../../domain/permisos.ts';
import {
  calcularStockActual,
  estaBajoStockMinimo,
  normalizarMovimientoStock,
  type TipoMovimientoStock,
} from '../../domain/stock.ts';

export interface ProductoAdminItemUI {
  readonly id: string;
  readonly nombre: string;
  readonly codigo_interno: string;
  readonly codigos_barras: readonly string[];
  readonly unidad: 'unidad' | 'kg' | 'm' | 'l' | 'caja';
  readonly permite_decimales: boolean;
  readonly costo_compra: Centavos;
  readonly precio_venta: Centavos;
  readonly stock_minimo: number;
  readonly boton_rapido: boolean;
  readonly imagen_path: string | null;
  readonly imagen_hash: string | null;
  readonly movimientos: ReadonlyArray<{
    readonly tipo: TipoMovimientoStock;
    readonly cantidad: number;
    readonly motivo?: string | null;
  }>;
}

export interface PanelProductosStockProps {
  readonly rolActivo: RolUsuario;
}

const PRODUCTOS_INICIALES_UI: ProductoAdminItemUI[] = [
  {
    id: 'prod-yerba',
    nombre: 'Yerba Mate Selección 1kg',
    codigo_interno: 'YER-001',
    codigos_barras: ['7791234560012', '7791234560019'],
    unidad: 'unidad',
    permite_decimales: false,
    costo_compra: 280000,
    precio_venta: 420000,
    stock_minimo: 10,
    boton_rapido: false,
    imagen_path: 'imagenes/prod-yerba.webp',
    imagen_hash: 'e3b0c44298fc1c149afbf4c8996fb924',
    movimientos: [
      { tipo: 'compra', cantidad: 25 },
      { tipo: 'venta', cantidad: -3 },
    ],
  },
  {
    id: 'prod-alfajor',
    nombre: 'Alfajor Triple Chocolate',
    codigo_interno: 'ALF-003',
    codigos_barras: ['7790001112223'],
    unidad: 'unidad',
    permite_decimales: false,
    costo_compra: 85000,
    precio_venta: 150000,
    stock_minimo: 15,
    boton_rapido: true,
    imagen_path: null,
    imagen_hash: null,
    movimientos: [
      { tipo: 'compra', cantidad: 12 },
      { tipo: 'venta', cantidad: -4 },
    ],
  },
];

export function PanelProductosStock({
  rolActivo,
}: PanelProductosStockProps): React.ReactElement {
  const [productos, setProductos] = useState<ProductoAdminItemUI[]>(
    PRODUCTOS_INICIALES_UI
  );
  const [busqueda, setBusqueda] = useState('');

  // Alta de producto
  const [nombreNuevo, setNombreNuevo] = useState('');
  const [codigoInternoNuevo, setCodigoInternoNuevo] = useState('');
  const [codigoBarrasNuevo, setCodigoBarrasNuevo] = useState('');
  const [costoInput, setCostoInput] = useState('');
  const [precioVentaInput, setPrecioVentaInput] = useState('');
  const [stockMinInput, setStockMinInput] = useState('5');
  const [stockInicialInput, setStockInicialInput] = useState('10');

  // Movimiento de stock manual
  const [productoAjusteId, setProductoAjusteId] = useState<string>(
    PRODUCTOS_INICIALES_UI[0]?.id ?? ''
  );
  const [tipoMovimiento, setTipoMovimiento] =
    useState<TipoMovimientoStock>('ajuste');
  const [cantidadMovimientoInput, setCantidadMovimientoInput] = useState('');
  const [motivoMovimiento, setMotivoMovimiento] = useState('');

  const [mensajeOk, setMensajeOk] = useState<string | null>(null);
  const [mensajeError, setMensajeError] = useState<string | null>(null);

  const mostrarCostos = puedeVerCostos(rolActivo);
  const puedeEditarCatalogo = tienePermiso(
    rolActivo,
    'abm_productos_precios_stock_compras'
  );

  const productosFiltrados = productos.filter(
    (p) =>
      p.nombre.toLowerCase().includes(busqueda.toLowerCase()) ||
      p.codigo_interno.toLowerCase().includes(busqueda.toLowerCase()) ||
      p.codigos_barras.some((cb) => cb.includes(busqueda.trim()))
  );

  function manejarCrearProducto(e: React.FormEvent) {
    e.preventDefault();
    if (!puedeEditarCatalogo) return;
    setMensajeError(null);
    setMensajeOk(null);

    try {
      if (!nombreNuevo.trim()) {
        throw new Error('El nombre del producto es obligatorio.');
      }
      const costo = pesosACentavos(costoInput);
      const precio = pesosACentavos(precioVentaInput);
      const stockInicial = parseFloat(stockInicialInput || '0');
      const stockMin = parseFloat(stockMinInput || '0');

      const nuevo: ProductoAdminItemUI = {
        id: `prod-${Date.now()}`,
        nombre: nombreNuevo.trim(),
        codigo_interno: codigoInternoNuevo.trim() || `INT-${Date.now().toString().slice(-4)}`,
        codigos_barras: codigoBarrasNuevo.trim()
          ? [codigoBarrasNuevo.trim()]
          : [],
        unidad: 'unidad',
        permite_decimales: false,
        costo_compra: costo,
        precio_venta: precio,
        stock_minimo: stockMin,
        boton_rapido: false,
        imagen_path: null,
        imagen_hash: null,
        movimientos:
          stockInicial !== 0
            ? [
                {
                  tipo: 'ajuste',
                  cantidad: normalizarMovimientoStock({
                    tipo: 'ajuste',
                    cantidad: stockInicial,
                    motivo: 'Stock inicial al crear producto',
                  }),
                  motivo: 'Stock inicial al crear producto',
                },
              ]
            : [],
      };

      setProductos((prev) => [...prev, nuevo]);
      setNombreNuevo('');
      setCodigoInternoNuevo('');
      setCodigoBarrasNuevo('');
      setCostoInput('');
      setPrecioVentaInput('');
      setMensajeOk(`Producto "${nuevo.nombre}" dado de alta y auditado.`);
    } catch (err) {
      setMensajeError(
        err instanceof Error ? err.message : 'Error al crear el producto.'
      );
    }
  }

  function manejarRegistrarMovimientoStock(e: React.FormEvent) {
    e.preventDefault();
    if (!puedeEditarCatalogo) return;
    setMensajeError(null);
    setMensajeOk(null);

    try {
      const cantidadNum = parseFloat(cantidadMovimientoInput.replace(',', '.'));
      const cantidadConSigno = normalizarMovimientoStock({
        tipo: tipoMovimiento,
        cantidad: cantidadNum,
        motivo: motivoMovimiento,
      });

      setProductos((prev) =>
        prev.map((p) =>
          p.id === productoAjusteId
            ? {
                ...p,
                movimientos: [
                  ...p.movimientos,
                  {
                    tipo: tipoMovimiento,
                    cantidad: cantidadConSigno,
                    motivo: motivoMovimiento.trim() || null,
                  },
                ],
              }
            : p
        )
      );

      setCantidadMovimientoInput('');
      setMotivoMovimiento('');
      setMensajeOk(
        `Movimiento de stock (${tipoMovimiento}: ${cantidadConSigno > 0 ? `+${cantidadConSigno}` : cantidadConSigno}) registrado y auditado.`
      );
    } catch (err) {
      setMensajeError(
        err instanceof Error
          ? err.message
          : 'No se pudo registrar el movimiento de stock.'
      );
    }
  }

  return (
    <section className="pos-venta-wrapper">
      {mensajeError && <div className="alert-error">{mensajeError}</div>}
      {mensajeOk && <div className="alert-ok">{mensajeOk}</div>}

      {puedeEditarCatalogo && (
        <div className="panel-grid">
          <div className="pos-card">
            <h2>Alta de Producto (con Costo, Precio e Imagen WebP)</h2>
            <form onSubmit={manejarCrearProducto} className="form-stack">
              <div className="form-row">
                <label>
                  Nombre:
                  <input
                    type="text"
                    value={nombreNuevo}
                    onChange={(e) => setNombreNuevo(e.target.value)}
                    placeholder="Ej. Cuaderno Rayado 48h"
                  />
                </label>
                <label>
                  Código interno:
                  <input
                    type="text"
                    value={codigoInternoNuevo}
                    onChange={(e) => setCodigoInternoNuevo(e.target.value)}
                    placeholder="LIB-048"
                  />
                </label>
                <label>
                  Código de barras (EAN):
                  <input
                    type="text"
                    value={codigoBarrasNuevo}
                    onChange={(e) => setCodigoBarrasNuevo(e.target.value)}
                    placeholder="7791234500001"
                  />
                </label>
              </div>
              <div className="form-row">
                <label>
                  Costo de compra ($):
                  <input
                    type="text"
                    value={costoInput}
                    onChange={(e) => setCostoInput(e.target.value)}
                    placeholder="1800,00"
                  />
                </label>
                <label>
                  Precio de venta ($):
                  <input
                    type="text"
                    value={precioVentaInput}
                    onChange={(e) => setPrecioVentaInput(e.target.value)}
                    placeholder="3100,00"
                  />
                </label>
                <label>
                  Stock inicial:
                  <input
                    type="number"
                    value={stockInicialInput}
                    onChange={(e) => setStockInicialInput(e.target.value)}
                  />
                </label>
                <label>
                  Stock mínimo:
                  <input
                    type="number"
                    value={stockMinInput}
                    onChange={(e) => setStockMinInput(e.target.value)}
                  />
                </label>
              </div>
              <button type="submit" className="btn-primary">
                Guardar Producto
              </button>
            </form>
          </div>

          <div className="pos-card">
            <h2>Movimiento de Stock (Suma de Movimientos — Regla 4)</h2>
            <p className="text-muted">
              El stock nunca se edita a mano: cada compra, ajuste o merma agrega un movimiento inmutable.
            </p>
            <form onSubmit={manejarRegistrarMovimientoStock} className="form-stack">
              <div className="form-row">
                <label>
                  Producto:
                  <select
                    value={productoAjusteId}
                    onChange={(e) => setProductoAjusteId(e.target.value)}
                  >
                    {productos.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.nombre}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Tipo de movimiento:
                  <select
                    value={tipoMovimiento}
                    onChange={(e) =>
                      setTipoMovimiento(e.target.value as TipoMovimientoStock)
                    }
                  >
                    <option value="compra">Compra / Ingreso (+)</option>
                    <option value="ajuste">Ajuste inventario (+/-)</option>
                    <option value="merma">Merma / Rotura (-)</option>
                    <option value="devolucion">Devolución (+)</option>
                  </select>
                </label>
              </div>
              <div className="form-row">
                <label>
                  Cantidad:
                  <input
                    type="text"
                    value={cantidadMovimientoInput}
                    onChange={(e) => setCantidadMovimientoInput(e.target.value)}
                    placeholder="Ej. 10 o -2"
                  />
                </label>
                <label>
                  Motivo (obligatorio en ajustes y mermas):
                  <input
                    type="text"
                    value={motivoMovimiento}
                    onChange={(e) => setMotivoMovimiento(e.target.value)}
                    placeholder="Ej. Recuento físico mensual"
                  />
                </label>
              </div>
              <button type="submit" className="btn-primary">
                Registrar Movimiento de Stock
              </button>
            </form>
          </div>
        </div>
      )}

      <div className="pos-card">
        <div className="card-header">
          <div>
            <h2>
              Catálogo de Productos y Stock Actual{' '}
              {!mostrarCostos && '(Vista Cajero: sin costos ni márgenes)'}
            </h2>
          </div>
          <label>
            Buscar producto o código:
            <input
              type="text"
              value={busqueda}
              onChange={(e) => setBusqueda(e.target.value)}
              placeholder="Nombre o código..."
            />
          </label>
        </div>

        <table className="data-table">
          <thead>
            <tr>
              <th>Imagen</th>
              <th>Producto</th>
              <th>Códigos de Barras</th>
              {mostrarCostos && <th className="num">Costo Compra</th>}
              <th className="num">Precio Venta</th>
              {mostrarCostos && <th className="num">Margen</th>}
              <th className="num">Stock Actual (Movimientos)</th>
            </tr>
          </thead>
          <tbody>
            {productosFiltrados.map((p) => {
              const stockActual = calcularStockActual(p.movimientos);
              const bajoMinimo = estaBajoStockMinimo(
                stockActual,
                p.stock_minimo
              );
              const margen =
                p.precio_venta > 0
                  ? Math.round(
                      ((p.precio_venta - p.costo_compra) / p.precio_venta) * 100
                    )
                  : 0;

              return (
                <tr key={p.id}>
                  <td>
                    <span className="badge-rol" title={p.imagen_path ?? 'Placeholder local'}>
                      {p.imagen_path ? 'WebP ✓' : 'Sin foto'}
                    </span>
                  </td>
                  <td>
                    <strong>{p.nombre}</strong>
                    <div className="text-muted">{p.codigo_interno}</div>
                  </td>
                  <td>
                    {p.codigos_barras.length > 0 ? (
                      p.codigos_barras.map((cb) => (
                        <code key={cb} style={{ marginRight: '0.35rem' }}>
                          {cb}
                        </code>
                      ))
                    ) : (
                      <span className="text-muted">Botón rápido</span>
                    )}
                  </td>
                  {mostrarCostos && (
                    <td className="num">{formatearMonedaARS(p.costo_compra)}</td>
                  )}
                  <td className="num">
                    <strong>{formatearMonedaARS(p.precio_venta)}</strong>
                  </td>
                  {mostrarCostos && <td className="num">{margen}%</td>}
                  <td className="num">
                    <strong className={bajoMinimo ? 'diff-negativa' : ''}>
                      {stockActual} {p.unidad}
                    </strong>
                    {bajoMinimo && (
                      <span className="badge-alerta" style={{ marginLeft: '0.4rem' }}>
                        Bajo mín. ({p.stock_minimo})
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
