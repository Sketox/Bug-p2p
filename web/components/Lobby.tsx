'use client';

import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { MAX_PLAYERS } from '@bug/engine';
import type { RoomStatus } from '@bug/net';
import type { LobbyPlayer } from '@/lib/netProtocol';
import { inviteUrl, isLocalOnly, signalUrl } from '@/lib/signal';
import { RoomQR } from './RoomQR';

interface Props {
  roomId: string;
  isHost: boolean;
  players: LobbyPlayer[];
  myId: string;
  status: RoomStatus;
  onStart: () => void;
  onLeave: () => void;
}

const STATUS_LABEL: Record<RoomStatus, string> = {
  connecting: 'conectando…',
  online: 'en línea',
  reconnecting: 'reconectando…',
  closed: 'sin conexión',
};

export function Lobby({ roomId, isHost, players, myId, status, onStart, onLeave }: Readonly<Props>) {
  const [invite, setInvite] = useState<string | null>(null);
  const [localOnly, setLocalOnly] = useState(false);
  const [copied, setCopied] = useState(false);

  // Con la mesa completa, la señalización ya rebota a quien intente entrar. Enseñar aquí un QR que
  // solo lleva a una pantalla de "no cabes" sería invitar a alguien a una puerta que ya cerramos.
  const full = players.length >= MAX_PLAYERS;

  // El enlace se arma en el navegador (necesita `window.location`), así que no puede calcularse
  // durante el render del servidor.
  useEffect(() => {
    setInvite(inviteUrl(roomId));
    setLocalOnly(isLocalOnly(signalUrl()) || isLocalOnly(window.location.origin));
  }, [roomId]);

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* sin permiso de portapapeles: queda el código a la vista para escribirlo a mano */
    }
  };

  return (
    // `flex`, no `grid place-items-center`: con grid, la tarjeta se quedaba en sus 28rem y
    // desbordaba la pantalla en un móvil de 360 px (que es como se entra por el QR).
    <div className="min-h-[100dvh] flex items-center justify-center p-4 sm:p-6">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="w-full max-w-md bg-black/40 border-2 border-black/60 rounded-2xl p-4 sm:p-6 shadow-pixel"
      >
        <p className="text-center text-[10px] font-pixel text-white/50 mb-1">
          Sala · {STATUS_LABEL[status]}
        </p>
        <div className="text-center mb-4">
          {/* `data-testid`: gancho estable para las pruebas de extremo a extremo (Cypress, V&V). */}
          <div
            data-testid="room-code"
            className="font-pixel text-3xl sm:text-4xl tracking-[0.3em] text-[#f27eb4]"
          >
            {roomId}
          </div>
        </div>

        {/* La mesa se llenó: donde estaba la invitación va el aviso. */}
        {full && (
          <motion.div
            data-testid="lobby-full"
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            className="mb-4 rounded-xl border-2 border-[#f27eb4]/40 bg-[#f27eb4]/10 px-3 py-4 text-center"
          >
            <p className="font-pixel text-[11px] text-[#f27eb4] mb-2">🐛 SALA LLENA</p>
            <p className="font-pixel text-[9px] leading-relaxed text-white/60">
              la mesa está completa ({MAX_PLAYERS} de {MAX_PLAYERS}). ya no entra nadie más:
              <br />
              a quien abra el enlace le saldrá que la sala está llena.
            </p>
          </motion.div>
        )}

        {/* Invitación: el QR lleva sala + señalización, así que quien escanea no configura nada. */}
        {invite && !full && (
          <div className="mb-4 space-y-2">
            <RoomQR url={invite} />
            <div className="flex justify-center gap-3">
              <button
                type="button"
                onClick={() => copy(invite)}
                className="font-pixel text-[9px] text-white/60 hover:text-white/90 px-2 py-1"
              >
                {copied ? '✓ copiado' : 'copiar enlace 🔗'}
              </button>
              <button
                type="button"
                onClick={() => copy(roomId)}
                className="font-pixel text-[9px] text-white/60 hover:text-white/90 px-2 py-1"
              >
                copiar código 📋
              </button>
            </div>
            {localOnly && (
              // Aviso honesto: un QR con `localhost` dentro solo funciona en esta misma máquina.
              // Para jugar entre redes hay que exponer la señalización (túnel o despliegue).
              <p className="font-pixel text-[8px] leading-relaxed text-yellow-400/80 text-center">
                ⚠ este QR apunta a localhost: solo sirve en esta computadora.
                <br />
                para jugar entre redes, expón la señalización (cloudflared / deploy).
              </p>
            )}
          </div>
        )}

        <p className="font-pixel text-[10px] text-white/60 mb-2">
          Jugadores{' '}
          <span className={full ? 'text-[#f27eb4]' : undefined}>
            ({players.length}/{MAX_PLAYERS})
          </span>
        </p>
        <ul className="space-y-2 mb-6">
          {players.map((p) => (
            <motion.li
              key={p.peerId}
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              className="flex items-center gap-2 bg-black/30 rounded px-3 py-2"
            >
              <span className="text-lg">🐛</span>
              <span className="font-pixel text-[10px] sm:text-xs truncate">
                {p.name}
                {p.peerId === myId ? ' (tú)' : ''}
              </span>
            </motion.li>
          ))}
          {players.length < 2 && (
            <li className="font-pixel text-[10px] text-white/40 text-center py-2 animate-pulse">
              esperando a otros jugadores…
            </li>
          )}
        </ul>

        {isHost ? (
          <button
            type="button"
            onClick={onStart}
            disabled={players.length < 2}
            className="w-full font-pixel text-xs sm:text-sm py-3 rounded-lg bg-[#50C878] text-[#08130c] shadow-pixel disabled:opacity-40 mb-2"
          >
            {players.length < 2 ? 'Faltan jugadores' : '¡Empezar!'}
          </button>
        ) : (
          <p className="text-center font-pixel text-[10px] text-white/50 py-3 animate-pulse">
            esperando a que el anfitrión inicie…
          </p>
        )}

        <button
          type="button"
          onClick={onLeave}
          className="w-full font-pixel text-[10px] py-2 rounded text-white/50 hover:text-white/80"
        >
          salir
        </button>
      </motion.div>
    </div>
  );
}
