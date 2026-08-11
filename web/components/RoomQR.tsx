'use client';

import { useEffect, useState } from 'react';

// QR de invitación. Lleva el enlace completo (web + sala + señalización), así que quien lo escanea
// entra directo a la mesa: sin escribir códigos ni configurar servidores.
//
// La librería del QR se carga bajo demanda, igual que PixiJS: solo la necesita el anfitrión, y
// solo mientras espera en el lobby.

export function RoomQR({ url }: Readonly<{ url: string }>) {
  const [png, setPng] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    void import('qrcode')
      .then((mod) => {
        // El paquete es CommonJS: según el bundler, la API cuelga del namespace o de `default`.
        const qr = ('toDataURL' in mod ? mod : (mod as { default: typeof mod }).default);
        return qr.toDataURL(url, {
          margin: 1,
          width: 200,
          errorCorrectionLevel: 'M',
          color: { dark: '#08130c', light: '#f2f3f4' },
        });
      })
      .then((dataUrl) => {
        if (alive) setPng(dataUrl);
      })
      .catch(() => {
        if (alive) setFailed(true); // sin QR se sigue jugando: queda el código de sala
      });
    return () => {
      alive = false;
    };
  }, [url]);

  if (failed) return null;

  return (
    <div className="grid place-items-center">
      <div className="w-[200px] h-[200px] grid place-items-center bg-[#f2f3f4] rounded-lg border-2 border-black/60 shadow-pixel overflow-hidden">
        {png ? (
          // La imagen es un data URI generado en el navegador; `next/image` no aporta nada aquí.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={png} alt="Código QR para unirse a la sala" className="w-full h-full pixelated" />
        ) : (
          <span className="font-pixel text-[9px] text-black/40">generando…</span>
        )}
      </div>
    </div>
  );
}
