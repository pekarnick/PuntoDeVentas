import { useCallback, useEffect, useState } from 'react';
import type { ModoTemaVisual } from '../types/estado_app.ts';

const CLAVE_TEMA_STORAGE = 'pos_tema_visual';

function leerTemaInicial(): ModoTemaVisual {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      const guardado = window.localStorage.getItem(CLAVE_TEMA_STORAGE);
      if (guardado === 'oscuro' || guardado === 'claro') {
        return guardado;
      }
    }
  } catch {
    // En entornos sin localStorage usar claro por defecto
  }
  return 'claro';
}

export interface UseTemaVisualResultado {
  readonly modoTema: ModoTemaVisual;
  readonly alternarTemaVisual: () => void;
}

export function useTemaVisual(): UseTemaVisualResultado {
  const [modoTema, setModoTema] = useState<ModoTemaVisual>(() =>
    leerTemaInicial()
  );

  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.setAttribute('data-theme', modoTema);
      document.body.setAttribute('data-theme', modoTema);
    }
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        window.localStorage.setItem(CLAVE_TEMA_STORAGE, modoTema);
      }
    } catch {
      // Ignorar fallo de almacenamiento local
    }
  }, [modoTema]);

  const alternarTemaVisual = useCallback(() => {
    setModoTema((prev) => (prev === 'claro' ? 'oscuro' : 'claro'));
  }, []);

  return {
    modoTema,
    alternarTemaVisual,
  };
}
