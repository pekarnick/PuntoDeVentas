import React from 'react';
import type { RolUsuario } from '../../domain/permisos.ts';
import type { ResumenEstadoSyncUI } from '../../domain/sync.ts';
import { PanelAuditoria } from '../../features/auditoria/PanelAuditoria.tsx';
import { PanelAyudaManual } from '../../features/ayuda/PanelAyudaManual.tsx';
import { PanelCaja } from '../../features/caja/PanelCaja.tsx';
import { PanelClientesCuentaCorriente } from '../../features/clientes/PanelClientesCuentaCorriente.tsx';
import { PanelComprasProveedores } from '../../features/compras/PanelComprasProveedores.tsx';
import { PanelConfiguracionSync } from '../../features/configuracion/PanelConfiguracionSync.tsx';
import { PanelInformes } from '../../features/informes/PanelInformes.tsx';
import { PanelProductosStock } from '../../features/productos/PanelProductosStock.tsx';
import { PanelUsuarios } from '../../features/usuarios/PanelUsuarios.tsx';
import { PanelVentaPOS } from '../../features/venta/PanelVentaPOS.tsx';
import {
  NOMBRES_OPERADOR,
  type EstadoInicialServidor,
  type PermisosModulosUI,
  type PestaniaActiva,
} from '../../types/estado_app.ts';

export interface ContenedorModuloActivoProps {
  readonly pestania: PestaniaActiva;
  readonly rolActivo: RolUsuario;
  readonly operadorNombreActivo: string;
  readonly datosServidor: EstadoInicialServidor | null;
  readonly resumenSync: ResumenEstadoSyncUI;
  readonly permisos: PermisosModulosUI;
  readonly onCambiarPestania: (nuevaPestania: PestaniaActiva) => void;
  readonly onRecargarEstadoLocal: () => Promise<void>;
  readonly onSubirAhora: () => Promise<void>;
  readonly onBajarAhora: () => Promise<void>;
  readonly onSincronizarCicloCompleto: () => Promise<void>;
}

export function ContenedorModuloActivo({
  pestania,
  rolActivo,
  operadorNombreActivo,
  datosServidor,
  resumenSync,
  permisos,
  onCambiarPestania,
  onRecargarEstadoLocal,
  onSubirAhora,
  onBajarAhora,
  onSincronizarCicloCompleto,
}: ContenedorModuloActivoProps): React.ReactElement {
  const {
    puedeGestionarCompras,
    puedeVerInformes,
    puedeGestionarUsuarios,
    puedeVerAuditoria,
    puedeConfigurarSistema,
  } = permisos;

  return (
    <main className="main-content">
      {pestania === 'venta' && (
        <PanelVentaPOS
          rolActivo={rolActivo}
          operadorNombre={operadorNombreActivo || NOMBRES_OPERADOR[rolActivo]}
          catalogoInicial={datosServidor ? datosServidor.catalogoVenta : []}
          ventasRecientesIniciales={
            datosServidor ? datosServidor.ventasRecientes : []
          }
          clientesDisponibles={datosServidor?.clientes ?? []}
          configArca={datosServidor?.configArca ?? null}
          listasPrecioDisponibles={datosServidor?.listasPrecio ?? []}
          combosDisponibles={datosServidor?.combos ?? []}
          estadoCaja={datosServidor ? datosServidor.estadoCaja : undefined}
          onIrACaja={() => onCambiarPestania('caja')}
          onDatosActualizados={() => void onRecargarEstadoLocal()}
        />
      )}
      {pestania === 'productos' && (
        <PanelProductosStock
          rolActivo={rolActivo}
          productosIniciales={datosServidor ? datosServidor.catalogoAdmin : []}
          categoriasServidor={datosServidor?.categorias ?? []}
          marcasServidor={datosServidor?.marcas ?? []}
          proveedoresServidor={datosServidor?.proveedores ?? []}
          combosIniciales={datosServidor?.combos ?? []}
          sucursalesServidor={datosServidor?.sucursales ?? []}
          sucursalActiva={datosServidor?.sucursalActiva ?? null}
          transferenciasSucursalesServidor={
            datosServidor?.transferenciasSucursales ?? []
          }
          onDatosActualizados={() => void onRecargarEstadoLocal()}
        />
      )}
      {pestania === 'compras' && puedeGestionarCompras && (
        <PanelComprasProveedores
          rolActivo={rolActivo}
          proveedoresServidor={datosServidor?.proveedores ?? []}
          comprasRecientesServidor={datosServidor?.comprasRecientes ?? []}
          catalogoProductos={datosServidor?.catalogoAdmin ?? []}
          categoriasServidor={datosServidor?.categorias ?? []}
          marcasServidor={datosServidor?.marcas ?? []}
          onDatosModificados={() => void onRecargarEstadoLocal()}
        />
      )}
      {pestania === 'clientes' && (
        <PanelClientesCuentaCorriente
          rolActivo={rolActivo}
          clientesServidor={datosServidor?.clientes ?? []}
          onDatosModificados={() => void onRecargarEstadoLocal()}
        />
      )}
      {pestania === 'caja' && (
        <PanelCaja
          rolActivo={rolActivo}
          estadoCajaInicial={datosServidor?.estadoCaja}
          onDatosActualizados={() => void onRecargarEstadoLocal()}
        />
      )}
      {pestania === 'informes' && puedeVerInformes && (
        <PanelInformes
          rolActivo={rolActivo}
          sucursalesDisponibles={datosServidor?.sucursales ?? []}
        />
      )}
      {pestania === 'usuarios' && puedeGestionarUsuarios && <PanelUsuarios />}
      {pestania === 'auditoria' && puedeVerAuditoria && <PanelAuditoria />}
      {pestania === 'configuracion' && puedeConfigurarSistema && (
        <PanelConfiguracionSync
          rolActivo={rolActivo}
          estadoSync={resumenSync}
          configuracionInicial={datosServidor?.configuracionSistema ?? null}
          configVentaMovilInicial={datosServidor?.configVentaMovil ?? null}
          configArcaInicial={datosServidor?.configArca ?? null}
          historialBackupsInicial={[...(datosServidor?.historialBackups ?? [])]}
          espacioImagenes={
            datosServidor?.espacioImagenes ?? {
              cantidadArchivos: 0,
              bytesTotales: 0,
              kbTotales: 0,
              mbTotales: 0,
              porcentajeCuotaGratuita: 0,
            }
          }
          onSubirAhora={onSubirAhora}
          onBajarAhora={onBajarAhora}
          onSincronizarCicloCompleto={onSincronizarCicloCompleto}
          onDatosActualizados={() => void onRecargarEstadoLocal()}
        />
      )}
      {pestania === 'ayuda' && (
        <PanelAyudaManual
          rolActivo={rolActivo}
          onDatosActualizados={() => void onRecargarEstadoLocal()}
        />
      )}
    </main>
  );
}
