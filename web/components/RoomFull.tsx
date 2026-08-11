'use client';

import { motion } from 'framer-motion';

interface Props {
  /** Cuánta gente cabía. Lo dice la señalización al rebotarnos: no se adivina aquí. */
  max: number;
  roomId?: string;
  onExit: () => void;
}

/**
 * "No cabes."
 *
 * Antes esto no existía y el jugador 11 entraba tan feliz: aparecía en la lista, veía el botón de
 * empezar y se enteraba de que sobraba cuando el anfitrión lo pulsaba y no pasaba nada. Con un QR
 * sobre la mesa, que se acerquen once curiosos no es un caso de laboratorio: es un martes.
 *
 * Así que el rebote es ahora una pantalla, y llega ANTES de entrar. Que a nadie le toque descubrir
 * que estaba de más cuando ya se había ilusionado.
 */
export function RoomFull({ max, roomId, onExit }: Readonly<Props>) {
  return (
    <div className="min-h-[100dvh] flex items-center justify-center p-4 sm:p-6">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="w-full max-w-md bg-black/40 border-2 border-black/60 rounded-2xl p-6 sm:p-8 shadow-pixel text-center"
      >
        {/* El bicho no cabe por la puerta: se queda meneándose fuera. */}
        <motion.div
          animate={{ rotate: [0, -8, 8, -8, 0] }}
          transition={{ duration: 1.4, repeat: Infinity, repeatDelay: 1.2 }}
          className="text-5xl sm:text-6xl mb-4"
        >
          🐛
        </motion.div>

        <h1 className="font-pixel text-lg sm:text-xl text-[#f27eb4] mb-3">SALA LLENA</h1>

        {roomId && (
          <p className="font-pixel text-[10px] text-white/40 mb-4">
            sala <span className="tracking-[0.2em] text-white/70">{roomId}</span>
          </p>
        )}

        {/* El aforo, de un vistazo: todos los sitios ocupados y ninguno libre. */}
        <div className="flex flex-wrap justify-center gap-1.5 mb-4" aria-hidden>
          {Array.from({ length: max }, (_, i) => (
            <motion.span
              key={i}
              initial={{ opacity: 0, scale: 0.5 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ delay: 0.05 * i }}
              className="text-lg"
            >
              🐛
            </motion.span>
          ))}
        </div>

        <p
          data-testid="room-full"
          className="font-pixel text-[10px] sm:text-xs leading-relaxed text-white/70 mb-2"
        >
          Esta partida ya tiene sus {max} jugadores.
        </p>
        <p className="font-pixel text-[9px] sm:text-[10px] leading-relaxed text-white/40 mb-6">
          {max} es el tope de la mesa. Pide al anfitrión que abra otra sala, o espera a que alguien
          se levante.
        </p>

        <button
          type="button"
          onClick={onExit}
          className="w-full font-pixel text-xs sm:text-sm py-3 rounded-lg bg-[#50C878] text-[#08130c] shadow-pixel"
        >
          Volver
        </button>
      </motion.div>
    </div>
  );
}
