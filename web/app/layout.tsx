import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Bug 🐛 — juego de cartas P2P',
  description: 'UNO re-tematizado, parodia informática, 100% P2P descentralizado.',
};

// En la feria la gente entra escaneando el QR con el móvil: la partida se juega en vertical, en
// pantallas de 360 px, y el tablero tiene que caber sin que nadie haga zoom para tocar una carta.
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#0c2119',
};

/**
 * El sprite con el arte de las cartas se incrusta en el HTML, no se descarga aparte.
 *
 * Se lee en el build (la página es estática), así que llega con el documento: las cartas están
 * dibujadas desde el primer fotograma, sin un parpadeo de "cargando" ni una petición extra. Es lo
 * contrario del criterio con PixiJS —que se descarga tarde y solo si hace falta— y por la razón
 * opuesta: los efectos son un adorno prescindible; las cartas SON el juego.
 */
const cardSprite = readFileSync(join(process.cwd(), 'public', 'cards.svg'), 'utf8');

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body>
        {/* Contenido propio generado en el build desde los .svg del repo (`npm run art`), no
            entrada de usuario. */}
        <div hidden dangerouslySetInnerHTML={{ __html: cardSprite }} />
        {children}
      </body>
    </html>
  );
}
