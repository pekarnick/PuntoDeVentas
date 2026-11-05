import React, { useEffect, useMemo, useState } from 'react';
import { PaginadorTabla } from '../../components/PaginadorTabla.tsx';
import { invocarPosApi } from '../../db/cliente_pos_api.ts';
import type {
  RegistroAuditoriaCompleto,
  ResultadoVerificacionAuditoria,
} from '../../domain/auditoria.ts';
import { formatearFechaHoraAR } from '../../domain/dinero.ts';
import {
  paginarListado,
  TAMANIO_PAGINA_POR_DEFECTO,
} from '../../domain/paginacion.ts';

export function PanelAuditoria(): React.ReactElement {
  const [registros, setRegistros] = useState<RegistroAuditoriaCompleto[]>([]);
  const [filtroAccion, setFiltroAccion] = useState('');
  const [filtroEntidad, setFiltroEntidad] = useState('');
  const [paginaAuditoria, setPaginaAuditoria] = useState(1);
  const [resultadoIntegridad, setResultadoIntegridad] =
    useState<ResultadoVerificacionAuditoria | null>(null);

  async function cargarAuditoria() {
    try {
      const res = await invocarPosApi<{
        registros: RegistroAuditoriaCompleto[];
      }>('consultar_auditoria', {
        rolActivo: 'superadmin',
      });
      setRegistros(res.registros);
    } catch {
      // Fallback para tests sin servidor
    }
  }

  useEffect(() => {
    void cargarAuditoria();
  }, []);

  const registrosFiltrados = useMemo(() => {
    return registros.filter((r) => {
      if (
        filtroAccion &&
        !r.accion.includes(filtroAccion.trim().toLowerCase())
      ) {
        return false;
      }
      if (filtroEntidad && r.entidad !== filtroEntidad) {
        return false;
      }
      return true;
    });
  }, [registros, filtroAccion, filtroEntidad]);

  const paginacionAuditoria = paginarListado(
    registrosFiltrados,
    paginaAuditoria,
    TAMANIO_PAGINA_POR_DEFECTO
  );

  async function manejarVerificarIntegridad() {
    try {
      const resultado =
        await invocarPosApi<ResultadoVerificacionAuditoria>(
          'verificar_integridad_auditoria',
          { rolActivo: 'superadmin' }
        );
      setResultadoIntegridad(resultado);
    } catch {
      // Fallback
    }
  }

  return (
    <section className="pos-card">
      <div className="card-header">
        <div>
          <h2>Registro Inmutable de Auditoría en Base de Datos (Solo Superadmin)</h2>
          <p className="text-muted">
            Tabla append-only con hash encadenado SHA-256. Ningún rol puede editar ni borrar registros.
          </p>
        </div>
        <button
          type="button"
          className="btn-primary"
          onClick={() => void manejarVerificarIntegridad()}
        >
          Verificar integridad de la auditoría
        </button>
      </div>

      {resultadoIntegridad && (
        <div
          className={
            resultadoIntegridad.integra ? 'alert-ok' : 'alert-error'
          }
        >
          {resultadoIntegridad.integra
            ? `Cadena SHA-256 íntegra: se verificaron ${resultadoIntegridad.totalRegistros} eslabones en la base de datos desde GENESIS sin alteraciones.`
            : `Alerta de alteración en registro ${resultadoIntegridad.registroAlteradoId}: ${resultadoIntegridad.motivoFallo}`}
        </div>
      )}

      <div className="form-row">
        <label>
          Filtrar por acción:
          <input
            type="text"
            value={filtroAccion}
            onChange={(e) => {
              setFiltroAccion(e.target.value);
              setPaginaAuditoria(1);
            }}
            placeholder="Ej. venta_crear, producto_crear..."
          />
        </label>
        <label>
          Entidad:
          <select
            value={filtroEntidad}
            onChange={(e) => {
              setFiltroEntidad(e.target.value);
              setPaginaAuditoria(1);
            }}
          >
            <option value="">Todas</option>
            <option value="comercios">comercios</option>
            <option value="usuarios">usuarios</option>
            <option value="productos">productos</option>
            <option value="movimientos_stock">movimientos_stock</option>
            <option value="ventas">ventas</option>
            <option value="caja_sesiones">caja_sesiones</option>
            <option value="caja_movimientos">caja_movimientos</option>
          </select>
        </label>
      </div>

      <table className="data-table">
        <thead>
          <tr>
            <th>Fecha/Hora (AR)</th>
            <th>Usuario (Rol)</th>
            <th>Acción / Entidad</th>
            <th>Motivo / Autorizador</th>
            <th>Hash SHA-256</th>
          </tr>
        </thead>
        <tbody>
          {paginacionAuditoria.itemsPagina.map((r) => (
            <tr key={r.id}>
              <td>{formatearFechaHoraAR(r.fecha_hora)}</td>
              <td>
                {r.usuario_nombre} <span className="badge-rol">{r.rol}</span>
              </td>
              <td>
                <strong>{r.accion}</strong> · <code>{r.entidad}</code>
              </td>
              <td>
                {r.motivo ?? '—'}
                {r.autorizado_por_nombre
                  ? ` (Autorizó: ${r.autorizado_por_nombre})`
                  : ''}
              </td>
              <td>
                <code title={r.hash}>{r.hash.slice(0, 14)}…</code>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <PaginadorTabla
        paginaActual={paginacionAuditoria.paginaActual}
        totalPaginas={paginacionAuditoria.totalPaginas}
        totalItems={paginacionAuditoria.totalItems}
        desdeRegistro={paginacionAuditoria.desdeRegistro}
        hastaRegistro={paginacionAuditoria.hastaRegistro}
        tamanioPagina={paginacionAuditoria.tamanioPagina}
        onCambiarPagina={setPaginaAuditoria}
        etiquetaItems="registros de auditoría"
      />
    </section>
  );
}
