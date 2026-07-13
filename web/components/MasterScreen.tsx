'use client';

import { AnimatePresence, motion } from 'framer-motion';
import type { JournalEntry, JournalKind, MeshView } from '@/lib/useBugRoom';

// Pantalla Maestra: la partida vista como SISTEMA DISTRIBUIDO, no como juego de cartas.
//
// Todo lo que en el tablero es invisible (quién sigue vivo, quién coordina, dónde está el
// testigo, si los nodos han convergido al mismo estado) aquí se ve en directo. Es la herramienta
// para demostrar la Fase 5: se cierra un navegador y se ve, en los demás, cómo el nodo pasa de
// vivo → sospechoso → caído, cómo se elige un líder nuevo si el que cayó era el coordinador, y
// cómo el testigo se regenera para que la mesa no se quede congelada.
//
// La columna decisiva es la HUELLA: cada nodo publica en su latido el hash de su estado
// replicado. Si todas las huellas coinciden, la malla está convergida — y eso es exactamente lo
// que sostiene el diseño sin servidor. Una huella distinta es un nodo que se desvió, y se ve al
// instante.

interface Props {
  mesh: MeshView;
  journal: JournalEntry[];
  onClose: () => void;
}

const HEALTH: Record<string, { dot: string; label: string; text: string }> = {
  alive: { dot: 'bg-[#50C878]', label: 'vivo', text: 'text-[#50C878]' },
  suspect: { dot: 'bg-yellow-400 animate-pulse', label: 'sospechoso', text: 'text-yellow-400' },
  down: { dot: 'bg-red-500', label: 'caído', text: 'text-red-400' },
  /** Se despidió (QUIT): no es un fallo, es una salida — no hay nada que recuperar. */
  left: { dot: 'bg-white/30', label: 'se fue', text: 'text-white/40' },
};

const KIND_ICON: Record<JournalKind, string> = {
  down: '💀',
  up: '🔌',
  election: '🗳️',
  leader: '👑',
  token: '🎫',
  sync: '🔄',
  info: '·',
};

const time = (at: number) =>
  new Date(at).toLocaleTimeString('es-EC', { hour12: false, minute: '2-digit', second: '2-digit' });

export function MasterScreen({ mesh, journal, onClose }: Props) {
  const converged = mesh.nodes
    .filter((n) => n.health !== 'down' && n.hash != null)
    .every((n) => n.converged);
  const present = mesh.nodes.filter((n) => !n.left);

  return (
    <motion.aside
      initial={{ opacity: 0, x: 40 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 40 }}
      className="fixed top-0 right-0 z-40 h-full w-full sm:w-[26rem] overflow-y-auto
                 bg-[#0b0f14]/95 backdrop-blur border-l-2 border-black/60 p-4 space-y-4"
    >
      <header className="flex items-center justify-between">
        <h2 className="font-pixel text-xs text-[#FF7F50]">🖥 Pantalla Maestra</h2>
        <button onClick={onClose} className="font-pixel text-[10px] text-white/50 hover:text-white">
          cerrar ✕
        </button>
      </header>

      {/* Resumen de la malla */}
      <section className="grid grid-cols-2 gap-2 font-pixel text-[9px]">
        <Stat label="líder" value={mesh.nodes.find((n) => n.isLeader)?.name ?? '—'} />
        <Stat
          label="elección"
          value={mesh.electing ? 'EN CURSO' : 'estable'}
          tone={mesh.electing ? 'warn' : 'ok'}
        />
        <Stat label="testigo" value={mesh.nodes.find((n) => n.hasToken)?.name ?? '—'} />
        <Stat label="seq testigo" value={String(mesh.tokenSeq)} />
        <Stat label="mi lamport" value={String(mesh.myLamport)} />
        <Stat label="eventos en el log" value={String(mesh.logSize)} />
        <Stat
          label="rechazados"
          value={String(mesh.rejectedCount)}
          tone={mesh.rejectedCount > 0 ? 'warn' : 'ok'}
        />
        <Stat
          label="convergencia"
          value={converged ? 'OK ✓' : 'DIVERGE ✗'}
          tone={converged ? 'ok' : 'bad'}
        />
      </section>

      {/* Nodos */}
      <section>
        <h3 className="font-pixel text-[10px] text-white/60 mb-2">
          Nodos ({present.length}
          {mesh.nodes.length > present.length ? ` +${mesh.nodes.length - present.length} ausentes` : ''})
        </h3>
        <ul className="space-y-1">
          {mesh.nodes.map((n) => {
            // Un nodo que se despidió no es un nodo caído: no hay nada que sospechar ni que
            // recuperar, se fue y la mesa ya cuenta sin él.
            const h = n.left ? HEALTH.left! : HEALTH[n.health]!;
            return (
              <li
                key={n.peerId}
                className={`bg-black/40 rounded px-2 py-1.5 flex items-center gap-2 font-pixel text-[9px] ${
                  n.left ? 'opacity-50' : ''
                }`}
              >
                <span className={`w-2 h-2 rounded-full shrink-0 ${h.dot}`} title={h.label} />
                <span className="flex-1 truncate">
                  {n.name}
                  {n.isMe && <span className="text-white/40"> (tú)</span>}
                  {n.isLeader && <span title="líder"> 👑</span>}
                  {n.hasToken && <span title="tiene el testigo de turno"> 🎫</span>}
                </span>
                <span className={`${h.text} w-14 text-right`}>
                  {n.left
                    ? 'se fue'
                    : n.health === 'alive'
                      ? 'vivo'
                      : n.health === 'suspect'
                        ? `${(n.silence / 1000) | 0}s…`
                        : 'caído'}
                </span>
                {/* Huella del estado replicado: si no coincide con la mía, ese nodo se desvió. */}
                <span
                  className={`w-16 text-right ${
                    n.hash == null ? 'text-white/25' : n.converged ? 'text-[#50C878]' : 'text-red-400'
                  }`}
                  title="huella del estado replicado (stateHash)"
                >
                  {n.hash ?? '········'}
                </span>
              </li>
            );
          })}
        </ul>
      </section>

      {/* Diario de sucesos */}
      <section>
        <h3 className="font-pixel text-[10px] text-white/60 mb-2">Sucesos</h3>
        <ul className="space-y-1 font-mono text-[10px] leading-relaxed">
          <AnimatePresence initial={false}>
            {[...journal].reverse().map((e) => (
              <motion.li
                key={`${e.at}-${e.text}`}
                initial={{ opacity: 0, x: 10 }}
                animate={{ opacity: 1, x: 0 }}
                className="flex gap-2 text-white/70"
              >
                <span className="text-white/30 shrink-0">{time(e.at)}</span>
                <span className="shrink-0">{KIND_ICON[e.kind]}</span>
                <span>{e.text}</span>
              </motion.li>
            ))}
          </AnimatePresence>
          {journal.length === 0 && (
            <li className="text-white/30 font-pixel text-[9px]">sin novedad en la malla</li>
          )}
        </ul>
      </section>
    </motion.aside>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'ok' | 'warn' | 'bad' }) {
  const color =
    tone === 'bad' ? 'text-red-400' : tone === 'warn' ? 'text-yellow-400' : 'text-white/90';
  return (
    <div className="bg-black/40 rounded px-2 py-1.5">
      <div className="text-white/40 text-[8px] uppercase tracking-wider">{label}</div>
      <div className={`${color} truncate`}>{value}</div>
    </div>
  );
}
