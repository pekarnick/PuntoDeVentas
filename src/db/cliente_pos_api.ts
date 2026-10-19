/**
 * Cliente HTTP local para comunicar la interfaz React con la base SQLite en disco (data/pos_local.db).
 */

export async function invocarPosApi<T>(
  accion: string,
  payload: Record<string, unknown> = {}
): Promise<T> {
  const respuesta = await fetch('/api/pos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accion, payload }),
  });

  const json = (await respuesta.json()) as
    | { ok: true; data: T }
    | { ok: false; error: string };

  if (!json.ok) {
    throw new Error(json.error);
  }
  return json.data;
}
