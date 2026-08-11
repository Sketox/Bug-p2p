'use client';

import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { RulesScreen } from './RulesScreen';

interface Props {
  onHost: (name: string) => void;
  onJoin: (name: string, code: string) => void;
  onLocal: () => void;
  /** Sala que venía en el enlace del QR: quien llega así solo tiene que poner su nombre. */
  invitedTo?: string | null;
}

export function MainMenu({ onHost, onJoin, onLocal, invitedTo }: Props) {
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [rules, setRules] = useState(false);
  const nameOk = name.trim().length > 0;

  return (
    // `flex` y no `grid place-items-center`: en un grid, la columna toma el max-content del hijo
    // (los 28rem de `max-w-md`) y la tarjeta desbordaba la pantalla en un móvil de 360 px.
    <div className="min-h-[100dvh] flex items-center justify-center p-4 sm:p-6">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="w-full max-w-md bg-black/40 border-2 border-black/60 rounded-2xl p-5 sm:p-6 shadow-pixel"
      >
        {/* El logo del proyecto, del mismo sprite que las cartas. */}
        <h1 className="grid place-items-center mb-2">
          <svg viewBox="0 0 100 66" className="w-44 sm:w-52 text-[#07d98c]" role="img" aria-label="¡Bug!">
            <use href="#c-logo" width="100" height="66" />
          </svg>
        </h1>
        <p className="text-center text-[10px] text-white/60 mb-6 font-pixel">
          juego de cartas P2P
        </p>

        <label className="block text-[10px] sm:text-xs font-pixel mb-2">Tu nombre</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="¿Cómo te llamas?"
          maxLength={16}
          autoFocus
          className="w-full bg-black/40 border border-white/20 rounded px-3 py-3 text-sm outline-none focus:border-[#50C878] mb-5"
        />

        {invitedTo ? (
          // Llegó escaneando el QR: la sala ya la sabemos, no hay nada que teclear.
          <>
            <p className="font-pixel text-[10px] text-center text-white/60 mb-3">
              te invitaron a la sala{' '}
              <span className="text-[#FF7F50] tracking-widest">{invitedTo}</span>
            </p>
            <button
              type="button"
              onClick={() => onJoin(name.trim(), invitedTo)}
              disabled={!nameOk}
              className="w-full font-pixel text-xs sm:text-sm py-3 rounded-lg bg-[#1E90FF] text-[#04121f] shadow-pixel hover:brightness-110 active:translate-y-0.5 disabled:opacity-40 mb-3"
            >
              Entrar a la sala
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={() => onHost(name.trim())}
              disabled={!nameOk}
              className="w-full font-pixel text-xs sm:text-sm py-3 rounded-lg bg-[#50C878] text-[#08130c] shadow-pixel hover:brightness-110 active:translate-y-0.5 disabled:opacity-40 mb-3"
            >
              Crear sala
            </button>

            <div className="flex gap-2 mb-4">
              <input
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                placeholder="CÓDIGO"
                maxLength={6}
                className="flex-1 min-w-0 bg-black/40 border border-white/20 rounded px-3 py-3 text-sm outline-none focus:border-[#1E90FF] font-pixel tracking-widest text-center"
              />
              <button
                type="button"
                onClick={() => onJoin(name.trim(), code)}
                disabled={!nameOk || code.trim().length === 0}
                className="font-pixel text-[10px] sm:text-xs px-4 rounded-lg bg-[#1E90FF] text-[#04121f] shadow-pixel disabled:opacity-40"
              >
                Unirse
              </button>
            </div>
          </>
        )}

        {/* Reglas: en la feria la gente llega, escanea el QR y no ha visto una carta de Bug en su
            vida. Tiene que poder enterarse sin que nadie se lo explique. */}
        <button
          type="button"
          onClick={() => setRules(true)}
          className="w-full font-pixel text-[10px] sm:text-xs py-3 rounded-lg bg-black/40 border-2 border-[#f27eb4]/50 text-[#f27eb4] hover:bg-[#f27eb4]/10 shadow-pixel mb-3"
        >
          📖 Cómo se juega
        </button>

        <button
          type="button"
          onClick={onLocal}
          className="w-full font-pixel text-[10px] py-2 rounded text-white/60 hover:text-white/90"
        >
          · practicar local (hot-seat) ·
        </button>
      </motion.div>

      <AnimatePresence>{rules && <RulesScreen onClose={() => setRules(false)} />}</AnimatePresence>
    </div>
  );
}
