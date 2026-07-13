'use client';

import { useEffect, useRef } from 'react';
import type { EffectKind } from '@/lib/effects';
import type { EffectStage } from '@/lib/pixiEffects';

// Capa de efectos. Solo hace de puente: recibe una "señal" (qué efecto y cuándo) y se la pasa al
// escenario de PixiJS, que se carga la primera vez que hace falta y no antes.
//
// Los efectos son PURA DECORACIÓN: no tocan el estado replicado ni la red. Si el navegador no
// tiene WebGL, o la descarga de PixiJS falla, el fallo se traga aquí y la partida continúa sin
// efectos — un adorno nunca debe poder tumbar una mesa.

export interface EffectCue {
  kind: EffectKind;
  /** Marca única del disparo: dos cartas iguales seguidas deben verse dos veces. */
  id: number;
}

export default function EffectsLayer({ cue }: { cue: EffectCue | null }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<EffectStage | null>(null);
  const loadingRef = useRef(false);
  /** Efecto que llegó mientras PixiJS aún se descargaba (se juega en cuanto esté listo). */
  const pendingRef = useRef<EffectKind | null>(null);
  const goneRef = useRef(false);

  useEffect(
    () => () => {
      goneRef.current = true;
      stageRef.current?.destroy();
      stageRef.current = null;
    },
    [],
  );

  useEffect(() => {
    if (!cue) return;

    const stage = stageRef.current;
    if (stage) {
      stage.play(cue.kind);
      return;
    }

    pendingRef.current = cue.kind;
    if (loadingRef.current || !hostRef.current) return;
    loadingRef.current = true;

    // Aquí es donde PixiJS entra en escena por primera vez: al jugarse la primera carta especial,
    // no al abrir la página.
    void import('@/lib/pixiEffects')
      .then(({ EffectStage: Stage }) => Stage.create(hostRef.current!))
      .then((created) => {
        if (goneRef.current) {
          created.destroy();
          return;
        }
        stageRef.current = created;
        if (pendingRef.current) created.play(pendingRef.current);
        pendingRef.current = null;
      })
      .catch(() => {
        loadingRef.current = false; // sin WebGL o sin red: se juega igual, sin efectos
      });
  }, [cue]);

  return <div ref={hostRef} aria-hidden className="pointer-events-none fixed inset-0 z-30" />;
}
