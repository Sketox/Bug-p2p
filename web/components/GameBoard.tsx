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
      className="fixed inset-0 z-[60] grid place-items-center bg-black/85 p-4"
    >
      <motion.div
        initial={{ scale: 0.7, rotate: -4 }}
        animate={{ scale: 1, rotate: 0 }}
        transition={{ type: 'spring', stiffness: 200, damping: 18 }}
        className={`w-full max-w-sm rounded-2xl p-6 sm:p-8 text-center shadow-pixel border-2 ${
          gané ? 'bg-[#0d2b1f] border-[#07d98c]' : 'bg-[#2b0a1b] border-[#a60d61]'
        }`}
      >
        <div className="text-6xl mb-4">{gané ? '🏆' : '💀'}</div>

        <h2
          className={`font-pixel text-lg sm:text-2xl mb-2 ${gané ? 'text-[#07d98c]' : 'text-[#f27eb4]'}`}
        >
          {gané ? '¡GANASTE!' : 'PERDISTE'}
        </h2>

        <p className="font-pixel text-[10px] sm:text-xs text-white/60 mb-6 leading-relaxed">
          {gané
            ? porAbandono
              ? 'te quedaste solo en la mesa'
              : 'te quedaste sin cartas'
            : `ganó ${winner?.name ?? '—'}`}
        </p>

        {onReset && (
          <button
            onClick={onReset}
            className={`w-full font-pixel text-xs sm:text-sm px-5 py-4 rounded-lg shadow-pixel hover:brightness-110 ${
              gané ? 'bg-[#07d98c] text-[#04241a]' : 'bg-[#a60d61] text-white'
            }`}
          >
            Volver al menú
          </button>
        )}
      </motion.div>
    </motion.div>
  );
}
