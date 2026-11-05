import React, { useEffect, useState } from 'react';
import { PaginadorTabla } from '../../components/PaginadorTabla.tsx';
import { invocarPosApi } from '../../db/cliente_pos_api.ts';
import {
  formatearMonedaARS,
  pesosACentavos,
  type Centavos,
} from '../../domain/dinero.ts';
import type { ReglaRedondeoPrecio } from '../../domain/gestion_fase3.ts';
import {
  paginarListado,
  TAMANIO_PAGINA_POR_DEFECTO,
} from '../../domain/paginacion.ts';
import {
  puedeVerCostos,
  tienePermiso,
  type RolUsuario,
} from '../../domain/permisos.ts';
import {
  estaBajoStockMinimo,
  normalizarMovimientoStock,
  type TipoMovimientoStock,
} from '../../domain/stock.ts';

export interface CategoriaItemUI {
  readonly id: string;
  readonly nombre: string;
}

export interface MarcaItemUI {
  readonly id: string;
  readonly nombre: string;
}

export interface ProveedorBasicoUI {
  readonly id: string;
  readonly razon_social: string;
}

export interface ProductoAdminItemUI {
  readonly id: string;
  readonly nombre: string;
  readonly codigo_interno: string;
  readonly categoria_id?: string | null;
  readonly marca_id?: string | null;
  readonly proveedor_id?: string | null;
  readonly categoria_nombre?: string | null;
  readonly marca_nombre?: string | null;
  readonly proveedor_nombre?: string | null;
  readonly codigos_barras: readonly string[];
  readonly unidad: 'unidad' | 'kg' | 'm' | 'l' | 'caja';
  readonly permite_decimales: boolean;
  readonly costo_compra?: Centavos;
  readonly precio_venta: Centavos;
  readonly stock_minimo: number;
  readonly stock_actual: number;
  readonly boton_rapido: boolean;
  readonly imagen_path: string | null;
  readonly imagen_hash: string | null;
}

export interface PanelProductosStockProps {
  readonly rolActivo: RolUsuario;
  readonly productosIniciales?: readonly ProductoAdminItemUI[];
  readonly categoriasServidor?: readonly CategoriaItemUI[];
  readonly marcasServidor?: readonly MarcaItemUI[];
  readonly proveedoresServidor?: readonly ProveedorBasicoUI[];
  readonly onDatosActualizados?: () => void;
}

const PRODUCTOS_FALLBACK_TESTS: ProductoAdminItemUI[] = [
  {
    id: 'prod-yerba',
    nombre: 'Yerba Mate Selección 1kg',
    codigo_interno: 'YER-001',
    codigos_barras: ['7791234560012', '7791234560019'],
    unidad: 'unidad',
    permite_decimales: false,
    costo_compra: 280000 as Centavos,
    precio_venta: 420000 as Centavos,
    stock_minimo: 10,
    stock_actual: 22,
    boton_rapido: false,
    imagen_path: 'imagenes/prod-yerba.webp',
    imagen_hash: 'e3b0c44298fc1c149afbf4c8996fb924',
  },
  {
    id: 'prod-alfajor',
    nombre: 'Alfajor Triple Chocolate',
    codigo_interno: 'ALF-003',
    codigos_barras: ['7790001112223'],
    unidad: 'unidad',
    permite_decimales: false,
    costo_compra: 85000 as Centavos,
    precio_venta: 150000 as Centavos,
    stock_minimo: 15,
    stock_actual: 8,
    boton_rapido: true,
    imagen_path: null,
    imagen_hash: null,
  },
];

export function PanelProductosStock({
  rolActivo,
  productosIniciales = PRODUCTOS_FALLBACK_TESTS,
  categoriasServidor = [],
  marcasServidor = [],
  proveedoresServidor = [],
  onDatosActualizados,
}: PanelProductosStockProps): React.ReactElement {
  const [productos, setProductos] = useState<ProductoAdminItemUI[]>(() => [
    ...productosIniciales,
  ]);
  const [busqueda, setBusqueda] = useState('');
  const [paginaProductos, setPaginaProductos] = useState(1);

  useEffect(() => {
    setProductos([...productosIniciales]);
    if (productosIniciales.length > 0 && !productoAjusteId) {
      setProductoAjusteId(productosIniciales[0]!.id);
    }
  }, [productosIniciales]);

  // Alta de producto
  const [nombreNuevo, setNombreNuevo] = useState('');
  const [codigoInternoNuevo, setCodigoInternoNuevo] = useState('');
  const [codigoBarrasNuevo, setCodigoBarrasNuevo] = useState('');
  const [categoriaProductoId, setCategoriaProductoId] = useState('');
  const [marcaProductoId, setMarcaProductoId] = useState('');
  const [proveedorProductoId, setProveedorProductoId] = useState('');
  const [costoInput, setCostoInput] = useState('');
  const [precioVentaInput, setPrecioVentaInput] = useState('');
  const [stockMinInput, setStockMinInput] = useState('5');
  const [stockInicialInput, setStockInicialInput] = useState('10');
  const [botonRapidoNuevo, setBotonRapidoNuevo] = useState(false);
  const [imagenNuevaBase64, setImagenNuevaBase64] = useState<string>('');
  const [imagenNuevaNombre, setImagenNuevaNombre] = useState<string>('');

  // Edición en línea de producto (nombre, costo, precio, stock_minimo, boton_rapido)
  const [editandoProductoId, setEditandoProductoId] = useState<string | null>(
    null
  );
  const [editNombre, setEditNombre] = useState('');
  const [editCostoInput, setEditCostoInput] = useState('');
  const [editPrecioInput, setEditPrecioInput] = useState('');
  const [editStockMinInput, setEditStockMinInput] = useState('');
  const [editBotonRapido, setEditBotonRapido] = useState(false);

  // Alta rápida de categoría y marca
  const [nuevaCategoriaNombre, setNuevaCategoriaNombre] = useState('');
  const [nuevaMarcaNombre, setNuevaMarcaNombre] = useState('');

  // Movimiento de stock manual
  const [productoAjusteId, setProductoAjusteId] = useState<string>(
    productosIniciales[0]?.id ?? ''
  );
  const [tipoMovimiento, setTipoMovimiento] =
    useState<TipoMovimientoStock>('compra');
  const [cantidadMovimientoInput, setCantidadMovimientoInput] = useState('');
  const [motivoMovimiento, setMotivoMovimiento] = useState('');

  // Actualización masiva de precios (Fase 3)
  const [porcentajeMasivoInput, setPorcentajeMasivoInput] = useState('15');
  const [reglaRedondeo, setReglaRedondeo] =
    useState<ReglaRedondeoPrecio>('multiplo_10_pesos');
  const [filtroCatMasivo, setFiltroCatMasivo] = useState('');
  const [filtroMarcaMasivo, setFiltroMarcaMasivo] = useState('');
  const [filtroProvMasivo, setFiltroProvMasivo] = useState('');
  const [actualizarCostoMasivo, setActualizarCostoMasivo] = useState(false);

  // Importación CSV (Fase 3)
  const [contenidoCsv, setContenidoCsv] = useState('');
  const [actualizarExistentesCsv, setActualizarExistentesCsv] = useState(true);

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

  const paginacionProductos = paginarListado(
    productosFiltrados,
    paginaProductos,
    TAMANIO_PAGINA_POR_DEFECTO
  );

  async function manejarCrearProducto(e: React.FormEvent) {
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
      const codigoInterno =
        codigoInternoNuevo.trim() || `INT-${Date.now().toString().slice(-4)}`;
      const codigos = codigoBarrasNuevo.trim()
        ? [codigoBarrasNuevo.trim()]
        : [];

      await invocarPosApi('crear_producto', {
        rolActivo,
        nombre: nombreNuevo.trim(),
        codigoInterno,
        categoriaId: categoriaProductoId || null,
        marcaId: marcaProductoId || null,
        proveedorId: proveedorProductoId || null,
        costoCompraCentavos: costo,
        precioVentaCentavos: precio,
        stockMinimo: stockMin,
        stockInicial,
        botonRapido: botonRapidoNuevo,
        codigosBarras: codigos,
        imagenBase64: imagenNuevaBase64 || undefined,
        nombreArchivoImagen: imagenNuevaNombre || undefined,
      });

      setNombreNuevo('');
      setCodigoInternoNuevo('');
      setCodigoBarrasNuevo('');
      setCostoInput('');
      setPrecioVentaInput('');
      setBotonRapidoNuevo(false);
      setImagenNuevaBase64('');
      setImagenNuevaNombre('');
      setMensajeOk(
        `Producto "${nombreNuevo.trim()}" guardado en la base de datos y auditado.`
      );
      onDatosActualizados?.();
    } catch (err) {
      setMensajeError(
        err instanceof Error ? err.message : 'Error al crear el producto.'
      );
    }
  }

  function manejarSeleccionImagenAlta(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) {
      setImagenNuevaBase64('');
      setImagenNuevaNombre('');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        setImagenNuevaBase64(reader.result);
        setImagenNuevaNombre(file.name);
      }
    };
    reader.readAsDataURL(file);
  }

  function iniciarEdicionProducto(p: ProductoAdminItemUI) {
    setEditandoProductoId(p.id);
    setEditNombre(p.nombre);
    const costoPesos = ((p.costo_compra ?? 0) / 100)
      .toFixed(2)
      .replace('.', ',');
    const precioPesos = (p.precio_venta / 100).toFixed(2).replace('.', ',');
    setEditCostoInput(costoPesos);
    setEditPrecioInput(precioPesos);
    setEditStockMinInput(String(p.stock_minimo));
    setEditBotonRapido(p.boton_rapido);
  }

  async function manejarGuardarEdicionProducto(productoId: string) {
    if (!puedeEditarCatalogo) return;
    setMensajeError(null);
    setMensajeOk(null);

    try {
      const stockMinNum = Number(editStockMinInput.replace(',', '.'));
      if (!Number.isFinite(stockMinNum) || stockMinNum < 0) {
        throw new Error('El stock mínimo debe ser un número mayor o igual a 0.');
      }

      const payload: Record<string, unknown> = {
        rolActivo,
        productoId,
        nombre: editNombre.trim(),
        precioVentaCentavos: pesosACentavos(editPrecioInput),
        stockMinimo: stockMinNum,
        botonRapido: editBotonRapido,
        motivo: 'Edición directa desde catálogo',
      };
      if (mostrarCostos && editCostoInput.trim()) {
        payload.costoCompraCentavos = pesosACentavos(editCostoInput);
      }

      await invocarPosApi('actualizar_producto', payload);

      setProductos((prev) =>
        prev.map((item) =>
          item.id === productoId
            ? {
                ...item,
                nombre: editNombre.trim() || item.nombre,
                ...(mostrarCostos && editCostoInput.trim()
                  ? { costo_compra: pesosACentavos(editCostoInput) }
                  : {}),
                precio_venta: pesosACentavos(editPrecioInput),
                stock_minimo: stockMinNum,
                boton_rapido: editBotonRapido,
              }
            : item
        )
      );
      setEditandoProductoId(null);
      setMensajeOk(
        `Producto "${editNombre.trim()}" actualizado (Stock mínimo: ${stockMinNum}).`
      );
      onDatosActualizados?.();
    } catch (err) {
      setMensajeError(
        err instanceof Error ? err.message : 'Error al actualizar el producto.'
      );
    }
  }

  function manejarSubirImagenProductoFila(
    productoId: string,
    productoNombre: string,
    e: React.ChangeEvent<HTMLInputElement>
  ) {
    const file = e.target.files?.[0];
    if (!file || !puedeEditarCatalogo) return;
    setMensajeError(null);
    setMensajeOk(null);

    const reader = new FileReader();
    reader.onload = async () => {
      if (typeof reader.result !== 'string') return;
      try {
        const res = await invocarPosApi<{
          imagenPathRelativo: string;
          imagenHash: string;
          bytesPrincipal: number;
        }>('subir_imagen_producto', {
          rolActivo,
          productoId,
          imagenBase64: reader.result,
          nombreArchivoImagen: file.name,
        });

        setProductos((prev) =>
          prev.map((item) =>
            item.id === productoId
              ? {
                  ...item,
                  imagen_path: res.imagenPathRelativo,
                  imagen_hash: res.imagenHash,
                }
              : item
          )
        );
        setMensajeOk(
          `Imagen de "${productoNombre}" optimizada a WebP (${Math.round(res.bytesPrincipal / 1024)} KB) y encolada para sincronizar.`
        );
        onDatosActualizados?.();
      } catch (err) {
        setMensajeError(
          err instanceof Error
            ? err.message
            : 'No se pudo procesar la imagen del producto.'
        );
      }
    };
    reader.readAsDataURL(file);
  }

  async function manejarCrearCategoriaRapida() {
    if (!nuevaCategoriaNombre.trim()) return;
    setMensajeError(null);
    try {
      await invocarPosApi('crear_categoria', {
        rolActivo,
        nombre: nuevaCategoriaNombre.trim(),
      });
      setNuevaCategoriaNombre('');
      setMensajeOk('Categoría creada correctamente.');
      onDatosActualizados?.();
    } catch (err) {
      setMensajeError(
        err instanceof Error ? err.message : 'Error al crear categoría.'
      );
    }
  }

  async function manejarCrearMarcaRapida() {
    if (!nuevaMarcaNombre.trim()) return;
    setMensajeError(null);
    try {
      await invocarPosApi('crear_marca', {
        rolActivo,
        nombre: nuevaMarcaNombre.trim(),
      });
      setNuevaMarcaNombre('');
      setMensajeOk('Marca creada correctamente.');
      onDatosActualizados?.();
    } catch (err) {
      setMensajeError(
        err instanceof Error ? err.message : 'Error al crear marca.'
      );
    }
  }

  async function manejarRegistrarMovimientoStock(e: React.FormEvent) {
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

      await invocarPosApi('registrar_movimiento_stock', {
        rolActivo,
        productoId: productoAjusteId,
        tipo: tipoMovimiento,
        cantidad: cantidadNum,
        motivo: motivoMovimiento.trim() || undefined,
      });

      setCantidadMovimientoInput('');
      setMotivoMovimiento('');
      setMensajeOk(
        `Movimiento de stock (${tipoMovimiento}: ${cantidadConSigno > 0 ? `+${cantidadConSigno}` : cantidadConSigno}) guardado en la base de datos y auditado.`
      );
      onDatosActualizados?.();
    } catch (err) {
      setMensajeError(
        err instanceof Error
          ? err.message
          : 'No se pudo registrar el movimiento de stock.'
      );
    }
  }

  async function manejarActualizacionMasivaPrecios(e: React.FormEvent) {
    e.preventDefault();
    if (!puedeEditarCatalogo) return;
    setMensajeError(null);
    setMensajeOk(null);

    try {
      const porcentaje = Number(porcentajeMasivoInput.replace(',', '.'));
      if (!Number.isFinite(porcentaje) || porcentaje === 0) {
        throw new Error('Ingresá un porcentaje distinto de cero (ej: 15 o -5).');
      }

      const res = await invocarPosApi<{ productosActualizados: number }>(
        'actualizar_precios_masivo',
        {
          rolActivo,
          porcentaje,
          reglaRedondeo,
          categoriaId: filtroCatMasivo || null,
          marcaId: filtroMarcaMasivo || null,
          proveedorId: filtroProvMasivo || null,
          actualizarCostoCompraTambien: actualizarCostoMasivo,
        }
      );

      setMensajeOk(
        `Actualización masiva aplicada: ${res.productosActualizados} producto(s) actualizados con ${porcentaje}% y redondeo (${reglaRedondeo}).`
      );
      onDatosActualizados?.();
    } catch (err) {
      setMensajeError(
        err instanceof Error
          ? err.message
          : 'Error al aplicar actualización masiva de precios.'
      );
    }
  }

  async function manejarImportarCsv(e: React.FormEvent) {
    e.preventDefault();
    if (!puedeEditarCatalogo) return;
    setMensajeError(null);
    setMensajeOk(null);

    try {
      if (!contenidoCsv.trim()) {
        throw new Error('Pegá el contenido CSV o seleccioná un archivo .csv.');
      }

      const res = await invocarPosApi<{
        creados: number;
        actualizados: number;
        errores: readonly string[];
      }>('importar_productos_csv', {
        rolActivo,
        contenidoCsv,
        actualizarSiExisteCodigo: actualizarExistentesCsv,
      });

      setContenidoCsv('');
      setMensajeOk(
        `Importación CSV completada: ${res.creados} creados, ${res.actualizados} actualizados.` +
          (res.errores.length > 0
            ? ` Advertencias (${res.errores.length}): ${res.errores[0]}`
            : '')
      );
      onDatosActualizados?.();
    } catch (err) {
      setMensajeError(
        err instanceof Error ? err.message : 'Error al importar catálogo CSV.'
      );
    }
  }

  function manejarCargaArchivoCsv(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        setContenidoCsv(reader.result);
      }
    };
    reader.readAsText(file, 'utf-8');
  }

  return (
    <section className="pos-venta-wrapper">
      {mensajeError && <div className="alert-error">{mensajeError}</div>}
      {mensajeOk && <div className="alert-ok">{mensajeOk}</div>}

      {puedeEditarCatalogo && (
        <>
          <div className="panel-grid">
            <div className="pos-card">
              <h2>Alta de Producto</h2>
              <form
                onSubmit={(e) => void manejarCrearProducto(e)}
                className="form-stack"
              >
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
                    Categoría:
                    <select
                      value={categoriaProductoId}
                      onChange={(e) => setCategoriaProductoId(e.target.value)}
                    >
                      <option value="">(Sin categoría)</option>
                      {categoriasServidor.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.nombre}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Marca:
                    <select
                      value={marcaProductoId}
                      onChange={(e) => setMarcaProductoId(e.target.value)}
                    >
                      <option value="">(Sin marca)</option>
                      {marcasServidor.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.nombre}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Proveedor habitual:
                    <select
                      value={proveedorProductoId}
                      onChange={(e) => setProveedorProductoId(e.target.value)}
                    >
                      <option value="">(Sin proveedor)</option>
                      {proveedoresServidor.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.razon_social}
                        </option>
                      ))}
                    </select>
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
                  <label className="checkbox-inline">
                    <input
                      type="checkbox"
                      checked={botonRapidoNuevo}
                      onChange={(e) => setBotonRapidoNuevo(e.target.checked)}
                    />
                    Mostrar como botón rápido en caja
                  </label>
                </div>
                <div className="form-row" style={{ alignItems: 'center' }}>
                  <label>
                    Imagen del producto (JPG, PNG, WebP o HEIC — se convierte a WebP ≤ 150 KB):
                    <input
                      type="file"
                      accept="image/jpeg,image/png,image/webp,image/heic,.heic"
                      onChange={manejarSeleccionImagenAlta}
                    />
                  </label>
                  {imagenNuevaBase64 && (
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.5rem',
                      }}
                    >
                      <img
                        src={imagenNuevaBase64}
                        alt="Previsualización"
                        style={{
                          width: '48px',
                          height: '48px',
                          objectFit: 'cover',
                          borderRadius: '0.4rem',
                          border: '1px solid #cbd5e1',
                        }}
                      />
                      <span className="text-muted" style={{ fontSize: '0.8rem' }}>
                        {imagenNuevaNombre}
                      </span>
                    </div>
                  )}
                </div>
                <button type="submit" className="btn-primary">
                  Guardar Producto
                </button>
              </form>

              <div
                className="form-row"
                style={{
                  marginTop: '0.85rem',
                  paddingTop: '0.75rem',
                  borderTop: '1px solid #e2e8f0',
                }}
              >
                <div style={{ display: 'flex', gap: '0.4rem', flex: 1 }}>
                  <input
                    type="text"
                    value={nuevaCategoriaNombre}
                    onChange={(e) => setNuevaCategoriaNombre(e.target.value)}
                    placeholder="Nueva categoría (ej. Almacén)"
                  />
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => void manejarCrearCategoriaRapida()}
                  >
                    + Categoría
                  </button>
                </div>
                <div style={{ display: 'flex', gap: '0.4rem', flex: 1 }}>
                  <input
                    type="text"
                    value={nuevaMarcaNombre}
                    onChange={(e) => setNuevaMarcaNombre(e.target.value)}
                    placeholder="Nueva marca (ej. Taragüi)"
                  />
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => void manejarCrearMarcaRapida()}
                  >
                    + Marca
                  </button>
                </div>
              </div>
            </div>

            <div className="pos-card">
              <h2>Movimiento de Stock (Suma de Movimientos — Regla 4)</h2>
              <p className="text-muted">
                El stock nunca se edita a mano: cada compra, ajuste o merma
                agrega un movimiento inmutable.
              </p>
              <form
                onSubmit={(e) => void manejarRegistrarMovimientoStock(e)}
                className="form-stack"
              >
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
                      onChange={(e) =>
                        setCantidadMovimientoInput(e.target.value)
                      }
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
                  Registrar Movimiento
                </button>
              </form>
            </div>
          </div>

          <div className="panel-grid">
            {/* Actualización masiva de precios */}
            <div className="pos-card">
              <h2>Actualización Masiva de Precios por % y Redondeo</h2>
              <p className="text-muted">
                Ajustá los precios por inflación o lista de proveedor filtrando
                por categoría, marca o proveedor, con redondeo comercial.
              </p>
              <form
                onSubmit={(e) => void manejarActualizacionMasivaPrecios(e)}
                className="form-stack"
              >
                <div className="form-row">
                  <label>
                    Porcentaje de variación (%):
                    <input
                      type="text"
                      value={porcentajeMasivoInput}
                      onChange={(e) => setPorcentajeMasivoInput(e.target.value)}
                      placeholder="Ej. 15 o -5"
                    />
                  </label>
                  <label>
                    Regla de redondeo:
                    <select
                      value={reglaRedondeo}
                      onChange={(e) =>
                        setReglaRedondeo(e.target.value as ReglaRedondeoPrecio)
                      }
                    >
                      <option value="exacto">Exacto (al centavo)</option>
                      <option value="pesos_enteros">
                        A peso entero ($ 1,00)
                      </option>
                      <option value="multiplo_10_pesos">
                        Múltiplo de $ 10
                      </option>
                      <option value="multiplo_50_pesos">
                        Múltiplo de $ 50
                      </option>
                      <option value="multiplo_100_pesos">
                        Múltiplo de $ 100
                      </option>
                    </select>
                  </label>
                </div>

                <div className="form-row">
                  <label>
                    Filtrar Categoría:
                    <select
                      value={filtroCatMasivo}
                      onChange={(e) => setFiltroCatMasivo(e.target.value)}
                    >
                      <option value="">Todas las categorías</option>
                      {categoriasServidor.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.nombre}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Filtrar Marca:
                    <select
                      value={filtroMarcaMasivo}
                      onChange={(e) => setFiltroMarcaMasivo(e.target.value)}
                    >
                      <option value="">Todas las marcas</option>
                      {marcasServidor.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.nombre}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Filtrar Proveedor:
                    <select
                      value={filtroProvMasivo}
                      onChange={(e) => setFiltroProvMasivo(e.target.value)}
                    >
                      <option value="">Todos los proveedores</option>
                      {proveedoresServidor.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.razon_social}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

                <label className="checkbox-inline">
                  <input
                    type="checkbox"
                    checked={actualizarCostoMasivo}
                    onChange={(e) => setActualizarCostoMasivo(e.target.checked)}
                  />
                  Actualizar también el costo_compra en la misma proporción
                </label>

                <button type="submit" className="btn-primary">
                  Aplicar Actualización Masiva de Precios
                </button>
              </form>
            </div>

            {/* Importación CSV / Excel CSV */}
            <div className="pos-card">
              <h2>Importar Catálogo desde CSV / Planilla</h2>
              <p className="text-muted">
                Columnas soportadas:{' '}
                <code>
                  codigo_interno;nombre;costo_compra;precio_venta;stock_inicial;codigo_barras;categoria;marca
                </code>
              </p>
              <form
                onSubmit={(e) => void manejarImportarCsv(e)}
                className="form-stack"
              >
                <label>
                  Cargar archivo .csv:
                  <input
                    type="file"
                    accept=".csv,text/csv,text/plain"
                    onChange={manejarCargaArchivoCsv}
                  />
                </label>
                <label>
                  Contenido CSV (separado por ; o ,):
                  <textarea
                    rows={4}
                    value={contenidoCsv}
                    onChange={(e) => setContenidoCsv(e.target.value)}
                    placeholder={
                      'codigo_interno;nombre;costo_compra;precio_venta;stock_inicial;codigo_barras;categoria;marca\nFER-101;Destornillador Phillips;3200;5500;15;7790010020034;Herramientas;Bahco'
                    }
                    style={{
                      width: '100%',
                      padding: '0.5rem',
                      borderRadius: '0.5rem',
                      border: '1px solid #cbd5e1',
                      fontFamily: 'monospace',
                      fontSize: '0.82rem',
                    }}
                  />
                </label>
                <label className="checkbox-inline">
                  <input
                    type="checkbox"
                    checked={actualizarExistentesCsv}
                    onChange={(e) =>
                      setActualizarExistentesCsv(e.target.checked)
                    }
                  />
                  Si el codigo_interno ya existe, actualizar su costo y precio
                </label>
                <button type="submit" className="btn-primary">
                  Importar Productos al Catálogo
                </button>
              </form>
            </div>
          </div>
        </>
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
              onChange={(e) => {
                setBusqueda(e.target.value);
                setPaginaProductos(1);
              }}
              placeholder="Nombre o código..."
            />
          </label>
        </div>

        <table className="data-table">
          <thead>
            <tr>
              <th>Imagen</th>
              <th>Producto / Clasificación</th>
              <th>Códigos de Barras</th>
              {mostrarCostos && <th className="num">Costo Compra</th>}
              <th className="num">Precio Venta</th>
              {mostrarCostos && <th className="num">Margen</th>}
              <th className="num">Stock Mínimo</th>
              <th className="num">Stock Actual (Movimientos)</th>
              {puedeEditarCatalogo && <th>Acciones</th>}
            </tr>
          </thead>
          <tbody>
            {paginacionProductos.itemsPagina.map((p) => {
              const stockActual = p.stock_actual;
              const bajoMinimo = estaBajoStockMinimo(
                stockActual,
                p.stock_minimo
              );
              const costoSeguro = (p.costo_compra ?? 0) as Centavos;
              const margen =
                p.precio_venta > 0
                  ? Math.round(
                      ((p.precio_venta - costoSeguro) / p.precio_venta) * 100
                    )
                  : 0;
              const enEdicion = editandoProductoId === p.id;

              return (
                <tr key={p.id}>
                  <td>
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.45rem',
                        flexWrap: 'wrap',
                      }}
                    >
                      {p.imagen_path && (
                        <img
                          src={`/api/pos-imagen/${p.id}_thumb.webp?h=${p.imagen_hash ?? ''}`}
                          alt={p.nombre}
                          style={{
                            width: '38px',
                            height: '38px',
                            objectFit: 'cover',
                            borderRadius: '0.35rem',
                            border: '1px solid #cbd5e1',
                          }}
                          onError={(ev) => {
                            (ev.currentTarget as HTMLImageElement).style.display =
                              'none';
                          }}
                        />
                      )}
                      <span
                        className="badge-rol"
                        title={p.imagen_path ?? 'Placeholder local'}
                      >
                        {p.imagen_path ? 'WebP ✓' : 'Sin foto'}
                      </span>
                      {puedeEditarCatalogo && (
                        <label
                          className="btn-secondary"
                          style={{
                            padding: '0.15rem 0.45rem',
                            fontSize: '0.74rem',
                            cursor: 'pointer',
                            margin: 0,
                          }}
                          title="Adjuntar o reemplazar imagen del producto (JPG, PNG, WebP, HEIC)"
                        >
                          📷 Foto
                          <input
                            type="file"
                            accept="image/jpeg,image/png,image/webp,image/heic,.heic"
                            style={{ display: 'none' }}
                            onChange={(e) =>
                              manejarSubirImagenProductoFila(p.id, p.nombre, e)
                            }
                          />
                        </label>
                      )}
                    </div>
                  </td>
                  <td>
                    {enEdicion ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
                        <input
                          type="text"
                          value={editNombre}
                          onChange={(e) => setEditNombre(e.target.value)}
                          aria-label={`Editar nombre de ${p.nombre}`}
                        />
                        <label className="checkbox-inline" style={{ fontSize: '0.78rem' }}>
                          <input
                            type="checkbox"
                            checked={editBotonRapido}
                            onChange={(e) => setEditBotonRapido(e.target.checked)}
                          />
                          Botón rápido en caja
                        </label>
                      </div>
                    ) : (
                      <>
                        <strong>{p.nombre}</strong>
                        <div className="text-muted">
                          {p.codigo_interno}
                          {p.categoria_nombre ? ` • ${p.categoria_nombre}` : ''}
                          {p.marca_nombre ? ` • ${p.marca_nombre}` : ''}
                        </div>
                      </>
                    )}
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
                    <td className="num">
                      {enEdicion ? (
                        <input
                          type="text"
                          value={editCostoInput}
                          onChange={(e) => setEditCostoInput(e.target.value)}
                          style={{ width: '90px', textAlign: 'right' }}
                          aria-label={`Editar costo de ${p.nombre}`}
                        />
                      ) : (
                        formatearMonedaARS(costoSeguro)
                      )}
                    </td>
                  )}
                  <td className="num">
                    {enEdicion ? (
                      <input
                        type="text"
                        value={editPrecioInput}
                        onChange={(e) => setEditPrecioInput(e.target.value)}
                        style={{ width: '90px', textAlign: 'right' }}
                        aria-label={`Editar precio de ${p.nombre}`}
                      />
                    ) : (
                      <strong>{formatearMonedaARS(p.precio_venta)}</strong>
                    )}
                  </td>
                  {mostrarCostos && <td className="num">{margen}%</td>}
                  <td className="num">
                    {enEdicion ? (
                      <input
                        type="number"
                        min={0}
                        step="any"
                        value={editStockMinInput}
                        onChange={(e) => setEditStockMinInput(e.target.value)}
                        style={{ width: '75px', textAlign: 'right' }}
                        aria-label={`Editar stock mínimo de ${p.nombre}`}
                      />
                    ) : (
                      <span>
                        {p.stock_minimo} {p.unidad}
                      </span>
                    )}
                  </td>
                  <td className="num">
                    <strong className={bajoMinimo ? 'diff-negativa' : ''}>
                      {stockActual} {p.unidad}
                    </strong>
                    {bajoMinimo && (
                      <span
                        className="badge-stock-bajo"
                        style={{ marginLeft: '0.4rem' }}
                      >
                        Bajo mínimo ({p.stock_minimo})
                      </span>
                    )}
                  </td>
                  {puedeEditarCatalogo && (
                    <td>
                      {enEdicion ? (
                        <div style={{ display: 'flex', gap: '0.35rem' }}>
                          <button
                            type="button"
                            className="btn-primary"
                            style={{ padding: '0.2rem 0.55rem', fontSize: '0.78rem' }}
                            onClick={() => void manejarGuardarEdicionProducto(p.id)}
                          >
                            💾 Guardar
                          </button>
                          <button
                            type="button"
                            className="btn-secondary"
                            style={{ padding: '0.2rem 0.55rem', fontSize: '0.78rem' }}
                            onClick={() => setEditandoProductoId(null)}
                          >
                            Cancelar
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          className="btn-secondary"
                          style={{ padding: '0.2rem 0.55rem', fontSize: '0.78rem' }}
                          onClick={() => iniciarEdicionProducto(p)}
                        >
                          ✏️ Editar
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
        <PaginadorTabla
          paginaActual={paginacionProductos.paginaActual}
          totalPaginas={paginacionProductos.totalPaginas}
          totalItems={paginacionProductos.totalItems}
          desdeRegistro={paginacionProductos.desdeRegistro}
          hastaRegistro={paginacionProductos.hastaRegistro}
          tamanioPagina={paginacionProductos.tamanioPagina}
          onCambiarPagina={setPaginaProductos}
          etiquetaItems="productos"
        />
      </div>
    </section>
  );
}
