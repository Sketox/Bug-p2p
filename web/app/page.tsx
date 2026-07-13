'use client';

import { useEffect, useState } from 'react';
import { MainMenu } from '@/components/MainMenu';
import { HotSeatGame } from '@/components/HotSeatGame';
import { NetworkGame } from '@/components/NetworkGame';
import { invitedRoom } from '@/lib/signal';
import { clearRoom, loadRoom } from '@/lib/session';

type Mode =
  | { kind: 'boot' } // aún no sabemos si venimos de una recarga
  | { kind: 'menu' }
  | { kind: 'hotseat' }
  | { kind: 'net'; mode: 'host' | 'join'; name: string; code?: string };

export default function Page() {
  const [mode, setMode] = useState<Mode>({ kind: 'boot' });
  const [invitedTo, setInvitedTo] = useState<string | null>(null);

  useEffect(() => {
    // ¿Veníamos de una partida y la página se recargó? Se vuelve a entrar solo, con la misma
    // identidad: para la mesa somos el mismo nodo de siempre, recuperamos la mano y el sitio.
    // Entramos como "join" aunque fuéramos el anfitrión — el anfitrión no es dueño de nada, y el
    // liderazgo ya se lo habrán repartido entre ellos mientras faltábamos.
    const saved = loadRoom();
    if (saved) {
      setMode({ kind: 'net', mode: 'join', name: saved.name, code: saved.code });
      return;
    }
    setInvitedTo(invitedRoom(window.location.search));
    setMode({ kind: 'menu' });
  }, []);

  const toMenu = () => {
    clearRoom(); // salir de verdad: la próxima recarga empieza en el menú
    setMode({ kind: 'menu' });
  };

  if (mode.kind === 'boot') return <div className="min-h-[100dvh]" />; // sin parpadeo del menú
  if (mode.kind === 'hotseat') return <HotSeatGame onExit={toMenu} />;
  if (mode.kind === 'net') {
    return <NetworkGame mode={mode.mode} name={mode.name} code={mode.code} onExit={toMenu} />;
  }
  return (
    <MainMenu
      invitedTo={invitedTo}
      onHost={(name) => setMode({ kind: 'net', mode: 'host', name })}
      onJoin={(name, code) => setMode({ kind: 'net', mode: 'join', name, code })}
      onLocal={() => setMode({ kind: 'hotseat' })}
    />
  );
}
