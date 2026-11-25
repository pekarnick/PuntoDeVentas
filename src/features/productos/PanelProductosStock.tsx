import React, { useEffect, useMemo, useState } from 'react';
import { PaginadorTabla } from '../../components/PaginadorTabla.tsx';
import {
  construirUrlImagenProducto,
  invocarPosApi,
} from '../../db/cliente_pos_api.ts';
import { calcularPrecioYStockCombo } from '../../domain/arca_fase4.ts';
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
import type { ComboPromocionUI } from '../venta/PanelVentaPOS.tsx';

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

export interface SucursalResumenUI {
  readonly id: string;
  readonly nombre: string;
  readonly codigo: string | null;
  readonly direccion: string | null;
  readonly telefono: string | null;
  readonly es_principal: boolean;
  readonly activo: boolean;
  readonly cantidad_productos_con_stock?: number;
  readonly total_unidades_stock?: number;
  readonly cantidad_ventas?: number;
}

export interface TransferenciaSucursalUI {
  readonly id: string;
  readonly fecha: string;
  readonly sucursal_origen_id: string;
  readonly sucursal_origen_nombre: string;
  readonly sucursal_destino_id: string;
  readonly sucursal_destino_nombre: string;
  readonly usuario_nombre: string;
  readonly motivo: string;
  readonly cantidad_items: number;
  readonly total_unidades: number;
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
  readonly stock_por_sucursal?: Readonly<Record<string, number>>;
  readonly stock_sucursal_activa?: number;
  readonly boton_rapido: boolean;
  readonly imagen_path: string | null;
  readonly imagen_hash: string | null;
}

export interface PanelProductosStockProps {
  readonly rolActivo: RolUsuario;
  readonly productosIniciales?: readonly ProductoAdminItemUI[];
  readonly combosIniciales?: readonly ComboPromocionUI[];
  readonly sucursalesServidor?: readonly SucursalResumenUI[];
  readonly sucursalActiva?: SucursalResumenUI | null;
  readonly transferenciasSucursalesServidor?: readonly TransferenciaSucursalUI[];
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
  combosIniciales = [],
  sucursalesServidor = [],
  sucursalActiva = null,
  transferenciasSucursalesServidor = [],
  categoriasServidor = [],
  marcasServidor = [],
  proveedoresServidor = [],
  onDatosActualizados,
}: PanelProductosStockProps): React.ReactElement {
  const [productos, setProductos] = useState<ProductoAdminItemUI[]>(() => [
    ...productosIniciales,
  ]);
  const [combos, setCombos] = useState<ComboPromocionUI[]>(() => [
    ...combosIniciales,
  ]);
  const [sucursales, setSucursales] = useState<SucursalResumenUI[]>(() =>
    sucursalesServidor.length > 0
      ? [...sucursalesServidor]
      : [
          {
            id: 'suc-principal-local',
            nombre: 'Casa Central',
            codigo: 'SUC-01',
            direccion: null,
            telefono: null,
            es_principal: true,
            activo: true,
          },
        ]
  );
  const [transferenciasSucursales, setTransferenciasSucursales] = useState<
    TransferenciaSucursalUI[]
  >(() => [...transferenciasSucursalesServidor]);
  const [busqueda, setBusqueda] = useState('');
  const [paginaProductos, setPaginaProductos] = useState(1);

  // Estado de Sucursales y Migración de Productos entre Sucursales
  const [sucNombreNueva, setSucNombreNueva] = useState('');
  const [sucCodigoNuevo, setSucCodigoNuevo] = useState('');
  const [sucDireccionNueva, setSucDireccionNueva] = useState('');
  const [sucTelefonoNuevo, setSucTelefonoNuevo] = useState('');
  const [transfOrigenId, setTransfOrigenId] = useState<string>(
    sucursalesServidor[0]?.id ?? 'suc-principal-local'
  );
  const [transfDestinoId, setTransfDestinoId] = useState<string>(
    sucursalesServidor[1]?.id ?? ''
  );
  const [transfMotivo, setTransfMotivo] = useState(
    'Reposición interna entre sucursales'
  );
  const [busquedaProdTransferencia, setBusquedaProdTransferencia] =
    useState('');
  const [transfProdId, setTransfProdId] = useState<string>(
    productosIniciales[0]?.id ?? ''
  );
  const [transfCantInput, setTransfCantInput] = useState('1');
  const [transfItemsBorrador, setTransfItemsBorrador] = useState<
    Array<{ productoId: string; nombreProducto: string; cantidad: number }>
  >([]);

  // Estado de Armado de Combo con sus componentes, cantidades requeridas y precio especial
  const [comboNombre, setComboNombre] = useState('');
  const [comboCodigoBarras, setComboCodigoBarras] = useState('');
  const [comboDescripcion, setComboDescripcion] = useState('');
  const [comboPrecioEspecialInput, setComboPrecioEspecialInput] = useState('');
  const [busquedaProdCombo, setBusquedaProdCombo] = useState('');
  const [comboComponenteProdId, setComboComponenteProdId] = useState<string>(
    productosIniciales[0]?.id ?? ''
  );
  const [comboComponenteCantInput, setComboComponenteCantInput] = useState('1');
  const [comboComponentesBorrador, setComboComponentesBorrador] = useState<
    Array<{ productoId: string; cantidad: number }>
  >([]);

  const productosFiltradosTransferencia = useMemo(() => {
    const q = busquedaProdTransferencia.trim().toLowerCase();
    if (!q) return productos;
    return productos.filter((p) => {
      const texto = [
        p.nombre,
        p.codigo_interno ?? '',
        ...(p.codigos_barras ?? []),
      ]
        .join(' ')
        .toLowerCase();
      return texto.includes(q);
    });
  }, [productos, busquedaProdTransferencia]);

  const productosFiltradosCombo = useMemo(() => {
    const q = busquedaProdCombo.trim().toLowerCase();
    if (!q) return productos;
    return productos.filter((p) => {
      const texto = [
        p.nombre,
        p.codigo_interno ?? '',
        ...(p.codigos_barras ?? []),
      ]
        .join(' ')
        .toLowerCase();
      return texto.includes(q);
    });
  }, [productos, busquedaProdCombo]);

  useEffect(() => {
    setProductos([...productosIniciales]);
    if (productosIniciales.length > 0 && !productoAjusteId) {
      setProductoAjusteId(productosIniciales[0]!.id);
    }
    if (productosIniciales.length > 0 && !comboComponenteProdId) {
      setComboComponenteProdId(productosIniciales[0]!.id);
    }
  }, [productosIniciales]);

  useEffect(() => {
    setCombos([...combosIniciales]);
  }, [combosIniciales]);

  useEffect(() => {
    if (sucursalesServidor.length > 0) {
      setSucursales([...sucursalesServidor]);
      if (!sucursalesServidor.some((s) => s.id === transfOrigenId)) {
        setTransfOrigenId(sucursalesServidor[0]!.id);
      }
      if (
        !transfDestinoId ||
        !sucursalesServidor.some((s) => s.id === transfDestinoId)
      ) {
        const otra = sucursalesServidor.find((s) => s.id !== transfOrigenId);
        if (otra) setTransfDestinoId(otra.id);
      }
    }
  }, [sucursalesServidor]);

  useEffect(() => {
    setTransferenciasSucursales([...transferenciasSucursalesServidor]);
  }, [transferenciasSucursalesServidor]);

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
  const [busquedaProductoAjuste, setBusquedaProductoAjuste] =
    useState<string>('');
  const [productoAjusteId, setProductoAjusteId] = useState<string>(
    productosIniciales[0]?.id ?? ''
  );

  const productosFiltradosAjuste = useMemo(() => {
    const q = busquedaProductoAjuste.trim().toLowerCase();
    if (!q) return productos;
    return productos.filter((p) => {
      const texto = [
        p.nombre,
        p.codigo_interno ?? '',
        ...(p.codigos_barras ?? []),
      ]
        .join(' ')
        .toLowerCase();
      return texto.includes(q);
    });
  }, [productos, busquedaProductoAjuste]);
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

  // =========================================================================
  // Armado de Combos con cálculo inteligente de stock por componente menor
  // =========================================================================

  const componentesBorradorDetallados = useMemo(() => {
    return comboComponentesBorrador.map((comp) => {
      const prod = productos.find((p) => p.id === comp.productoId);
      const stockActual = prod?.stock_actual ?? 0;
      const precioUnitarioNormal = (prod?.precio_venta ?? 0) as Centavos;
      const combosPosiblesPorComponente =
        comp.cantidad > 0 ? Math.floor(Math.max(0, stockActual) / comp.cantidad) : 0;
      return {
        productoId: comp.productoId,
        nombreProducto: prod?.nombre ?? 'Producto',
        unidad: prod?.unidad ?? 'unidad',
        cantidadPorCombo: comp.cantidad,
        precioUnitarioNormalCentavos: precioUnitarioNormal,
        subtotalNormalCentavos: Math.round(
          comp.cantidad * precioUnitarioNormal
        ) as Centavos,
        stockActualComponente: stockActual,
        combosPosiblesPorComponente,
      };
    });
  }, [comboComponentesBorrador, productos]);

  const calculoBorradorCombo = useMemo(() => {
    if (componentesBorradorDetallados.length === 0) return null;
    let precioEspecialCentavos = 0 as Centavos;
    try {
      precioEspecialCentavos = comboPrecioEspecialInput.trim()
        ? pesosACentavos(comboPrecioEspecialInput)
        : (0 as Centavos);
    } catch {
      precioEspecialCentavos = 0 as Centavos;
    }

    const sumaNormal = componentesBorradorDetallados.reduce(
      (acc, c) => acc + c.subtotalNormalCentavos,
      0
    ) as Centavos;

    const precioParaCalculo =
      precioEspecialCentavos > 0
        ? precioEspecialCentavos
        : Math.max(1, sumaNormal);

    const resultado = calcularPrecioYStockCombo({
      componentes: componentesBorradorDetallados,
      precioComboCentavos: precioParaCalculo,
    });

    const componenteLimitante = componentesBorradorDetallados.reduce(
      (min, actual) =>
        actual.combosPosiblesPorComponente < min.combosPosiblesPorComponente
          ? actual
          : min,
      componentesBorradorDetallados[0]!
    );

    return {
      ...resultado,
      precioEspecialIngresado: precioEspecialCentavos,
      componenteLimitante,
    };
  }, [componentesBorradorDetallados, comboPrecioEspecialInput]);

  // Recalcular stock disponible de cada combo activo usando el stock actual en vivo de sus componentes
  const combosConStockEnVivo = useMemo(() => {
    return combos.map((combo) => {
      const itemsActualizados = combo.items.map((it) => {
        const prodEnVivo = productos.find((p) => p.id === it.producto_id);
        return {
          ...it,
          stock_actual: prodEnVivo ? prodEnVivo.stock_actual : it.stock_actual,
          precio_unitario_normal: prodEnVivo
            ? prodEnVivo.precio_venta
            : it.precio_unitario_normal,
        };
      });

      if (itemsActualizados.length === 0) {
        return combo;
      }

      const calc = calcularPrecioYStockCombo({
        precioComboCentavos: Math.max(1, combo.precio_venta),
        componentes: itemsActualizados.map((it) => ({
          productoId: it.producto_id,
          nombreProducto: it.producto_nombre,
          cantidadPorCombo: it.cantidad,
          precioUnitarioNormalCentavos: it.precio_unitario_normal,
          stockActualComponente: it.stock_actual,
        })),
      });

      return {
        ...combo,
        precio_suma_normal: calc.precioSumaNormalCentavos,
        ahorro_centavos: calc.ahorroCentavos,
        porcentaje_descuento: calc.porcentajeDescuento,
        stock_combos_disponibles: calc.stockCombosDisponibles,
        items: itemsActualizados,
      };
    });
  }, [combos, productos]);

  const [paginaSucursales, setPaginaSucursales] = useState(1);
  const [paginaTransfItemsBorrador, setPaginaTransfItemsBorrador] = useState(1);
  const [paginaTransferenciasSucursales, setPaginaTransferenciasSucursales] =
    useState(1);
  const [paginaComponentesBorrador, setPaginaComponentesBorrador] = useState(1);
  const [paginaCombos, setPaginaCombos] = useState(1);

  const paginacionSucursales = paginarListado(
    sucursales,
    paginaSucursales,
    TAMANIO_PAGINA_POR_DEFECTO
  );
  const paginacionTransfItemsBorrador = paginarListado(
    transfItemsBorrador,
    paginaTransfItemsBorrador,
    TAMANIO_PAGINA_POR_DEFECTO
  );
  const paginacionTransferenciasSucursales = paginarListado(
    transferenciasSucursales,
    paginaTransferenciasSucursales,
    TAMANIO_PAGINA_POR_DEFECTO
  );
  const paginacionComponentesBorrador = paginarListado(
    componentesBorradorDetallados,
    paginaComponentesBorrador,
    TAMANIO_PAGINA_POR_DEFECTO
  );
  const paginacionCombos = paginarListado(
    combosConStockEnVivo,
    paginaCombos,
    TAMANIO_PAGINA_POR_DEFECTO
  );

  function agregarComponenteAlComboBorrador() {
    setMensajeError(null);
    const idEfectivo = comboComponenteProdId || productos[0]?.id || '';
    const prod = productos.find((p) => p.id === idEfectivo);
    if (!prod) {
      setMensajeError('Seleccioná un producto del catálogo para agregar al combo.');
      return;
    }

    const cantidad = Number(comboComponenteCantInput.replace(',', '.'));
    if (!Number.isFinite(cantidad) || cantidad <= 0) {
      setMensajeError('La cantidad requerida del componente debe ser mayor a cero.');
      return;
    }

    setComboComponentesBorrador((prev) => {
      const existe = prev.find((c) => c.productoId === prod.id);
      if (existe) {
        return prev.map((c) =>
          c.productoId === prod.id
            ? { ...c, cantidad: Number((c.cantidad + cantidad).toFixed(3)) }
            : c
        );
      }
      return [...prev, { productoId: prod.id, cantidad }];
    });
    setComboComponenteCantInput('1');
  }

  function quitarComponenteDelComboBorrador(productoId: string) {
    setComboComponentesBorrador((prev) =>
      prev.filter((c) => c.productoId !== productoId)
    );
  }

  async function manejarGuardarComboPromocion(e: React.FormEvent) {
    e.preventDefault();
    if (!puedeEditarCatalogo) return;
    setMensajeError(null);
    setMensajeOk(null);

    try {
      if (!comboNombre.trim()) {
        throw new Error('Ingresá un nombre para el combo o promoción.');
      }
      if (comboComponentesBorrador.length === 0) {
        throw new Error('Agregá al menos un producto componente al combo.');
      }
      const precioEspecial = pesosACentavos(comboPrecioEspecialInput);
      if (precioEspecial <= 0) {
        throw new Error('El precio especial de venta del combo debe ser mayor a $ 0,00.');
      }

      const res = await invocarPosApi<{
        id: string;
        combos: readonly ComboPromocionUI[];
      }>('crear_combo_promocion', {
        rolActivo,
        nombre: comboNombre.trim(),
        descripcion: comboDescripcion.trim() || null,
        codigoBarras: comboCodigoBarras.trim() || null,
        precioVentaCentavos: precioEspecial,
        componentes: comboComponentesBorrador,
      });

      setCombos([...res.combos]);
      setComboNombre('');
      setComboCodigoBarras('');
      setComboDescripcion('');
      setComboPrecioEspecialInput('');
      setComboComponentesBorrador([]);
      setMensajeOk(
        `Combo "${comboNombre.trim()}" creado con éxito. Al venderlo en caja se descontará automáticamente el stock de cada uno de sus componentes.`
      );
      onDatosActualizados?.();
    } catch (err) {
      setMensajeError(
        err instanceof Error ? err.message : 'No se pudo guardar el combo.'
      );
    }
  }

  async function manejarEliminarCombo(comboId: string, nombreCombo: string) {
    if (!puedeEditarCatalogo) return;
    setMensajeError(null);
    setMensajeOk(null);

    try {
      const res = await invocarPosApi<{
        ok: boolean;
        combos: readonly ComboPromocionUI[];
      }>('eliminar_combo_promocion', {
        rolActivo,
        comboId,
        motivo: `Baja de combo "${nombreCombo}" desde panel de productos`,
      });
      setCombos([...res.combos]);
      setMensajeOk(`Combo "${nombreCombo}" desactivado y registrado en auditoría.`);
      onDatosActualizados?.();
    } catch (err) {
      setMensajeError(
        err instanceof Error ? err.message : 'No se pudo desactivar el combo.'
      );
    }
  }

  async function manejarCrearSucursal(e: React.FormEvent) {
    e.preventDefault();
    setMensajeError(null);
    setMensajeOk(null);

    try {
      const nombreLimpio = sucNombreNueva.trim();
      if (!nombreLimpio) {
        throw new Error('Ingresá el nombre de la nueva sucursal.');
      }

      const idNuevo = `suc-${Date.now()}`;
      try {
        await invocarPosApi('crear_sucursal', {
          rolActivo,
          nombre: nombreLimpio,
          codigo: sucCodigoNuevo.trim() || null,
          direccion: sucDireccionNueva.trim() || null,
          telefono: sucTelefonoNuevo.trim() || null,
        });
      } catch (err) {
        if (err instanceof Error && !err.message.includes('fetch')) {
          throw err;
        }
      }

      const nuevaSuc: SucursalResumenUI = {
        id: idNuevo,
        nombre: nombreLimpio,
        codigo: sucCodigoNuevo.trim() || `SUC-0${sucursales.length + 1}`,
        direccion: sucDireccionNueva.trim() || null,
        telefono: sucTelefonoNuevo.trim() || null,
        es_principal: false,
        activo: true,
        cantidad_productos_con_stock: 0,
        total_unidades_stock: 0,
        cantidad_ventas: 0,
      };
      setSucursales((prev) => [...prev, nuevaSuc]);
      if (!transfDestinoId) {
        setTransfDestinoId(nuevaSuc.id);
      }
      setSucNombreNueva('');
      setSucCodigoNuevo('');
      setSucDireccionNueva('');
      setSucTelefonoNuevo('');
      setMensajeOk(`Sucursal "${nombreLimpio}" creada y sincronizable.`);
      onDatosActualizados?.();
    } catch (err) {
      setMensajeError(
        err instanceof Error
          ? err.message
          : 'No se pudo crear la sucursal.'
      );
    }
  }

  async function manejarActivarSucursalEnTerminal(suc: SucursalResumenUI) {
    setMensajeError(null);
    setMensajeOk(null);
    try {
      try {
        await invocarPosApi('seleccionar_sucursal_activa', {
          rolActivo,
          sucursalId: suc.id,
        });
      } catch (err) {
        if (err instanceof Error && !err.message.includes('fetch')) {
          throw err;
        }
      }
      setMensajeOk(
        `Sucursal activa de esta terminal cambiada a "${suc.nombre}".`
      );
      onDatosActualizados?.();
    } catch (err) {
      setMensajeError(
        err instanceof Error
          ? err.message
          : 'No se pudo cambiar la sucursal activa.'
      );
    }
  }

  function obtenerStockProductoEnSucursalUI(
    prod: ProductoAdminItemUI,
    sucId: string
  ): number {
    if (prod.stock_por_sucursal && sucId in prod.stock_por_sucursal) {
      return prod.stock_por_sucursal[sucId] ?? 0;
    }
    const suc = sucursales.find((s) => s.id === sucId);
    if (suc?.es_principal || sucursales.length <= 1) {
      return prod.stock_actual;
    }
    return 0;
  }

  function agregarItemTransferenciaSucursal() {
    setMensajeError(null);
    const idEfectivo = transfProdId || productos[0]?.id || '';
    const prod = productos.find((p) => p.id === idEfectivo);
    if (!prod) {
      setMensajeError('Seleccioná un producto para migrar entre sucursales.');
      return;
    }
    const cant = Number(transfCantInput.replace(',', '.'));
    if (!Number.isFinite(cant) || cant <= 0) {
      setMensajeError('La cantidad a transferir debe ser mayor a cero.');
      return;
    }
    const dispOrigen = obtenerStockProductoEnSucursalUI(prod, transfOrigenId);
    if (cant > dispOrigen) {
      setMensajeError(
        `Stock insuficiente en la sucursal de origen: "${prod.nombre}" tiene ${dispOrigen} ${prod.unidad} disponibles.`
      );
      return;
    }

    setTransfItemsBorrador((prev) => {
      const idx = prev.findIndex((i) => i.productoId === prod.id);
      if (idx >= 0) {
        return prev.map((it, i) =>
          i === idx
            ? {
                ...it,
                cantidad: Math.min(
                  dispOrigen,
                  Math.round((it.cantidad + cant) * 1000) / 1000
                ),
              }
            : it
        );
      }
      return [
        ...prev,
        {
          productoId: prod.id,
          nombreProducto: prod.nombre,
          cantidad: cant,
        },
      ];
    });
    setTransfCantInput('1');
  }

  function cargarTodosProductosDeSucursalOrigen() {
    setMensajeError(null);
    const conStock = productos
      .map((p) => ({
        productoId: p.id,
        nombreProducto: p.nombre,
        cantidad: obtenerStockProductoEnSucursalUI(p, transfOrigenId),
      }))
      .filter((it) => it.cantidad > 0);

    if (conStock.length === 0) {
      setMensajeError(
        'La sucursal de origen seleccionada no tiene productos con stock positivo para migrar.'
      );
      return;
    }
    setTransfItemsBorrador(conStock);
    setMensajeOk(
      `Se cargaron ${conStock.length} producto(s) con su stock disponible de la sucursal de origen.`
    );
  }

  async function manejarConfirmarTransferenciaSucursales(e: React.FormEvent) {
    e.preventDefault();
    setMensajeError(null);
    setMensajeOk(null);

    try {
      if (!transfOrigenId || !transfDestinoId) {
        throw new Error(
          'Seleccioná la sucursal de origen y la sucursal de destino.'
        );
      }
      if (transfOrigenId === transfDestinoId) {
        throw new Error(
          'La sucursal de origen y la sucursal de destino deben ser diferentes.'
        );
      }
      if (!transfMotivo.trim()) {
        throw new Error(
          'El motivo de la migración/transferencia entre sucursales es obligatorio.'
        );
      }
      if (transfItemsBorrador.length === 0) {
        throw new Error(
          'Agregá al menos un producto a la lista de migración entre sucursales.'
        );
      }

      try {
        await invocarPosApi('transferir_stock_sucursales', {
          rolActivo,
          sucursalOrigenId: transfOrigenId,
          sucursalDestinoId: transfDestinoId,
          motivo: transfMotivo.trim(),
          items: transfItemsBorrador.map((it) => ({
            productoId: it.productoId,
            cantidad: it.cantidad,
          })),
        });
      } catch (err) {
        if (err instanceof Error && !err.message.includes('fetch')) {
          throw err;
        }
      }

      const sucOrigNombre =
        sucursales.find((s) => s.id === transfOrigenId)?.nombre ?? 'Origen';
      const sucDestNombre =
        sucursales.find((s) => s.id === transfDestinoId)?.nombre ?? 'Destino';
      const totalUnid = transfItemsBorrador.reduce(
        (acc, it) => acc + it.cantidad,
        0
      );

      setTransferenciasSucursales((prev) => [
        {
          id: `transf-${Date.now()}`,
          fecha: new Date().toISOString(),
          sucursal_origen_id: transfOrigenId,
          sucursal_origen_nombre: sucOrigNombre,
          sucursal_destino_id: transfDestinoId,
          sucursal_destino_nombre: sucDestNombre,
          usuario_nombre: rolActivo,
          motivo: transfMotivo.trim(),
          cantidad_items: transfItemsBorrador.length,
          total_unidades: totalUnid,
        },
        ...prev,
      ]);

      setTransfItemsBorrador([]);
      setMensajeOk(
        `Migración completada: ${transfItemsBorrador.length} artículo(s) (${totalUnid} unidades) transferidos de "${sucOrigNombre}" hacia "${sucDestNombre}" mediante movimientos de stock auditados.`
      );
      onDatosActualizados?.();
    } catch (err) {
      setMensajeError(
        err instanceof Error
          ? err.message
          : 'No se pudo completar la transferencia entre sucursales.'
      );
    }
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
                  <label style={{ flex: 1 }}>
                    Buscar producto (por nombre, código interno o código de barras):
                    <input
                      type="search"
                      aria-label="Buscar producto para movimiento de stock"
                      value={busquedaProductoAjuste}
                      onChange={(e) => {
                        const valor = e.target.value;
                        setBusquedaProductoAjuste(valor);
                        const q = valor.trim().toLowerCase();
                        if (!q) return;
                        const coincidencia = productos.find((p) =>
                          [
                            p.nombre,
                            p.codigo_interno ?? '',
                            ...(p.codigos_barras ?? []),
                          ]
                            .join(' ')
                            .toLowerCase()
                            .includes(q)
                        );
                        if (coincidencia) {
                          setProductoAjusteId(coincidencia.id);
                        }
                      }}
                      placeholder="🔍 Escribí nombre, código interno o EAN para filtrar el producto..."
                    />
                  </label>
                </div>
                <div className="form-row">
                  <label>
                    Producto ({productosFiltradosAjuste.length} coincidencia(s)):
                    <select
                      value={
                        productoAjusteId ||
                        productosFiltradosAjuste[0]?.id ||
                        productos[0]?.id ||
                        ''
                      }
                      onChange={(e) => setProductoAjusteId(e.target.value)}
                    >
                      {productosFiltradosAjuste.length === 0 && (
                        <option value="">
                          Sin productos que coincidan con la búsqueda
                        </option>
                      )}
                      {productosFiltradosAjuste.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.nombre}
                          {p.codigo_interno ? ` (${p.codigo_interno})` : ''} —
                          Stock: {p.stock_actual} {p.unidad}
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

      {/* Panel de Administración de Sucursales, Ubicación de Stock y Migración entre Locales */}
      <div className="pos-card">
        <div className="card-header">
          <div>
            <h2>
              🏢 Sucursales, Ubicación de Productos y Migración de Stock entre Locales
            </h2>
            <p className="text-muted">
              Administrá las sucursales del comercio, seleccioná en qué sucursal opera esta terminal,
              consultá dónde se encuentran las unidades de cada producto y migrá mercadería entre
              sucursales con trazabilidad contable append-only.
            </p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontWeight: 600 }}>
              📍 Sucursal activa en esta terminal:
              <select
                value={sucursalActiva?.id ?? sucursales[0]?.id ?? ''}
                onChange={(e) => {
                  const elegida = sucursales.find((s) => s.id === e.target.value);
                  if (elegida) {
                    void manejarActivarSucursalEnTerminal(elegida);
                  }
                }}
                style={{ fontWeight: 700 }}
              >
                {sucursales.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.nombre} ({s.codigo}) {s.es_principal ? '★ Principal' : ''}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
            gap: '1rem',
            marginBottom: '1rem',
          }}
        >
          {/* Tarjeta 1: Lista y alta de sucursales */}
          <div className="subcard-box" style={{ padding: '0.9rem', borderRadius: '0.65rem' }}>
            <h3 style={{ marginTop: 0, marginBottom: '0.5rem' }}>
              Locales / Sucursales del Comercio ({sucursales.length})
            </h3>
            <table className="pos-table" style={{ marginBottom: '0.75rem' }}>
              <thead>
                <tr>
                  <th>Código</th>
                  <th>Nombre</th>
                  <th>Dirección / Teléfono</th>
                  <th>Estado</th>
                </tr>
              </thead>
              <tbody>
                {paginacionSucursales.itemsPagina.map((s) => {
                  const esActiva = (sucursalActiva?.id ?? sucursales[0]?.id) === s.id;
                  return (
                    <tr key={s.id}>
                      <td>
                        <code>{s.codigo}</code>
                      </td>
                      <td>
                        <strong>{s.nombre}</strong>
                        {s.es_principal && (
                          <span
                            className="role-pill"
                            style={{ marginLeft: '0.35rem', fontSize: '0.72rem' }}
                          >
                            Principal
                          </span>
                        )}
                      </td>
                      <td className="text-muted">
                        {s.direccion || 'Sin dirección'}
                        {s.telefono ? ` · Tel: ${s.telefono}` : ''}
                      </td>
                      <td>
                        {esActiva ? (
                          <span className="stock-ok">🟢 Activa en caja</span>
                        ) : (
                          <button
                            type="button"
                            className="btn-secondary"
                            style={{ padding: '0.2rem 0.55rem', fontSize: '0.78rem' }}
                            onClick={() => void manejarActivarSucursalEnTerminal(s)}
                          >
                            Operar aquí
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <PaginadorTabla
              paginaActual={paginacionSucursales.paginaActual}
              totalPaginas={paginacionSucursales.totalPaginas}
              totalItems={paginacionSucursales.totalItems}
              desdeRegistro={paginacionSucursales.desdeRegistro}
              hastaRegistro={paginacionSucursales.hastaRegistro}
              tamanioPagina={paginacionSucursales.tamanioPagina}
              onCambiarPagina={setPaginaSucursales}
              etiquetaItems="sucursales"
            />

            {puedeEditarCatalogo && (
              <form onSubmit={(e) => void manejarCrearSucursal(e)} className="form-stack">
                <strong style={{ fontSize: '0.88rem' }}>➕ Agregar nueva sucursal o depósito</strong>
                <div className="form-row">
                  <label>
                    Nombre de sucursal:
                    <input
                      type="text"
                      value={sucNombreNueva}
                      onChange={(e) => setSucNombreNueva(e.target.value)}
                      placeholder="Ej. Sucursal Norte / Depósito Central"
                    />
                  </label>
                  <label>
                    Código corto:
                    <input
                      type="text"
                      value={sucCodigoNuevo}
                      onChange={(e) => setSucCodigoNuevo(e.target.value)}
                      placeholder="Ej. SUC-02"
                    />
                  </label>
                </div>
                <div className="form-row">
                  <label>
                    Dirección (opcional):
                    <input
                      type="text"
                      value={sucDireccionNueva}
                      onChange={(e) => setSucDireccionNueva(e.target.value)}
                      placeholder="Av. Corrientes 2450"
                    />
                  </label>
                  <label>
                    Teléfono (opcional):
                    <input
                      type="text"
                      value={sucTelefonoNuevo}
                      onChange={(e) => setSucTelefonoNuevo(e.target.value)}
                      placeholder="11-4555-0199"
                    />
                  </label>
                  <button
                    type="submit"
                    className="btn-secondary"
                    style={{ alignSelf: 'flex-end' }}
                  >
                    Guardar Sucursal
                  </button>
                </div>
              </form>
            )}
          </div>

          {/* Tarjeta 2: Migración / Transferencia de productos entre sucursales */}
          <div className="subcard-box" style={{ padding: '0.9rem', borderRadius: '0.65rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
              <h3 style={{ marginTop: 0, marginBottom: '0.5rem' }}>
                🚚 Migrar / Transferir Productos entre Sucursales
              </h3>
              {puedeEditarCatalogo && (
                <button
                  type="button"
                  className="btn-secondary"
                  style={{ fontSize: '0.78rem', padding: '0.25rem 0.6rem' }}
                  onClick={cargarTodosProductosDeSucursalOrigen}
                >
                  Cargar todo el stock de origen
                </button>
              )}
            </div>
            <p className="text-muted" style={{ fontSize: '0.84rem', marginBottom: '0.65rem' }}>
              Descuenta stock en la sucursal de origen y lo acredita en la sucursal de destino en una
              única operación atómica auditada.
            </p>

            {puedeEditarCatalogo ? (
              <form
                onSubmit={(e) => void manejarConfirmarTransferenciaSucursales(e)}
                className="form-stack"
              >
                <div className="form-row">
                  <label>
                    Sucursal Origen (sale mercadería):
                    <select
                      value={transfOrigenId || sucursalActiva?.id || sucursales[0]?.id || ''}
                      onChange={(e) => setTransfOrigenId(e.target.value)}
                    >
                      {sucursales.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.nombre} ({s.codigo})
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Sucursal Destino (entra mercadería):
                    <select
                      value={
                        transfDestinoId ||
                        sucursales.find(
                          (s) => s.id !== (transfOrigenId || sucursalActiva?.id),
                        )?.id ||
                        ''
                      }
                      onChange={(e) => setTransfDestinoId(e.target.value)}
                    >
                      <option value="">-- Seleccionar sucursal destino --</option>
                      {sucursales.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.nombre} ({s.codigo})
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

                <div className="form-row" style={{ alignItems: 'flex-end' }}>
                  <label style={{ flex: 2 }}>
                    Producto a migrar:
                    <input
                      type="search"
                      value={busquedaProdTransferencia}
                      onChange={(e) => {
                        const valor = e.target.value;
                        setBusquedaProdTransferencia(valor);
                        const q = valor.trim().toLowerCase();
                        if (q) {
                          const coincidencia = productos.find((p) =>
                            [
                              p.nombre,
                              p.codigo_interno ?? '',
                              ...(p.codigos_barras ?? []),
                            ]
                              .join(' ')
                              .toLowerCase()
                              .includes(q)
                          );
                          if (coincidencia) {
                            setTransfProdId(coincidencia.id);
                          }
                        }
                      }}
                      placeholder="🔎 Buscar producto a migrar por nombre, código o barras..."
                      style={{ marginBottom: '0.35rem' }}
                    />
                    <select
                      value={
                        transfProdId ||
                        productosFiltradosTransferencia[0]?.id ||
                        productos[0]?.id ||
                        ''
                      }
                      onChange={(e) => setTransfProdId(e.target.value)}
                    >
                      {productosFiltradosTransferencia.length === 0 ? (
                        <option value="">
                          Sin coincidencias para &ldquo;{busquedaProdTransferencia}&rdquo;
                        </option>
                      ) : (
                        productosFiltradosTransferencia.map((p) => {
                          const origId =
                            transfOrigenId ||
                            sucursalActiva?.id ||
                            sucursales[0]?.id ||
                            '';
                          const stockEnOrigen = obtenerStockProductoEnSucursalUI(
                            p,
                            origId
                          );
                          return (
                            <option key={p.id} value={p.id}>
                              {p.nombre} ({p.codigo_interno}) — En origen:{' '}
                              {stockEnOrigen} {p.unidad}
                            </option>
                          );
                        })
                      )}
                    </select>
                  </label>
                  <label style={{ flex: 1 }}>
                    Cantidad:
                    <input
                      type="number"
                      min="0.001"
                      step="any"
                      value={transfCantInput}
                      onChange={(e) => setTransfCantInput(e.target.value)}
                    />
                  </label>
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={agregarItemTransferenciaSucursal}
                  >
                    + Agregar al envío
                  </button>
                </div>

                {transfItemsBorrador.length > 0 && (
                  <>
                    <table className="pos-table" style={{ marginTop: '0.5rem' }}>
                      <thead>
                        <tr>
                          <th>Producto</th>
                          <th>Cantidad a migrar</th>
                          <th>Acción</th>
                        </tr>
                      </thead>
                      <tbody>
                        {paginacionTransfItemsBorrador.itemsPagina.map((item) => {
                          const prod = productos.find((p) => p.id === item.productoId);
                          return (
                            <tr key={item.productoId}>
                              <td>
                                {prod
                                  ? `${prod.nombre} (${prod.codigo_interno})`
                                  : item.nombreProducto}
                              </td>
                              <td>
                                <strong>
                                  {item.cantidad} {prod?.unidad ?? 'u.'}
                                </strong>
                              </td>
                              <td>
                                <button
                                  type="button"
                                  className="btn-link"
                                  onClick={() =>
                                    setTransfItemsBorrador((prev) =>
                                      prev.filter((i) => i.productoId !== item.productoId)
                                    )
                                  }
                                >
                                  Quitar
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                    <PaginadorTabla
                      paginaActual={paginacionTransfItemsBorrador.paginaActual}
                      totalPaginas={paginacionTransfItemsBorrador.totalPaginas}
                      totalItems={paginacionTransfItemsBorrador.totalItems}
                      desdeRegistro={paginacionTransfItemsBorrador.desdeRegistro}
                      hastaRegistro={paginacionTransfItemsBorrador.hastaRegistro}
                      tamanioPagina={paginacionTransfItemsBorrador.tamanioPagina}
                      onCambiarPagina={setPaginaTransfItemsBorrador}
                      etiquetaItems="productos a migrar"
                    />
                  </>
                )}

                <div className="form-row" style={{ alignItems: 'flex-end' }}>
                  <label style={{ flex: 2 }}>
                    Motivo / Remito interno:
                    <input
                      type="text"
                      value={transfMotivo}
                      onChange={(e) => setTransfMotivo(e.target.value)}
                      placeholder="Ej. Reposición semanal a Sucursal Norte"
                    />
                  </label>
                  <button
                    type="submit"
                    className="btn-primary"
                    disabled={transfItemsBorrador.length === 0}
                  >
                    Confirmar Migración de Stock ({transfItemsBorrador.length})
                  </button>
                </div>
              </form>
            ) : (
              <p className="text-muted">
                Solo Superadmin o Encargado pueden migrar stock entre sucursales.
              </p>
            )}
          </div>
        </div>

        {/* Historial reciente de transferencias entre sucursales */}
        {transferenciasSucursales.length > 0 && (
          <div style={{ marginTop: '0.75rem' }}>
            <h4 style={{ margin: '0 0 0.45rem 0' }}>
              Últimas migraciones de mercadería entre sucursales
            </h4>
            <table className="pos-table">
              <thead>
                <tr>
                  <th>Fecha</th>
                  <th>Origen → Destino</th>
                  <th>Resumen de Productos Migrados</th>
                  <th>Motivo</th>
                </tr>
              </thead>
              <tbody>
                {paginacionTransferenciasSucursales.itemsPagina.map((t) => (
                  <tr key={t.id}>
                    <td>{new Date(t.fecha).toLocaleString('es-AR')}</td>
                    <td>
                      <strong>{t.sucursal_origen_nombre}</strong> →{' '}
                      <strong>{t.sucursal_destino_nombre}</strong>
                    </td>
                    <td>
                      {t.cantidad_items} producto(s) · {t.total_unidades} u. totales
                    </td>
                    <td className="text-muted">{t.motivo}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <PaginadorTabla
              paginaActual={paginacionTransferenciasSucursales.paginaActual}
              totalPaginas={paginacionTransferenciasSucursales.totalPaginas}
              totalItems={paginacionTransferenciasSucursales.totalItems}
              desdeRegistro={paginacionTransferenciasSucursales.desdeRegistro}
              hastaRegistro={paginacionTransferenciasSucursales.hastaRegistro}
              tamanioPagina={paginacionTransferenciasSucursales.tamanioPagina}
              onCambiarPagina={setPaginaTransferenciasSucursales}
              etiquetaItems="migraciones de sucursal"
            />
          </div>
        )}
      </div>

      {/* Panel de Armado de Combos y Promociones (docs/manual/04_productos_y_stock.md §3) */}
      <div className="pos-card">
        <div className="card-header">
          <div>
            <h2>
              Combos y Promociones — Armado de Paquetes con Stock Inteligente
            </h2>
            <p className="text-muted">
              Cada vez que se vende un combo, el sistema descuenta automáticamente
              del inventario la cantidad correspondiente de cada uno de sus
              componentes individuales. El stock disponible del combo se calcula de
              manera inteligente en base al componente que tenga menor existencia
              en el local.
            </p>
          </div>
        </div>

        {puedeEditarCatalogo && (
          <form
            onSubmit={(e) => void manejarGuardarComboPromocion(e)}
            className="form-stack"
            style={{
              marginBottom: '1.25rem',
              paddingBottom: '1rem',
              borderBottom: '1px solid #e2e8f0',
            }}
          >
            <h3>Panel de Armado de Combo</h3>
            <div className="form-row">
              <label>
                Nombre del combo / promoción:
                <input
                  type="text"
                  value={comboNombre}
                  onChange={(e) => setComboNombre(e.target.value)}
                  placeholder="Ej. Promo Fernet 750ml + 2 Gaseosas Cola 1.5L"
                />
              </label>
              <label>
                Precio especial de venta ($):
                <input
                  type="text"
                  value={comboPrecioEspecialInput}
                  onChange={(e) => setComboPrecioEspecialInput(e.target.value)}
                  placeholder="Ej. 14500,00"
                />
              </label>
              <label>
                Código de barras del combo (opcional):
                <input
                  type="text"
                  value={comboCodigoBarras}
                  onChange={(e) => setComboCodigoBarras(e.target.value)}
                  placeholder="Ej. 7799990001112"
                />
              </label>
              <label>
                Descripción (opcional):
                <input
                  type="text"
                  value={comboDescripcion}
                  onChange={(e) => setComboDescripcion(e.target.value)}
                  placeholder="Ej. Oferta fin de semana"
                />
              </label>
            </div>

            <div className="subcard-box" style={{ padding: '0.85rem', borderRadius: '0.6rem' }}>
              <strong style={{ display: 'block', marginBottom: '0.5rem' }}>
                Componentes y cantidades requeridas por cada combo
              </strong>
              <div className="form-row" style={{ alignItems: 'flex-end' }}>
                <label style={{ flex: 2 }}>
                  Producto componente:
                  <input
                    type="search"
                    value={busquedaProdCombo}
                    onChange={(e) => {
                      const valor = e.target.value;
                      setBusquedaProdCombo(valor);
                      const q = valor.trim().toLowerCase();
                      if (q) {
                        const coincidencia = productos.find((p) =>
                          [
                            p.nombre,
                            p.codigo_interno ?? '',
                            ...(p.codigos_barras ?? []),
                          ]
                            .join(' ')
                            .toLowerCase()
                            .includes(q)
                        );
                        if (coincidencia) {
                          setComboComponenteProdId(coincidencia.id);
                        }
                      }
                    }}
                    placeholder="🔎 Buscar producto para el combo por nombre, código o barras..."
                    style={{ marginBottom: '0.35rem' }}
                  />
                  <select
                    value={
                      comboComponenteProdId ||
                      productosFiltradosCombo[0]?.id ||
                      productos[0]?.id ||
                      ''
                    }
                    onChange={(e) => setComboComponenteProdId(e.target.value)}
                  >
                    {productosFiltradosCombo.length === 0 ? (
                      <option value="">
                        Sin coincidencias para &ldquo;{busquedaProdCombo}&rdquo;
                      </option>
                    ) : (
                      productosFiltradosCombo.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.nombre} ({p.codigo_interno}) — Precio normal:{' '}
                          {formatearMonedaARS(p.precio_venta)} — Existencia actual:{' '}
                          {p.stock_actual} {p.unidad}
                        </option>
                      ))
                    )}
                  </select>
                </label>
                <label style={{ flex: 1 }}>
                  Cantidad requerida:
                  <input
                    type="number"
                    min="0.001"
                    step="any"
                    value={comboComponenteCantInput}
                    onChange={(e) => setComboComponenteCantInput(e.target.value)}
                    placeholder="1"
                  />
                </label>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={agregarComponenteAlComboBorrador}
                >
                  + Agregar Componente al Combo
                </button>
              </div>

              {componentesBorradorDetallados.length > 0 && (
                <div style={{ marginTop: '0.85rem' }}>
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Componente</th>
                        <th className="num">Cant. Requerida</th>
                        <th className="num">Precio Unit. Normal</th>
                        <th className="num">Subtotal Normal</th>
                        <th className="num">Existencia en Local</th>
                        <th className="num">Combos Armables</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {paginacionComponentesBorrador.itemsPagina.map((comp) => {
                        const esLimitante =
                          calculoBorradorCombo?.componenteLimitante.productoId ===
                          comp.productoId;
                        return (
                          <tr key={comp.productoId}>
                            <td>
                              <strong>{comp.nombreProducto}</strong>
                              {esLimitante && (
                                <span
                                  className="badge-rol"
                                  style={{ marginLeft: '0.4rem' }}
                                >
                                  Menor existencia (define tope)
                                </span>
                              )}
                            </td>
                            <td className="num">
                              {comp.cantidadPorCombo} {comp.unidad}
                            </td>
                            <td className="num">
                              {formatearMonedaARS(
                                comp.precioUnitarioNormalCentavos
                              )}
                            </td>
                            <td className="num">
                              {formatearMonedaARS(comp.subtotalNormalCentavos)}
                            </td>
                            <td className="num">
                              {comp.stockActualComponente} {comp.unidad}
                            </td>
                            <td className="num">
                              <strong
                                className={
                                  comp.combosPosiblesPorComponente <= 0
                                    ? 'diff-negativa'
                                    : ''
                                }
                              >
                                {comp.combosPosiblesPorComponente} combo(s)
                              </strong>
                            </td>
                            <td>
                              <button
                                type="button"
                                className="btn-danger-outline"
                                onClick={() =>
                                  quitarComponenteDelComboBorrador(comp.productoId)
                                }
                              >
                                Quitar
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  <PaginadorTabla
                    paginaActual={paginacionComponentesBorrador.paginaActual}
                    totalPaginas={paginacionComponentesBorrador.totalPaginas}
                    totalItems={paginacionComponentesBorrador.totalItems}
                    desdeRegistro={paginacionComponentesBorrador.desdeRegistro}
                    hastaRegistro={paginacionComponentesBorrador.hastaRegistro}
                    tamanioPagina={paginacionComponentesBorrador.tamanioPagina}
                    onCambiarPagina={setPaginaComponentesBorrador}
                    etiquetaItems="componentes del combo"
                  />

                  {calculoBorradorCombo && (
                    <div
                      className="arqueo-box"
                      style={{ marginTop: '0.75rem' }}
                    >
                      <div className="arqueo-line">
                        <span>Suma de precios individuales normales:</span>
                        <strong>
                          {formatearMonedaARS(
                            calculoBorradorCombo.precioSumaNormalCentavos
                          )}
                        </strong>
                      </div>
                      <div className="arqueo-line">
                        <span>Precio especial de venta del combo:</span>
                        <strong>
                          {calculoBorradorCombo.precioEspecialIngresado > 0
                            ? formatearMonedaARS(
                                calculoBorradorCombo.precioEspecialIngresado
                              )
                            : 'Ingresá el precio especial arriba'}
                        </strong>
                      </div>
                      {calculoBorradorCombo.precioEspecialIngresado > 0 && (
                        <div className="arqueo-line">
                          <span>Ahorro para el cliente en caja:</span>
                          <strong className="diff-positiva">
                            {formatearMonedaARS(
                              calculoBorradorCombo.ahorroCentavos
                            )}{' '}
                            ({calculoBorradorCombo.porcentajeDescuento}% OFF)
                          </strong>
                        </div>
                      )}
                      <div className="arqueo-line destaque">
                        <span>
                          Stock disponible del combo (limitado por &ldquo;
                          {calculoBorradorCombo.componenteLimitante.nombreProducto}
                          &rdquo;):
                        </span>
                        <strong
                          className={
                            calculoBorradorCombo.stockCombosDisponibles <= 0
                              ? 'diff-negativa'
                              : 'diff-positiva'
                          }
                        >
                          {calculoBorradorCombo.stockCombosDisponibles} combo(s)
                          disponibles
                        </strong>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            <button
              type="submit"
              className="btn-primary"
              disabled={comboComponentesBorrador.length === 0}
            >
              Guardar Combo con Precio Especial
            </button>
          </form>
        )}

        <h3>Combos Activos y Stock Calculado por Menor Existencia</h3>
        <table className="data-table">
          <thead>
            <tr>
              <th>Combo / Promoción</th>
              <th>Componentes y Cantidades Requeridas</th>
              <th className="num">Suma Individual</th>
              <th className="num">Precio Especial Venta</th>
              <th className="num">Ahorro Cliente</th>
              <th className="num">Stock Disponible del Combo</th>
              {puedeEditarCatalogo && <th>Acciones</th>}
            </tr>
          </thead>
          <tbody>
            {combosConStockEnVivo.length === 0 ? (
              <tr>
                <td
                  colSpan={puedeEditarCatalogo ? 7 : 6}
                  className="text-muted"
                >
                  No hay combos armados todavía. Utilizá el panel superior para
                  armar una promoción con sus componentes y precio especial.
                </td>
              </tr>
            ) : (
              paginacionCombos.itemsPagina.map((combo) => (
                <tr key={combo.id}>
                  <td>
                    <strong>{combo.nombre}</strong>
                    {combo.descripcion && (
                      <div className="text-muted">{combo.descripcion}</div>
                    )}
                    {combo.codigo_barras && (
                      <div>
                        <code>{combo.codigo_barras}</code>
                      </div>
                    )}
                  </td>
                  <td>
                    {combo.items.map((it) => {
                      const posibles =
                        it.cantidad > 0
                          ? Math.floor(Math.max(0, it.stock_actual) / it.cantidad)
                          : 0;
                      const esMenorExistencia =
                        posibles === combo.stock_combos_disponibles;
                      return (
                        <div
                          key={it.producto_id}
                          style={{ fontSize: '0.84rem', marginBottom: '0.2rem' }}
                        >
                          • <strong>{it.cantidad}x</strong> {it.producto_nombre}{' '}
                          <span className="text-muted">
                            (Stock local: {it.stock_actual} → alcanza para{' '}
                            {posibles} combo{posibles === 1 ? '' : 's'})
                          </span>
                          {esMenorExistencia && (
                            <span
                              className="badge-rol"
                              style={{ marginLeft: '0.35rem', fontSize: '0.72rem' }}
                            >
                              Menor existencia
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </td>
                  <td className="num">
                    {formatearMonedaARS(combo.precio_suma_normal)}
                  </td>
                  <td className="num">
                    <strong>{formatearMonedaARS(combo.precio_venta)}</strong>
                  </td>
                  <td className="num">
                    <span className="diff-positiva">
                      {formatearMonedaARS(combo.ahorro_centavos)} (
                      {combo.porcentaje_descuento}% OFF)
                    </span>
                  </td>
                  <td className="num">
                    <strong
                      className={
                        combo.stock_combos_disponibles <= 0
                          ? 'diff-negativa'
                          : 'diff-positiva'
                      }
                    >
                      {combo.stock_combos_disponibles} combo(s)
                    </strong>
                  </td>
                  {puedeEditarCatalogo && (
                    <td>
                      <button
                        type="button"
                        className="btn-danger-outline"
                        style={{ padding: '0.2rem 0.55rem', fontSize: '0.78rem' }}
                        onClick={() =>
                          void manejarEliminarCombo(combo.id, combo.nombre)
                        }
                      >
                        Desactivar
                      </button>
                    </td>
                  )}
                </tr>
              ))
            )}
          </tbody>
        </table>
        <PaginadorTabla
          paginaActual={paginacionCombos.paginaActual}
          totalPaginas={paginacionCombos.totalPaginas}
          totalItems={paginacionCombos.totalItems}
          desdeRegistro={paginacionCombos.desdeRegistro}
          hastaRegistro={paginacionCombos.hastaRegistro}
          tamanioPagina={paginacionCombos.tamanioPagina}
          onCambiarPagina={setPaginaCombos}
          etiquetaItems="combos activos"
        />
      </div>

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
                          src={construirUrlImagenProducto(
                            `${p.id}_thumb.webp`,
                            p.imagen_hash
                              ? `h=${encodeURIComponent(p.imagen_hash)}`
                              : undefined
                          )}
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
                    {sucursales.length > 0 && (
                      <div
                        className="text-muted"
                        style={{ fontSize: '0.75rem', marginTop: '0.2rem' }}
                        title="Distribución de stock por sucursal"
                      >
                        📍{' '}
                        {sucursales
                          .map(
                            (s) =>
                              `${s.nombre}: ${obtenerStockProductoEnSucursalUI(p, s.id)}`
                          )
                          .join(' · ')}
                      </div>
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
