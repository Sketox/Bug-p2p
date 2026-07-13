// Elección de líder: algoritmo del matón (Bully, García-Molina 1982).
//
// ¿Para qué queremos un líder si el juego es descentralizado? Precisamente porque lo es. El
// motor replicado no necesita jefe (cada nodo calcula el estado por su cuenta), pero hay tres
// tareas que NO pueden hacer todos a la vez sin pisarse:
//
//   1. Atender al que llega tarde o se reconecta (mandarle el snapshot).
//   2. Regenerar el testigo de turno si su poseedor se cayó con él en la mano.
//   3. Emitir el PASS de recuperación del jugador que abandonó la partida.
//
// Si esas tres las hicieran todos, tendríamos tormentas de mensajes y testigos duplicados. Así
// que se elige a UNO. Pero —y esto es lo importante— el líder no manda sobre las reglas: no
// valida jugadas ni reparte cartas. Es un coordinador reemplazable. Si muere, se elige otro y
// la partida sigue: nadie era dueño de nada.
//
// El algoritmo, en una frase: **gana el peerId más alto que siga vivo**.
//
//   - Al detectar que el líder cayó, un nodo lanza ELECTION hacia todos los peerId MAYORES.
//   - Si nadie mayor contesta (ANSWER) antes de `answerTimeout`, es que no queda nadie por
//     encima: se proclama líder y difunde COORDINATOR.
//   - Si alguien mayor contesta, se calla y espera su COORDINATOR. Si tampoco llega (el mayor
//     también se cayó, a media elección), reabre la elección.
//   - Quien recibe un COORDINATOR de alguien MENOR que él, lo desafía abriendo otra elección:
//     de ahí el nombre "matón". El resultado converge al mayor vivo.
//
// Como en `heartbeat.ts`, el tiempo entra por parámetro (`tick(now)`) y los envíos salen por
// callbacks: no hay `setTimeout` ni red dentro. Eso permite montar una malla simulada con reloj
// virtual en los tests y provocar caídas a voluntad.

export type BullyMessage =
  | { b: 'election' }
  | { b: 'answer' }
  | { b: 'coordinator'; leader: string };

/** En qué punto de la elección está este nodo. */
export type ElectionPhase = 'idle' | 'awaiting-answer' | 'awaiting-coordinator';

export interface BullyOptions {
  /** peerId de este nodo. */
  self: string;
  /** Peers que el detector de fallos considera vivos (sin incluirme). Se consulta al vuelo. */
  aliveNodes: () => string[];
  send: (to: string, msg: BullyMessage) => void;
  broadcast: (msg: BullyMessage) => void;
  /** Se llama cuando este nodo adopta un líder (propio o ajeno). */
  onLeader: (leaderId: string) => void;
  /** Espera por un ANSWER de alguien superior antes de proclamarse. */
  answerTimeout?: number;
  /** Espera por el COORDINATOR del superior que contestó, antes de reabrir la elección. */
  coordinatorTimeout?: number;
}

const DEFAULTS = { answerTimeout: 1200, coordinatorTimeout: 3000 };

export class BullyElection {
  private readonly self: string;
  private readonly answerTimeout: number;
  private readonly coordinatorTimeout: number;
  private leaderId: string | null = null;
  private phase: ElectionPhase = 'idle';
  private deadline = 0;

  constructor(private readonly o: BullyOptions) {
    this.self = o.self;
    this.answerTimeout = o.answerTimeout ?? DEFAULTS.answerTimeout;
    this.coordinatorTimeout = o.coordinatorTimeout ?? DEFAULTS.coordinatorTimeout;
  }

  get leader(): string | null {
    return this.leaderId;
  }

  get state(): ElectionPhase {
    return this.phase;
  }

  get electing(): boolean {
    return this.phase !== 'idle';
  }

  /** Líder de arranque, conocido sin votar (el anfitrión que creó la sala). */
  assume(leaderId: string): void {
    this.leaderId = leaderId;
    this.phase = 'idle';
  }

  /** Lanza una elección (típicamente al declarar caído al líder). */
  start(now: number): void {
    const superiors = this.o.aliveNodes().filter((p) => p > this.self);
    if (superiors.length === 0) {
      this.win();
      return;
    }
    for (const peer of superiors) this.o.send(peer, { b: 'election' });
    this.phase = 'awaiting-answer';
    this.deadline = now + this.answerTimeout;
  }

  /** Mensaje de elección recibido de otro nodo. */
  receive(from: string, msg: BullyMessage, now: number): void {
    switch (msg.b) {
      case 'election':
        // Me escribe alguien inferior: le confirmo que sigo vivo y, si aún no estoy en ello,
        // levanto mi propia elección hacia los que son superiores a mí. Así la elección "sube".
        if (from < this.self) {
          this.o.send(from, { b: 'answer' });
          if (this.phase === 'idle') this.start(now);
        }
        break;

      case 'answer':
        // Alguien superior sigue vivo: me retiro y espero su anuncio.
        if (this.phase === 'awaiting-answer' && from > this.self) {
          this.phase = 'awaiting-coordinator';
          this.deadline = now + this.coordinatorTimeout;
        }
        break;

      case 'coordinator':
        if (msg.leader === this.self) break; // eco de mi propio anuncio
        if (msg.leader > this.self) {
          this.adopt(msg.leader);
        } else {
          // Se proclama alguien inferior a mí (venía de una elección donde yo no figuraba,
          // p. ej. porque me daban por caído y acabo de volver). Lo desafío: soy más alto.
          this.start(now);
        }
        break;
    }
  }

  /** Vence los temporizadores. Debe llamarse periódicamente con el reloj real. */
  tick(now: number): void {
    if (this.phase === 'idle' || now < this.deadline) return;
    if (this.phase === 'awaiting-answer') {
      // Nadie superior contestó → no queda nadie por encima: mando yo.
      this.win();
    } else {
      // El superior que contestó no llegó a anunciarse (se cayó a media elección): se reabre.
      this.start(now);
    }
  }

  /** Un peer desapareció: si era el líder, hay que elegir de nuevo. */
  onPeerDown(peerId: string, now: number): void {
    if (peerId === this.leaderId && !this.electing) {
      this.leaderId = null;
      this.start(now);
    }
  }

  private win(): void {
    this.phase = 'idle';
    this.deadline = 0;
    this.adopt(this.self);
    this.o.broadcast({ b: 'coordinator', leader: this.self });
  }

  private adopt(leaderId: string): void {
    this.phase = 'idle';
    this.deadline = 0;
    if (this.leaderId === leaderId) return;
    this.leaderId = leaderId;
    this.o.onLeader(leaderId);
  }
}
