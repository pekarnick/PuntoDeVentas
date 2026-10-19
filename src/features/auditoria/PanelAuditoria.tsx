import React, { useMemo, useState } from 'react';
import {
  calcularHashAuditoria,
  HASH_GENESIS_AUDITORIA,
  verificarCadenaAuditoria,
  type RegistroAuditoriaCompleto,
  type ResultadoVerificacionAuditoria,
} from '../../domain/auditoria.ts';
import { formatearFechaHoraAR } from '../../domain/dinero.ts';

function construirRegistrosDemostracion(): RegistroAuditoriaCompleto[] {
  const base1 = {
    id: '018f0000-0000-7000-8000-000000000001',
    comercio_id: 'com-1',
    fecha_hora: '2026-10-19T12:00:00.000Z',
    usuario_id: 'usr-1',
    usuario_nombre: 'María Superadmin',
    rol: 'superadmin',
    device_id: 'terminal-caja-1',
    accion: 'inicializar_comercio',
    entidad: 'comercios',
    entidad_id: 'com-1',
    valores_antes: null,
    valores_despues: '{"nombre":"Kiosco El Sol"}',
    motivo: null,
  };
  const hash1 = calcularHashAuditoria(base1, HASH_GENESIS_AUDITORIA);
  const reg1: RegistroAuditoriaCompleto = {
    ...base1,
    hash_prev: HASH_GENESIS_AUDITORIA,
    hash: hash1,
  };

  const base2 = {
    id: '018f0000-0000-7000-8000-000000000002',
    comercio_id: 'com-1',
    fecha_hora: '2026-10-19T12:15:00.000Z',
    usuario_id: 'usr-2',
    usuario_nombre: 'Carlos Encargado',
    rol: 'encargado',
    device_id: 'terminal-caja-1',
    accion: 'stock_ajuste',
    entidad: 'movimientos_stock',
    entidad_id: 'mov-1',
    valores_antes: null,
    valores_despues: '{"cantidad":-2,"producto_id":"prod-1"}',
    motivo: 'Envases aplastados en depósito',
  };
  const hash2 = calcularHashAuditoria(base2, reg1.hash);
  const reg2: RegistroAuditoriaCompleto = {
    ...base2,
    hash_prev: reg1.hash,
    hash: hash2,
  };

  const base3 = {
    id: '018f0000-0000-7000-8000-000000000003',
    comercio_id: 'com-1',
    fecha_hora: '2026-10-19T12:30:00.000Z',
    usuario_id: 'usr-3',
    usuario_nombre: 'Lucas Cajero',
    rol: 'cajero',
    device_id: 'terminal-caja-1',
    accion: 'venta_anular',
    entidad: 'ventas',
    entidad_id: 'vta-1',
    valores_antes: '{"estado":"completada","total":450000}',
    valores_despues: '{"estado":"anulada"}',
    motivo: 'Error al escanear cantidad',
    autorizado_por_id: 'usr-2',
    autorizado_por_nombre: 'Carlos Encargado',
  };
  const hash3 = calcularHashAuditoria(base3, reg2.hash);
  const reg3: RegistroAuditoriaCompleto = {
    ...base3,
    hash_prev: reg2.hash,
    hash: hash3,
  };

  return [reg1, reg2, reg3];
}

export function PanelAuditoria(): React.ReactElement {
  const [registros] = useState<RegistroAuditoriaCompleto[]>(() =>
    construirRegistrosDemostracion()
  );
  const [filtroAccion, setFiltroAccion] = useState('');
  const [filtroEntidad, setFiltroEntidad] = useState('');
  const [resultadoIntegridad, setResultadoIntegridad] =
    useState<ResultadoVerificacionAuditoria | null>(null);

  const registrosFiltrados = useMemo(() => {
    return registros.filter((r) => {
      if (filtroAccion && !r.accion.includes(filtroAccion.trim().toLowerCase())) {
        return false;
      }
      if (filtroEntidad && r.entidad !== filtroEntidad) {
        return false;
      }
      return true;
    });
  }, [registros, filtroAccion, filtroEntidad]);

  function manejarVerificarIntegridad() {
    const resultado = verificarCadenaAuditoria(registros);
    setResultadoIntegridad(resultado);
  }

  return (
    <section className="pos-card">
      <div className="card-header">
        <div>
          <h2>Registro Inmutable de Auditoría (Solo Superadmin)</h2>
          <p className="text-muted">
            Tabla append-only con hash encadenado SHA-256. Ningún rol puede editar ni borrar registros.
          </p>
        </div>
        <button
          type="button"
          className="btn-primary"
          onClick={manejarVerificarIntegridad}
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
            ? `Cadena SHA-256 íntegra: se verificaron ${resultadoIntegridad.totalRegistros} eslabones desde GENESIS sin alteraciones.`
            : `Alerta de alteración en registro ${resultadoIntegridad.registroAlteradoId}: ${resultadoIntegridad.motivoFallo}`}
        </div>
      )}

      <div className="form-row">
        <label>
          Filtrar por acción:
          <input
            type="text"
            value={filtroAccion}
            onChange={(e) => setFiltroAccion(e.target.value)}
            placeholder="Ej. venta_anular, stock_ajuste..."
          />
        </label>
        <label>
          Entidad:
          <select
            value={filtroEntidad}
            onChange={(e) => setFiltroEntidad(e.target.value)}
          >
            <option value="">Todas</option>
            <option value="comercios">comercios</option>
            <option value="usuarios">usuarios</option>
            <option value="movimientos_stock">movimientos_stock</option>
            <option value="ventas">ventas</option>
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
          {registrosFiltrados.map((r) => (
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
    </section>
  );
}
