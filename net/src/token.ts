// Exclusión mutua distribuida por paso de testigo (token passing).
//
// El problema: en la malla no hay árbitro. ¿Qué impide que dos jugadores emitan una jugada a la
// vez y la partida se enrede? La respuesta clásica en sistemas distribuidos es un TESTIGO único:
// solo quien lo posee puede entrar en la sección crítica —aquí, emitir una acción de turno
// (PLAY / DRAW / PASS)—. Como hay exactamente un testigo, hay exactamente un jugador habilitado.
//
// Al terminar su acción, el poseedor CEDE el testigo al siguiente jugador (que se deduce del
// estado replicado: dirección, skips, reversas). El testigo circula por la mesa.
//
// El `seq` monotónico resuelve los mensajes que llegan tarde: un anuncio de testigo con `seq`
// menor o igual al que ya conocemos es un fantasma de una vuelta anterior y se descarta.
//
// Ojo con la división de responsabilidades:
//   - El testigo COORDINA (evita que dos nodos actúen a la vez, y apaga los botones en la UI).
//   - El motor replicado es quien MANDA: aunque alguien se salte el testigo y emita una jugada
//     fuera de turno, todos los nodos la rechazan igual, porque el reductor valida el turno.
//     Defensa en profundidad: el testigo es coordinación, no seguridad.
//
// Fase 5: si el poseedor se cae con el testigo en la mano, este se pierde. Ahí entra la elección
// de líder (Bully), que lo regenera con un `seq` mayor — ver `regenerate()`.

export interface TokenState {
  /** Secuencia monotónica de cesiones. Descarta anuncios rezagados. */
  seq: number;
  /** peerId habilitado para actuar. */
  holder: string;
}

export class TurnToken {
  private seq: number;
  private holderId: string;

  constructor(
    /** peerId de este nodo. */
    private readonly self: string,
    /** Quién arranca con el testigo (en Bug: el primer jugador en turno). */
    initialHolder: string,
    startSeq = 0,
  ) {
    this.holderId = initialHolder;
    this.seq = startSeq;
  }

  get holder(): string {
    return this.holderId;
  }

  get sequence(): number {
    return this.seq;
  }

  /** ¿Tengo yo el testigo? Es la guarda para emitir acciones de turno. */
  held(): boolean {
    return this.holderId === this.self;
  }

  /** Instantánea para enviar por la red o para sincronizar a un nodo que llega tarde. */
  snapshot(): TokenState {
    return { seq: this.seq, holder: this.holderId };
  }

  /**
   * Cede el testigo al siguiente jugador. Solo el poseedor puede hacerlo (si otro nodo lo
   * intenta, devuelve null: no puedes regalar algo que no tienes).
   * Devuelve el anuncio a difundir por la malla.
   */
  passTo(next: string): TokenState | null {
    if (!this.held()) return null;
    this.seq += 1;
    this.holderId = next;
    return this.snapshot();
  }

  /**
   * Procesa el anuncio de testigo de otro nodo. Devuelve true si lo adoptamos.
   *
   * El criterio es el `seq`, no el emisor: un nodo que estuvo desconectado puede tener una idea
   * vieja de quién es el poseedor, y aun así debe poder ponerse al día con un anuncio reciente.
   * Cualquier anuncio con `seq` menor o igual al nuestro es historia pasada y se ignora.
   *
   * `force` rompe esa regla a propósito, y solo para un caso: el nodo que se descubrió DESVIADO y
   * adoptó la partida de otro entera. Su `seq` puede ser más alto que el del resto —lo heredó de
   * una historia que acaba de tirar a la basura—, así que compararlo no significa nada. El testigo
   * viene con la partida que adopta, o se quedaría empuñando el de una partida que ya no existe.
   */
  receive(token: TokenState, options: { force?: boolean } = {}): boolean {
    if (!options.force && token.seq <= this.seq) return false;
    this.seq = token.seq;
    this.holderId = token.holder;
    return true;
  }

  /**
   * Regenera el testigo tras una elección de líder (Fase 5), cuando el poseedor cayó y el
   * testigo se perdió. El salto de `seq` garantiza que el testigo nuevo gana sobre cualquier
   * fantasma del anterior si el nodo caído resucita y vuelve a anunciar el suyo.
   */
  regenerate(holder: string): TokenState {
    this.seq += 1;
    this.holderId = holder;
    return this.snapshot();
  }
}
