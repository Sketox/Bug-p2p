'use client';

import { useCallback, useState } from 'react';
import { azar32 } from './uid';
import {
  apply,
  createGame,
  EngineError,
  type Color,
  type GameEvent,
  type GameState,
} from '@bug/engine';

export interface PlayOptions {
  chosenColor?: Color;
  target?: string;
  giveCardIds?: string[];
  rebootCardId?: string;
}

export function useBugGame() {
  const [state, setState] = useState<GameState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const dispatch = useCallback((event: GameEvent) => {
    setState((prev) => {
      if (!prev) return prev;
      try {
        const next = apply(prev, event);
        setError(null);
        return next;
      } catch (e) {
        setError(e instanceof EngineError ? e.message : String(e));
        return prev; // jugada inválida: no cambia el estado
      }
    });
  }, []);

  const start = useCallback((players: { id: string; name: string }[]) => {
    const seed = azar32();
    setError(null);
    setState(createGame(seed, players));
  }, []);

  const play = useCallback(
    (playerId: string, cardId: string, opts: PlayOptions = {}) =>
      dispatch({ type: 'PLAY', playerId, cardId, ...opts }),
    [dispatch],
  );
  const draw = useCallback((playerId: string) => dispatch({ type: 'DRAW', playerId }), [dispatch]);
  const pass = useCallback((playerId: string) => dispatch({ type: 'PASS', playerId }), [dispatch]);
  const shoutBug = useCallback(
    (playerId: string) => dispatch({ type: 'SHOUT_BUG', playerId }),
    [dispatch],
  );
  const callBug = useCallback(
    (accuserId: string, accusedId: string) => dispatch({ type: 'CALL_BUG', accuserId, accusedId }),
    [dispatch],
  );
  const reset = useCallback(() => {
    setState(null);
    setError(null);
  }, []);

  return { state, error, start, play, draw, pass, shoutBug, callBug, reset };
}
