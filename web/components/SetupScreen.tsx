'use client';

import { useState } from 'react';
import { motion } from 'framer-motion';

const DEFAULT_NAMES = ['Ana', 'Beto', 'Dina', 'Eze', 'Fabi'];

export function SetupScreen({ onStart }: { onStart: (players: { id: string; name: string }[]) => void }) {
  const [count, setCount] = useState(3);
  const [names, setNames] = useState<string[]>(DEFAULT_NAMES);

  const start = () => {
    const players = Array.from({ length: count }, (_, i) => ({
      id: `p${i}`,
      name: names[i]?.trim() || `Jugador ${i + 1}`,
    }));
    onStart(players);
  };

  return (
    <div className="min-h-screen grid place-items-center p-6">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="w-full max-w-md bg-black/40 border-2 border-black/60 rounded-2xl p-6 shadow-pixel"
      >
        <h1 className="font-pixel text-2xl text-center mb-1 text-[#50C878]">BUG</h1>
        <p className="text-center text-xs text-white/60 mb-6 font-pixel">hot-seat local</p>

        <label className="block text-xs font-pixel mb-2">Jugadores: {count}</label>
        <input
          type="range"
          min={2}
          max={5}
          value={count}
          onChange={(e) => setCount(Number(e.target.value))}
          className="w-full mb-5 accent-[#FF7F50]"
        />

        <div className="space-y-2 mb-6">
          {Array.from({ length: count }, (_, i) => (
            <input
              key={i}
              value={names[i] ?? ''}
              onChange={(e) => {
                const copy = [...names];
                copy[i] = e.target.value;
                setNames(copy);
              }}
              placeholder={`Jugador ${i + 1}`}
              className="w-full bg-black/40 border border-white/20 rounded px-3 py-2 text-sm outline-none focus:border-[#50C878]"
            />
          ))}
        </div>

        <button
          onClick={start}
          className="w-full font-pixel text-sm py-3 rounded-lg bg-[#50C878] text-[#08130c] shadow-pixel hover:brightness-110 active:translate-y-0.5"
        >
          ¡A jugar!
        </button>
      </motion.div>
    </div>
  );
}
