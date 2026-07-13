// Detección de fallos por latidos (heartbeats).
//
// En una malla P2P nadie te avisa de que un nodo murió: simplemente deja de hablar. Y "deja de
// hablar" es indistinguible de "va lento" o "su WiFi tuvo un hipo" — es el problema clásico de
// la detección de fallos en sistemas asíncronos: no hay forma de saber con certeza si un nodo
// cayó o solo tarda. Lo que sí se puede hacer es SOSPECHAR con un criterio explícito.
//
// Aquí el criterio es temporal, en dos escalones:
//
//   alive  → latidos recientes; el nodo está sano.
//   suspect→ lleva `suspectAfter` ms sin latir. Aún no se toca la partida: solo se avisa en la
//            Pantalla Maestra ("puede que se esté cayendo").
//   down   → lleva `downAfter` ms sin latir. Se declara el fallo y se actúan las consecuencias
//            (elección de líder si era el líder, regeneración del testigo si lo tenía él).
//
// El escalón intermedio evita el peor error de un detector: declarar muerto a alguien que solo
// tuvo un pico de latencia, y luego tener que deshacer lo hecho cuando reaparece. Es un detector
// "eventualmente fuerte": puede equivocarse un rato, pero acaba acertando.
//
// La clase es PURA en el sentido que importa para los tests: no usa `Date.now()` ni temporizadores.
// El tiempo entra por parámetro (`now`), así que el reloj se puede simular y los tests son
// deterministas. Quien la usa (el hook de React) es el que le pasa el reloj real.

export type PeerHealth = 'alive' | 'suspect' | 'down';

export interface FailureDetectorOptions {
  /**
   * Quién soy yo.
   *
   * Parece un detalle y no lo es: un nodo no se vigila a sí mismo (no se manda latidos), así que
   * sin esto `healthOf(yo)` caía en el valor por defecto —"no sé nada de él, luego está caído"— y
   * el nodo se declaraba muerto A SÍ MISMO. Con el líder, además, era mortal: se saltaba su propio
   * turno cada ronda y no llegaba a jugar nunca.
   */
  self?: string;
  /** Cada cuánto (ms) este nodo debe emitir su propio latido. */
  interval?: number;
  /** Silencio a partir del cual un peer pasa a sospechoso. */
  suspectAfter?: number;
  /** Silencio a partir del cual se declara el fallo. */
  downAfter?: number;
}

export interface HealthChange {
  peerId: string;
  from: PeerHealth;
  to: PeerHealth;
}

export interface PeerHealthInfo {
  peerId: string;
  health: PeerHealth;
  /** Momento (ms) del último latido recibido. */
  lastSeen: number;
  /** Silencio acumulado en el último barrido. */
  silence: number;
}

const DEFAULTS = { interval: 1000, suspectAfter: 2500, downAfter: 6000 };

export class FailureDetector {
  private readonly self: string | null;
  private readonly interval: number;
  private readonly suspectAfter: number;
  private readonly downAfter: number;

  private lastSeen = new Map<string, number>();
  private health = new Map<string, PeerHealth>();
  private lastBeat = -Infinity;

  constructor(options: FailureDetectorOptions = {}) {
    this.self = options.self ?? null;
    this.interval = options.interval ?? DEFAULTS.interval;
    this.suspectAfter = options.suspectAfter ?? DEFAULTS.suspectAfter;
    this.downAfter = options.downAfter ?? DEFAULTS.downAfter;
  }

  /** Empieza a vigilar a un peer (al abrirse su canal). Se le presume vivo. */
  watch(peerId: string, now: number): void {
    if (this.health.has(peerId)) return;
    this.lastSeen.set(peerId, now);
    this.health.set(peerId, 'alive');
  }

  /** Deja de vigilar a un peer (salió limpiamente, o se rehace la malla). */
  forget(peerId: string): void {
    this.lastSeen.delete(peerId);
    this.health.delete(peerId);
  }

  /** Latido recibido: el peer está vivo. Sirve también para resucitar a un caído que vuelve. */
  beat(peerId: string, now: number): HealthChange | null {
    const before = this.health.get(peerId) ?? 'down';
    this.lastSeen.set(peerId, now);
    this.health.set(peerId, 'alive');
    return before === 'alive' ? null : { peerId, from: before, to: 'alive' };
  }

  /** ¿Toca emitir mi propio latido? Consumir esta respuesta reinicia el temporizador. */
  shouldBeat(now: number): boolean {
    if (now - this.lastBeat < this.interval) return false;
    this.lastBeat = now;
    return true;
  }

  /**
   * Reevalúa la salud de todos los peers vigilados y devuelve SOLO los que cambiaron de estado.
   * Devolver los cambios (y no el estado entero) es lo que permite reaccionar una única vez a
   * cada caída: quien llama no tiene que recordar a quién ya había dado por muerto.
   */
  sweep(now: number): HealthChange[] {
    const changes: HealthChange[] = [];
    for (const [peerId, from] of this.health) {
      const silence = now - (this.lastSeen.get(peerId) ?? now);
      const to: PeerHealth =
        silence >= this.downAfter ? 'down' : silence >= this.suspectAfter ? 'suspect' : 'alive';
      if (to !== from) {
        this.health.set(peerId, to);
        changes.push({ peerId, from, to });
      }
    }
    return changes;
  }

  healthOf(peerId: string): PeerHealth {
    // Uno no se sospecha a sí mismo. Si estuvieras caído no estarías aquí preguntando.
    if (peerId === this.self) return 'alive';
    return this.health.get(peerId) ?? 'down';
  }

  isDown(peerId: string): boolean {
    return this.healthOf(peerId) === 'down';
  }

  /** Peers que no están caídos (los que aún cuentan para una elección). */
  alive(): string[] {
    return [...this.health].filter(([, h]) => h !== 'down').map(([peerId]) => peerId);
  }

  down(): string[] {
    return [...this.health].filter(([, h]) => h === 'down').map(([peerId]) => peerId);
  }

  /** Foto completa para la Pantalla Maestra. */
  report(now: number): PeerHealthInfo[] {
    return [...this.health].map(([peerId, health]) => {
      const lastSeen = this.lastSeen.get(peerId) ?? now;
      return { peerId, health, lastSeen, silence: now - lastSeen };
    });
  }
}
