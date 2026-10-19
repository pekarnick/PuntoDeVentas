/**
 * Sistema de migraciones versionadas para SQLite (PLAN.md §2 y AGENTS.md).
 * Ejecuta archivos .sql ordenados desde /migrations dentro de transacciones atómicas.
 */

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';

const requireNode = createRequire(import.meta.url);
const { DatabaseSync } = requireNode('node:sqlite') as {
  DatabaseSync: new (location: string) => DatabaseSyncType;
};

export interface MigracionAplicada {
  readonly version: string;
  readonly nombre: string;
  readonly aplicada_at: string;
}

/**
 * Inicializa una conexión SQLite con claves foráneas activas y aplica todas las migraciones pendientes.
 */
export function crearBaseDatos(
  rutaArchivo: string = ':memory:',
  directorioMigraciones: string = path.resolve(process.cwd(), 'migrations')
): DatabaseSyncType {
  const db = new DatabaseSync(rutaArchivo);
  db.exec('PRAGMA foreign_keys = ON;');
  if (rutaArchivo !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL;');
  }
  aplicarMigraciones(db, directorioMigraciones);
  return db;
}

/**
 * Aplica las migraciones .sql pendientes en orden lexicográfico.
 */
export function aplicarMigraciones(
  db: DatabaseSyncType,
  directorioMigraciones: string = path.resolve(process.cwd(), 'migrations')
): MigracionAplicada[] {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migraciones (
      version TEXT PRIMARY KEY NOT NULL,
      nombre TEXT NOT NULL,
      aplicada_at TEXT NOT NULL
    );
  `);

  const aplicadasRows = db
    .prepare('SELECT version, nombre, aplicada_at FROM _migraciones ORDER BY version ASC')
    .all() as unknown as MigracionAplicada[];
  const versionesAplicadas = new Set(aplicadasRows.map((r) => r.version));

  const archivos = fs
    .readdirSync(directorioMigraciones)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const nuevasAplicadas: MigracionAplicada[] = [];

  for (const archivo of archivos) {
    const version = archivo.split('_')[0] ?? archivo;
    if (versionesAplicadas.has(version)) {
      continue;
    }

    const rutaCompleta = path.join(directorioMigraciones, archivo);
    const sql = fs.readFileSync(rutaCompleta, 'utf-8');
    const ahora = new Date().toISOString();

    db.exec('BEGIN IMMEDIATE;');
    try {
      db.exec(sql);
      db.prepare(
        'INSERT INTO _migraciones (version, nombre, aplicada_at) VALUES (?, ?, ?)'
      ).run(version, archivo, ahora);
      db.exec('COMMIT;');

      nuevasAplicadas.push({
        version,
        nombre: archivo,
        aplicada_at: ahora,
      });
    } catch (error) {
      db.exec('ROLLBACK;');
      throw error;
    }
  }

  return nuevasAplicadas;
}
