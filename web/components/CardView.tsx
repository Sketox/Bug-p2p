'use client';

import { forwardRef } from 'react';
import { motion } from 'framer-motion';
import type { Card } from '@bug/engine';
import { cardFace } from '@/lib/cards';
import { CARD_BOX, CARD_VIEWBOX } from '@/lib/cardBox';

interface Props {
  card?: Card;
  faceDown?: boolean;
  playable?: boolean;
  dimmed?: boolean;
  onClick?: () => void;
  /** Para animaciones compartidas (carta que vuela mano → pozo). */
  layoutId?: string;
  size?: 'sm' | 'md' | 'lg';
  /** Jugable fuera de turno ("Copiar y Pegar"): se marca distinto para que se note que puedes cortar. */
  interrupt?: boolean;
  /** Posición en la mano: las cartas entran escalonadas, como si te las estuvieran repartiendo. */
  dealIndex?: number;
  /**
   * Color (hex) que eligió quien jugó este comodín. Solo lo usa la carta del pozo: la carta gira en
   * 3D y aterriza teñida del color elegido.
   *
   * No es solo un adorno. Un comodín no tiene color propio —su dibujo son las cuatro franjas— así
   * que, mirando el pozo, no hay forma de saber a qué color hay que igualar ahora. El giro lo
   * cuenta, y el tinte lo deja dicho.
   */
  wildColor?: string;
}

// Las cartas son las del proyecto (pixel art de Inkscape), servidas como sprite SVG e inyectadas
// una sola vez en el documento (ver `app/layout.tsx`). Aquí solo se referencian con <use>.
//
// Los especiales de color se recolorean con `currentColor`: el arte trae una única muestra de cada
// uno (el "se fue el WiFi" solo existe en vino) y el juego los necesita en los cuatro palos.

/** Proporción real de las cartas del arte (la misma para todas: ver `lib/cardBox.ts`). */
const ASPECT = `${CARD_BOX.w} / ${CARD_BOX.h}`;

const SIZES = {
  sm: 'w-9 sm:w-12',
  md: 'w-14 sm:w-16',
  lg: 'w-16 sm:w-20',
};

// `forwardRef` no es decorativo: `AnimatePresence` mide el elemento que sale (la carta que vuela al
// pozo) a través de su ref. Sin reenviarla, React avisa y la animación de salida se pierde.
export const CardView = forwardRef<HTMLElement, Props>(function CardView(
  { card, faceDown, playable, dimmed, onClick, layoutId, size = 'md', interrupt, wildColor, dealIndex },
  ref,
) {
  const clickable = Boolean(onClick && playable);
  // El reparto: cada carta entra un pelín después que la anterior, como si te las fueran dando.
  const deal = dealIndex != null ? { delay: dealIndex * 0.07 } : {};

  if (faceDown || !card) {
    return (
      <motion.div
        ref={ref as React.Ref<HTMLDivElement>}
        layout
        layoutId={layoutId}
        style={{ aspectRatio: ASPECT }}
        className={`${SIZES[size]} shrink-0 rounded-lg border-2 border-black/60
                    bg-[#2a2140] shadow-pixel grid place-items-center select-none overflow-hidden`}
      >
        {/* Reverso: el mismo logo del juego, en claro sobre el morado. */}
        <svg viewBox="0 0 100 66" className="w-3/4 text-[#7c6bb0]" aria-hidden>
          <use href="#c-logo" width="100" height="66" />
        </svg>
      </motion.div>
    );
  }

  const face = cardFace(card);
  return (
    <motion.button
      ref={ref as React.Ref<HTMLButtonElement>}
      layout
      layoutId={layoutId}
      type="button"
      onClick={clickable ? onClick : undefined}
      disabled={!clickable}
      title={face.name}
      whileHover={clickable ? { y: -14, scale: 1.05 } : undefined}
      whileTap={clickable ? { scale: 0.96 } : undefined}
      initial={
        dealIndex != null
          ? { opacity: 0, y: -140, x: -60, rotate: -25, scale: 0.7 } // llega volando del mazo
          : { opacity: 0, y: 24, rotate: -6 }
      }
      animate={{ opacity: dimmed ? 0.45 : 1, y: 0, x: 0, rotate: 0, scale: 1 }}
      exit={{ opacity: 0, scale: 0.6 }}
      transition={{ type: 'spring', stiffness: 420, damping: 30, ...deal }}
      style={{
        aspectRatio: ASPECT,
        color: face.ink,
        // La perspectiva vive en el padre; el giro, en la capa de dentro. Así el volteo no se pisa
        // con la animación de layout que hace volar la carta de la mano al pozo.
        perspective: 700,
        ...(wildColor ? { boxShadow: `0 0 18px ${wildColor}` } : {}),
      }}
      className={`${SIZES[size]} shrink-0 relative rounded-lg
        shadow-pixel select-none
        ${/* con `overflow-hidden` el navegador aplana el 3D y no hay volteo que valga */ ''}
        ${wildColor ? '' : 'overflow-hidden'}
        ${interrupt ? 'ring-4 ring-[#f27eb4] animate-pulse cursor-pointer' : ''}
        ${clickable && !interrupt ? 'cursor-pointer ring-2 ring-yellow-300/90' : ''}
        ${!clickable ? 'cursor-default' : ''}
        ${!playable && onClick ? 'saturate-[0.65]' : ''}`}
    >
      {wildColor ? (
        <Flip color={wildColor} name={face.name} symbol={face.symbol} />
      ) : (
        <svg viewBox={CARD_VIEWBOX} className="w-full h-full pixelated" aria-label={face.name}>
          <use href={`#${face.symbol}`} width={CARD_BOX.w} height={CARD_BOX.h} />
        </svg>
      )}
    </motion.button>
  );
});

/**
 * El volteo del comodín: la carta llega girando y aterriza teñida del color que eligió quien la
 * jugó.
 *
 * Dos caras de verdad (`backface-visibility: hidden`), no un truco de opacidad: la de atrás es la
 * carta "apagada" —como estaba en la mano, sin color asignado— y la de delante, la misma carta ya
 * marcada. Media vuelta, y el pozo cuenta lo que pasó.
 */
function Flip({ color, name, symbol }: { color: string; name: string; symbol: string }) {
  const card = (
    <svg viewBox={CARD_VIEWBOX} className="w-full h-full pixelated" aria-label={name}>
      <use href={`#${symbol}`} width={CARD_BOX.w} height={CARD_BOX.h} />
    </svg>
  );

  return (
    <motion.div
      // La `key` incluye el color: si se juega otro comodín (o se cambia de color), la carta vuelve
      // a girar en vez de quedarse quieta.
      key={`${symbol}-${color}`}
      initial={{ rotateY: 180 }}
      animate={{ rotateY: 0 }}
      // Vuelta y media, despacio, y ARRANCANDO TARDE a propósito.
      //
      // El giro no puede empezar a la vez que la carta: mientras vuela de la mano al pozo, Framer
      // ya la está animando (posición y tamaño). Si el volteo va encima, se solapan y el resultado
      // es un borrón — que es exactamente lo que se veía. Se le deja llegar primero, y entonces
      // gira, sola, donde se la puede mirar.
      transition={{ duration: 0.9, ease: [0.22, 1, 0.36, 1], delay: 0.35 }}
      style={{ transformStyle: 'preserve-3d' }}
      className="relative w-full h-full rounded-lg"
    >
      {/* Cara final: el comodín, con un aro del color elegido.
          El aro va ENCIMA del dibujo, en su propia capa. Como `box-shadow: inset` se pinta debajo
          del contenido, el arte de la carta lo tapaba entero y no se veía nada. */}
      <div
        style={{ backfaceVisibility: 'hidden' }}
        className="absolute inset-0 rounded-lg overflow-hidden"
      >
        {card}
        <div
          aria-hidden
          className="absolute inset-0 rounded-lg pointer-events-none"
          style={{ border: `5px solid ${color}` }}
        />
      </div>

      {/* Cara de partida: el REVERSO. Antes esta cara era la misma carta, así que el volteo no
          contaba nada: girabas y veías lo mismo, un borrón y ya. Ahora la carta llega boca abajo y
          se da la vuelta para enseñar el comodín — que es lo que un volteo tiene que hacer. */}
      <div
        style={{ backfaceVisibility: 'hidden', transform: 'rotateY(180deg)' }}
        className="absolute inset-0 rounded-lg overflow-hidden bg-[#2a2140] border-2 border-black/60 grid place-items-center"
      >
        <svg viewBox="0 0 100 66" className="w-3/4 text-[#7c6bb0]" aria-hidden>
          <use href="#c-logo" width="100" height="66" />
        </svg>
      </div>
    </motion.div>
  );
}
