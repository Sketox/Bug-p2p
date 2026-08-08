// En qué sala estabas cuando la página se descargó.
//
// La malla ya sabía reconectar: tu identidad es estable por sala, la señalización desaloja tu
// sesión fantasma y cualquier nodo te reenvía el log completo para que reconstruyas la partida. Lo
// que faltaba era más tonto: **la web se olvidaba de en qué sala estabas** y te devolvía al menú.
// Recargabas y, aunque la mesa te seguía guardando el sitio, tú ya no sabías volver.
//
// Se guarda en `sessionStorage` a propósito, no en `localStorage`: sobrevive a un F5 (que es el
// caso) pero es de esta pestaña. Dos pestañas del mismo navegador son dos jugadores distintos, y
// compartir la sesión entre ellas las convertiría en el mismo — con la misma identidad, peleándose
// por el mismo sitio en la mesa.

const KEY = 'bug:room';

export interface SavedRoom {
  code: string;
  name: string;
}

/**
 * Una invitación explícita manda sobre la sala que esta pestaña recuerde de antes.
 *
 * Sin esta prioridad, abrir `?r=YW1T` desde una pestaña que había estado en `IT71` dejaba la URL
 * nueva a la vista pero volvía silenciosamente a `IT71`: parecía que la invitación había creado
 * otra sala y ninguno de los dos jugadores podía verse.
 */
export function chooseSavedRoom(saved: SavedRoom | null, invitedRoom: string | null): SavedRoom | null {
  return invitedRoom ? null : saved;
}

export function saveRoom(room: SavedRoom): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(room));
  } catch {
    /* modo privado: sin memoria de sesión. Se juega igual; solo no se sobrevive a un F5. */
  }
}

export function loadRoom(): SavedRoom | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SavedRoom>;
    if (typeof parsed.code !== 'string' || typeof parsed.name !== 'string') return null;
    if (!parsed.code || !parsed.name) return null;
    return { code: parsed.code, name: parsed.name };
  } catch {
    return null;
  }
}

/** Se olvida la sala. Solo al SALIR de verdad: una recarga tiene que poder volver. */
export function clearRoom(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* nada que limpiar */
  }
}
