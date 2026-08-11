'use client';

import { useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { AnimatePresence, motion } from 'framer-motion';
import { canPlayOn, type Card, type PublicView } from '@bug/engine';
import { CardView } from './CardView';
import { RulesScreen } from './RulesScreen';
import { SUIT } from '@/lib/cards';
import { effectFor } from '@/lib/effects';
import type { EffectCue } from './EffectsLayer';

// La capa de efectos va en su propio chunk y solo en el cliente (PixiJS necesita `window`, y su
// peso no puede colarse en el arranque de la página).
const EffectsLayer = dynamic(() => import('./EffectsLayer'), { ssr: false });

interface Props {
  view: PublicView;
  /** id del jugador local (de quién se muestra la mano). */
  myId: string;
  error: string | null;
  onPlay: (cardId: string) => void;
  onDraw: () => void;
  onPass: () => void;
  onShoutBug: () => void;
  onCallBug: (accusedId: string) => void;
  onReset?: () => void;
  /** Abandonar a media partida (en red: se despide de la mesa). Sin esto solo queda cerrar la pestaña. */
  onLeave?: () => void;
  /**
   * En red: ¿tengo el testigo de turno? Es lo que habilita de verdad las acciones — el estado
   * puede decir que me toca una fracción de segundo antes de que el testigo me llegue.
   * En hot-seat no hay testigo, así que se deriva del estado.
   */
  canAct?: boolean;
  /** Cuándo empezó el turno en curso (para la cuenta atrás). Sin esto, no hay reloj. */
  turnStartedAt?: number | null;
  /** Lo que dura un turno antes del castigo. */
  turnMs?: number;
}

/**
 * Cuenta atrás del turno.
 *
 * El reloj es LOCAL: cada nodo lo arranca cuando aplica el evento que cambió el turno. No es un
 * reloj compartido —no existe tal cosa en una malla— y no hace falta que lo sea: quien decide de
 * verdad que se acabó el tiempo es el líder, con un evento que el motor valida. Esto solo lo
 * enseña.
 */
function TurnClock({ startedAt, total }: { startedAt: number; total: number }) {
  const [left, setLeft] = useState(total);

  useEffect(() => {
    const tick = () => setLeft(Math.max(0, total - (Date.now() - startedAt)));
    tick();
    const id = setInterval(tick, 200);
    return () => clearInterval(id);
  }, [startedAt, total]);

  const seconds = Math.ceil(left / 1000);
  const ratio = left / total;
  const urgente = seconds <= 10;

  return (
    <div className="flex flex-col items-center gap-1">
      <span
        className={`font-pixel text-[10px] sm:text-xs tabular-nums ${
          urgente ? 'text-red-400 animate-pulse' : 'text-white/60'
        }`}
      >
        ⏱ {seconds}s
      </span>
      <div className="w-28 sm:w-40 h-1.5 rounded-full bg-black/50 overflow-hidden">
        <div
          className={`h-full transition-[width] duration-200 ease-linear ${
            urgente ? 'bg-red-500' : 'bg-[#07d98c]'
          }`}
          style={{ width: `${ratio * 100}%` }}
        />
      </div>
    </div>
  );
}

/**
 * Dispara el efecto de la carta que acaba de caer al pozo.
 *
 * Se mira el TOPE DEL POZO, no los eventos de red: así el mismo código sirve para el hot-seat y
 * para la malla, y —lo importante— cada nodo dispara su efecto a partir de su propio estado
 * replicado. Nadie manda "reproduce un BSOD": todos llegan a la misma carta y la ven caer.
 */
function useCardEffect(view: PublicView): EffectCue | null {
  const [cue, setCue] = useState<EffectCue | null>(null);
  const lastTopRef = useRef<string | null>(null);

  const topId = view.topCard.id;
  useEffect(() => {
    const first = lastTopRef.current === null;
    if (lastTopRef.current === topId) return;
    lastTopRef.current = topId;
    if (first) return; // la carta que ya estaba en el pozo al entrar no "acaba de jugarse"

    const kind = effectFor(view.topCard);
    if (kind) setCue({ kind, id: Date.now() });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topId]);

  return cue;
}

export function GameBoard(props: Props) {
  const { view, myId, error, onPlay, onDraw, onPass, onShoutBug, onCallBug, onReset, onLeave } = props;
  const me = view.players.find((p) => p.id === myId);
  const myHand = view.yourHand ?? [];
  const top = view.topCard;
  const color = SUIT[view.currentColor];
  const turnPlayer = view.players[view.turn];
  const isMyTurn = turnPlayer?.id === myId;
  const canAct = props.canAct ?? isMyTurn;
  const opponents = view.players.filter((p) => p.id !== myId);
  const cue = useCardEffect(view);
  const [rules, setRules] = useState(false);

  /**
   * ¿Con esta carta puedo cortar la ronda ahora mismo?
   *
   * Cortar ya no es gratis: el Copiar y Pegar tiene color, así que además de ser un portapapeles
   * tiene que IGUALAR el pozo, como cualquier otra carta. Lo único que se salta es el turno.
   */
  const puedeCortar = (card: Card) =>
    card.kind === 'copy_paste' && canPlayOn(top, view.currentColor, card);

  /**
   * El arranque: mientras nadie ha jugado (`seq === 0`) se reparten las cartas y se anuncia a quién
   * le toca abrir. Quién empieza lo decide la SEMILLA, no la lista de jugadores — así que ya no es
   * siempre el anfitrión, y por eso hay que decirlo en voz alta.
   */
  const repartiendo = view.seq === 0 && !view.finished;
  const [anuncio, setAnuncio] = useState(repartiendo);
  useEffect(() => {
    if (!repartiendo) {
      setAnuncio(false);
      return;
    }
    setAnuncio(true);
    const id = setTimeout(() => setAnuncio(false), 2600);
    return () => clearTimeout(id);
  }, [repartiendo]);

  /**
   * ¿Puedo cortar la ronda ahora mismo? Solo si no me toca y la carta del pozo no la puse yo — las
   * mismas dos condiciones que comprueba el motor, porque si la UI ofreciera una interrupción que
   * el motor va a rechazar, el jugador tiraría su carta contra un error.
   */
  const canInterrupt = !view.finished && !isMyTurn && view.lastPlayer !== myId;

  // Reglas del turno, tal y como las aplica el motor. La UI no las inventa: las enseña.
  //
  //   · Sin ninguna carta jugable, robar deja de ser una opción y pasa a ser LA opción: el botón
  //     brilla, porque es la única salida y el reloj corre.
  //   · Pasar exige haber robado antes. Pasar de gratis era la puerta trasera para esquivar el robo.
  const tengoJugable = myHand.some((c) => canPlayOn(top, view.currentColor, c));
  const debeRobar = canAct && !tengoJugable && !view.drewThisTurn;
  const puedePasar = canAct && view.drewThisTurn;

  return (
    <div className="min-h-[100dvh] flex flex-col p-2 sm:p-6 gap-2 sm:gap-4">
      <EffectsLayer cue={cue} />

      {/* Consultar las reglas sin abandonar la mesa: la carta rara aparece a mitad de partida. */}
      <button
        onClick={() => setRules(true)}
        title="Cómo se juega"
        className="fixed top-3 right-3 z-40 font-pixel text-[9px] px-3 py-2 rounded-lg
                   bg-black/60 text-white/50 hover:text-white/90 border-2 border-black/60 shadow-pixel"
      >
        📖 reglas
      </button>
      <AnimatePresence>{rules && <RulesScreen onClose={() => setRules(false)} />}</AnimatePresence>

      {/* Abandonar. El tablero solo ofrece la puerta; lo que significa cruzarla (y si hay que
          avisar antes) lo decide quien conoce la partida — en red no tiene vuelta atrás.
          Se deja montado SIEMPRE, también al acabar: la pantalla de fin lo tapa (z-[60]), pero si
          algún día esa pantalla fallara, nadie debería quedarse encerrado en una mesa muerta. */}
      {onLeave && (
        <button
          onClick={onLeave}
          className="fixed bottom-3 left-3 z-40 font-pixel text-[9px] px-3 py-2 rounded-lg
                     bg-black/60 text-white/50 hover:text-white/90 border-2 border-black/60 shadow-pixel"
        >
          🚪 salir
        </button>
      )}

      {/* Oponentes */}
      <div className="flex flex-wrap justify-center gap-2 sm:gap-4">
        {opponents.map((p) => {
          const gone = p.status === 'down';
          return (
            <div
              key={p.id}
              className={`flex flex-col items-center gap-1 rounded-lg px-2 py-1 ${
                turnPlayer?.id === p.id ? 'bg-yellow-300/15 ring-1 ring-yellow-300/50' : ''
              } ${gone ? 'opacity-40 grayscale' : ''}`}
            >
              <div className="flex -space-x-5 sm:-space-x-6">
                {gone ? (
                  <span className="text-2xl" title="abandonó la partida">
                    👋
                  </span>
                ) : (
                  Array.from({ length: Math.min(p.handCount, 7) }).map((_, i) => (
                    <CardView key={i} faceDown size="sm" />
                  ))
                )}
              </div>
              <span className="font-pixel text-[9px] sm:text-[10px] text-white/80">
                {p.name} · {gone ? 'se fue' : p.handCount}
              </span>
              {/* A un ausente no se le acusa: ya no tiene cartas ni turno. */}
              {!gone && p.handCount === 1 && !p.saidBug && (
                <button
                  onClick={() => onCallBug(p.id)}
                  className="font-pixel text-[8px] px-2 py-1 rounded bg-red-500/80 text-white"
                >
                  ¡acusar Bug!
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/* Centro: mazo + pozo + color actual */}
      <div className="flex-1 grid place-items-center">
        <div className="flex items-center gap-4 sm:gap-8">
          {/* El mazo. Cuando no tienes ninguna jugada, deja de ser decoración: brilla, porque es
              tu única salida y el reloj no se detiene. */}
          <div
            className={`flex flex-col items-center gap-2 rounded-xl p-1 ${
              debeRobar ? 'ring-4 ring-yellow-300 animate-pulse' : ''
            }`}
          >
            <CardView faceDown size="lg" onClick={onDraw} playable={canAct} />
            <button
              onClick={onDraw}
              disabled={!canAct}
              className={`font-pixel text-[9px] sm:text-[10px] px-3 py-2 rounded border disabled:opacity-40 ${
                debeRobar
                  ? 'bg-yellow-400 text-black border-yellow-200 font-bold'
                  : 'bg-black/50 border-white/20'
              }`}
            >
              {debeRobar ? '¡ROBA!' : 'Robar'} ({view.drawCount})
            </button>
          </div>

          <div className="flex flex-col items-center gap-2">
            <AnimatePresence mode="popLayout">
              <CardView
                key={top.id}
                card={top}
                size="lg"
                testId="pile-top"
                layoutId={`card-${top.id}`}
                // Un comodín no tiene color propio: sin esto, mirando el pozo no sabrías a qué hay
                // que igualar. La carta gira y aterriza teñida del color que eligió quien la jugó.
                wildColor={top.color == null ? color.hex : undefined}
              />
            </AnimatePresence>
            <span
              className="font-pixel text-[9px] sm:text-[10px] px-3 py-1 rounded-full border-2 border-black/50"
              style={{ backgroundColor: color.hex, color: color.fg }}
            >
              {color.label}
            </span>
          </div>
        </div>
      </div>

      {/* Barra de estado: quién juega, cuánto le queda, y qué se espera de ti.
          Los `data-*` son el gancho de las pruebas de extremo a extremo: el texto de dentro cambia
          según lo que toque hacer ("¡Es tu turno!", "ROBA una carta", un error…), así que afirmar
          sobre él sería frágil. De quién es el turno, en cambio, siempre es la misma pregunta. */}
      <div
        data-testid="status-bar"
        data-turn={turnPlayer?.id ?? ''}
        data-turn-name={turnPlayer?.name ?? ''}
        className="flex flex-col items-center gap-2 min-h-[3.5rem]"
      >
        {error ? (
          <span className="font-pixel text-[9px] sm:text-[10px] text-red-400">⚠ {error}</span>
        ) : canInterrupt && myHand.some((c) => puedeCortar(c)) ? (
          <span className="font-pixel text-[9px] sm:text-[10px] text-[#f27eb4] animate-pulse">
            📋 puedes CORTAR la ronda con Copiar y Pegar
          </span>
        ) : debeRobar ? (
          <span className="font-pixel text-[9px] sm:text-[10px] text-yellow-300 animate-pulse">
            no tienes jugada: ROBA una carta
          </span>
        ) : (
          <span className="font-pixel text-[9px] sm:text-[10px] text-white/50">
            {isMyTurn ? '¡Es tu turno!' : `Turno de ${turnPlayer?.name ?? '—'}`}
          </span>
        )}

        {/* El reloj corre para todos, no solo para ti: así se ve por qué el de enfrente va a robar
            dos cartas dentro de nada. */}
        {!view.finished && props.turnStartedAt != null && props.turnMs != null && (
          <TurnClock startedAt={props.turnStartedAt} total={props.turnMs} />
        )}
      </div>

      {/* Mano del jugador local */}
      <div className="bg-black/30 rounded-2xl p-2 sm:p-3 border-2 border-black/50">
        <div className="flex items-center justify-between mb-2 px-1 gap-2">
          <span className="font-pixel text-[10px] sm:text-xs truncate" style={{ color: color.hex }}>
            {me?.name ?? 'Tú'}
          </span>
          <div className="flex gap-2 shrink-0">
            {myHand.length === 1 && (
              <button
                onClick={onShoutBug}
                className={`font-pixel text-[9px] sm:text-[10px] px-3 py-2 rounded ${
                  me?.saidBug ? 'bg-green-600/60' : 'bg-yellow-400 text-black animate-pulse'
                }`}
              >
                {me?.saidBug ? '✓ dijiste Bug' : '¡Grita BUG!'}
              </button>
            )}
            {/* Pasar solo se desbloquea si ya robaste: no se pasa de gratis. */}
            <button
              onClick={onPass}
              disabled={!puedePasar}
              title={canAct && !puedePasar ? 'tienes que robar antes de pasar' : undefined}
              className="font-pixel text-[9px] sm:text-[10px] px-3 py-2 rounded bg-black/50 border border-white/20 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Pasar
            </button>
          </div>
        </div>
        {/* La mano va CENTRADA. El scroll vive en el contenedor y el `w-max mx-auto` centra las
            cartas cuando caben; cuando no caben (una mano larga), el ancho manda y el scroll
            aparece sin recortar nada por los lados. */}
        <div className="overflow-x-auto hand-scroll pb-2">
          <motion.div
            layout
            className="flex gap-1.5 sm:gap-2 w-max mx-auto min-h-[5.5rem] sm:min-h-[7rem] items-end px-1"
          >
            {myHand.map((card, i) => {
              // "Copiar y Pegar" se juega FUERA de turno: es la única carta que sigue viva cuando
              // no te toca (ver `applyCopyPaste` en el motor) — si además iguala el pozo.
              const interrupt = canInterrupt && puedeCortar(card);
              const playable = interrupt || (canAct && canPlayOn(top, view.currentColor, card));
              return (
                <CardView
                  key={card.id}
                  card={card}
                  testId="hand-card"
                  layoutId={`card-${card.id}`}
                  playable={playable}
                  dimmed={!playable}
                  interrupt={interrupt}
                  dealIndex={repartiendo ? i : undefined}
                  onClick={() => onPlay(card.id)}
                />
              );
            })}
          </motion.div>
        </div>
      </div>

      {/* Quién abre la partida. Hace falta decirlo: ya no es siempre el anfitrión, lo decide la
          semilla, y sin anuncio nadie sabría por qué le toca a quien le toca. */}
      <AnimatePresence>
        {anuncio && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 grid place-items-center bg-black/70 pointer-events-none"
          >
            <motion.div
              initial={{ scale: 0.5, rotate: -8 }}
              animate={{ scale: 1, rotate: 0 }}
              exit={{ scale: 1.3, opacity: 0 }}
              transition={{ type: 'spring', stiffness: 200, damping: 14 }}
              className="text-center px-8"
            >
              <div className="text-5xl sm:text-6xl mb-4">🎴</div>
              <p className="font-pixel text-[10px] sm:text-xs text-white/50 mb-2">repartiendo…</p>
              <p
                className="font-pixel text-lg sm:text-3xl"
                style={{ color: isMyTurn ? '#07d98c' : '#f27eb4' }}
              >
                {isMyTurn ? '¡EMPIEZAS TÚ!' : `empieza ${turnPlayer?.name ?? '—'}`}
              </p>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Fin de la partida. Ganar y perder no se cuentan igual: antes ponía "Fulano ganó" a los dos
          y el que perdía tenía que deducirlo. Y por encima de TODO (z-[60]): esta pantalla es la
          única salida, así que ni los efectos ni la Pantalla Maestra pueden taparla. */}
      <AnimatePresence>
        {view.finished && <GameOver view={view} myId={myId} onReset={onReset} />}
      </AnimatePresence>
    </div>
  );
}

function GameOver({
  view,
  myId,
  onReset,
}: {
  view: PublicView;
  myId: string;
  onReset?: () => void;
}) {
  const winner = view.players.find((p) => p.id === view.winner);
  const gané = view.winner === myId;
  // Si el rival se fue y te quedaste solo, has ganado — pero no por jugar mejor. Conviene decirlo.
  const porAbandono = view.players.filter((p) => p.status !== 'down').length <= 1;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[60] grid place-items-center p-0"
    >
      {gané ? (
        <Victoria porAbandono={porAbandono} onReset={onReset} />
      ) : (
        <Derrota ganador={winner?.name ?? '—'} onReset={onReset} />
      )}
    </motion.div>
  );
}

/**
 * Confeti de píxeles: cuadraditos que caen girando, en los cuatro palos del juego.
 *
 * Las posiciones salen del índice y no de `Math.random`, por dos motivos que van en la misma
 * dirección: sale igual en las tres pantallas de una partida en red —que es de lo que va este
 * proyecto— y una captura de la pantalla de victoria es reproducible en vez de distinta cada vez.
 */
function Confeti() {
  const PALOS = ['#07d98c', '#a60d61', '#4227f2', '#f27eb4'];
  const piezas = Array.from({ length: 44 }, (_, i) => ({
    id: `confeti-${i}`,
    izq: (i * 37) % 100,
    color: PALOS[i % PALOS.length]!,
    retraso: ((i * 13) % 30) / 10,
    duracion: 2.6 + ((i * 7) % 20) / 10,
    tam: 6 + (i % 3) * 4,
    giro: i % 2 === 0 ? 360 : -360,
  }));

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden motion-reduce:hidden" aria-hidden>
      {piezas.map((p) => (
        <motion.div
          key={p.id}
          initial={{ y: '-12vh', rotate: 0, opacity: 1 }}
          animate={{ y: '112vh', rotate: p.giro, opacity: [1, 1, 0.9] }}
          transition={{ duration: p.duracion, delay: p.retraso, repeat: Infinity, ease: 'linear' }}
          style={{
            position: 'absolute',
            left: `${p.izq}%`,
            width: p.tam,
            height: p.tam,
            backgroundColor: p.color,
            boxShadow: '2px 2px 0 rgba(0,0,0,.45)',
          }}
        />
      ))}
    </div>
  );
}

/**
 * La copa, dibujada píxel a píxel como las cartas.
 *
 * Se escribe como un mapa de caracteres en vez de con un `<path>` porque así se lee —y se
 * retoca— igual que el arte del juego: cada letra es un píxel y se ve la forma en el propio
 * código. `o` es el borde, `O` el relleno, `s` la sombra que le da volumen.
 */
const COPA = [
  '  oooooooooo  ',
  '  oOOOOOOOOo  ',
  ' oOOOOOOOOOOo ',
  'ooOOOOOOOOOOoo',
  'oOsOOOOOOOOsOo',
  'oOsOOOOOOOOsOo',
  ' ooOOOOOOOOoo ',
  '  oOOOOOOOOo  ',
  '   oOOOOOOo   ',
  '    oOOOOo    ',
  '     oOOo     ',
  '     oOOo     ',
  '   ooOOOOoo   ',
  '  oOOOOOOOOo  ',
];

const TINTA_COPA: Record<string, string> = { o: '#B8860B', O: '#F2C14E', s: '#FFE9A8' };

/**
 * El bicho: el que da nombre al juego, y el que te ganó. Se dibuja entero y de frente, no aplastado
 * — perder no es matarlo, es quedártelo en la mano sin resolver.
 *
 * Va aquí y no una Pantalla Azul porque **el azul ya significa otra cosa**: es la carta «Pantalla
 * Azul de la Muerte», con su propio efecto cuando alguien la juega. Repetir esa imagen para el
 * final de la partida hacía creer que el juego se había roto — dos mensajes distintos con la misma
 * cara.
 */
const BICHO = [
  ' x       x ',
  '  x     x  ',
  '  ooooooo  ',
  ' oo ooo oo ',
  'ooooooooooo',
  'o ooooooo o',
  'o o     o o',
  '   oo oo   ',
];

const TINTA_BICHO: Record<string, string> = { o: '#FF7F50', x: '#ffffff' };

/** Dibuja un mapa de caracteres como píxeles. Lo usan la copa y el bicho. */
function Pixeles({
  mapa,
  tinta,
  clase,
}: Readonly<{ mapa: string[]; tinta: Record<string, string>; clase: string }>) {
  const ancho = mapa[0]!.length;
  return (
    <motion.svg
      viewBox={`0 0 ${ancho} ${mapa.length}`}
      className={`${clase} mx-auto pixelated`}
      aria-hidden
      initial={{ scale: 0.4, rotate: -12, opacity: 0 }}
      animate={{ scale: 1, rotate: 0, opacity: 1 }}
      transition={{ type: 'spring', stiffness: 180, damping: 12, delay: 0.15 }}
    >
      {mapa.flatMap((fila, y) =>
        [...fila].map((c, x) =>
          tinta[c] ? (
            <rect key={`${x}-${y}`} x={x} y={y} width="1" height="1" fill={tinta[c]} />
          ) : null,
        ),
      )}
    </motion.svg>
  );
}

function CopaPixel() {
  return <Pixeles mapa={COPA} tinta={TINTA_COPA} clase="w-32 sm:w-40" />;
}

/** Ganar es compilar sin errores: la pantalla que cualquier programador quiere ver. */
function Victoria({ porAbandono, onReset }: Readonly<{ porAbandono: boolean; onReset?: () => void }>) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="relative w-full h-full bg-[#04120c] grid place-items-center p-4 overflow-hidden"
    >
      <Confeti />

      <motion.div
        initial={{ scale: 0.8, y: 18 }}
        animate={{ scale: 1, y: 0 }}
        transition={{ type: 'spring', stiffness: 200, damping: 18 }}
        className="relative w-full max-w-lg rounded-2xl border-2 border-[#07d98c] bg-[#082016] p-6 sm:p-8 text-center shadow-pixel"
      >
        <CopaPixel />

        <motion.h2
          className="font-pixel text-2xl sm:text-4xl text-[#F2C14E] mt-4 mb-1 drop-shadow-[3px_3px_0_rgba(0,0,0,.6)]"
          initial={{ scale: 0.7, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: 'spring', stiffness: 220, damping: 14, delay: 0.35 }}
        >
          ¡GANASTE!
        </motion.h2>

        {/* El logo se queda, pero pequeño y debajo: quien gana quiere ver la copa, no la marca. */}
        <svg viewBox="0 0 100 66" className="w-16 sm:w-20 mx-auto mb-4 text-[#07d98c] opacity-70" aria-hidden>
          <use href="#c-logo" width="100" height="66" />
        </svg>

        {/* La consola del que compila bien: cero errores, cero avisos. */}
        <div className="text-left font-pixel text-[9px] sm:text-[11px] leading-relaxed bg-black/50 rounded-lg p-3 sm:p-4 border border-[#07d98c]/30 mb-6">
          <p className="text-[#07d98c]">&gt; build --release</p>
          <p className="text-white/70">
            {porAbandono ? 'te quedaste solo en la mesa' : 'te quedaste sin cartas'}
          </p>
          <p className="text-[#07d98c]">✓ 0 errores &nbsp; 0 avisos</p>
          <p className="text-white/40">compilado sin un solo bug</p>
        </div>

        {onReset && (
          <button
            type="button"
            onClick={onReset}
            className="w-full font-pixel text-xs sm:text-sm px-5 py-4 rounded-lg shadow-pixel bg-[#07d98c] text-[#04241a] hover:brightness-110 active:translate-y-0.5"
          >
            Volver al menú
          </button>
        )}
      </motion.div>
    </motion.div>
  );
}

/**
 * Perder es que la compilación falle: el reverso exacto de ganar.
 *
 * Ganar dice «0 errores, compilado sin un solo bug»; perder dice lo contrario, con el bicho
 * delante. Es la misma metáfora leída al revés, y por eso se entiende sin explicarla — mientras que
 * la Pantalla Azul que había aquí antes chocaba con la carta del mismo nombre: la misma imagen para
 * «alguien jugó una carta» y para «se acabó la partida» hacía pensar que el juego se había roto.
 */
function Derrota({ ganador, onReset }: Readonly<{ ganador: string; onReset?: () => void }>) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="relative w-full h-full grid place-items-center bg-black/85 p-4"
    >
      <motion.div
        initial={{ scale: 0.85, y: 16, opacity: 0 }}
        animate={{ scale: 1, y: 0, opacity: 1 }}
        transition={{ type: 'spring', stiffness: 210, damping: 20 }}
        className="w-full max-w-md rounded-2xl border-2 border-[#FF7F50] bg-[#1c0d0a] p-6 sm:p-8 shadow-pixel text-center"
      >
        <Pixeles mapa={BICHO} tinta={TINTA_BICHO} clase="w-28 sm:w-36" />

        <motion.h2
          className="font-pixel text-2xl sm:text-4xl text-[#FF7F50] mt-4 mb-1 drop-shadow-[3px_3px_0_rgba(0,0,0,.6)]"
          initial={{ scale: 0.7, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: 'spring', stiffness: 220, damping: 14, delay: 0.35 }}
        >
          PERDISTE
        </motion.h2>

        <p className="font-pixel text-[11px] sm:text-sm text-white/70 mb-5">
          ganó <span className="text-white">{ganador}</span>
        </p>

        {/* La consola del que no llegó a compilar. Mismo formato que la de victoria, al revés. */}
        <div className="text-left font-pixel text-[9px] sm:text-[11px] leading-relaxed bg-black/50 rounded-lg p-3 sm:p-4 border border-[#FF7F50]/30 mb-6">
          <p className="text-[#FF7F50]">&gt; build --release</p>
          <p className="text-white/70">te quedaste con cartas en la mano</p>
          <p className="text-[#FF7F50]">✗ 1 error &nbsp; build failed</p>
          <p className="text-white/40">quedó un bug sin resolver</p>
        </div>

        {onReset && (
          <button
            type="button"
            onClick={onReset}
            className="w-full font-pixel text-xs sm:text-sm px-5 py-4 rounded-lg shadow-pixel bg-[#FF7F50] text-[#2b0a02] hover:brightness-110 active:translate-y-0.5"
          >
            Volver al menú
          </button>
        )}
      </motion.div>
    </motion.div>
  );
}
