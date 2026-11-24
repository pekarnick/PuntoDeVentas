import React, { useEffect, useState } from 'react';
import { invocarPosApi } from '../../db/cliente_pos_api.ts';
import type { RolUsuario } from '../../domain/permisos.ts';
import { REGLAS_SEGURIDAD_FIRESTORE_RECOMENDADAS } from '../../sync/adaptador_firebase.ts';

export interface PanelAyudaManualProps {
  readonly rolActivo: RolUsuario;
  readonly onDatosActualizados?: () => void;
}

type SeccionAyuda =
  | 'manual_uso'
  | 'supabase_sql'
  | 'firebase_rules'
  | 'actualizaciones'
  | 'android_movil';

const GUIA_MODULOS = [
  {
    id: 'uso_solo_pc_tauri',
    titulo: '0. Uso 100% en tu PC (Programa Instalable sin conocimientos técnicos)',
    palabrasClave: 'pc local sin internet tauri instalador github releases facil sin nube',
    contenido: [
      'Podés usar este sistema únicamente con el programa instalado en tu computadora (empaquetado de escritorio Tauri), sin necesidad de configurar servidores, ni cuentas en la nube, ni tener conocimientos técnicos.',
      'Todo lo que cargás (productos, precios, stock, clientes, ventas y cierres de caja) se guarda automáticamente en el disco de tu computadora y funciona aunque se corte internet.',
      'Las opciones de Nube (Supabase / Firebase) y Cajero Móvil son 100% opcionales: solo se usan si más adelante querés tener copia en internet, conectar varias computadoras o cobrar con el celular.',
    ],
  },
  {
    id: 'operadores_login',
    titulo: '1. Asistente de Primer Uso, Login y Control por Cajero',
    palabrasClave: 'login usuario cajero asistente primer uso vendedor clave contraseña rol superadmin',
    contenido: [
      'Asistente de Primer Uso: La primera vez que abrís el programa recién instalado, creás el nombre de tu comercio y tu usuario y contraseña personal de dueño (Superadmin, mín. 8 caracteres). Por seguridad no existen contraseñas de fábrica preestablecidas.',
      'Inicio de Sesión diario: Cada persona ingresa con su propio usuario y contraseña. Podés cerrar sesión en cualquier momento con el botón "🚪 Cerrar sesión" de arriba a la derecha. Desde "Usuarios y Roles" el dueño puede crear encargados y cajeros o cambiar claves (revocando automáticamente las sesiones móviles).',
      'El selector "Probar vista de rol" en el encabezado superior aparece únicamente cuando inicia sesión un Superadmin (para que pueda verificar qué ven el encargado o el cajero). Cuando entra un encargado o un cajero, ve únicamente su propio puesto de trabajo.',
      'Cada venta, apertura/cierre de caja, compra o movimiento de stock queda registrado a nombre del usuario que inició sesión y se puede consultar en "Informes → Control de Operaciones por Usuario / Cajero".',
    ],
  },
  {
    id: 'venta_mostrador',
    titulo: '2. Venta en Mostrador, Combos y Buscador de Clientes',
    palabrasClave: 'venta mostrador codigo barras f2 f4 f9 combo quitar cliente consumidor final descuento',
    contenido: [
      'Atajos rápidos con teclado: F2 lleva el cursor al buscador / lector de código de barras; las flechas ↑/↓ y Enter eligen el producto; Ctrl + "+" / "-" cambia la cantidad; F9 permite pagar combinando dos medios (ej. Efectivo + Transferencia); F4 confirma la venta.',
      'Combos y Promociones: Al tocar un botón rápido de [Combo], se cargan sus artículos y su descuento promocional. Si te equivocaste y querés sacarlo del ticket, tocá el botón "✕ Quitar combo" o la "✕" del renglón sin que la pantalla se tilde ni quede en blanco.',
      'Buscador de Clientes al Cobrar: Por defecto toda venta arranca en "Consumidor Final (Anónimo)". Si necesitás buscar un cliente habitual o anotar en Cuenta Corriente (Fiado), escribí su nombre, DNI o CUIT en el buscador arriba de la lista de clientes.',
      'Privacidad en el mostrador: En la pantalla de venta, tickets y comprobantes nunca se muestran los costos de compra ni la ganancia del comercio.',
    ],
  },
  {
    id: 'productos_stock',
    titulo: '3. Productos, Stock, Transferencias entre Sucursales y Armado de Combos',
    palabrasClave: 'productos stock movimiento ajuste merma buscador listas precio variantes etiquetas sucursales migrar combo componentes',
    contenido: [
      'El stock se calcula siempre sumando las entradas y salidas (compras, ventas, ajustes, mermas y envíos entre sucursales), para que siempre sepas por qué subió o bajó una cantidad.',
      'Buscadores rápidos en todos los selectores: Tanto en "Movimiento de Stock", como en "🚚 Migrar / Transferir Productos entre Sucursales" y en "Componentes y cantidades requeridas por cada combo", tenés un cuadro de búsqueda arriba de cada lista para encontrar cualquier artículo por nombre, código interno o código de barras.',
      'Fotos de productos livianas: Al cargar una foto, el programa la optimiza automáticamente y la guarda en tu carpeta de imágenes sin poner lenta la base de datos.',
    ],
  },
  {
    id: 'compras_proveedores_clientes',
    titulo: '4. Compras a Proveedores, Clientes y Cuentas Corrientes',
    palabrasClave: 'compras proveedores factura buscador articulo stock bajo pedido pdf excel cuenta corriente padron clientes',
    contenido: [
      'Buscador de Artículos en Compras: En "Compras y Proveedores → Registrar Compra a Proveedor", usá el buscador por nombre o código para elegir rápido qué artículo compraste y cargar la factura del proveedor.',
      'Buscador en Padrón de Clientes y Cuentas Corrientes: En la pestaña "Clientes", dentro de "Padrón de Clientes y Cuentas Corrientes", contás con un buscador instantáneo por nombre, CUIT/DNI, teléfono o dirección para encontrar rápido quién tiene saldo pendiente o registrar un pago.',
      'Pedidos Automáticos por Stock Bajo: El sistema te avisa qué artículos están por debajo del mínimo y te permite armar la lista de pedido en PDF o Excel en un clic.',
    ],
  },
  {
    id: 'caja_sucursales_arca',
    titulo: '5. Caja Ciega, Sucursales y Facturación Electrónica ARCA (Opcional)',
    palabrasClave: 'caja arqueo ciego sucursales transferencia arca afip cae factura nota credito',
    contenido: [
      'Arqueo Ciego de Caja: Al cerrar el turno, el cajero anota cuánto dinero físico contó en el cajón sin ver antes cuánto "debería haber". Así el control de sobrantes o faltantes es transparente.',
      'Facturación ARCA (ex-AFIP) Opcional: Por defecto el programa emite Ticket No Fiscal común. Solo si el comercio desea emitir Factura A, B o C electrónica, se activa en Configuración.',
    ],
  },
];

export function PanelAyudaManual({
  rolActivo,
  onDatosActualizados,
}: PanelAyudaManualProps): React.ReactElement {
  const [seccionActiva, setSeccionActiva] =
    useState<SeccionAyuda>('manual_uso');
  const [busquedaManual, setBusquedaManual] = useState('');
  const [sqlSupabaseUnificado, setSqlSupabaseUnificado] = useState<string>(
    'Cargando script SQL unificado (001 a 005)...'
  );
  const [estadoActualizaciones, setEstadoActualizaciones] = useState<{
    versionApp: string;
    rutaBaseDatos: string;
    tamanoDbBytes: number;
    migracionesAplicadas: Array<{
      id: number;
      nombre: string;
      aplicada_en: string;
    }>;
    ultimoBackupAt: string | null;
    ultimoBackupArchivo: string | null;
    pendientesSync: number;
    proveedorNube: string;
  } | null>(null);
  const [mensajeOk, setMensajeOk] = useState<string | null>(null);
  const [mensajeError, setMensajeError] = useState<string | null>(null);
  const [procesandoAccion, setProcesandoAccion] = useState(false);

  useEffect(() => {
    let cancelado = false;
    async function cargarDatosAyuda() {
      try {
        const resSql = await invocarPosApi<{ sql: string }>(
          'obtener_sql_migracion_supabase',
          { rolActivo }
        );
        if (!cancelado && resSql.sql) {
          setSqlSupabaseUnificado(resSql.sql);
        }
      } catch {
        // Fallback silencioso en entorno de tests sin servidor HTTP
      }

      try {
        const resAct = await invocarPosApi<{
          versionApp: string;
          rutaBaseDatos: string;
          tamanoDbBytes: number;
          migracionesAplicadas: Array<{
            id: number;
            nombre: string;
            aplicada_en: string;
          }>;
          ultimoBackupAt: string | null;
          ultimoBackupArchivo: string | null;
          pendientesSync: number;
          proveedorNube: string;
        }>('obtener_estado_actualizaciones', { rolActivo });
        if (!cancelado) {
          setEstadoActualizaciones(resAct);
        }
      } catch {
        // Fallback silencioso
      }
    }
    void cargarDatosAyuda();
    return () => {
      cancelado = true;
    };
  }, [rolActivo]);

  async function copiarTextoAlPortapapeles(
    texto: string,
    mensajeConfirmacion: string
  ) {
    setMensajeError(null);
    setMensajeOk(null);
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard) {
        await navigator.clipboard.writeText(texto);
      }
      setMensajeOk(mensajeConfirmacion);
    } catch (err) {
      setMensajeError(
        err instanceof Error
          ? err.message
          : 'No se pudo copiar al portapapeles.'
      );
    }
  }

  async function manejarCrearBackupPreActualizacion() {
    setMensajeError(null);
    setMensajeOk(null);
    setProcesandoAccion(true);
    try {
      const bkp = await invocarPosApi<{
        ruta_archivo: string;
        tamano_bytes: number;
      }>('crear_backup_manual', { rolActivo });
      setMensajeOk(
        `🛡️ Resguardo pre-actualización creado con éxito en "${bkp.ruta_archivo}" (${(bkp.tamano_bytes / 1024).toFixed(1)} KB). Ya podés ejecutar el instalador de la nueva versión con total seguridad.`
      );
      onDatosActualizados?.();
    } catch (err) {
      setMensajeError(
        err instanceof Error
          ? err.message
          : 'Solo superadmin puede generar el backup manual desde este botón.'
      );
    } finally {
      setProcesandoAccion(false);
    }
  }

  const modulosFiltrados = GUIA_MODULOS.filter((m) => {
    const q = busquedaManual.trim().toLowerCase();
    if (!q) return true;
    const texto =
      `${m.titulo} ${m.palabrasClave} ${m.contenido.join(' ')}`.toLowerCase();
    return texto.includes(q);
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
      {mensajeOk && (
        <div className="alert-ok" role="status">
          {mensajeOk}
        </div>
      )}
      {mensajeError && (
        <div className="alert-error" role="alert">
          {mensajeError}
        </div>
      )}

      <section className="card">
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: '0.75rem',
            marginBottom: '0.85rem',
          }}
        >
          <div>
            <h2 style={{ margin: 0 }}>
              📖 Manual Integrado, Scripts de Nube (Supabase / Firebase), Actualizaciones y Android
            </h2>
            <p className="text-muted" style={{ margin: '0.25rem 0 0 0' }}>
              Documentación completa integrada en la aplicación (funciona 100% offline), con scripts listos para copiar en 1 clic.
            </p>
          </div>
        </div>

        <div
          style={{
            display: 'flex',
            gap: '0.5rem',
            flexWrap: 'wrap',
            borderBottom: '1px solid #e2e8f0',
            paddingBottom: '0.75rem',
          }}
          role="tablist"
          aria-label="Secciones del manual de ayuda"
        >
          <button
            type="button"
            role="tab"
            aria-selected={seccionActiva === 'manual_uso'}
            className={
              seccionActiva === 'manual_uso'
                ? 'btn btn-primary'
                : 'btn btn-secondary'
            }
            onClick={() => setSeccionActiva('manual_uso')}
          >
            📚 Guía de Uso por Módulo
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={seccionActiva === 'supabase_sql'}
            className={
              seccionActiva === 'supabase_sql'
                ? 'btn btn-primary'
                : 'btn btn-secondary'
            }
            onClick={() => setSeccionActiva('supabase_sql')}
          >
            🐘 Script SQL Unificado Supabase (001–004)
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={seccionActiva === 'firebase_rules'}
            className={
              seccionActiva === 'firebase_rules'
                ? 'btn btn-primary'
                : 'btn btn-secondary'
            }
            onClick={() => setSeccionActiva('firebase_rules')}
          >
            🔥 Script y Configuración Firebase
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={seccionActiva === 'actualizaciones'}
            className={
              seccionActiva === 'actualizaciones'
                ? 'btn btn-primary'
                : 'btn btn-secondary'
            }
            onClick={() => setSeccionActiva('actualizaciones')}
          >
            🔄 Cómo Actualizar (PC Binario + Web sin perder datos)
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={seccionActiva === 'android_movil'}
            className={
              seccionActiva === 'android_movil'
                ? 'btn btn-primary'
                : 'btn btn-secondary'
            }
            onClick={() => setSeccionActiva('android_movil')}
          >
            📱 Versión Android del Cajero Móvil
          </button>
        </div>
      </section>

      {seccionActiva === 'manual_uso' && (
        <section className="card">
          <div className="form-group" style={{ marginBottom: '1rem' }}>
            <label htmlFor="input-buscar-manual">
              Buscar en el Manual de Usuario:
            </label>
            <input
              id="input-buscar-manual"
              type="search"
              value={busquedaManual}
              onChange={(e) => setBusquedaManual(e.target.value)}
              placeholder="🔍 Buscá por tema: ej. combo, cajero, stock, compras, consumidor final, arca..."
            />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            {modulosFiltrados.map((mod) => (
              <div
                key={mod.id}
                className="subcard-box"
                style={{ padding: '1rem', borderRadius: '0.6rem' }}
              >
                <h3 style={{ marginTop: 0, marginBottom: '0.5rem' }}>
                  {mod.titulo}
                </h3>
                <ul
                  style={{
                    margin: 0,
                    paddingLeft: '1.25rem',
                    lineHeight: 1.55,
                  }}
                >
                  {mod.contenido.map((parrafo, i) => (
                    <li key={i} style={{ marginBottom: '0.35rem' }}>
                      {parrafo}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>
      )}

      {seccionActiva === 'supabase_sql' && (
        <section className="card">
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: '0.75rem',
              marginBottom: '0.75rem',
            }}
          >
            <div>
              <h3 style={{ margin: 0 }}>
                🐘 Script SQL Unificado de Supabase (Migraciones 001 a 005 en un solo documento)
              </h3>
              <p className="text-muted" style={{ margin: '0.25rem 0 0 0' }}>
                Incluye el esquema inicial completo, Row Level Security (RLS estricto para usuarios autenticados), Storage de imágenes WebP, RPC de Venta Móvil (<code>crear_venta_movil</code>), Facturación ARCA, Combos y Multi-Sucursal. Es 100% idempotente (no borra datos existentes).
              </p>
            </div>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() =>
                void copiarTextoAlPortapapeles(
                  sqlSupabaseUnificado,
                  '✅ Script SQL Unificado Completo de Supabase (001 a 005) copiado al portapapeles.'
                )
              }
            >
              📋 Copiar Script SQL Completo de Supabase
            </button>
          </div>

          <div
            className="subcard-box"
            style={{
              padding: '0.85rem',
              borderRadius: '0.5rem',
              marginBottom: '0.85rem',
            }}
          >
            <strong>Pasos para inicializar y asegurar tu base en Supabase:</strong>
            <ol style={{ margin: '0.45rem 0 0 1.2rem', lineHeight: 1.55 }}>
              <li>
                Ingresá a{' '}
                <a
                  href="https://supabase.com/dashboard"
                  target="_blank"
                  rel="noreferrer"
                >
                  supabase.com/dashboard
                </a>{' '}
                y abrí tu proyecto.
              </li>
              <li>
                En el menú lateral izquierdo, abrí <strong>SQL Editor</strong> y
                hacé clic en <strong>+ New query</strong>.
              </li>
              <li>
                Presioná el botón{' '}
                <strong>"📋 Copiar Script SQL Completo de Supabase"</strong> de
                arriba, pegalo en el editor y hacé clic en{' '}
                <strong>Run (Ctrl + Enter)</strong>.
              </li>
              <li>
                En <strong>Authentication → Users → Add user</strong> creá tu usuario con email y contraseña, y asignale <code>comercio_id</code> y <code>rol</code> en <code>raw_app_meta_data</code> (guía paso a paso en el Manual Módulo 10).
              </li>
              <li>
                En <strong>Project Settings → API</strong> copiá la{' '}
                <code>Project URL</code> y la clave pública <code>anon</code>{' '}
                (nunca la <code>service_role</code>), pegalas en{' '}
                <strong>Configuración</strong> e iniciá sesión en la nube.
              </li>
            </ol>
          </div>

          <textarea
            readOnly
            aria-label="Script SQL Unificado de Supabase"
            value={sqlSupabaseUnificado}
            style={{
              width: '100%',
              minHeight: '340px',
              fontFamily: 'monospace',
              fontSize: '0.8rem',
              padding: '0.75rem',
              borderRadius: '0.5rem',
              border: '1px solid #cbd5e1',
              background: '#0f172a',
              color: '#f8fafc',
            }}
          />
        </section>
      )}

      {seccionActiva === 'firebase_rules' && (
        <section className="card">
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: '0.75rem',
              marginBottom: '0.75rem',
            }}
          >
            <div>
              <h3 style={{ margin: 0 }}>
                🔥 Configuración y Reglas de Seguridad de Firebase (Cloud Firestore)
              </h3>
              <p className="text-muted" style={{ margin: '0.25rem 0 0 0' }}>
                Cómo activar Cloud Firestore y copiar toda la base de datos local sin generar registros repetidos.
              </p>
            </div>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() =>
                void copiarTextoAlPortapapeles(
                  REGLAS_SEGURIDAD_FIRESTORE_RECOMENDADAS,
                  '✅ Reglas de Seguridad de Firebase Firestore copiadas al portapapeles.'
                )
              }
            >
              📋 Copiar Reglas de Seguridad de Firestore
            </button>
          </div>

          <div
            className="subcard-box"
            style={{
              padding: '0.85rem',
              borderRadius: '0.5rem',
              marginBottom: '0.85rem',
            }}
          >
            <strong>
              Pasos para que Firebase Firestore guarde correctamente sin duplicados:
            </strong>
            <ol style={{ margin: '0.45rem 0 0 1.2rem', lineHeight: 1.55 }}>
              <li>
                Entrá a{' '}
                <a
                  href="https://console.firebase.google.com/"
                  target="_blank"
                  rel="noreferrer"
                >
                  console.firebase.google.com
                </a>
                , creá o abrí tu proyecto, activá <strong>Authentication (Correo electrónico/contraseña)</strong> creando tu usuario con los claims <code>comercio_id</code> y <code>rol</code>, y habilitá{' '}
                <strong>Compilación → Firestore Database → Crear base de datos</strong>{' '}
                (base por defecto <code>(default)</code>).
              </li>
              <li>
                Dentro de <strong>Firestore Database</strong>, abrí la pestaña{' '}
                <strong>Reglas (Rules)</strong>, pegá el script de abajo y
                presioná <strong>Publicar (Publish)</strong>. Luego iniciá sesión en Firebase desde <strong>Configuración</strong>.
              </li>
              <li>
                En <strong>Configuración del proyecto (⚙️) → General</strong>,
                copiá el <strong>ID del proyecto</strong> (ej.{' '}
                <code>mi-pos-comercio</code>) y la{' '}
                <strong>Clave de API web</strong> (<code>AIza...</code>).
              </li>
              <li>
                En este sistema, andá a <strong>Configuración</strong>, elegí el
                proveedor <strong>Firebase</strong> o{' '}
                <strong>Ambos en paralelo (Supabase + Firebase)</strong>, pegá
                ambos datos y presioná el botón{' '}
                <strong>
                  "🔥 Copiar toda la base a Firebase ahora (Sin repetidos)"
                </strong>
                .
              </li>
              <li>
                <strong>¿Por qué nunca duplica datos?</strong> Cada registro se
                escribe usando su ruta determinística exacta con su UUIDv7:{' '}
                <code>
                  comercios/&#123;comercioId&#125;/&#123;tabla&#125;/&#123;id&#125;
                </code>
                . Si presionás el botón varias veces, Firestore actualiza el
                mismo documento existente en su lugar y jamás crea duplicados.
              </li>
            </ol>
          </div>

          <textarea
            readOnly
            aria-label="Reglas de Seguridad de Firebase Firestore"
            value={REGLAS_SEGURIDAD_FIRESTORE_RECOMENDADAS}
            style={{
              width: '100%',
              minHeight: '240px',
              fontFamily: 'monospace',
              fontSize: '0.82rem',
              padding: '0.75rem',
              borderRadius: '0.5rem',
              border: '1px solid #cbd5e1',
              background: '#0f172a',
              color: '#f8fafc',
            }}
          />
        </section>
      )}

      {seccionActiva === 'actualizaciones' && (
        <section className="card">
          <h3 style={{ marginTop: 0 }}>
            🔄 Cómo Actualizar el Programa desde GitHub Releases sin Perder tus Datos
          </h3>
          <p className="text-muted">
            Esta guía está pensada para <strong>personas no técnicas</strong> que
            usan el <strong>programa instalable en la computadora (Tauri para Windows)</strong>,
            y también contempla el caso en que uses la sincronización en la nube.{' '}
            <strong>Tus productos, precios, clientes, caja y ventas nunca se borran al actualizar.</strong>
          </p>

          {estadoActualizaciones && (
            <div
              className="subcard-box"
              style={{
                padding: '0.85rem',
                borderRadius: '0.5rem',
                marginBottom: '1rem',
              }}
            >
              <strong>Estado actual de tus datos guardados en esta computadora:</strong>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))',
                  gap: '0.6rem',
                  marginTop: '0.5rem',
                  fontSize: '0.86rem',
                }}
              >
                <div>
                  <strong>Archivo de tus datos (Base Local):</strong>{' '}
                  <code>{estadoActualizaciones.rutaBaseDatos}</code>
                </div>
                <div>
                  <strong>Tamaño actual:</strong>{' '}
                  {(estadoActualizaciones.tamanoDbBytes / 1024).toFixed(1)} KB
                </div>
                <div>
                  <strong>Versión de estructura de datos:</strong>{' '}
                  {estadoActualizaciones.migracionesAplicadas.length} etapas aplicadas (
                  {estadoActualizaciones.migracionesAplicadas
                    .map((m) => m.nombre.split('_')[0])
                    .join(', ')}
                  )
                </div>
                <div>
                  <strong>Pendientes de subir a nube:</strong>{' '}
                  {estadoActualizaciones.pendientesSync} registro(s)
                </div>
              </div>
              <div style={{ marginTop: '0.75rem' }}>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={procesandoAccion}
                  onClick={() => void manejarCrearBackupPreActualizacion()}
                >
                  🛡️ Paso 1: Crear Copia de Seguridad antes de Actualizar
                </button>
              </div>
            </div>
          )}

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
              gap: '1rem',
            }}
          >
            <div
              className="subcard-box"
              style={{ padding: '1rem', borderRadius: '0.6rem' }}
            >
              <h4 style={{ marginTop: 0 }}>
                💻 Si usás solo el Programa en tu PC (Descargado desde GitHub Releases)
              </h4>
              <p style={{ fontSize: '0.88rem', marginBottom: '0.5rem' }}>
                No necesitás saber programación ni usar comandos. Cada vez que
                salga una versión nueva en <strong>GitHub Releases</strong>, seguí
                estos <strong>4 pasos simples</strong>:
              </p>
              <ol style={{ paddingLeft: '1.2rem', lineHeight: 1.6 }}>
                <li>
                  <strong>Hacé una copia preventiva en 1 clic:</strong> Tocá el
                  botón azul{' '}
                  <strong>"🛡️ Paso 1: Crear Copia de Seguridad antes de Actualizar"</strong>{' '}
                  que está acá arriba.
                </li>
                <li>
                  <strong>Cerrá el programa Punto de Venta</strong> como cerrás
                  cualquier ventana en Windows (con la X de arriba a la derecha).
                </li>
                <li>
                  <strong>Descargá el instalador nuevo desde GitHub Releases:</strong>{' '}
                  Entrá a la página de <strong>Releases de GitHub</strong> del
                  proyecto, buscá la última versión publicada y hacé clic en el
                  archivo instalador para Windows (termina en{' '}
                  <code>.msi</code> o en <code>-setup.exe</code>).
                </li>
                <li>
                  <strong>Instalá haciendo doble clic:</strong> Abrí el archivo
                  descargado y dale a <em>Siguiente → Instalar → Finalizar</em>.
                  Windows actualiza solo el programa y{' '}
                  <strong>
                    deja intactos todos tus productos, precios, fotos, clientes y
                    ventas
                  </strong>
                  . Si la nueva versión trae funciones nuevas, tu base de datos
                  se adapta sola automáticamente al abrir el programa.
                </li>
              </ol>
              <div
                style={{
                  marginTop: '0.65rem',
                  padding: '0.6rem',
                  background: '#f8fafc',
                  borderRadius: '0.4rem',
                  border: '1px solid #e2e8f0',
                  fontSize: '0.84rem',
                }}
              >
                💡 <strong>¿Y si cambio de computadora en el mostrador?</strong>{' '}
                Instalás el programa desde GitHub Releases en la computadora
                nueva y en la pestaña <strong>Configuración → Copias de Seguridad</strong>{' '}
                elegís el archivo de backup (o si usabas nube, tocás{' '}
                <strong>"↓ Bajar datos ahora"</strong>) y recuperás todo tu negocio
                en segundos.
              </div>
            </div>

            <div
              className="subcard-box"
              style={{ padding: '1rem', borderRadius: '0.6rem' }}
            >
              <h4 style={{ marginTop: 0 }}>
                🌐 Si además usás Nube opcional (Supabase, Firebase o Cajero Web)
              </h4>
              <p style={{ fontSize: '0.88rem', marginBottom: '0.5rem' }}>
                Si aparte del programa en la PC activaste la nube para respaldo o
                para cobrar con celular:
              </p>
              <ol style={{ paddingLeft: '1.2rem', lineHeight: 1.6 }}>
                <li>
                  <strong>En Supabase (sin perder datos):</strong> Si una versión
                  nueva avisa que hay cambios en la nube, copiás el{' '}
                  <strong>Script SQL Unificado</strong> de la pestaña de al lado y
                  lo ejecutás en Supabase. Está preparado con{' '}
                  <code>IF NOT EXISTS</code> para agregar solo lo nuevo{' '}
                  <strong>sin borrar ni tocar ningún producto ni venta cargada</strong>.
                </li>
                <li>
                  <strong>En Firebase Firestore (sin repetidos):</strong> Desde{' '}
                  <strong>Configuración</strong> podés tocar{' '}
                  <strong>"🔥 Copiar toda la base a Firebase ahora (Sin repetidos)"</strong>.
                  Actualiza cada ficha sobre su propio identificador único sin
                  duplicar jamás un registro.
                </li>
                <li>
                  <strong>En el Cajero Móvil (/web-pos):</strong> Desde{' '}
                  <strong>Configuración → Publicación Automática en Netlify</strong>,
                  tocás <strong>"🚀 Redesplegar Actualización en 1 Clic"</strong> y
                  los celulares reciben la mejora manteniendo el mismo código QR.
                </li>
              </ol>
            </div>
          </div>
        </section>
      )}

      {seccionActiva === 'android_movil' && (
        <section className="card">
          <h3 style={{ marginTop: 0 }}>
            📱 Cómo Tener la Versión Android del Cajero Móvil (/web-pos)
          </h3>
          <p className="text-muted">
            Siguiendo la arquitectura de <strong>PLAN.md §6.2</strong>, el
            cajero móvil se conecta por HTTPS contra Supabase (sin requerir
            certificados locales ni configurar IPs en la red Wi-Fi del local) y
            aplica la <strong>Regla 20</strong> (jamás incluye{' '}
            <code>costo_compra</code>) y la <strong>Regla 8</strong> (sin claves
            secretas en el teléfono). Tenés <strong>dos formas</strong> de
            usarlo como aplicación Android:
          </p>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
              gap: '1rem',
              marginTop: '0.75rem',
            }}
          >
            <div
              className="subcard-box"
              style={{ padding: '1rem', borderRadius: '0.6rem' }}
            >
              <h4 style={{ marginTop: 0 }}>
                ⚡ Opción 1 (Inmediata, sin tiendas ni cables): Instalar WebAPK Nativa desde Chrome Android
              </h4>
              <p style={{ fontSize: '0.88rem', lineHeight: 1.5 }}>
                El módulo <code>/web-pos</code> ya incluye manifiesto nativo de
                aplicación (<code>manifest.webmanifest</code> con{' '}
                <code>display: standalone</code>), íconos dedicados y acceso a
                la cámara trasera con autofoco y linterna para leer códigos de
                barras EAN-13.
              </p>
              <ol style={{ paddingLeft: '1.2rem', lineHeight: 1.55 }}>
                <li>
                  Escaneá el <strong>Código QR de Venta Móvil</strong> desde la
                  pestaña Configuración con cualquier teléfono Android.
                </li>
                <li>
                  En Chrome para Android, tocá el menú <strong>⋮</strong>{' '}
                  (arriba a la derecha) y elegí{' '}
                  <strong>"Instalar aplicación"</strong> (o{' '}
                  <em>"Agregar a la pantalla principal"</em>).
                </li>
                <li>
                  Android compila e instala un paquete <strong>WebAPK</strong>{' '}
                  en el cajón de aplicaciones con su propio ícono{' '}
                  <strong>"POS Venta Móvil"</strong>, corriendo a pantalla
                  completa sin barra de direcciones y con cola offline con UUID
                  idempotente por si se corta el Wi-Fi o los datos móviles en el
                  pasillo del local.
                </li>
              </ol>
            </div>

            <div
              className="subcard-box"
              style={{ padding: '1rem', borderRadius: '0.6rem' }}
            >
              <h4 style={{ marginTop: 0 }}>
                📦 Opción 2: Generar archivo instalable .APK para Android (PWABuilder / TWA o Tauri Android)
              </h4>
              <p style={{ fontSize: '0.88rem', lineHeight: 1.5 }}>
                Si querés distribuir un archivo <code>.apk</code> directo a los
                celulares o colectores Android (ej. Sunmi, Zebra, teléfonos del
                personal):
              </p>
              <ol style={{ paddingLeft: '1.2rem', lineHeight: 1.55 }}>
                <li>
                  <strong>Vía PWABuilder (en 2 minutos sin Android Studio):</strong>{' '}
                  Publicá el cajero móvil en Netlify desde Configuración, abrí{' '}
                  <a
                    href="https://www.pwabuilder.com"
                    target="_blank"
                    rel="noreferrer"
                  >
                    pwabuilder.com
                  </a>
                  , pegá la URL pública de tu <code>/web-pos</code> y hacé clic
                  en <strong>Package for stores → Android → Download APK</strong>
                  . Obtendrás un <code>.apk</code> firmado (Trusted Web Activity)
                  que se actualiza solo cada vez que redesplegás en Netlify.
                </li>
                <li>
                  <strong>Vía Capacitor / Tauri 2 Mobile (Compilación local):</strong>{' '}
                  El proyecto compila el bundle móvil estático mediante{' '}
                  <code>npm run build:web-pos</code> (en la carpeta{' '}
                  <code>dist-web-pos/</code>), el cual puede empaquetarse en un
                  APK nativo con Tauri 2 Android (
                  <code>npx tauri android init && npx tauri android build --apk</code>
                  ) o Capacitor.
                </li>
              </ol>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
