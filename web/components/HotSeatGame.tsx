'use client';

import { useState } from 'react';
import { redactFor, type Card } from '@bug/engine';
import { useBugGame } from '@/lib/useBugGame';
import { needsPrompt } from '@/lib/cards';
import { SetupScreen } from './SetupScreen';
import { GameBoard } from './GameBoard';
import { PlayPrompt, type PlayChoice } from './PlayPrompt';

export function HotSeatGame({ onExit }: Readonly<{ onExit: () => void }>) {
  const game = useBugGame();
  const { state } = game;
  /** Carta jugada que aún tiene decisiones pendientes (color, víctima, regalo, base del pozo). */
  const [pending, setPending] = useState<Card | null>(null);

  if (!state) return <SetupScreen onStart={game.start} />;

  const me = state.players[state.turn]!;
  const view = redactFor(state, me.id);

  const handlePlay = (cardId: string) => {
    const card = me.hand.find((c) => c.id === cardId);
    if (!card) return;
    if (needsPrompt(card)) {
      setPending(card); // hay algo que decidir antes de jugarla
      return;
    }
    game.play(me.id, cardId);
  };

  const finishPlay = (choice: PlayChoice) => {
    const card = pending;
    setPending(null);
    if (card) game.play(me.id, card.id, choice);
  };

  return (
    <>
      <GameBoard
        view={view}
        myId={me.id}
        error={game.error}
        onPlay={handlePlay}
        onDraw={() => game.draw(me.id)}
        onPass={() => game.pass(me.id)}
        onShoutBug={() => game.shoutBug(me.id)}
        onCallBug={(accusedId) => game.callBug(me.id, accusedId)}
        onReset={onExit}
        // En hot-seat no hay a quién despedirse: salir es simplemente volver al menú.
        onLeave={onExit}
      />
      {pending && (
        <PlayPrompt
          card={pending}
          hand={me.hand}
          rivals={state.players.filter((p) => p.id !== me.id)}
          onConfirm={finishPlay}
          onCancel={() => setPending(null)}
        />
      )}
    </>
  );
}
