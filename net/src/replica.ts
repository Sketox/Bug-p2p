// Replicación de máquina de estados (state machine replication).
//
// Idea: si todos los nodos parten del MISMO estado inicial y aplican la MISMA secuencia de
// eventos con un reductor PURO y determinista, todos llegan al mismo estado. No hace falta
// enviar el estado por la red — basta con enviar los eventos. Eso es lo que hace que "Bug"
// sea de verdad descentralizado: nadie es dueño de la partida, todos la recalculan.
//
// El problema es que la red no respeta el orden: los mensajes llegan cuando llegan. Aquí se
// resuelve así:
//
//   - Cada evento viaja sellado con Lamport + peerId → hay un orden total (ver `lamport.ts`).
//   - El log se mantiene SIEMPRE ordenado por ese criterio.
//   - Si un evento llega en su sitio (al final), se aplica de forma incremental: barato.
//   - Si llega tarde (le toca ir en medio del log), se recalcula el estado desde cero
//     reaplicando todo el log: rollback & replay. Es correcto por construcción y, con partidas
//     de unos cientos de eventos y un reductor puro, es instantáneo.
//
// Consecuencia clave (la que se demuestra en los tests): dos nodos que reciben el MISMO CONJUNTO
// de eventos convergen al mismo estado, sin importar en qué ORDEN los recibieron.

import { compareStamped, stampKey, type Stamped } from './lamport.js';

export interface ReplicaOptions<S, E> {
  /** Estado inicial. Debe ser idéntico en todos los nodos (mismo seed, mismos jugadores). */
  initial: S;
  /**
   * Reductor PURO: (estado, evento) → estado nuevo. No debe mutar `state`.
   * Si el evento es inválido debe lanzar; la réplica lo marca como rechazado (ver abajo).
   */
  apply: (state: S, event: E) => S;
}

export interface DeliverResult {
  /** false si el evento ya estaba en el log (reenvío duplicado por la malla). */
  accepted: boolean;
  /** true si hubo que reordenar el log y recalcular el estado (el evento llegó tarde). */
  replayed: boolean;
  /** Motivo por el que el reductor rechazó el evento, si lo hizo (la partida sigue igual). */
  rejected?: string;
}

export class Replica<S, E> {
  private readonly initial: S;
  private readonly reduce: (state: S, event: E) => S;
  private log: Stamped<E>[] = [];
  private seen = new Set<string>();
  /** Eventos que el reductor rechazó en la posición que ocupan hoy (p. ej. jugada ilegal). */
  private rejected = new Map<string, string>();
  private current: S;

  constructor(options: ReplicaOptions<S, E>) {
    this.initial = options.initial;
    this.reduce = options.apply;
    this.current = options.initial;
  }

  /** Estado convergido tras aplicar todo el log conocido. */
  get state(): S {
    return this.current;
  }

  /** El log ordenado (incluye los eventos rechazados: forman parte de la historia común). */
  get events(): readonly Stamped<E>[] {
    return this.log;
  }

  /** Cantidad de eventos rechazados por el reductor (jugadas ilegales que nadie aplicó). */
  get rejectedCount(): number {
    return this.rejected.size;
  }

  /**
   * Entrega un evento a la réplica. Es idempotente: reentregar el mismo evento no cambia nada,
   * así que da igual si la malla lo hace llegar por varios caminos.
   */
  deliver(stamped: Stamped<E>): DeliverResult {
    const key = stampKey(stamped);
    if (this.seen.has(key)) return { accepted: false, replayed: false };
    this.seen.add(key);

    const at = this.insertionIndex(stamped);
    this.log.splice(at, 0, stamped);

    // Caso feliz: el evento es el más nuevo que conocemos → basta con aplicarlo encima.
    if (at === this.log.length - 1) {
      const rejected = this.step(this.current, stamped, key);
      return { accepted: true, replayed: false, ...(rejected ? { rejected } : {}) };
    }

    // Llegó tarde: se coló antes de eventos ya aplicados, así que el estado actual ya no
    // corresponde al log. Se recalcula todo desde el inicio.
    this.replay();
    return {
      accepted: true,
      replayed: true,
      ...(this.rejected.has(key) ? { rejected: this.rejected.get(key)! } : {}),
    };
  }

  /** Entrega un lote de eventos (p. ej. el log completo que manda un nodo al sincronizar). */
  deliverAll(stampeds: readonly Stamped<E>[]): void {
    for (const s of stampeds) this.deliver(s);
  }

  /**
   * Tira la historia propia y adopta ENTERA la de otro nodo. Reconstruye el estado desde cero.
   *
   * `deliverAll` no basta para reparar una divergencia: solo AÑADE. Si mi log tiene un evento que
   * los demás no tienen —o le falta uno que ya no me va a llegar nunca— por muchos eventos que me
   * manden, mi estado seguirá siendo otro. Aquí se borra el log propio y se adopta el ajeno.
   *
   * Es la última red del diseño: mientras los nodos convergen, nadie la usa. Cuando uno se
   * desvía y no vuelve solo, deja de ser una partida y pasa a ser dos — y eso hay que cortarlo.
   */
  adopt(events: readonly Stamped<E>[]): void {
    this.log = [];
    this.seen.clear();
    this.rejected.clear();
    this.current = this.initial;
    this.deliverAll(events);
  }

  /**
   * Aplica un evento sobre un estado, registrando el rechazo si el reductor lo considera
   * inválido. El rechazo es determinista: como el reductor es puro y el log es el mismo en
   * todos los nodos, TODOS rechazan exactamente los mismos eventos. Por eso el evento se
   * conserva en el log en vez de descartarse: forma parte de la historia que todos comparten.
   */
  private step(state: S, stamped: Stamped<E>, key: string): string | undefined {
    try {
      this.current = this.reduce(state, stamped.event);
      this.rejected.delete(key);
      return undefined;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.current = state; // la partida no avanza: el evento simplemente no ocurrió
      this.rejected.set(key, message);
      return message;
    }
  }

  /** Recalcula el estado aplicando el log entero desde el estado inicial. */
  private replay(): void {
    this.current = this.initial;
    this.rejected.clear();
    for (const stamped of this.log) {
      this.step(this.current, stamped, stampKey(stamped));
    }
  }

  /** Posición que le toca al evento en el log ordenado (búsqueda binaria). */
  private insertionIndex(stamped: Stamped<E>): number {
    let lo = 0;
    let hi = this.log.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (compareStamped(this.log[mid]!, stamped) <= 0) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
}

/**
 * Huella determinista de un estado. Dos nodos convergen si —y solo si— sus huellas coinciden.
 * Se usa en los tests de convergencia y alimentará la Pantalla Maestra (Fase 5), donde se ve
 * en vivo si algún nodo se desvía de la mayoría.
 */
export function stateHash(state: unknown): string {
  const json = JSON.stringify(state);
  let h = 0x811c9dc5; // FNV-1a de 32 bits
  for (let i = 0; i < json.length; i++) {
    h ^= json.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
