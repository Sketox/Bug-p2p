'use client';

import { useState } from 'react';
import { motion } from 'framer-motion';
import type { Card, Color } from '@bug/engine';
import { CardView } from './CardView';
import { COLOR_OPTIONS, SUIT } from '@/lib/cards';

// Lo que hay que preguntarle al jugador ANTES de mandar la jugada.
//
// Hasta ahora estas decisiones se tomaban solas: el troyano infectaba al primer jugador de la lista
// y regalaba las dos primeras cartas de tu mano. Funcionaba, pero no lo decidías tú — y una carta
// que se juega sola no es una carta, es un efecto secundario.
//
// Todo lo que se elige aquí lo revalida el motor (`applyPlay`): esto solo evita que el jugador
// mande una jugada que va a ser rechazada. La UI acompaña; las reglas las pone el motor.

export interface PlayChoice {
  chosenColor?: Color;
  target?: string;
  giveCardIds?: string[];
  rebootCardId?: string;
}

interface Props {
  /** La carta que se está jugando. */
  card: Card;
  /** Mi mano (incluida la carta jugada, que se excluye sola). */
  hand: Card[];
  /** Los demás jugadores, para el troyano. Los ausentes no cuentan: ya no están en la mesa. */
  rivals: { id: string; name: string; status: string }[];
  onConfirm: (choice: PlayChoice) => void;
  onCancel: () => void;
}

const MAX_GIFT = 2; // el motor solo acepta 2: `giveCardIds.slice(0, 2)`

export function PlayPrompt({ card, hand, rivals, onConfirm, onCancel }: Props) {
  if (card.kind === 'trojan') {
    return <Trojan card={card} hand={hand} rivals={rivals} onConfirm={onConfirm} onCancel={onCancel} />;
  }
  if (card.kind === 'reboot') {
    return <Reboot card={card} hand={hand} onConfirm={onConfirm} onCancel={onCancel} />;
  }
  return (
    <Shell title="Elige color" onCancel={onCancel}>
      <Colors onPick={(chosenColor) => onConfirm({ chosenColor })} />
    </Shell>
  );
}

/**
 * Virus Troyano: eliges a quién infectas, qué le regalas y con qué color sigue la partida.
 *
 * El motor exige las tres cosas (víctima distinta de ti y presente, cartas que estén de verdad en
 * tu mano, y un color, porque es un comodín). Se piden en ese orden.
 */
function Trojan({ card, hand, rivals, onConfirm, onCancel }: Omit<Props, never>) {
  const [target, setTarget] = useState<string | null>(null);
  const [gift, setGift] = useState<string[]>([]);

  const giftable = hand.filter((c) => c.id !== card.id);
  const victims = rivals.filter((p) => p.status !== 'down');
  const maxGift = Math.min(MAX_GIFT, giftable.length);

  const toggle = (id: string) =>
    setGift((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : prev.length < maxGift ? [...prev, id] : prev,
    );

  if (!target) {
    return (
      <Shell title="🦠 ¿A quién infectas?" onCancel={onCancel}>
        <div className="grid gap-2">
          {victims.map((p) => (
            <button
              key={p.id}
              onClick={() => setTarget(p.id)}
              className="font-pixel text-[10px] sm:text-xs py-3 px-4 rounded-lg bg-black/40 border-2 border-[#4227f2]/60 text-white hover:bg-[#4227f2]/20 shadow-pixel"
            >
              {p.name}
            </button>
          ))}
        </div>
      </Shell>
    );
  }

  if (gift.length < maxGift) {
    const name = victims.find((p) => p.id === target)?.name ?? '';
    return (
      <Shell title={`🎁 Regálale ${maxGift} carta${maxGift === 1 ? '' : 's'} a ${name}`} onCancel={onCancel}>
        <p className="font-pixel text-[9px] text-white/50 mb-3 text-center">
          elegidas {gift.length}/{maxGift} · un regalo que no se puede rechazar
        </p>
        <div className="flex flex-wrap gap-2 justify-center max-h-[40vh] overflow-y-auto hand-scroll p-1">
          {giftable.map((c) => {
            const chosen = gift.includes(c.id);
            return (
              <div key={c.id} className={chosen ? 'ring-4 ring-[#f27eb4] rounded-lg' : ''}>
                <CardView card={c} size="md" playable onClick={() => toggle(c.id)} />
              </div>
            );
          })}
        </div>
        {gift.length > 0 && (
          <button
            onClick={() => setGift([])}
            className="w-full font-pixel text-[9px] py-2 mt-3 text-white/50 hover:text-white/80"
          >
            · empezar de nuevo ·
          </button>
        )}
      </Shell>
    );
  }

  return (
    <Shell title="🎨 ¿Con qué color sigue?" onCancel={onCancel}>
      <Colors onPick={(chosenColor) => onConfirm({ chosenColor, target, giveCardIds: gift })} />
    </Shell>
  );
}

/**
 * Apagar y volver a prender: o reinicias el pozo con una carta tuya (que pasa a ser la nueva base y
 * fija el color), o te limitas a cambiar el color.
 *
 * La carta base tiene que tener color: el motor rechaza usar un comodín de base (`BAD_BASE_CARD`),
 * y con razón — un pozo que arranca con un comodín no dice a qué color hay que igualar.
 */
function Reboot({ card, hand, onConfirm, onCancel }: Omit<Props, 'rivals'>) {
  const [mode, setMode] = useState<'ask' | 'color' | 'base'>('ask');
  const bases = hand.filter((c) => c.id !== card.id && c.color != null);

  if (mode === 'color') {
    return (
      <Shell title="🎨 Elige color" onCancel={() => setMode('ask')}>
        <Colors onPick={(chosenColor) => onConfirm({ chosenColor })} />
      </Shell>
    );
  }

  if (mode === 'base') {
    return (
      <Shell title="🔌 Elige la nueva base del pozo" onCancel={() => setMode('ask')}>
        <p className="font-pixel text-[9px] text-white/50 mb-3 text-center">
          la sueltas encima y la partida sigue con SU color
        </p>
        <div className="flex flex-wrap gap-2 justify-center max-h-[40vh] overflow-y-auto hand-scroll p-1">
          {bases.map((c) => (
            <CardView
              key={c.id}
              card={c}
              size="md"
              playable
              onClick={() => onConfirm({ rebootCardId: c.id })}
            />
          ))}
        </div>
      </Shell>
    );
  }

  return (
    <Shell title="🔌 Apagar y volver a prender" onCancel={onCancel}>
      <div className="grid gap-3">
        <button
          onClick={() => setMode('color')}
          className="font-pixel text-[10px] sm:text-xs py-4 px-4 rounded-lg bg-black/40 border-2 border-white/20 text-white hover:bg-white/10 shadow-pixel"
        >
          Solo cambiar el color
        </button>
        <button
          onClick={() => setMode('base')}
          disabled={bases.length === 0}
          title={bases.length === 0 ? 'no tienes ninguna carta de color para poner de base' : undefined}
          className="font-pixel text-[10px] sm:text-xs py-4 px-4 rounded-lg bg-black/40 border-2 border-[#07d98c]/60 text-[#07d98c] hover:bg-[#07d98c]/10 shadow-pixel disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Reiniciar el pozo con una carta mía
          <span className="block text-[8px] text-white/50 mt-1 font-pixel">
            {bases.length === 0 ? 'no te queda ninguna de color' : 'sueltas otra carta: una menos'}
          </span>
        </button>
      </div>
    </Shell>
  );
}

function Shell({
  title,
  children,
  onCancel,
}: {
  title: string;
  children: React.ReactNode;
  onCancel: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4" onClick={onCancel}>
      <motion.div
        initial={{ scale: 0.85, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md bg-[#0f1f19] border-2 border-black/60 rounded-2xl p-5 shadow-pixel"
      >
        <h2 className="font-pixel text-[11px] sm:text-sm text-center mb-4 text-white">{title}</h2>
        {children}
        <button
          onClick={onCancel}
          className="w-full font-pixel text-[9px] py-2 mt-4 text-white/40 hover:text-white/70"
        >
          cancelar
        </button>
      </motion.div>
    </div>
  );
}

function Colors({ onPick }: { onPick: (color: Color) => void }) {
  return (
    <div className="grid grid-cols-2 gap-3">
      {COLOR_OPTIONS.map((opt) => (
        <button
          key={opt.color}
          onClick={() => onPick(opt.color)}
          style={{ backgroundColor: opt.hex, color: SUIT[opt.color].fg }}
          className="h-16 rounded-lg border-[3px] border-black/70 shadow-pixel font-pixel text-[10px] hover:scale-105 transition-transform"
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
