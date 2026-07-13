'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  apply,
  createGame,
  EngineError,
  redactFor,
  type Color,
  type GameEvent,
  type GameState,
  type PublicView,
} from '@bug/engine';
import {
  BullyElection,
  FailureDetector,
  LamportClock,
  Replica,
  Room,
  stateHash,
  TurnToken,
  type BullyMessage,
  type PeerHealth,
  type RoomStatus,
  type Stamped,
} from '@bug/net';
import type { GameSetup, Heartbeat, LobbyPlayer, NetMessage, RoomSnapshot } from './netProtocol';
import { loadIceServers } from './ice';
import { signalUrl } from './signal';

// Nodo de la malla. Cada navegador es cliente Y servidor: tiene el motor completo, replica el
// estado aplicando el log de eventos, y coordina con los demás mediante:
//
//   - Lamport         → orden total de los eventos, sin reloj compartido.
//   - Replica         → todos convergen al mismo estado aplicando el mismo log.
//   - TurnToken       → exclusión mutua: solo el poseedor del testigo emite acciones de turno.
//   - FailureDetector → latidos y timeouts: quién sigue vivo (Fase 5).
//   - BullyElection   → si el coordinador cae, se elige otro (Fase 5).
//
// Nadie es dueño de la partida. El líder es un cargo reemplazable con tres tareas de fontanería:
// atender al que se reconecta, regenerar el testigo si su poseedor murió con él, y forzar el
// paso de turno del jugador que abandonó. Ninguna toca las reglas: esas las aplica el motor
// replicado, idéntico en todos los nodos.

/** Cada cuánto se revisa la malla (latidos, timeouts, temporizadores de elección). */
const TICK_MS = 500;
/** Margen mínimo entre dos recuperaciones del líder: evita ráfagas de PASS forzados. */
const RECOVERY_COOLDOWN = 1500;

/**
 * Lo que dura un turno. Al agotarse, el líder emite un `TIMEOUT`: robas 2 y lo pierdes.
 *
 * El reloj lo lleva cada nodo por su cuenta (arranca cuando aplica el evento que cambió el turno),
 * pero **quien decide** que se acabó es solo el líder. Si lo decidiera cada uno, cinco nodos con
 * relojes ligeramente distintos emitirían cinco castigos por el mismo turno.
 */
const TURN_MS = 30_000;

/**
 * Cuánto se tolera que el testigo esté en manos de quien NO tiene el turno antes de regenerarlo.
 *
 * El testigo viaja en un mensaje, y un mensaje se puede perder (o llegar mientras el destinatario
 * recargaba la página). Cuando eso pasa, el jugador ve "es tu turno" y no puede tocar una carta:
 * la partida está viva pero él está fuera de ella. Antes solo se regeneraba si su poseedor estaba
 * CAÍDO; si estaba vivo y simplemente no le llegó, nadie lo arreglaba nunca.
 */
const TOKEN_MISMATCH_MS = 4000;

/**
 * Cuánto se tolera tener una huella de estado distinta a la del líder antes de darse por desviado.
 *
 * Un desfase momentáneo es NORMAL: los eventos viajan, y durante unos cientos de milisegundos dos
 * nodos legítimamente no han aplicado lo mismo. Lo que no es normal es que la diferencia se quede.
 * Ahí ya no hay una partida con retraso: hay dos partidas distintas, cada una convencida de la
 * suya. Y eso es exactamente lo que se veía — un jugador esperando su turno mientras el resto
 * jugaba otra cosa.
 */
const DIVERGED_MS = 6000;
/**
 * Respiro entre el "me voy" y el cierre de los canales. Un DataChannel envía en diferido: si se
 * cierra el `RTCPeerConnection` en la misma vuelta del bucle de eventos, el adiós se queda en el
 * buffer y no lo recibe nadie — que es justo lo que la salida limpia quiere evitar.
 */
const FAREWELL_GRACE = 250;

export type Phase = 'idle' | 'lobby' | 'playing';

export interface PlayOptions {
  chosenColor?: Color;
  target?: string;
  giveCardIds?: string[];
  rebootCardId?: string;
}

/** Un nodo de la malla, tal y como lo ve ESTE navegador. Alimenta la Pantalla Maestra. */
export interface MeshNode {
  peerId: string;
  name: string;
  health: PeerHealth;
  /** ms desde su último latido. */
  silence: number;
  /** Huella de SU estado replicado (la que anunció en su último latido). */
  hash: string | null;
  /** ¿Su huella coincide con la mía? Si no, hay divergencia y hay que mirarlo. */
  converged: boolean;
  lamport: number;
  isLeader: boolean;
  hasToken: boolean;
  isMe: boolean;
  /**
   * Se despidió (evento QUIT). No es lo mismo que `health: 'down'`: un caído es una sospecha y
   * puede volver; un ausente ya no está en la partida y el motor no le guarda el turno.
   */
  left: boolean;
}

export interface MeshView {
  nodes: MeshNode[];
  leaderId: string | null;
  electing: boolean;
  tokenHolder: string | null;
  tokenSeq: number;
  myHash: string | null;
  myLamport: number;
  logSize: number;
  rejectedCount: number;
}

export type JournalKind = 'down' | 'up' | 'election' | 'leader' | 'token' | 'sync' | 'info';

export interface JournalEntry {
  at: number;
  kind: JournalKind;
  text: string;
}

const EMPTY_MESH: MeshView = {
  nodes: [],
  leaderId: null,
  electing: false,
  tokenHolder: null,
  tokenSeq: 0,
  myHash: null,
  myLamport: 0,
  logSize: 0,
  rejectedCount: 0,
};

function newRoomCode(): string {
  return Math.random().toString(36).slice(2, 6).toUpperCase();
}

/**
 * Identidad estable por sala. Si el navegador recarga (o se cae y vuelve), el jugador regresa con
 * el MISMO peerId: para la malla es el mismo nodo de siempre, recupera su mano y su sitio en la
 * mesa. Sin esto, un F5 te convertiría en un desconocido y perderías la partida.
 */
function identityFor(code: string): string {
  const key = `bug:peer:${code}`;
  try {
    const saved = sessionStorage.getItem(key);
    if (saved) return saved;
    const fresh = crypto.randomUUID();
    sessionStorage.setItem(key, fresh);
    return fresh;
  } catch {
    return crypto.randomUUID(); // modo privado / sin storage: identidad de un solo uso
  }
}

/**
 * La otra mitad de la identidad: QUÉ CONEXIÓN eres, no quién eres.
 *
 * El `peerId` de arriba sobrevive al F5 —tiene que hacerlo, o perderías tu mano—, y por eso no
 * sirve para saber si tu WebRTC es nuevo. Esto sí: se genera una vez por CARGA de la página y NO
 * se guarda en ningún sitio, así que un F5 te da una encarnación nueva.
 *
 * Con las dos, la malla distingue "recargó, tira el canal" de "solo volvió la señalización, el
 * canal está sano" — que llegan indistinguibles si solo miras el peerId. Ver `PeerInfo.epoch`.
 */
let epoch: string | null = null;
function thisPageLoad(): string {
  return (epoch ??= crypto.randomUUID());
}

/** Jugador que origina un evento (para verificar que un peer solo actúa como sí mismo). */
function eventActor(event: GameEvent): string {
  return event.type === 'CALL_BUG' ? event.accuserId : event.playerId;
}

/**
 * Acciones sujetas al testigo de turno.
 *
 * El testigo es exclusión mutua: solo su poseedor puede jugar, robar o pasar. Pero hay eventos que
 * son **legítimamente concurrentes** y pedirles el testigo sería absurdo — gritar "¡Bug!", acusar a
 * otro, despedirse… y, desde la Fase 6, **interrumpir con "Copiar y Pegar"**: una carta cuya gracia
 * es precisamente jugarse cuando NO te toca. Esos van sin testigo y los ordena Lamport.
 */
function needsToken(state: GameState, event: GameEvent): boolean {
  if (event.type === 'DRAW' || event.type === 'PASS') return true;
  if (event.type !== 'PLAY') return false;
  return !isInterrupt(state, event);
}

/**
 * Lo único que el LÍDER puede emitir en nombre de otro: un `TIMEOUT`.
 *
 * Es la única excepción al anti-spoof, y ahora es **una sola**. Antes eran dos —el líder emitía un
 * `PASS` por el jugador caído—, pero desde que no se puede pasar sin robar, ese PASS sería una
 * jugada ilegal. Y resulta que no hacía falta: **un jugador caído es exactamente un jugador que no
 * juega a tiempo**. El mismo mecanismo sirve para los dos casos.
 *
 * Es un CASTIGO (roba 2 y pierde el turno), nunca un premio: ni juega, ni gana, ni le quita cartas
 * a nadie. Y pasa por el motor como cualquier otro evento: si ese jugador no estaba en turno, se
 * rechaza en todos los nodos por igual.
 */
function isLeaderAction(event: GameEvent): boolean {
  return event.type === 'TIMEOUT';
}

/** ¿Esta jugada es una interrupción? Un "Copiar y Pegar" jugado fuera de turno (mismo criterio que el motor). */
function isInterrupt(state: GameState, event: GameEvent): boolean {
  if (event.type !== 'PLAY') return false;
  const player = state.players.find((p) => p.id === event.playerId);
  const card = player?.hand.find((c) => c.id === event.cardId);
  return card?.kind === 'copy_paste' && state.players[state.turn]?.id !== event.playerId;
}

/** Quién debería tener el testigo según el estado: el jugador en turno. */
function holderOf(state: GameState): string {
  return state.players[state.turn]!.id;
}

export function useBugRoom() {
  const [phase, setPhase] = useState<Phase>('idle');
  const [status, setStatus] = useState<RoomStatus>('connecting');
  const [isHost, setIsHost] = useState(false);
  const [roomId, setRoomId] = useState<string | null>(null);
  const [lobby, setLobby] = useState<LobbyPlayer[]>([]);
  const [view, setView] = useState<PublicView | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** true si puedo emitir una acción de turno (tengo el testigo). */
  const [canAct, setCanAct] = useState(false);
  /** Radiografía de la malla y diario de sucesos: los ve la Pantalla Maestra. */
  const [mesh, setMesh] = useState<MeshView>(EMPTY_MESH);
  const [journal, setJournal] = useState<JournalEntry[]>([]);
  /** Cuándo empezó el turno en curso (para la cuenta atrás). `null` = no hay reloj corriendo. */
  const [turnStartedAt, setTurnStartedAt] = useState<number | null>(null);

  const roomRef = useRef<Room | null>(null);
  const replicaRef = useRef<Replica<GameState, GameEvent> | null>(null);
  const clockRef = useRef(new LamportClock());
  const tokenRef = useRef<TurnToken | null>(null);
  const detectorRef = useRef<FailureDetector | null>(null);
  const bullyRef = useRef<BullyElection | null>(null);
  const setupRef = useRef<GameSetup | null>(null);
  const isHostRef = useRef(false);
  const hostIdRef = useRef<string>('');
  const myIdRef = useRef<string>('');
  const lobbyRef = useRef<LobbyPlayer[]>([]);
  const startedRef = useRef(false);
  /**
   * Contador de entradas a una sala. Cada `enter()` abre una sesión nueva; cada `leave()` la
   * cierra. El trabajo asíncrono que quedó en vuelo (cargar los servidores ICE, por ejemplo)
   * comprueba al volver si su sesión sigue siendo la vigente — si no, se descarta.
   *
   * Un simple booleano "ya me fui" no basta: en desarrollo, StrictMode monta, desmonta y vuelve a
   * montar, así que la sesión N+1 lo pondría a `false` y resucitaría el callback de la sesión N,
   * que sobrescribiría la sala buena con una muerta.
   */
  const sessionRef = useRef(0);
  /** Último latido recibido de cada peer (para la Pantalla Maestra). */
  const beatsRef = useRef(new Map<string, Heartbeat>());
  const lastRecoveryRef = useRef(0);
  const tickerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  /** Turno en curso: de quién es y desde cuándo (el reloj de los 30 segundos). */
  const turnRef = useRef<{ holder: string | null; at: number; seq: number }>({
    holder: null,
    at: 0,
    seq: -1,
  });
  /** Desde cuándo el testigo está en manos de quien no tiene el turno (0 = está donde debe). */
  const tokenMismatchRef = useRef(0);
  /**
   * Eventos que llegaron ANTES de tener con qué aplicarlos (justo tras recargar, o al entrar a
   * media partida, mientras se espera el historial).
   *
   * Antes se tiraban a la basura —"no tengo réplica, no puedo aplicarlo"— y ahí estaba una fuga de
   * convergencia de las malas: pides el historial, alguien juega una carta mientras viaja, tú la
   * descartas, y el historial que recibes se generó ANTES de esa carta. Esa jugada no está en tu
   * partida y **nunca lo estará**: manos descuadradas para siempre, y si la jugada perdida era la
   * ganadora, los demás ven el final y tú sigues jugando solo.
   *
   * Ahora se guardan y se aplican en cuanto hay motor. El log es idempotente, así que si el
   * historial ya los traía, no pasa nada: se descartan por duplicados.
   */
  const pendingRef = useRef<{ from: string; stamped: Stamped<GameEvent>; recovery?: boolean }[]>([]);
  /** Desde cuándo mi huella de estado no coincide con la del líder (0 = vamos a la par). */
  const divergedRef = useRef(0);
  /** Para no pedir reparación en ráfaga mientras el snapshot viaja. */
  const lastRepairRef = useRef(0);

  // --- Diario de sucesos ------------------------------------------------------
  const log = useCallback((kind: JournalKind, text: string) => {
    setJournal((prev) => [...prev.slice(-49), { at: Date.now(), kind, text }]);
  }, []);

  const nameOf = useCallback((peerId: string): string => {
    const player =
      setupRef.current?.players.find((p) => p.peerId === peerId) ??
      lobbyRef.current.find((p) => p.peerId === peerId);
    return player?.name ?? peerId.slice(0, 4);
  }, []);

  // --- Vista local: se recalcula desde MI réplica, no me la manda nadie -------
  const refresh = useCallback(() => {
    const replica = replicaRef.current;
    const token = tokenRef.current;
    if (!replica) return;
    const state = replica.state;
    setView(redactFor(state, myIdRef.current));
    setCanAct(!state.finished && !!token?.held() && holderOf(state) === myIdRef.current);

    // El reloj del turno arranca cuando el turno cambia de manos. Cada nodo lo mide por su cuenta
    // (no hay reloj compartido), pero solo el líder decide que se acabó — si no, cinco relojes
    // ligeramente distintos castigarían cinco veces el mismo turno.
    const holder = holderOf(state);
    if (turnRef.current.holder !== holder || turnRef.current.seq === -1) {
      turnRef.current = { holder, at: Date.now(), seq: state.seq };
      setTurnStartedAt(state.finished ? null : Date.now());
    }
    if (state.finished) setTurnStartedAt(null);

    // Ventana de depuración (solo fuera de producción). El estado replicado es la RECETA de la
    // partida: con la semilla y el log de eventos se reconstruye entera en un test. Cuando algo se
    // rompe en el navegador —una mesa que se queda muerta, por ejemplo— esto es lo que permite
    // reproducirlo en el motor en vez de adivinar.
    if (process.env.NODE_ENV !== 'production') {
      (window as unknown as Record<string, unknown>).__bug = {
        state,
        setup: setupRef.current,
        events: replica.events,
        me: myIdRef.current,
      };
    }
  }, []);

  /** Foto de la malla para la Pantalla Maestra. */
  const refreshMesh = useCallback(() => {
    const detector = detectorRef.current;
    const bully = bullyRef.current;
    if (!detector || !bully) return;

    const now = Date.now();
    const replica = replicaRef.current;
    const token = tokenRef.current;
    const myHash = replica ? stateHash(replica.state) : null;
    const health = new Map(detector.report(now).map((r) => [r.peerId, r]));

    const ids = new Set<string>([myIdRef.current, ...health.keys()]);
    for (const p of setupRef.current?.players ?? lobbyRef.current) ids.add(p.peerId);

    // Quién se despidió: lo dice el estado replicado, no la red. Todos los nodos coinciden porque
    // todos aplicaron el mismo QUIT.
    const gone = new Set(
      (replica?.state.players ?? []).filter((p) => p.status === 'down').map((p) => p.id),
    );

    const nodes: MeshNode[] = [...ids].map((peerId) => {
      const isMe = peerId === myIdRef.current;
      const beat = beatsRef.current.get(peerId);
      const info = health.get(peerId);
      const hash = isMe ? myHash : (beat?.hash ?? null);
      return {
        peerId,
        name: nameOf(peerId),
        health: isMe ? 'alive' : (info?.health ?? 'down'),
        silence: isMe ? 0 : (info?.silence ?? 0),
        hash,
        converged: hash != null && myHash != null && hash === myHash,
        lamport: isMe ? clockRef.current.time : (beat?.lamport ?? 0),
        isLeader: peerId === bully.leader,
        hasToken: peerId === token?.holder,
        isMe,
        left: gone.has(peerId),
      };
    });

    setMesh({
      nodes,
      leaderId: bully.leader,
      electing: bully.electing,
      tokenHolder: token?.holder ?? null,
      tokenSeq: token?.sequence ?? 0,
      myHash,
      myLamport: clockRef.current.time,
      logSize: replica?.events.length ?? 0,
      rejectedCount: replica?.rejectedCount ?? 0,
    });
  }, [nameOf]);

  /** Arranca la réplica local. Todos los nodos ejecutan esto con el MISMO setup. */
  const startReplica = useCallback(
    (setup: GameSetup, tokenSeq: number, tokenHolder: string) => {
      const initial = createGame(
        setup.seed,
        setup.players.map((p) => ({ id: p.peerId, name: p.name })),
      );
      setupRef.current = setup;
      replicaRef.current = new Replica<GameState, GameEvent>({ initial, apply });
      tokenRef.current = new TurnToken(myIdRef.current, tokenHolder, tokenSeq);
      startedRef.current = true;
      setPhase('playing');
      setError(null);
      refresh();
    },
    [refresh],
  );

  /** Snapshot de la partida: la receta completa para reconstruirla (semilla + log + testigo). */
  const snapshot = useCallback((): RoomSnapshot | null => {
    const replica = replicaRef.current;
    const setup = setupRef.current;
    const token = tokenRef.current;
    if (!replica || !setup || !token) return null;
    return {
      setup,
      log: [...replica.events],
      token: token.snapshot(),
      leaderId: bullyRef.current?.leader ?? hostIdRef.current,
    };
  }, []);

  /**
   * Tras aplicar un evento, si YO tengo el testigo y el turno ya es de otro, lo cedo.
   * Así el testigo circula por la mesa siguiendo las reglas (dirección, skips, reversas).
   */
  const passTokenIfNeeded = useCallback(() => {
    const replica = replicaRef.current;
    const token = tokenRef.current;
    if (!replica || !token || !token.held()) return;

    const state = replica.state;
    if (state.finished) return;

    const next = holderOf(state);
    if (next === myIdRef.current) return; // sigue siendo mi turno (p. ej. robé carta jugable)

    const announcement = token.passTo(next);
    if (announcement) {
      roomRef.current?.broadcast({ k: 'token', token: announcement } satisfies NetMessage);
    }
  }, []);

  // --- Emitir un evento propio ----------------------------------------------
  const emit = useCallback(
    (event: GameEvent) => {
      const replica = replicaRef.current;
      const token = tokenRef.current;
      if (!replica || !token) return;

      // Exclusión mutua: sin testigo no se emiten acciones de turno. (Una interrupción no es una
      // acción de turno — de eso va: se juega cuando NO te toca.)
      if (needsToken(replica.state, event) && !token.held()) {
        setError('No es tu turno');
        return;
      }

      // Validación local previa: da feedback inmediato y evita ensuciar el log con jugadas
      // ilegales. (Aunque una se colara, todos los nodos la rechazarían igual: el reductor
      // es determinista — ver `Replica.step`.)
      try {
        apply(replica.state, event);
      } catch (e) {
        setError(e instanceof EngineError ? e.message : String(e));
        return;
      }

      const stamped: Stamped<GameEvent> = {
        lamport: clockRef.current.tick(),
        origin: myIdRef.current,
        event,
      };
      replica.deliver(stamped);
      roomRef.current?.broadcast({ k: 'event', stamped } satisfies NetMessage);

      setError(null);
      passTokenIfNeeded();
      refresh();
    },
    [passTokenIfNeeded, refresh],
  );

  /**
   * Un jugador anunció que se va (Fase 6). Se le retira de la malla en el acto, sin esperar a que
   * el detector de fallos lo sospeche: no hay nada que sospechar, lo ha dicho él.
   *
   * Ojo con la diferencia, que no es cosmética: un CAÍDO puede volver (su sitio se le guarda y el
   * líder le salta el turno mientras tanto); un AUSENTE no vuelve, y el motor lo saca de la
   * rotación para siempre. Por eso el abandono es un evento del motor y no un mensaje de red.
   */
  const onPeerQuit = useCallback(
    (peerId: string) => {
      detectorRef.current?.forget(peerId);
      beatsRef.current.delete(peerId);
      log('down', `${nameOf(peerId)} abandonó la partida`);

      // Si el que se va es el líder, se elige sucesor YA. Bully llegaría a lo mismo por falta de
      // latidos, pero seis segundos sin coordinador son seis segundos sin nadie que atienda una
      // reconexión ni destrabe un turno.
      if (peerId === bullyRef.current?.leader) {
        log('election', `el líder (${nameOf(peerId)}) se fue: elección en marcha`);
        bullyRef.current?.onPeerDown(peerId, Date.now());
      }
    },
    [log, nameOf],
  );

  // --- Recibir eventos de la malla ------------------------------------------
  const onRemoteEvent = useCallback(
    (from: string, stamped: Stamped<GameEvent>, recovery = false) => {
      const replica = replicaRef.current;
      if (!replica) return;

      // Anti-spoof: un peer solo puede emitir eventos en su propio nombre.
      //
      // Única excepción: el LÍDER puede emitir un PASS (jugador caído) o un TIMEOUT (se le acabó
      // el tiempo) en nombre de otro. Ver `isLeaderAction`: son las dos cosas que la mesa necesita
      // que alguien haga por ti y que no pueden darte ventaja. Y aun así pasan por el motor como
      // cualquier otro evento: si no era el turno de ese jugador, se rechazan.
      const impersonating = eventActor(stamped.event) !== from;
      const legitRecovery =
        recovery && from === bullyRef.current?.leader && isLeaderAction(stamped.event);
      if (stamped.origin !== from || (impersonating && !legitRecovery)) return;

      clockRef.current.update(stamped.lamport);
      replica.deliver(stamped);
      if (legitRecovery && impersonating) {
        const quien = nameOf(eventActor(stamped.event));
        log(
          'token',
          stamped.event.type === 'TIMEOUT'
            ? `a ${quien} se le acabó el tiempo: roba 2 y pierde el turno`
            : `el líder saltó el turno de ${quien} (caído)`,
        );
      }
      // Nadie puede echar a nadie: el anti-spoof de arriba ya garantiza que un QUIT solo puede
      // venir del propio jugador que se marcha.
      if (stamped.event.type === 'QUIT') onPeerQuit(stamped.event.playerId);
      passTokenIfNeeded(); // si el evento ajeno me devolvió el turno, puede tocarme ceder luego
      refresh();
    },
    [log, nameOf, onPeerQuit, passTokenIfNeeded, refresh],
  );

  /**
   * Aplica los eventos que se guardaron mientras no había motor (ver `pendingRef`).
   *
   * Se llama en cuanto la réplica existe: al empezar la partida y al recibir el historial. El log
   * dedupea, así que los que ya venían en el historial se descartan solos — reenviar de más es
   * gratis; perder uno, no.
   */
  const drainPending = useCallback(() => {
    const pendientes = pendingRef.current;
    if (pendientes.length === 0) return;
    pendingRef.current = [];
    for (const p of pendientes) onRemoteEvent(p.from, p.stamped, p.recovery);
    log('sync', `aplicadas ${pendientes.length} jugadas que llegaron mientras me ponía al día`);
  }, [log, onRemoteEvent]);

  const broadcastLobby = useCallback(() => {
    roomRef.current?.broadcast({
      k: 'lobby',
      hostId: hostIdRef.current,
      players: lobbyRef.current,
      started: startedRef.current,
    } satisfies NetMessage);
    setLobby([...lobbyRef.current]);
  }, []);

  // --- Destrabar la mesa (solo lo hace el líder) ------------------------------
  //
  // Cuatro formas de quedarse atascados, y el líder las vigila todas:
  //
  //   a) El jugador EN TURNO se cayó. Nadie va a jugar por él y la mesa se congela para siempre.
  //      → el líder emite un PASS en su nombre: la partida sigue, y él puede volver más tarde.
  //   b) El testigo se quedó en manos de un caído (murió justo después de jugar, sin cederlo).
  //      → el líder lo regenera con un `seq` mayor y se lo da a quien le toca jugar. El `seq`
  //        mayor es lo que garantiza que, si el caído resucita y anuncia su testigo viejo, todos
  //        lo descarten como el fantasma que es.
  //   c) El testigo se perdió por el camino, con su poseedor VIVO. El mensaje que lo cedía no
  //      llegó (o llegó mientras el otro recargaba la página): el jugador ve "es tu turno" y no
  //      puede tocar una carta. La partida está viva; él está fuera de ella.
  //      → si el testigo lleva `TOKEN_MISMATCH_MS` en manos de quien no tiene el turno, se regenera.
  //   d) Al jugador en turno se le acabó el tiempo (`TURN_MS`).
  //      → el líder emite un TIMEOUT: roba 2 y pierde el turno. La mesa no espera indefinidamente.
  const recoverIfStuck = useCallback(() => {
    const replica = replicaRef.current;
    const token = tokenRef.current;
    const detector = detectorRef.current;
    const bully = bullyRef.current;
    const room = roomRef.current;
    if (!replica || !token || !detector || !bully || !room) return;
    if (bully.leader !== myIdRef.current || !startedRef.current) return; // solo el líder
    if (replica.state.finished) return;

    const now = Date.now();
    if (now - lastRecoveryRef.current < RECOVERY_COOLDOWN) return;

    const turnOwner = holderOf(replica.state);

    /**
     * Nadie se rescata a sí mismo. El detector ya lo garantiza (`self`), pero el cinturón se pone
     * también aquí: el día que esto falle, el líder se salta su propio turno cada ronda y no vuelve
     * a jugar en toda la partida — sin un solo error en pantalla. Ya pasó una vez.
     */
    const isDown = (peerId: string) => peerId !== myIdRef.current && detector.isDown(peerId);

    /** Fuerza el fin del turno de `quien`: roba 2 y pasa. Y el testigo va a quien toque ahora. */
    const forceTimeout = (quien: string, motivo: string) => {
      lastRecoveryRef.current = now;
      const stamped: Stamped<GameEvent> = {
        lamport: clockRef.current.tick(),
        origin: myIdRef.current,
        event: { type: 'TIMEOUT', playerId: quien },
      };
      replica.deliver(stamped);
      room.broadcast({ k: 'event', stamped, recovery: true } satisfies NetMessage);

      const next = holderOf(replica.state);
      const regenerated = token.regenerate(next);
      room.broadcast({ k: 'token', token: regenerated } satisfies NetMessage);
      log('token', `${nameOf(quien)} ${motivo}: roba 2 y pasa · testigo → ${nameOf(next)}`);
      tokenMismatchRef.current = 0;
      refresh();
    };

    // (a) el que tiene que jugar está caído. No va a jugar: se le acaba el tiempo como a cualquiera.
    if (isDown(turnOwner)) {
      forceTimeout(turnOwner, 'caído');
      return;
    }

    // (d) al jugador en turno se le acabó el tiempo, sin más. La mesa no espera indefinidamente.
    if (turnRef.current.holder === turnOwner && now - turnRef.current.at > TURN_MS) {
      forceTimeout(turnOwner, 'sin tiempo');
      return;
    }

    // (b) el testigo se perdió con un caído, pero el turno es de otro → se regenera y se entrega.
    if (isDown(token.holder) && token.holder !== turnOwner) {
      lastRecoveryRef.current = now;
      const regenerated = token.regenerate(turnOwner);
      room.broadcast({ k: 'token', token: regenerated } satisfies NetMessage);
      log('token', `testigo perdido con ${nameOf(token.holder)} (caído): regenerado → ${nameOf(turnOwner)}`);
      tokenMismatchRef.current = 0;
      refresh();
      return;
    }

    // (c) el testigo está en manos de alguien VIVO que ya no tiene el turno: el mensaje que lo
    // cedía se perdió. Nadie puede jugar y nadie está caído — la partida se muere de pie. Se
    // tolera un rato (los mensajes tardan), y si no se arregla solo, el líder lo regenera.
    if (token.holder !== turnOwner) {
      if (tokenMismatchRef.current === 0) {
        tokenMismatchRef.current = now;
      } else if (now - tokenMismatchRef.current > TOKEN_MISMATCH_MS) {
        lastRecoveryRef.current = now;
        const regenerated = token.regenerate(turnOwner);
        room.broadcast({ k: 'token', token: regenerated } satisfies NetMessage);
        log('token', `el testigo no llegó a ${nameOf(turnOwner)}: regenerado y reenviado`);
        tokenMismatchRef.current = 0;
        refresh();
      }
    } else {
      tokenMismatchRef.current = 0; // está donde debe
    }
  }, [log, nameOf, refresh]);

  /**
   * ¿Mi partida sigue siendo la misma que la de los demás?
   *
   * Cada latido trae la huella del estado de quien lo manda. La del líder es la referencia (no
   * porque tenga razón por decreto, sino porque hace falta UNA para no discutir eternamente). Si la
   * mía difiere y no se arregla sola en `DIVERGED_MS`, pido reparación: que me manden su historia
   * entera y la adopto tirando la mía.
   */
  const checkDiverged = useCallback(
    (now: number) => {
      const replica = replicaRef.current;
      const bully = bullyRef.current;
      const room = roomRef.current;
      if (!replica || !bully || !room || !startedRef.current) return;
      if (replica.state.finished) return;

      const leader = bully.leader;
      if (!leader || leader === myIdRef.current) return; // el líder es su propia referencia

      const suyo = beatsRef.current.get(leader)?.hash;
      if (!suyo) return; // aún no ha latido: nada que comparar

      if (suyo === stateHash(replica.state)) {
        divergedRef.current = 0; // vamos a la par
        return;
      }

      // Difieren. Puede ser un desfase de milisegundos (normal) o una divergencia de verdad.
      if (divergedRef.current === 0) {
        divergedRef.current = now;
        return;
      }
      if (now - divergedRef.current < DIVERGED_MS) return;
      if (now - lastRepairRef.current < DIVERGED_MS) return; // ya hay una reparación en camino

      lastRepairRef.current = now;
      divergedRef.current = 0;
      log('sync', `me desincronicé de ${nameOf(leader)}: pidiendo la partida entera`);
      room.sendTo(leader, { k: 'sync-req', repair: true } satisfies NetMessage);
    },
    [log, nameOf],
  );

  // --- Latido, detección de fallos y elección (se ejecuta cada TICK_MS) -------
  const tickMesh = useCallback(() => {
    const detector = detectorRef.current;
    const bully = bullyRef.current;
    const room = roomRef.current;
    if (!detector || !bully || !room) return;

    const now = Date.now();

    // 1. Latir: "sigo vivo, y esta es la huella del estado al que he convergido".
    if (detector.shouldBeat(now)) {
      const hb: Heartbeat = {
        hash: replicaRef.current ? stateHash(replicaRef.current.state) : null,
        lamport: clockRef.current.time,
        token: tokenRef.current?.snapshot() ?? null,
        leaderId: bully.leader,
      };
      room.broadcast({ k: 'hb', hb } satisfies NetMessage);
    }

    // 2. Escuchar el silencio: quién lleva demasiado tiempo sin latir.
    for (const change of detector.sweep(now)) {
      if (change.to === 'suspect') {
        log('down', `${nameOf(change.peerId)} no responde…`);
      } else if (change.to === 'down') {
        log('down', `${nameOf(change.peerId)} CAÍDO (sin latidos)`);
        if (!startedRef.current && bully.leader === myIdRef.current) {
          lobbyRef.current = lobbyRef.current.filter((p) => p.peerId !== change.peerId);
          broadcastLobby();
        }
        // Si el caído era el líder, hay que elegir otro: la partida no puede quedarse sin
        // coordinador (nadie atendería reconexiones ni destrabaría turnos).
        if (change.peerId === bully.leader) {
          log('election', `cayó el líder (${nameOf(change.peerId)}): elección en marcha`);
          bully.onPeerDown(change.peerId, now);
        }
      }
    }

    // 3. Vencer los temporizadores de la elección en curso (si la hay).
    bully.tick(now);

    // 4. Como líder: destrabar la partida si alguien cayó con el turno o el testigo.
    recoverIfStuck();

    // 5. ¿Me he desviado? Comparo mi huella con la del líder (viene en su latido).
    //
    // Esta es la red que faltaba. La convergencia del diseño es sólida MIENTRAS todos reciban los
    // mismos eventos; si uno se pierde uno —y en una red doméstica, con móviles que se suspenden,
    // se pierden— ese nodo se queda con otra partida en la cabeza para siempre: ve otro turno, otras
    // manos, y no puede jugar. No basta con pedir "los eventos que me faltan": hay que tirar la
    // historia propia y adoptar la del líder entera (`Replica.adopt`).
    checkDiverged(now);

    refreshMesh();
  }, [broadcastLobby, checkDiverged, log, nameOf, recoverIfStuck, refreshMesh]);

  const handleMessage = useCallback(
    (from: string, msg: NetMessage) => {
      const now = Date.now();
      switch (msg.k) {
        case 'lobby':
          hostIdRef.current = msg.hostId;
          lobbyRef.current = msg.players;
          setLobby(msg.players);
          // El anfitrión es el líder de arranque, hasta que se demuestre lo contrario.
          if (!bullyRef.current?.leader) bullyRef.current?.assume(msg.hostId);
          break;

        case 'start':
          if (from !== bullyRef.current?.leader && from !== hostIdRef.current) return;
          startReplica(msg.setup, msg.token.seq, msg.token.holder);
          drainPending(); // las jugadas que se adelantaron al "empezar" no se pierden
          break;

        case 'event':
          // Sin motor todavía (aún llega el historial): se guarda, no se tira. Ver `pendingRef`.
          if (!replicaRef.current) {
            if (pendingRef.current.length < 500) {
              pendingRef.current.push({ from, stamped: msg.stamped, recovery: msg.recovery });
            }
            return;
          }
          onRemoteEvent(from, msg.stamped, msg.recovery);
          break;

        case 'token':
          if (tokenRef.current?.receive(msg.token)) refresh();
          break;

        case 'hb': {
          // Un latido es una prueba de vida (reinicia el timeout del emisor) y, de paso, un
          // chivato de convergencia: trae la huella de SU estado, que la Pantalla Maestra compara
          // con la mía. Si dos nodos anuncian huellas distintas, algo se ha desviado.
          beatsRef.current.set(from, msg.hb);
          const change = detectorRef.current?.beat(from, now);
          if (change?.from === 'down') log('up', `${nameOf(from)} ha vuelto`);
          // Un nodo que acaba de entrar no sabe quién manda: se fía del líder que le anuncian.
          if (!bullyRef.current?.leader && msg.hb.leaderId) {
            bullyRef.current?.assume(msg.hb.leaderId);
          }
          break;
        }

        case 'bully':
          bullyRef.current?.receive(from, msg.msg as BullyMessage, now);
          break;

        case 'sync-req': {
          // Alguien llega tarde, vuelve de una caída, o se ha desviado (`repair`): le mandamos la
          // historia completa. Responde cualquier nodo que tenga la partida (no hace falta que sea
          // el líder): el log es idempotente, así que varias respuestas iguales no hacen daño — y
          // así la reconexión no depende de que un nodo concreto siga vivo.
          const snap = snapshot();
          if (snap) {
            roomRef.current?.sendTo(from, {
              k: 'sync',
              snapshot: snap,
              ...(msg.repair ? { repair: true } : {}),
            } satisfies NetMessage);
          }
          break;
        }

        case 'sync': {
          const { setup, log: history, token, leaderId } = msg.snapshot;
          if (!startedRef.current) startReplica(setup, token.seq, token.holder);
          const replica = replicaRef.current;
          if (!replica) return;
          for (const stamped of history) clockRef.current.update(stamped.lamport);

          if (msg.repair) {
            // Reparación: no se funden las dos historias, se ADOPTA la ajena. Mezclarlas sería
            // conservar justo lo que me desvió — y seguiría sin ser la misma partida que la suya.
            replica.adopt(history);
            // El testigo del otro manda también: el mío pertenecía a la partida que acabo de tirar.
            tokenRef.current?.receive(token, { force: true });
            divergedRef.current = 0;
            log('sync', `partida reconstruida desde ${nameOf(from)} (${history.length} eventos)`);
          } else {
            replica.deliverAll(history);
            tokenRef.current?.receive(token);
            log('sync', `sincronizado con ${nameOf(from)}: ${history.length} eventos en el log`);
          }

          if (!bullyRef.current?.leader) bullyRef.current?.assume(leaderId);

          // Y ahora las jugadas que llegaron MIENTRAS viajaba este historial. Sin esto se perderían:
          // el historial se generó antes que ellas, así que no las trae — y ya no llegarían nunca.
          drainPending();
          refresh();
          break;
        }
      }
    },
    [drainPending, log, nameOf, onRemoteEvent, refresh, snapshot, startReplica],
  );

  // --- Wiring de la sala ----------------------------------------------------
  const wireRoom = useCallback(
    (room: Room) => {
      room.on('status', (s: RoomStatus) => setStatus(s));
      room.on('message', ({ from, data }: { from: string; data: NetMessage }) =>
        handleMessage(from, data),
      );

      room.on('peeropen', (peerId: string) => {
        const now = Date.now();
        detectorRef.current?.watch(peerId, now);

        if (bullyRef.current?.leader === myIdRef.current && !startedRef.current) {
          const peer = room.peers().find((p) => p.peerId === peerId);
          if (peer && !lobbyRef.current.some((p) => p.peerId === peerId)) {
            lobbyRef.current = [...lobbyRef.current, { peerId, name: peer.name }];
          }
          broadcastLobby();
        }

        // Al abrirse un canal (primera vez o tras reconectar) se intercambia historia:
        //   - Si yo tengo partida, le mando mi snapshot: si él venía de una caída, recupera de
        //     golpe todo lo que se perdió mientras estaba fuera.
        //   - Si no la tengo, se la pido. Entre los dos, ningún hueco sobrevive al reencuentro.
        const snap = snapshot();
        if (snap) room.sendTo(peerId, { k: 'sync', snapshot: snap } satisfies NetMessage);
        else room.sendTo(peerId, { k: 'sync-req' } satisfies NetMessage);
      });

      room.on('peerclose', (peerId: string) => {
        // OJO: cerrar un canal NO es morirse. Puede ser un corte de red pasajero (la Room lo
        // reintenta) o incluso una reconexión. Quien decide que alguien está caído es el detector
        // de fallos, por ausencia de latidos — nunca este evento. Aquí solo actuamos en el lobby,
        // donde no hay partida que proteger y conviene que la lista se sienta viva.
        if (startedRef.current) return;
        if (bullyRef.current?.leader !== myIdRef.current) return;
        lobbyRef.current = lobbyRef.current.filter((p) => p.peerId !== peerId);
        broadcastLobby();
      });
    },
    [broadcastLobby, handleMessage, snapshot],
  );

  const enter = useCallback(
    (name: string, code: string, asHost: boolean) => {
      const myId = identityFor(code);
      myIdRef.current = myId;
      isHostRef.current = asHost;
      if (asHost) hostIdRef.current = myId;
      lobbyRef.current = [{ peerId: myId, name }];
      startedRef.current = false;
      replicaRef.current = null;
      tokenRef.current = null;
      setupRef.current = null;
      clockRef.current = new LamportClock();
      beatsRef.current = new Map();
      lastRecoveryRef.current = 0;

      // El detector tiene que saber quién soy: si no, me da por caído a mí mismo (nadie se manda
      // latidos) y, siendo líder, me salto mi propio turno cada ronda.
      const detector = new FailureDetector({ self: myId });
      detectorRef.current = detector;

      const bully = new BullyElection({
        self: myId,
        aliveNodes: () => detector.alive(),
        send: (to, m) => roomRef.current?.sendTo(to, { k: 'bully', msg: m } satisfies NetMessage),
        broadcast: (m) => roomRef.current?.broadcast({ k: 'bully', msg: m } satisfies NetMessage),
        onLeader: (leaderId) => {
          log(
            'leader',
            leaderId === myIdRef.current
              ? 'soy el nuevo líder (coordinador de la sala)'
              : `nuevo líder: ${nameOf(leaderId)}`,
          );
          refreshMesh();
        },
      });
      bullyRef.current = bully;
      // El anfitrión arranca de líder sin votar: no hay nada que discutir cuando estás solo.
      if (asHost) bully.assume(myId);

      setIsHost(asHost);
      setRoomId(code);
      setLobby([{ peerId: myId, name }]);
      setPhase('lobby');
      setCanAct(false);
      setJournal([]);
      setMesh(EMPTY_MESH);
      const session = ++sessionRef.current;

      void loadIceServers().then((iceServers) => {
        if (sessionRef.current !== session) return; // esta entrada ya fue abandonada
        // La señalización puede venir del QR que escaneó este jugador (Fase 6): no hay una URL
        // "oficial" — la levanta quien crea la sala y la reparte con la invitación.
        const room = new Room(
          signalUrl(),
          code,
          { peerId: myId, name, epoch: thisPageLoad() },
          { iceServers },
        );
        roomRef.current = room;
        wireRoom(room);
        room.connect();
      });

      if (tickerRef.current) clearInterval(tickerRef.current);
      tickerRef.current = setInterval(() => tickMesh(), TICK_MS);
    },
    [log, nameOf, refreshMesh, tickMesh, wireRoom],
  );

  const host = useCallback((name: string) => enter(name, newRoomCode(), true), [enter]);
  const join = useCallback(
    (name: string, code: string) => enter(name, code.trim().toUpperCase(), false),
    [enter],
  );

  const startGame = useCallback(() => {
    if (bullyRef.current?.leader !== myIdRef.current) return;
    const players = [...lobbyRef.current];
    if (players.length < 2) {
      setError('Se necesitan al menos 2 jugadores');
      return;
    }

    const seed = (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0;
    const setup: GameSetup = { seed, players };

    // El testigo arranca en quien abre la partida según el motor (mismo cálculo en todos).
    const initial = createGame(
      seed,
      players.map((p) => ({ id: p.peerId, name: p.name })),
    );
    const token = { seq: 0, holder: holderOf(initial) };

    startedRef.current = true;
    broadcastLobby();
    roomRef.current?.broadcast({ k: 'start', setup, token } satisfies NetMessage);
    startReplica(setup, token.seq, token.holder);
  }, [broadcastLobby, startReplica]);

  const me = myIdRef.current;
  const actions = {
    play: (cardId: string, opts: PlayOptions = {}) =>
      emit({ type: 'PLAY', playerId: me, cardId, ...opts }),
    draw: () => emit({ type: 'DRAW', playerId: me }),
    pass: () => emit({ type: 'PASS', playerId: me }),
    shoutBug: () => emit({ type: 'SHOUT_BUG', playerId: me }),
    callBug: (accusedId: string) => emit({ type: 'CALL_BUG', accuserId: me, accusedId }),
  };

  /**
   * Despedirse de la mesa: el evento `QUIT`, que te saca de la rotación PARA SIEMPRE.
   *
   * ⚠️ Solo se emite en una salida EXPLÍCITA (el botón de salir). Antes también se lanzaba al
   * descargar la página (`pagehide`) — y ahí estaba el fallo: **el navegador dispara `pagehide`
   * también al recargar**. Un F5 y te expulsabas de tu propia partida, sin vuelta atrás.
   *
   * Cerrar la pestaña o recargar ya no es "irse", es "caerse": los demás te guardan el sitio, el
   * líder te va saltando el turno mientras no estás, y cuando vuelves recuperas tu mano. Que es
   * exactamente lo que uno espera de un F5.
   */
  const farewell = useCallback(() => {
    const replica = replicaRef.current;
    if (!startedRef.current || !replica || replica.state.finished) return;
    if (!replica.state.players.some((p) => p.id === myIdRef.current && p.status !== 'down')) return;
    emit({ type: 'QUIT', playerId: myIdRef.current });
  }, [emit]);

  const leave = useCallback(() => {
    farewell();

    sessionRef.current++; // cualquier trabajo en vuelo de esta sesión queda invalidado
    if (tickerRef.current) clearInterval(tickerRef.current);
    tickerRef.current = null;

    // El cierre va con retraso a propósito: primero tiene que salir el adiós por los canales.
    const room = roomRef.current;
    if (room) setTimeout(() => room.destroy(), FAREWELL_GRACE);

    roomRef.current = null;
    replicaRef.current = null;
    tokenRef.current = null;
    setupRef.current = null;
    detectorRef.current = null;
    bullyRef.current = null;
    startedRef.current = false;
    setPhase('idle');
    setView(null);
    setLobby([]);
    setRoomId(null);
    setError(null);
    setCanAct(false);
    setMesh(EMPTY_MESH);
  }, [farewell]);

  // OJO: aquí NO se escucha `pagehide`. Se hacía, para mandar el adiós al cerrar la pestaña, y era
  // un error: el navegador dispara `pagehide` también al RECARGAR, así que un F5 te expulsaba de tu
  // propia partida. Descargar la página se trata ahora como una caída —te guardan el sitio— y la
  // recarga te devuelve a la mesa (ver `web/lib/session.ts`). Irse de verdad es un botón.

  // Red de seguridad: si el componente muere sin llamar a `leave`, no dejamos el ticker corriendo.
  useEffect(() => () => {
    if (tickerRef.current) clearInterval(tickerRef.current);
  }, []);

  return {
    phase,
    status,
    isHost,
    roomId,
    lobby,
    view,
    error,
    canAct,
    mesh,
    journal,
    leaderId: mesh.leaderId,
    isLeader: mesh.leaderId === myIdRef.current,
    tokenHolder: mesh.tokenHolder,
    myId: myIdRef.current,
    /** Cuándo empezó el turno en curso, para la cuenta atrás. */
    turnStartedAt,
    /** Lo que dura un turno antes del castigo. */
    turnMs: TURN_MS,
    host,
    join,
    startGame,
    leave,
    actions,
  };
}
