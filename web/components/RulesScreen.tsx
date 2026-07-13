'use client';

import { useEffect } from 'react';
import { motion } from 'framer-motion';
import type { Card, CardKind, Color } from '@bug/engine';
import { CardView } from './CardView';
import { SUIT } from '@/lib/cards';

// Cómo se juega. Se enseña con las cartas de verdad (el mismo sprite que usa la mesa), no con
// texto: en la feria la gente llega, escanea el QR y quiere jugar en un minuto.
//
// Lo que se cuenta aquí tiene que ser lo que hace el MOTOR, no lo que nos gustaría que hiciera.
// Cada descripción está sacada de `engine/src/game.ts` — si cambian las reglas, cambia esto.

const demo = (kind: CardKind, color?: Color, value?: number): Card => ({
  id: `demo-${kind}-${color ?? 'x'}-${value ?? 'x'}`,
  kind,
  ...(color ? { color } : {}),
  ...(value != null ? { value } : {}),
});

interface Rule {
  card: Card;
  title: string;
  text: string;
  /** Se destaca: es la mecánica propia de Bug, la que nadie espera. */
  star?: boolean;
}

const ESPECIALES: Rule[] = [
  {
    card: demo('skip', 'internet'),
    title: 'Se fue el WiFi',
    text: 'El siguiente jugador se queda sin turno. Se desconectó.',
  },
  {
    card: demo('reverse', 'code'),
    title: 'Ctrl + Z',
    text: 'Deshace el sentido de la ronda. Con solo dos jugadores actúa como un salto: repites turno.',
  },
  {
    card: demo('draw2', 'survival'),
    title: 'Actualización de Windows',
    text: 'El siguiente roba 2 cartas y pierde el turno. No se puede cancelar, como debe ser.',
  },
];

const COMODINES: Rule[] = [
  {
    card: demo('wild'),
    title: 'Reinicio de Router',
    text: 'Se juega sobre cualquier carta y tú eliges el color con el que sigue la partida.',
  },
  {
    card: demo('wild_draw4'),
    title: 'BSOD — Pantalla Azul de la Muerte',
    text: 'Eliges color y el siguiente roba 4 cartas y pierde el turno. La carta más cruel del mazo.',
  },
];

const CAOS: Rule[] = [
  {
    card: demo('copy_paste'),
    title: 'Copiar y Pegar',
    star: true,
    text:
      '¡Se juega CUANDO NO ES TU TURNO! Cortas la ronda, copias el efecto de la carta que acaba de ' +
      'caer al pozo y la partida sigue desde ti. No puedes cortar tu propia carta, y el portapapeles ' +
      'no copia cartas de caos. En tu turno se comporta como un comodín normal.',
  },
  {
    card: demo('coffee_spill'),
    title: 'Derrame de Café',
    text: 'Todos los jugadores pasan su mano entera al siguiente. Tu partida ya no es tu partida.',
  },
  {
    card: demo('trojan'),
    title: 'Virus Troyano',
    text:
      'Eliges a quién infectas y qué 2 cartas de tu mano le regalas. Un regalo que no se puede ' +
      'rechazar: él se come tus peores cartas y tú te quedas más cerca de ganar.',
  },
  {
    card: demo('reboot'),
    title: 'Apagar y volver a prender',
    text:
      'O cambias el color, sin más, o REINICIAS EL POZO: sueltas encima otra carta tuya, que pasa ' +
      'a ser la nueva base y fija el color. Suelta dos cartas de golpe, pero el color ya no lo ' +
      'eliges tú: manda la carta.',
  },
];

export function RulesScreen({ onClose }: { onClose: () => void }) {
  // Cerrar con Escape: quien abre esto en mitad de una feria quiere volver rápido.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      // Fondo opaco: con transparencia se leía el menú por detrás del texto de las reglas.
      className="fixed inset-0 z-50 overflow-y-auto overflow-x-hidden bg-[#081712]"
    >
      <div className="max-w-3xl mx-auto p-4 sm:p-8 pb-24">
        <header className="flex items-center justify-between mb-6 sticky top-0 bg-[#081712]/95 py-3 -mx-2 px-2 z-10">
          <h2 className="font-pixel text-sm sm:text-lg text-[#07d98c]">Cómo se juega</h2>
          <button
            onClick={onClose}
            className="font-pixel text-[10px] px-4 py-2 rounded-lg bg-black/50 border-2 border-black/60 text-white/70 hover:text-white shadow-pixel"
          >
            cerrar ✕
          </button>
        </header>

        {/* Objetivo */}
        <Section title="El objetivo">
          <p className="text-white/80 leading-relaxed">
            Quedarte <b className="text-[#07d98c]">sin cartas</b>. Empiezas con 7 y en tu turno tiras
            una carta que <b>coincida en color o en número</b> con la del pozo. Si no puedes (o no
            quieres), robas del mazo.
          </p>
          <div className="flex items-end gap-3 mt-4 flex-wrap">
            {(['code', 'hardware', 'internet', 'survival'] as Color[]).map((color, i) => (
              <div key={color} className="flex flex-col items-center gap-1">
                <CardView card={demo('number', color, i + 4)} size="md" />
                <span className="font-pixel text-[8px]" style={{ color: SUIT[color].hex }}>
                  {SUIT[color].label}
                </span>
              </div>
            ))}
          </div>
          <p className="text-white/60 text-xs mt-3 leading-relaxed">
            Cuatro palos, del 0 al 9. Sobre el <b>7 de Internet</b> puedes tirar cualquier otro 7, o
            cualquier carta de Internet.
          </p>
        </Section>

        <Section title="Tu turno: 30 segundos">
          <p className="text-white/80 leading-relaxed">
            Tienes <b className="text-[#07d98c]">30 segundos</b> para jugar. Si{' '}
            <b>no tienes ninguna carta que puedas tirar</b>, el mazo se pone a brillar: robar deja de
            ser una opción y pasa a ser <b>la</b> opción.
          </p>
          <p className="text-white/60 text-xs mt-3 leading-relaxed">
            Y no vale escaquearse: <b>no puedes pasar el turno sin haber robado</b>. Si dejas que se
            acabe el tiempo sin hacer nada,{' '}
            <b className="text-red-400">robas 2 cartas de castigo</b> y pierdes el turno igualmente.
          </p>
        </Section>

        {/* La regla que da nombre al juego */}
        <Section title='La regla del "¡Bug!"'>
          <p className="text-white/80 leading-relaxed">
            Cuando te quedes con <b className="text-yellow-300">una sola carta</b>, tienes que gritar{' '}
            <b className="text-yellow-300">¡Bug!</b> (hay un botón). Si no lo haces y alguien te{' '}
            <b>acusa</b> antes de que juegues, <b className="text-red-400">robas 2 cartas</b> de
            castigo.
          </p>
        </Section>

        <Section title="Cartas especiales">
          <Cards rules={ESPECIALES} />
          <p className="text-white/50 text-xs mt-3">
            Vienen en los cuatro colores. Aquí se muestra una de cada.
          </p>
        </Section>

        <Section title="Comodines">
          <Cards rules={COMODINES} />
          <p className="text-white/50 text-xs mt-3">
            No tienen color: se pueden tirar sobre cualquier carta.
          </p>
        </Section>

        <Section title="Cartas de Caos">
          <p className="text-white/60 text-xs mb-4 leading-relaxed">
            Las que no existen en ningún otro juego de cartas. Aquí es donde la partida se rompe.
          </p>
          <Cards rules={CAOS} />
        </Section>

        <Section title="Si te caes, vuelves. Si te vas, te vas.">
          <p className="text-white/80 leading-relaxed">
            Si se te va el internet, o <b>recargas la página</b>, no pasa nada: los demás te{' '}
            <b>guardan el sitio</b>, te van saltando el turno mientras faltas, y al volver recuperas
            tu mano y sigues jugando.
          </p>
          <p className="text-white/60 text-xs mt-2 leading-relaxed">
            Solo si pulsas <b>salir</b> te vas de verdad: entonces la mesa te saca de la rotación,
            tus cartas vuelven al mazo, y la partida sigue sin ti. Eso no tiene vuelta atrás.
          </p>
        </Section>

        <button
          onClick={onClose}
          className="w-full font-pixel text-xs sm:text-sm py-4 rounded-lg bg-[#07d98c] text-[#04241a] shadow-pixel hover:brightness-110"
        >
          ¡Entendido, a jugar!
        </button>
      </div>
    </motion.div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-8 bg-black/30 border-2 border-black/50 rounded-2xl p-4 sm:p-5">
      <h3 className="font-pixel text-[11px] sm:text-xs text-[#f27eb4] mb-3">{title}</h3>
      <div className="text-sm">{children}</div>
    </section>
  );
}

function Cards({ rules }: { rules: Rule[] }) {
  return (
    <ul className="space-y-4">
      {rules.map((r) => (
        <li
          key={r.card.id}
          className={`flex gap-4 items-start rounded-xl p-3 ${
            r.star ? 'bg-[#f27eb4]/10 ring-2 ring-[#f27eb4]/40' : 'bg-black/20'
          }`}
        >
          <div className="shrink-0">
            <CardView card={r.card} size="lg" />
          </div>
          <div className="min-w-0">
            <h4 className="font-pixel text-[10px] sm:text-[11px] mb-1.5 text-white">
              {r.title}
              {r.star && <span className="text-[#f27eb4]"> ★</span>}
            </h4>
            <p className="text-white/75 text-xs sm:text-sm leading-relaxed">{r.text}</p>
          </div>
        </li>
      ))}
    </ul>
  );
}
