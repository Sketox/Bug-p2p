'use client';

import { useEffect, useState } from 'react';
import { AnimatePresence } from 'framer-motion';
import type { Card } from '@bug/engine';
import { useBugRoom } from '@/lib/useBugRoom';
import { needsPrompt } from '@/lib/cards';
import { saveRoom } from '@/lib/session';
import { Lobby } from './Lobby';
import { RoomFull } from './RoomFull';
import { GameBoard } from './GameBoard';
import { PlayPrompt, type PlayChoice } from './PlayPrompt';
import { MasterScreen } from './MasterScreen';

interface Props {
  mode: 'host' | 'join';
  name: string;
  code?: string;
  onExit: () => void;
}

export function NetworkGame({ mode, name, code, onExit }: Props) {
  const room = useBugRoom();
  /** Carta jugada que aún tiene decisiones pendientes (color, víctima, regalo, base del pozo). */
  const [pending, setPending] = useState<Card | null>(null);
  const [master, setMaster] = useState(false);

  // Entrar en la sala al montar, salir al desmontar.
  //
  // OJO con el flag "hazlo solo una vez": en desarrollo, StrictMode monta, DESMONTA y vuelve a
  // montar. Con un flag, el desmontaje cerraba la sala y el segundo montaje ya no la reabría — el
  // jugador se quedaba mirando un lobby vacío para siempre. El efecto tiene que ser simétrico:
  // cada montaje entra, cada desmontaje sale. De invalidar el trabajo pendiente de una entrada
  // abandonada ya se encarga `useBugRoom` (ver el contador de sesión).
  useEffect(() => {
    if (mode === 'host') room.host(name);
    else room.join(name, code ?? '');
    return () => room.leave();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // En cuanto sabemos el código de sala, se recuerda: si la página se recarga, volvemos solos a la
  // mesa en vez de aterrizar en el menú (`app/page.tsx`). El anfitrión no lo sabe hasta que su sala
  // existe, así que se guarda cuando aparece, no al montar.
  useEffect(() => {
    if (room.roomId) saveRoom({ code: room.roomId, name });
  }, [room.roomId, name]);

  // La Pantalla Maestra se abre y cierra con la tecla M (cómodo para la demo en la feria).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'm' || e.key === 'M') setMaster((v) => !v);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const view = room.view;

  const handlePlay = (cardId: string) => {
    const card = view?.yourHand?.find((c) => c.id === cardId);
    if (!card || !view) return;

    // Interrumpir no abre el selector de color: el portapapeles copia el efecto (y el color) de la
    // carta que corta. Pararse a elegir color arruinaría lo único que tiene de gracia: la prisa.
    const interrupting =
      card.kind === 'copy_paste' && view.players[view.turn]?.id !== room.myId;
    if (interrupting) {
      room.actions.play(cardId);
      return;
    }

    // Algunas cartas piden algo antes de salir: el color (los comodines) o a quién infectas y qué
    // carta pones de base (troyano y reinicio). Lo decide el jugador, no nosotros.
    if (needsPrompt(card)) {
      setPending(card);
      return;
    }
    room.actions.play(cardId);
  };

  const finishPlay = (choice: PlayChoice) => {
    const card = pending;
    setPending(null);
    if (card) room.actions.play(card.id, choice);
  };

  /** Nodos vivos que no soy yo: si alguno falla, se nota aquí antes que en el tablero. */
  const trouble = room.mesh.nodes.some((n) => !n.isMe && n.health !== 'alive');

  const masterToggle = (
    <button
      onClick={() => setMaster((v) => !v)}
      title="Pantalla Maestra (tecla M): estado de la malla, líder, testigo y convergencia"
      className={`fixed bottom-3 right-3 z-50 font-pixel text-[9px] px-3 py-2 rounded-lg
                  border-2 border-black/60 shadow-pixel ${
                    trouble ? 'bg-red-500/90 text-white animate-pulse' : 'bg-black/60 text-white/70'
                  }`}
    >
      🖥 malla{trouble ? ' ⚠' : ''}
    </button>
  );

  const masterPanel = (
    <AnimatePresence>
      {master && (
        <MasterScreen mesh={room.mesh} journal={room.journal} onClose={() => setMaster(false)} />
      )}
    </AnimatePresence>
  );

  // Antes que nada: si la sala estaba llena, nunca llegamos a entrar. No hay lobby que enseñar
  // —no somos de la partida—, así que esta rama va delante de todas.
  if (room.phase === 'full') {
    return <RoomFull max={room.aforo} roomId={room.roomId ?? undefined} onExit={onExit} />;
  }

  if (room.phase === 'lobby' || !view) {
    return (
      <>
        <Lobby
          roomId={room.roomId ?? '····'}
          isHost={room.isHost}
          players={room.lobby}
          myId={room.myId}
          status={room.status}
          onStart={room.startGame}
          onLeave={onExit}
        />
        {masterToggle}
        {masterPanel}
      </>
    );
  }

  return (
    <>
      <GameBoard
        view={view}
        myId={room.myId}
        error={room.error}
        canAct={room.canAct}
        turnStartedAt={room.turnStartedAt}
        turnMs={room.turnMs}
        onPlay={handlePlay}
        onDraw={room.actions.draw}
        onPass={room.actions.pass}
        onShoutBug={room.actions.shoutBug}
        onCallBug={room.actions.callBug}
        onReset={onExit}
        // Salir de una partida en red es definitivo: la mesa te saca de la rotación y sigue sin ti
        // (una caída es distinta — ahí te guardan el sitio por si vuelves). Conviene preguntar.
        onLeave={() => {
          if (window.confirm('¿Abandonar la partida? Los demás seguirán jugando sin ti.')) onExit();
        }}
      />
      {pending && (
        <PlayPrompt
          card={pending}
          hand={view.yourHand ?? []}
          rivals={view.players.filter((p) => p.id !== room.myId)}
          onConfirm={finishPlay}
          onCancel={() => setPending(null)}
        />
      )}
      {masterToggle}
      {masterPanel}
    </>
  );
}
