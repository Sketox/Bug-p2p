// Relojes lógicos de Lamport: dan un ORDEN TOTAL a eventos concurrentes sin reloj compartido.
//
// En una malla P2P no hay "hora oficial": los relojes de pared van desfasados y no sirven para
// decidir quién actuó primero. Lamport resuelve esto con un contador por nodo y dos reglas:
//
//   1. Antes de emitir un evento:  t = t + 1        → `tick()`
//   2. Al recibir un evento ajeno: t = max(t, r) + 1 → `update(r)`
//
// Eso garantiza la relación "happened-before": si A causó B, entonces lamport(A) < lamport(B).
// Lo que NO garantiza es unicidad — dos nodos pueden emitir con el mismo lamport (son eventos
// genuinamente concurrentes, sin relación causal). Para que TODOS los nodos elijan el mismo
// orden en ese caso hace falta un desempate determinista: usamos el peerId (ver `compareStamped`).

/** Reloj lógico de un nodo. */
export class LamportClock {
  private t: number;

  constructor(start = 0) {
    this.t = start;
  }

  /** Valor actual (sin avanzar). */
  get time(): number {
    return this.t;
  }

  /** Regla 1: avanza el reloj para sellar un evento propio. */
  tick(): number {
    return ++this.t;
  }

  /** Regla 2: sincroniza con el sello de un evento ajeno recién recibido. */
  update(received: number): number {
    this.t = Math.max(this.t, received) + 1;
    return this.t;
  }
}

/** Un evento sellado con su reloj lógico y su emisor. */
export interface Stamped<E> {
  /** Sello de Lamport del emisor en el momento de emitir. */
  lamport: number;
  /** peerId que originó el evento. Desempata sellos iguales y sirve de anti-spoof. */
  origin: string;
  event: E;
}

/** Clave única de un evento en el log (para deduplicar reenvíos por la malla). */
export function stampKey<E>(s: Stamped<E>): string {
  return `${s.lamport}:${s.origin}`;
}

/**
 * Orden TOTAL determinista: primero por sello de Lamport, y ante empate (eventos concurrentes)
 * por peerId. Todos los nodos aplican este mismo criterio, así que todos obtienen exactamente
 * la misma secuencia sin importar en qué orden les llegaron los mensajes por la red.
 */
export function compareStamped<E>(a: Stamped<E>, b: Stamped<E>): number {
  if (a.lamport !== b.lamport) return a.lamport - b.lamport;
  if (a.origin === b.origin) return 0;
  return a.origin < b.origin ? -1 : 1;
}
