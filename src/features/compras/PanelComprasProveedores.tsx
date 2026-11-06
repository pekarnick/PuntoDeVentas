import React, { useMemo, useState } from 'react';
import { PaginadorTabla } from '../../components/PaginadorTabla.tsx';
import { invocarPosApi } from '../../db/cliente_pos_api.ts';
import {
  aCentavos,
  formatearFechaAR,
  formatearPesos,
  pesosACentavos,
} from '../../domain/dinero.ts';
import { validarDocumentoArgentino } from '../../domain/cuit.ts';
import {
  paginarListado,
  TAMANIO_PAGINA_POR_DEFECTO,
} from '../../domain/paginacion.ts';
import {
  agruparPedidoReposicionStockBajo,
  generarPdfPedidoReposicion,
  ID_GRUPO_SIN_ASIGNAR,
  type CriterioAgrupacionPedido,
  type GrupoPedidoReposicion,
  type ProductoParaPedidoInput,
} from '../../domain/pedidos_reposicion.ts';
import type { RolUsuario } from '../../domain/permisos.ts';
import type { AlicuotaIva } from '../../domain/totales.ts';
import type {
  CategoriaItemUI,
  MarcaItemUI,
  ProductoAdminItemUI,
} from '../productos/PanelProductosStock.tsx';

export interface ProveedorConSaldoUI {
  readonly id: string;
  readonly razon_social: string;
  readonly cuit: string | null;
  readonly telefono: string | null;
  readonly email: string | null;
  readonly total_cargos_centavos: number;
  readonly total_pagos_centavos: number;
  readonly saldo_pendiente_centavos: number;
}

export interface CompraResumenUI {
  readonly id: string;
  readonly fecha: string;
  readonly proveedor_id: string | null;
  readonly proveedor_nombre: string | null;
  readonly numero_comprobante: string | null;
  readonly total_centavos: number;
  readonly usuario_nombre: string;
  readonly cantidad_items: number;
}

export interface MovimientoCcUI {
  readonly id: string;
  readonly entidad_tipo: 'cliente' | 'proveedor';
  readonly entidad_id: string;
  readonly tipo: 'cargo' | 'pago';
  readonly monto_centavos: number;
  readonly referencia_id: string | null;
  readonly observaciones: string | null;
  readonly fecha: string;
}

interface ItemBorradorCompra {
  readonly productoId: string;
  readonly nombreProducto: string;
  readonly cantidad: number;
  readonly costoUnitarioCentavos: number;
  readonly alicuotaIva: AlicuotaIva;
  readonly actualizarCostoProducto: boolean;
}

export interface PanelComprasProveedoresProps {
  readonly rolActivo: RolUsuario;
  readonly proveedoresServidor?: readonly ProveedorConSaldoUI[];
  readonly comprasRecientesServidor?: readonly CompraResumenUI[];
  readonly catalogoProductos?: readonly ProductoAdminItemUI[];
  readonly categoriasServidor?: readonly CategoriaItemUI[];
  readonly marcasServidor?: readonly MarcaItemUI[];
  readonly onDatosModificados?: () => void | Promise<void>;
}

export function PanelComprasProveedores({
  rolActivo,
  proveedoresServidor = [],
  comprasRecientesServidor = [],
  catalogoProductos = [],
  categoriasServidor = [],
  marcasServidor = [],
  onDatosModificados,
}: PanelComprasProveedoresProps): React.ReactElement {
  const tienePermisoCompras =
    rolActivo === 'superadmin' || rolActivo === 'encargado';

  // Estado Lista Automática de Pedidos por Stock Bajo (Proveedor / Marca / Categoría + PDF)
  const [criterioAgrupacionPedido, setCriterioAgrupacionPedido] =
    useState<CriterioAgrupacionPedido>('proveedor');
  const [filtroGrupoPedidoId, setFiltroGrupoPedidoId] =
    useState<string>('todos');
  const [cantidadesPersonalizadasPedido, setCantidadesPersonalizadasPedido] =
    useState<Record<string, number>>({});
  const [exportandoPdfPedido, setExportandoPdfPedido] = useState(false);

  // Estado ABM Proveedor
  const [razonSocial, setRazonSocial] = useState('');
  const [cuitProveedor, setCuitProveedor] = useState('');
  const [telefonoProveedor, setTelefonoProveedor] = useState('');
  const [emailProveedor, setEmailProveedor] = useState('');

  // Estado Nueva Compra
  const [proveedorCompraId, setProveedorCompraId] = useState<string>('');
  const [numeroComprobante, setNumeroComprobante] = useState('');
  const [productoSeleccionadoId, setProductoSeleccionadoId] = useState<string>(
    catalogoProductos[0]?.id ?? ''
  );
  const [cantidadItemInput, setCantidadItemInput] = useState('1');
  const [costoUnitarioInput, setCostoUnitarioInput] = useState('');
  const [alicuotaItem, setAlicuotaItem] = useState<AlicuotaIva>(21);
  const [actualizarCostoCheck, setActualizarCostoCheck] = useState(true);
  const [itemsCompra, setItemsCompra] = useState<ItemBorradorCompra[]>([]);
  const [cargarEnCuentaCorriente, setCargarEnCuentaCorriente] = useState(true);
  const [montoPagadoActoInput, setMontoPagadoActoInput] = useState('0');

  // Estado Cuenta Corriente Proveedor
  const [proveedorDetalleCcId, setProveedorDetalleCcId] = useState<string>('');
  const [movimientosCc, setMovimientosCc] = useState<readonly MovimientoCcUI[]>(
    []
  );
  const [montoPagoProveedorInput, setMontoPagoProveedorInput] = useState('');
  const [obsPagoProveedor, setObsPagoProveedor] = useState('');

  const [mensajeExito, setMensajeExito] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [paginaCompras, setPaginaCompras] = useState(1);
  const [paginaProveedores, setPaginaProveedores] = useState(1);
  const [paginaMovsProveedor, setPaginaMovsProveedor] = useState(1);

  const paginacionCompras = paginarListado(
    comprasRecientesServidor,
    paginaCompras,
    TAMANIO_PAGINA_POR_DEFECTO
  );
  const paginacionProveedores = paginarListado(
    proveedoresServidor,
    paginaProveedores,
    TAMANIO_PAGINA_POR_DEFECTO
  );
  const paginacionMovsProveedor = paginarListado(
    movimientosCc,
    paginaMovsProveedor,
    TAMANIO_PAGINA_POR_DEFECTO
  );

  const productosNormalizadosParaPedido: readonly ProductoParaPedidoInput[] =
    useMemo(() => {
      return catalogoProductos.map((p) => {
        const provNombre =
          p.proveedor_nombre ??
          proveedoresServidor.find((pr) => pr.id === p.proveedor_id)
            ?.razon_social ??
          null;
        const marcaNombre =
          p.marca_nombre ??
          marcasServidor.find((m) => m.id === p.marca_id)?.nombre ??
          null;
        const catNombre =
          p.categoria_nombre ??
          categoriasServidor.find((c) => c.id === p.categoria_id)?.nombre ??
          null;
        return {
          id: p.id,
          nombre: p.nombre,
          codigo_interno: p.codigo_interno,
          codigos_barras: p.codigos_barras,
          unidad: p.unidad,
          stock_actual: p.stock_actual,
          stock_minimo: p.stock_minimo,
          costo_compra: aCentavos(p.costo_compra ?? 0),
          precio_venta: aCentavos(p.precio_venta),
          proveedor_id: p.proveedor_id ?? null,
          proveedor_nombre: provNombre,
          marca_id: p.marca_id ?? null,
          marca_nombre: marcaNombre,
          categoria_id: p.categoria_id ?? null,
          categoria_nombre: catNombre,
        };
      });
    }, [
      catalogoProductos,
      proveedoresServidor,
      marcasServidor,
      categoriasServidor,
    ]);

  // Resumen sin filtro de grupo para conocer todos los grupos disponibles del criterio activo
  const resumenTodosLosGruposCriterio = useMemo(
    () =>
      agruparPedidoReposicionStockBajo({
        productos: productosNormalizadosParaPedido,
        criterio: criterioAgrupacionPedido,
        filtroGrupoId: null,
        cantidadesPersonalizadasPorProducto: cantidadesPersonalizadasPedido,
      }),
    [
      productosNormalizadosParaPedido,
      criterioAgrupacionPedido,
      cantidadesPersonalizadasPedido,
    ]
  );

  // Resumen filtrado según el grupo seleccionado por el usuario
  const resumenPedidoReposicionActivo = useMemo(
    () =>
      agruparPedidoReposicionStockBajo({
        productos: productosNormalizadosParaPedido,
        criterio: criterioAgrupacionPedido,
        filtroGrupoId:
          filtroGrupoPedidoId === 'todos' ? null : filtroGrupoPedidoId,
        cantidadesPersonalizadasPorProducto: cantidadesPersonalizadasPedido,
      }),
    [
      productosNormalizadosParaPedido,
      criterioAgrupacionPedido,
      filtroGrupoPedidoId,
      cantidadesPersonalizadasPedido,
    ]
  );

  if (!tienePermisoCompras) {
    return (
      <div className="card">
        <h2>Acceso restringido</h2>
        <p className="text-muted">
          Solo el encargado y el superadmin pueden gestionar proveedores,
          compras y costos de reposición (PLAN.md §6.1 y Regla 20).
        </p>
      </div>
    );
  }

  async function manejarCrearProveedor(e: React.FormEvent) {
    e.preventDefault();
    setErrorMsg(null);
    setMensajeExito(null);

    try {
      if (!razonSocial.trim()) {
        throw new Error('La razón social del proveedor es obligatoria.');
      }
      if (cuitProveedor.trim()) {
        const val = validarDocumentoArgentino(cuitProveedor);
        if (!val.valido) {
          throw new Error(val.error ?? 'CUIT inválido.');
        }
      }

      await invocarPosApi('crear_proveedor', {
        rolActivo,
        razonSocial: razonSocial.trim(),
        cuit: cuitProveedor.trim() || null,
        telefono: telefonoProveedor.trim() || null,
        email: emailProveedor.trim() || null,
      });

      setRazonSocial('');
      setCuitProveedor('');
      setTelefonoProveedor('');
      setEmailProveedor('');
      setMensajeExito('Proveedor registrado correctamente.');
      await onDatosModificados?.();
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : 'Error al crear proveedor.'
      );
    }
  }

  function agregarItemBorradorCompra() {
    setErrorMsg(null);
    const idEfectivo = productoSeleccionadoId || catalogoProductos[0]?.id || '';
    const prod = catalogoProductos.find((p) => p.id === idEfectivo);
    if (!prod) {
      setErrorMsg('Seleccioná un producto del catálogo para agregar a la compra.');
      return;
    }

    const cantidad = Number(cantidadItemInput.replace(',', '.'));
    if (!Number.isFinite(cantidad) || cantidad <= 0) {
      setErrorMsg('La cantidad comprada debe ser mayor a cero.');
      return;
    }

    let costoCentavos = 0;
    try {
      costoCentavos = costoUnitarioInput.trim()
        ? pesosACentavos(costoUnitarioInput)
        : (prod.costo_compra ?? 0);
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : 'Costo unitario inválido.'
      );
      return;
    }

    setItemsCompra((prev) => [
      ...prev,
      {
        productoId: prod.id,
        nombreProducto: prod.nombre,
        cantidad,
        costoUnitarioCentavos: costoCentavos,
        alicuotaIva: alicuotaItem,
        actualizarCostoProducto: actualizarCostoCheck,
      },
    ]);
    setCantidadItemInput('1');
    setCostoUnitarioInput('');
  }

  function quitarItemCompra(index: number) {
    setItemsCompra((prev) => prev.filter((_, idx) => idx !== index));
  }

  const totalBorradorCompraCentavos = itemsCompra.reduce(
    (acc, it) => acc + Math.round(it.cantidad * it.costoUnitarioCentavos),
    0
  );

  async function confirmarCompraProveedor(e: React.FormEvent) {
    e.preventDefault();
    setErrorMsg(null);
    setMensajeExito(null);

    try {
      if (itemsCompra.length === 0) {
        throw new Error('Agregá al menos un ítem a la factura de compra.');
      }

      const montoPagadoCentavos = montoPagadoActoInput.trim()
        ? pesosACentavos(montoPagadoActoInput)
        : aCentavos(0);

      await invocarPosApi('registrar_compra_proveedor', {
        rolActivo,
        proveedorId: proveedorCompraId || null,
        numeroComprobante: numeroComprobante.trim() || null,
        items: itemsCompra.map((it) => ({
          productoId: it.productoId,
          cantidad: it.cantidad,
          costoUnitarioCentavos: it.costoUnitarioCentavos,
          alicuotaIva: it.alicuotaIva,
          actualizarCostoProducto: it.actualizarCostoProducto,
        })),
        registrarCargoCuentaCorriente:
          Boolean(proveedorCompraId) && cargarEnCuentaCorriente,
        montoPagadoEnElActoCentavos: montoPagadoCentavos,
      });

      setItemsCompra([]);
      setNumeroComprobante('');
      setMontoPagadoActoInput('0');
      setMensajeExito(
        'Compra registrada: stock incrementado, costos actualizados y auditoría encadenada grabada.'
      );
      await onDatosModificados?.();
      if (proveedorDetalleCcId && proveedorDetalleCcId === proveedorCompraId) {
        await cargarMovimientosProveedor(proveedorDetalleCcId);
      }
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : 'Error al registrar la compra.'
      );
    }
  }

  async function cargarMovimientosProveedor(provId: string) {
    setProveedorDetalleCcId(provId);
    if (!provId) {
      setMovimientosCc([]);
      return;
    }
    try {
      const res = await invocarPosApi<{
        movimientos: readonly MovimientoCcUI[];
      }>('listar_movimientos_cc', {
        rolActivo,
        entidadTipo: 'proveedor',
        entidadId: provId,
      });
      setMovimientosCc(res.movimientos);
    } catch {
      setMovimientosCc([]);
    }
  }

  async function registrarPagoAProveedor(e: React.FormEvent) {
    e.preventDefault();
    setErrorMsg(null);
    setMensajeExito(null);

    try {
      if (!proveedorDetalleCcId) {
        throw new Error('Seleccioná un proveedor para registrar el pago.');
      }
      const montoCentavos = pesosACentavos(montoPagoProveedorInput);
      if (montoCentavos <= 0) {
        throw new Error('El monto del pago debe ser mayor a cero.');
      }

      await invocarPosApi('registrar_movimiento_cc', {
        rolActivo,
        entidadTipo: 'proveedor',
        entidadId: proveedorDetalleCcId,
        tipo: 'pago',
        montoCentavos,
        observaciones:
          obsPagoProveedor.trim() || 'Pago a proveedor en cuenta corriente',
      });

      setMontoPagoProveedorInput('');
      setObsPagoProveedor('');
      setMensajeExito('Pago a proveedor asentado en cuenta corriente.');
      await onDatosModificados?.();
      await cargarMovimientosProveedor(proveedorDetalleCcId);
    } catch (err) {
      setErrorMsg(
        err instanceof Error
          ? err.message
          : 'Error al registrar pago a proveedor.'
      );
    }
  }

  function actualizarCantidadPersonalizadaPedido(
    productoId: string,
    valorTexto: string
  ) {
    const num = Number(valorTexto.replace(',', '.'));
    if (!Number.isFinite(num) || num <= 0) {
      setCantidadesPersonalizadasPedido((prev) => {
        const copia = { ...prev };
        delete copia[productoId];
        return copia;
      });
      return;
    }
    setCantidadesPersonalizadasPedido((prev) => ({
      ...prev,
      [productoId]: num,
    }));
  }

  function cargarGrupoPedidoEnFormularioCompra(grupo: GrupoPedidoReposicion) {
    setErrorMsg(null);
    const nuevosItems: ItemBorradorCompra[] = grupo.items.map((it) => ({
      productoId: it.producto_id,
      nombreProducto: it.nombre,
      cantidad: it.cantidad_a_pedir,
      costoUnitarioCentavos: it.costo_unitario_centavos,
      alicuotaIva: alicuotaItem,
      actualizarCostoProducto: true,
    }));

    setItemsCompra(nuevosItems);
    if (
      grupo.criterio === 'proveedor' &&
      grupo.grupo_id !== ID_GRUPO_SIN_ASIGNAR
    ) {
      setProveedorCompraId(grupo.grupo_id);
    }
    setMensajeExito(
      `Se cargaron ${nuevosItems.length} producto(s) del pedido (${grupo.grupo_nombre}) en el formulario de compra.`
    );
  }

  async function manejarExportarPdfPedido(
    criterio: CriterioAgrupacionPedido,
    filtroGrupoIdEspecifico: string | null,
    etiquetaNombreArchivo?: string
  ) {
    setExportandoPdfPedido(true);
    setErrorMsg(null);
    setMensajeExito(null);

    try {
      let bytesPdf: Uint8Array | null = null;
      let nombreArchivoSugerido = `pedido_${criterio}_${new Date().toISOString().slice(0, 10)}.pdf`;

      try {
        const respuesta = await invocarPosApi<{
          pdfBase64: string;
          nombreArchivoSugerido: string;
          auditoriaId: string;
        }>('exportar_pedido_reposicion_pdf', {
          rolActivo,
          criterio,
          filtroGrupoId: filtroGrupoIdEspecifico,
          cantidadesPersonalizadasPorProducto: cantidadesPersonalizadasPedido,
        });

        const binario = atob(respuesta.pdfBase64);
        const arreglo = new Uint8Array(binario.length);
        for (let i = 0; i < binario.length; i += 1) {
          arreglo[i] = binario.charCodeAt(i);
        }
        bytesPdf = arreglo;
        nombreArchivoSugerido = respuesta.nombreArchivoSugerido;
      } catch {
        // Fallback local offline puro usando las funciones de dominio
        const resumenLocal = agruparPedidoReposicionStockBajo({
          productos: productosNormalizadosParaPedido,
          criterio,
          filtroGrupoId: filtroGrupoIdEspecifico,
          cantidadesPersonalizadasPorProducto: cantidadesPersonalizadasPedido,
        });
        bytesPdf = generarPdfPedidoReposicion({
          resumen: resumenLocal,
        });
        const sufijo = etiquetaNombreArchivo
          ? `_${etiquetaNombreArchivo
              .toLowerCase()
              .replace(/[^a-z0-9]+/gi, '_')
              .replace(/^_+|_+$/g, '')}`
          : '';
        nombreArchivoSugerido = `pedido_${criterio}${sufijo}_${new Date().toISOString().slice(0, 10)}.pdf`;
      }

      if (
        bytesPdf &&
        typeof window !== 'undefined' &&
        typeof URL.createObjectURL === 'function'
      ) {
        const bufferSeguro = new ArrayBuffer(bytesPdf.byteLength);
        new Uint8Array(bufferSeguro).set(bytesPdf);
        const blob = new Blob([bufferSeguro], {
          type: 'application/pdf',
        });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = nombreArchivoSugerido;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }

      setMensajeExito(
        `PDF de pedido generado y descargado (${nombreArchivoSugerido}). Acción registrada en auditoría SHA-256.`
      );
    } catch (err) {
      setErrorMsg(
        err instanceof Error
          ? err.message
          : 'No se pudo generar el PDF del pedido de reposición.'
      );
    } finally {
      setExportandoPdfPedido(false);
    }
  }

  const etiquetaCriterioPlural: Record<CriterioAgrupacionPedido, string> = {
    proveedor: 'Por Proveedor',
    marca: 'Por Marca',
    categoria: 'Por Categoría',
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
      {errorMsg && (
        <div className="alert-error" role="alert">
          {errorMsg}
        </div>
      )}
      {mensajeExito && (
        <div className="alert-success" role="status">
          {mensajeExito}
        </div>
      )}

      {/* Lista Automática de Productos con Stock Bajo para Pedido a Proveedor (Proveedor / Marca / Categoría + PDF) */}
      <section
        className="card"
        aria-label="Lista Automática de Pedidos por Stock Bajo"
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-start',
            flexWrap: 'wrap',
            gap: '0.85rem',
            marginBottom: '0.85rem',
          }}
        >
          <div>
            <h2 style={{ marginBottom: '0.25rem' }}>
              📋 Lista Automática de Productos con Stock Bajo (Pedidos de
              Reposición)
            </h2>
            <p className="text-muted" style={{ margin: 0 }}>
              Detecta automáticamente todos los artículos con{' '}
              <code>stock_actual &lt;= stock_minimo</code> y arma las órdenes de
              pedido agrupadas <strong>por Proveedor</strong>,{' '}
              <strong>por Marca</strong> o <strong>por Categoría</strong> con
              exportación directa a <strong>PDF</strong>.
            </p>
          </div>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn-primary"
              disabled={
                exportandoPdfPedido ||
                resumenPedidoReposicionActivo.total_productos_bajo_stock === 0
              }
              onClick={() =>
                void manejarExportarPdfPedido(
                  criterioAgrupacionPedido,
                  filtroGrupoPedidoId === 'todos' ? null : filtroGrupoPedidoId
                )
              }
            >
              {exportandoPdfPedido
                ? 'Generando PDF...'
                : `📄 Exportar PDF (${etiquetaCriterioPlural[criterioAgrupacionPedido]})`}
            </button>
          </div>
        </div>

        {/* Barra de controles de agrupación y filtrado */}
        <div
          className="subcard-box"
          style={{
            padding: '0.85rem',
            borderRadius: '0.65rem',
            marginBottom: '1rem',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-end',
            flexWrap: 'wrap',
            gap: '0.85rem',
          }}
        >
          <div style={{ display: 'flex', gap: '0.65rem', flexWrap: 'wrap' }}>
            <div>
              <label
                style={{
                  display: 'block',
                  fontSize: '0.82rem',
                  fontWeight: 600,
                  marginBottom: '0.3rem',
                }}
              >
                Armar listas agrupadas por:
              </label>
              <div style={{ display: 'flex', gap: '0.4rem' }}>
                <button
                  type="button"
                  className={
                    criterioAgrupacionPedido === 'proveedor'
                      ? 'btn-primary'
                      : 'btn-secondary'
                  }
                  onClick={() => {
                    setCriterioAgrupacionPedido('proveedor');
                    setFiltroGrupoPedidoId('todos');
                  }}
                >
                  🚚 Por Proveedor
                </button>
                <button
                  type="button"
                  className={
                    criterioAgrupacionPedido === 'marca'
                      ? 'btn-primary'
                      : 'btn-secondary'
                  }
                  onClick={() => {
                    setCriterioAgrupacionPedido('marca');
                    setFiltroGrupoPedidoId('todos');
                  }}
                >
                  🏷️ Por Marca
                </button>
                <button
                  type="button"
                  className={
                    criterioAgrupacionPedido === 'categoria'
                      ? 'btn-primary'
                      : 'btn-secondary'
                  }
                  onClick={() => {
                    setCriterioAgrupacionPedido('categoria');
                    setFiltroGrupoPedidoId('todos');
                  }}
                >
                  📂 Por Categoría
                </button>
              </div>
            </div>

            <div className="form-group" style={{ marginBottom: 0, minWidth: '240px' }}>
              <label htmlFor="select-filtro-grupo-pedido">
                Filtrar{' '}
                {criterioAgrupacionPedido === 'proveedor'
                  ? 'Proveedor'
                  : criterioAgrupacionPedido === 'marca'
                    ? 'Marca'
                    : 'Categoría'}
              </label>
              <select
                id="select-filtro-grupo-pedido"
                value={filtroGrupoPedidoId}
                onChange={(e) => setFiltroGrupoPedidoId(e.target.value)}
              >
                <option value="todos">
                  Todos ({resumenTodosLosGruposCriterio.total_grupos} grupo(s) ·{' '}
                  {resumenTodosLosGruposCriterio.total_productos_bajo_stock}{' '}
                  artículo(s))
                </option>
                {resumenTodosLosGruposCriterio.grupos.map((g) => (
                  <option key={g.grupo_id} value={g.grupo_id}>
                    {g.grupo_nombre} ({g.cantidad_productos} art. ·{' '}
                    {formatearPesos(g.costo_total_estimado_centavos)})
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div
            style={{
              display: 'flex',
              gap: '1rem',
              alignItems: 'center',
              flexWrap: 'wrap',
              fontSize: '0.9rem',
            }}
          >
            <span>
              Artículos en alerta:{' '}
              <strong>
                {resumenPedidoReposicionActivo.total_productos_bajo_stock}
              </strong>
            </span>
            <span>
              Unidades a pedir:{' '}
              <strong>
                {resumenPedidoReposicionActivo.total_unidades_general}
              </strong>
            </span>
            <span>
              Costo estimado total:{' '}
              <strong>
                {formatearPesos(
                  resumenPedidoReposicionActivo.costo_total_general_centavos
                )}
              </strong>
            </span>
          </div>
        </div>

        {resumenPedidoReposicionActivo.grupos.length === 0 ? (
          <p className="text-muted" style={{ margin: 0 }}>
            Todo el catálogo tiene stock por encima del mínimo configurado. No
            hay productos pendientes de reposición en este momento.
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            {resumenPedidoReposicionActivo.grupos.map((grupo) => (
              <div
                key={`${grupo.criterio}-${grupo.grupo_id}`}
                className="subcard-box"
                style={{
                  padding: '0.9rem',
                  borderRadius: '0.65rem',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    flexWrap: 'wrap',
                    gap: '0.65rem',
                    marginBottom: '0.65rem',
                  }}
                >
                  <div>
                    <strong style={{ fontSize: '1rem' }}>
                      {grupo.criterio === 'proveedor'
                        ? '🚚 Proveedor: '
                        : grupo.criterio === 'marca'
                          ? '🏷️ Marca: '
                          : '📂 Categoría: '}
                      {grupo.grupo_nombre}
                    </strong>
                    <span
                      className="text-muted"
                      style={{ marginLeft: '0.65rem', fontSize: '0.85rem' }}
                    >
                      ({grupo.cantidad_productos} producto(s) ·{' '}
                      {grupo.total_unidades_a_pedir} unid. · Subtotal estimado:{' '}
                      <strong>
                        {formatearPesos(grupo.costo_total_estimado_centavos)}
                      </strong>
                      )
                    </span>
                  </div>
                  <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                    <button
                      type="button"
                      className="btn-secondary"
                      onClick={() => cargarGrupoPedidoEnFormularioCompra(grupo)}
                    >
                      🛒 Cargar en formulario de compra
                    </button>
                    <button
                      type="button"
                      className="btn-primary"
                      disabled={exportandoPdfPedido}
                      onClick={() =>
                        void manejarExportarPdfPedido(
                          grupo.criterio,
                          grupo.grupo_id,
                          grupo.grupo_nombre
                        )
                      }
                    >
                      📄 Exportar PDF de este{' '}
                      {grupo.criterio === 'proveedor'
                        ? 'Proveedor'
                        : grupo.criterio === 'marca'
                          ? 'Marca'
                          : 'Categoría'}
                    </button>
                  </div>
                </div>

                <table className="pos-table">
                  <thead>
                    <tr>
                      <th>Código</th>
                      <th>Producto</th>
                      <th>Proveedor / Marca / Categoría</th>
                      <th>Stock Actual</th>
                      <th>Stock Mínimo</th>
                      <th>Cant. a Pedir</th>
                      <th>Costo Unit.</th>
                      <th>Subtotal Est.</th>
                    </tr>
                  </thead>
                  <tbody>
                    {grupo.items.map((item) => (
                      <tr key={item.producto_id}>
                        <td>
                          <code>{item.codigo_mostrar}</code>
                        </td>
                        <td>
                          <strong>{item.nombre}</strong>
                        </td>
                        <td className="text-muted" style={{ fontSize: '0.84rem' }}>
                          {item.proveedor_nombre} · {item.marca_nombre} ·{' '}
                          {item.categoria_nombre}
                        </td>
                        <td>
                          <span className="badge-stock-bajo">
                            {item.stock_actual} {item.unidad}
                          </span>
                        </td>
                        <td>
                          {item.stock_minimo} {item.unidad}
                        </td>
                        <td style={{ maxWidth: '110px' }}>
                          <input
                            type="number"
                            min="1"
                            step="1"
                            aria-label={`Cantidad a pedir ${item.nombre}`}
                            value={
                              cantidadesPersonalizadasPedido[item.producto_id] ??
                              item.cantidad_a_pedir
                            }
                            onChange={(e) =>
                              actualizarCantidadPersonalizadaPedido(
                                item.producto_id,
                                e.target.value
                              )
                            }
                            style={{
                              width: '82px',
                              padding: '0.25rem 0.4rem',
                            }}
                          />
                        </td>
                        <td>
                          {formatearPesos(item.costo_unitario_centavos)}
                        </td>
                        <td>
                          <strong>
                            {formatearPesos(
                              item.subtotal_costo_estimado_centavos
                            )}
                          </strong>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
        )}
      </section>

      <div className="pos-grid">
        {/* Columna izquierda: Registro de Compra + Ingreso de mercadería */}
        <section className="card">
          <h2>Registrar Compra a Proveedor (Ingreso de Stock)</h2>
          <p className="text-muted">
            Cada ítem genera un movimiento de stock{' '}
            <code>tipo = &apos;compra&apos;</code> y actualiza opcionalmente el{' '}
            <code>costo_compra</code> de reposición.
          </p>

          <form onSubmit={confirmarCompraProveedor}>
            <div className="form-row">
              <div className="form-group">
                <label htmlFor="select-proveedor-compra">Proveedor</label>
                <select
                  id="select-proveedor-compra"
                  value={proveedorCompraId}
                  onChange={(e) => setProveedorCompraId(e.target.value)}
                >
                  <option value="">(Compra sin proveedor asignado)</option>
                  {proveedoresServidor.map((prov) => (
                    <option key={prov.id} value={prov.id}>
                      {prov.razon_social}{' '}
                      {prov.cuit ? `(${prov.cuit})` : ''} — Saldo:{' '}
                      {formatearPesos(aCentavos(prov.saldo_pendiente_centavos))}
                    </option>
                  ))}
                </select>
              </div>
              <div className="form-group">
                <label htmlFor="input-comprobante-compra">
                  Nº Factura / Remito
                </label>
                <input
                  id="input-comprobante-compra"
                  type="text"
                  value={numeroComprobante}
                  onChange={(e) => setNumeroComprobante(e.target.value)}
                  placeholder="Ej: FC-A 0001-00045812"
                />
              </div>
            </div>

            <div
              className="subcard-box"
              style={{
                borderRadius: '0.65rem',
                padding: '0.85rem',
                marginBottom: '0.85rem',
              }}
            >
              <strong style={{ display: 'block', marginBottom: '0.55rem' }}>
                Agregar producto al comprobante
              </strong>
              <div className="form-row">
                <div className="form-group">
                  <label htmlFor="select-prod-compra">Producto</label>
                  <select
                    id="select-prod-compra"
                    value={
                      productoSeleccionadoId || catalogoProductos[0]?.id || ''
                    }
                    onChange={(e) => setProductoSeleccionadoId(e.target.value)}
                  >
                    {catalogoProductos.length === 0 && (
                      <option value="">Sin productos cargados</option>
                    )}
                    {catalogoProductos.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.nombre} ({p.codigo_interno || 'S/C'}) — Costo actual:{' '}
                        {formatearPesos(aCentavos(p.costo_compra ?? 0))}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="form-group">
                  <label htmlFor="input-cant-compra">Cantidad</label>
                  <input
                    id="input-cant-compra"
                    type="text"
                    value={cantidadItemInput}
                    onChange={(e) => setCantidadItemInput(e.target.value)}
                  />
                </div>
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label htmlFor="input-costo-compra-item">
                    Costo unitario ($)
                  </label>
                  <input
                    id="input-costo-compra-item"
                    type="text"
                    value={costoUnitarioInput}
                    onChange={(e) => setCostoUnitarioInput(e.target.value)}
                    placeholder="Vacío = usar costo actual"
                  />
                </div>
                <div className="form-group">
                  <label htmlFor="select-iva-compra">Alícuota IVA</label>
                  <select
                    id="select-iva-compra"
                    value={alicuotaItem}
                    onChange={(e) =>
                      setAlicuotaItem(Number(e.target.value) as AlicuotaIva)
                    }
                  >
                    <option value={21}>21%</option>
                    <option value={10.5}>10,5%</option>
                    <option value={27}>27%</option>
                    <option value={0}>0% / Exento</option>
                  </select>
                </div>
              </div>

              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: '0.75rem',
                  flexWrap: 'wrap',
                }}
              >
                <label className="checkbox-inline">
                  <input
                    type="checkbox"
                    checked={actualizarCostoCheck}
                    onChange={(e) => setActualizarCostoCheck(e.target.checked)}
                  />
                  Actualizar costo_compra de ficha del producto
                </label>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={agregarItemBorradorCompra}
                >
                  + Agregar ítem a compra
                </button>
              </div>
            </div>

            {itemsCompra.length > 0 && (
              <div style={{ marginBottom: '0.9rem' }}>
                <table className="pos-table">
                  <thead>
                    <tr>
                      <th>Producto</th>
                      <th>Cant.</th>
                      <th>Costo Unit.</th>
                      <th>IVA</th>
                      <th>Subtotal</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {itemsCompra.map((item, idx) => (
                      <tr key={`${item.productoId}-${idx}`}>
                        <td>{item.nombreProducto}</td>
                        <td>{item.cantidad}</td>
                        <td>{formatearPesos(aCentavos(item.costoUnitarioCentavos))}</td>
                        <td>{item.alicuotaIva}%</td>
                        <td>
                          {formatearPesos(
                            aCentavos(
                              Math.round(
                                item.cantidad * item.costoUnitarioCentavos
                              )
                            )
                          )}
                        </td>
                        <td>
                          <button
                            type="button"
                            className="btn-danger-outline"
                            onClick={() => quitarItemCompra(idx)}
                          >
                            Quitar
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div
                  style={{
                    marginTop: '0.5rem',
                    fontWeight: 700,
                    textAlign: 'right',
                  }}
                >
                  Total Compra:{' '}
                  {formatearPesos(aCentavos(totalBorradorCompraCentavos))}
                </div>
              </div>
            )}

            {proveedorCompraId && (
              <div className="form-row">
                <div className="form-group">
                  <label className="checkbox-inline">
                    <input
                      type="checkbox"
                      checked={cargarEnCuentaCorriente}
                      onChange={(e) =>
                        setCargarEnCuentaCorriente(e.target.checked)
                      }
                    />
                    Asentar deuda en Cuenta Corriente del proveedor
                  </label>
                </div>
                {cargarEnCuentaCorriente && (
                  <div className="form-group">
                    <label htmlFor="input-pagado-acto">
                      Monto abonado en el acto ($)
                    </label>
                    <input
                      id="input-pagado-acto"
                      type="text"
                      value={montoPagadoActoInput}
                      onChange={(e) => setMontoPagadoActoInput(e.target.value)}
                    />
                  </div>
                )}
              </div>
            )}

            <button
              type="submit"
              className="btn-primary btn-block"
              disabled={itemsCompra.length === 0}
            >
              Confirmar Compra e Ingresar Stock
            </button>
          </form>
        </section>

        {/* Columna derecha: Alta de Proveedores + Cuenta Corriente */}
        <section className="card">
          <h2>Nuevo Proveedor</h2>
          <form onSubmit={manejarCrearProveedor}>
            <div className="form-row">
              <div className="form-group">
                <label htmlFor="input-razon-prov">Razón Social / Nombre</label>
                <input
                  id="input-razon-prov"
                  type="text"
                  value={razonSocial}
                  onChange={(e) => setRazonSocial(e.target.value)}
                  placeholder="Ej: Distribuidora Mayorista Sur S.R.L."
                />
              </div>
              <div className="form-group">
                <label htmlFor="input-cuit-prov">CUIT (con Módulo 11)</label>
                <input
                  id="input-cuit-prov"
                  type="text"
                  value={cuitProveedor}
                  onChange={(e) => setCuitProveedor(e.target.value)}
                  placeholder="Ej: 30-71234567-9"
                />
              </div>
            </div>
            <div className="form-row">
              <div className="form-group">
                <label htmlFor="input-tel-prov">Teléfono</label>
                <input
                  id="input-tel-prov"
                  type="text"
                  value={telefonoProveedor}
                  onChange={(e) => setTelefonoProveedor(e.target.value)}
                  placeholder="Ej: 11 4555-9900"
                />
              </div>
              <div className="form-group">
                <label htmlFor="input-email-prov">Email</label>
                <input
                  id="input-email-prov"
                  type="email"
                  value={emailProveedor}
                  onChange={(e) => setEmailProveedor(e.target.value)}
                  placeholder="ventas@proveedor.com.ar"
                />
              </div>
            </div>
            <button type="submit" className="btn-primary">
              Guardar Proveedor
            </button>
          </form>

          <hr style={{ margin: '1.25rem 0', borderColor: '#e2e8f0' }} />

          <h3>Proveedores y Cuenta Corriente</h3>
          <table className="pos-table">
            <thead>
              <tr>
                <th>Razón Social</th>
                <th>CUIT</th>
                <th>Cargos</th>
                <th>Pagos</th>
                <th>Saldo Deudor</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {proveedoresServidor.length === 0 ? (
                <tr>
                  <td colSpan={6} className="text-muted">
                    No hay proveedores registrados todavía.
                  </td>
                </tr>
              ) : (
                paginacionProveedores.itemsPagina.map((prov) => (
                  <tr key={prov.id}>
                    <td>
                      <strong>{prov.razon_social}</strong>
                      {prov.telefono && (
                        <div className="text-muted">{prov.telefono}</div>
                      )}
                    </td>
                    <td>{prov.cuit ?? '—'}</td>
                    <td>{formatearPesos(aCentavos(prov.total_cargos_centavos))}</td>
                    <td>{formatearPesos(aCentavos(prov.total_pagos_centavos))}</td>
                    <td>
                      <strong>
                        {formatearPesos(
                          aCentavos(prov.saldo_pendiente_centavos)
                        )}
                      </strong>
                    </td>
                    <td>
                      <button
                        type="button"
                        className="btn-secondary"
                        onClick={() => {
                          setPaginaMovsProveedor(1);
                          void cargarMovimientosProveedor(prov.id);
                        }}
                      >
                        Ver / Pagar
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
          <PaginadorTabla
            paginaActual={paginacionProveedores.paginaActual}
            totalPaginas={paginacionProveedores.totalPaginas}
            totalItems={paginacionProveedores.totalItems}
            desdeRegistro={paginacionProveedores.desdeRegistro}
            hastaRegistro={paginacionProveedores.hastaRegistro}
            tamanioPagina={paginacionProveedores.tamanioPagina}
            onCambiarPagina={setPaginaProveedores}
            etiquetaItems="proveedores"
          />

          {proveedorDetalleCcId && (
            <div
              className="subcard-box"
              style={{
                marginTop: '1rem',
                padding: '0.85rem',
                borderRadius: '0.65rem',
              }}
            >
              <h4>Registrar Pago a Proveedor Seleccionado</h4>
              <form onSubmit={registrarPagoAProveedor}>
                <div className="form-row">
                  <div className="form-group">
                    <label htmlFor="input-monto-pago-prov">
                      Monto a pagar ($)
                    </label>
                    <input
                      id="input-monto-pago-prov"
                      type="text"
                      value={montoPagoProveedorInput}
                      onChange={(e) =>
                        setMontoPagoProveedorInput(e.target.value)
                      }
                      placeholder="Ej: 25000"
                    />
                  </div>
                  <div className="form-group">
                    <label htmlFor="input-obs-pago-prov">Observaciones</label>
                    <input
                      id="input-obs-pago-prov"
                      type="text"
                      value={obsPagoProveedor}
                      onChange={(e) => setObsPagoProveedor(e.target.value)}
                      placeholder="Ej: Transferencia recibo #402"
                    />
                  </div>
                </div>
                <button type="submit" className="btn-primary">
                  Registrar Pago en Cuenta Corriente
                </button>
              </form>

              {movimientosCc.length > 0 && (
                <>
                  <table className="pos-table" style={{ marginTop: '0.75rem' }}>
                    <thead>
                      <tr>
                        <th>Fecha</th>
                        <th>Tipo</th>
                        <th>Monto</th>
                        <th>Observaciones</th>
                      </tr>
                    </thead>
                    <tbody>
                      {paginacionMovsProveedor.itemsPagina.map((m) => (
                        <tr key={m.id}>
                          <td>{formatearFechaAR(new Date(m.fecha))}</td>
                          <td>
                            <span
                              className={`badge-rol ${
                                m.tipo === 'cargo'
                                  ? 'rol-encargado'
                                  : 'rol-cajero'
                              }`}
                            >
                              {m.tipo.toUpperCase()}
                            </span>
                          </td>
                          <td>{formatearPesos(aCentavos(m.monto_centavos))}</td>
                          <td>{m.observaciones ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <PaginadorTabla
                    paginaActual={paginacionMovsProveedor.paginaActual}
                    totalPaginas={paginacionMovsProveedor.totalPaginas}
                    totalItems={paginacionMovsProveedor.totalItems}
                    desdeRegistro={paginacionMovsProveedor.desdeRegistro}
                    hastaRegistro={paginacionMovsProveedor.hastaRegistro}
                    tamanioPagina={paginacionMovsProveedor.tamanioPagina}
                    onCambiarPagina={setPaginaMovsProveedor}
                    etiquetaItems="movimientos"
                  />
                </>
              )}
            </div>
          )}
        </section>
      </div>

      {/* Historial de compras recientes */}
      <section className="card">
        <h2>Últimas Compras Registradas</h2>
        <table className="pos-table">
          <thead>
            <tr>
              <th>Fecha</th>
              <th>Comprobante</th>
              <th>Proveedor</th>
              <th>Ítems</th>
              <th>Total</th>
              <th>Operador</th>
            </tr>
          </thead>
          <tbody>
            {comprasRecientesServidor.length === 0 ? (
              <tr>
                <td colSpan={6} className="text-muted">
                  Sin compras registradas aún.
                </td>
              </tr>
            ) : (
              paginacionCompras.itemsPagina.map((c) => (
                <tr key={c.id}>
                  <td>{formatearFechaAR(new Date(c.fecha))}</td>
                  <td>{c.numero_comprobante ?? 'S/N'}</td>
                  <td>{c.proveedor_nombre ?? 'Compra directa'}</td>
                  <td>{c.cantidad_items}</td>
                  <td>
                    <strong>{formatearPesos(aCentavos(c.total_centavos))}</strong>
                  </td>
                  <td>{c.usuario_nombre}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
        <PaginadorTabla
          paginaActual={paginacionCompras.paginaActual}
          totalPaginas={paginacionCompras.totalPaginas}
          totalItems={paginacionCompras.totalItems}
          desdeRegistro={paginacionCompras.desdeRegistro}
          hastaRegistro={paginacionCompras.hastaRegistro}
          tamanioPagina={paginacionCompras.tamanioPagina}
          onCambiarPagina={setPaginaCompras}
          etiquetaItems="compras"
        />
      </section>
    </div>
  );
}
