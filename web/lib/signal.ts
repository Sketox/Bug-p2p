// De dónde sale la URL del servidor de señalización, y cómo viaja en el QR.
//
// Recordatorio del modelo (Fase 3): la señalización es un punto de encuentro, no un servidor de
// juego. No hay una "oficial": la levanta quien crea la sala. Por eso la URL no puede estar
// clavada en el build — tiene que poder viajar CON la invitación, que es justo lo que hace el QR:
//
//     https://…/?r=AB12&s=wss%3A%2F%2Fabc-def.trycloudflare.com
//                  ^ sala        ^ dónde nos encontramos
//
// Quien escanea no configura nada: entra, y su navegador ya sabe a qué tablón de anuncios asomarse.
//
// La lógica de abajo es PURA (el navegador entra por parámetro, igual que el reloj entra por
// parámetro en el detector de fallos): así se prueba sin montar un DOM. Los envoltorios que sí
// tocan `window` viven al final, y no tienen nada que decidir.

/** Señalización fijada en el build (deploy con configuración explícita). Normalmente no hay. */
const CONFIGURED = process.env.NEXT_PUBLIC_SIGNAL_URL || null;
/** Desarrollo: `npm run signaling` levanta su propio puerto, aparte del de Next. */
const DEV_FALLBACK = 'ws://localhost:8787';
const KEY = 'bug:signal';

/**
 * Solo se aceptan URLs `ws://` o `wss://`.
 *
 * Esto es un parámetro de URL: cualquiera puede fabricar un enlace con la `s` que quiera y
 * mandárselo a alguien. Aceptar cualquier cosa sería dejar que el enlace decida a qué se conecta
 * tu navegador y con qué esquema (`javascript:`, `file:`…). Que un anfitrión cualquiera pueda
 * ofrecer SU señalización es el diseño; que un enlace pueda ofrecer cualquier cosa, no.
 *
 * (Aun así, quien escanea un QR ajeno confía en la señalización de quien lo generó para el
 * handshake: no le ve las cartas —viajan cifradas peer a peer— pero sí sabe quién juega con quién.
 * Queda anotado como hallazgo conocido para el reporte de V&V.)
 */
export function validateSignalUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'ws:' || parsed.protocol === 'wss:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}

/**
 * La señalización servida por el MISMO sitio que la web, en `/ws`.
 *
 * Es lo que hace portátil la imagen de Docker: el contenedor sirve la web y la señalización por un
 * único puerto, así que quien lo levanta no tiene que configurar ninguna URL — y cuando lo publica
 * con un túnel, la señalización viaja con él sin rehacer el build. (Con `NEXT_PUBLIC_SIGNAL_URL`
 * horneada en el build eso sería imposible: la URL del túnel no existe hasta que se abre.)
 *
 * ⚠️ Aquí NO se descarta `localhost`, y antes sí — y ese descarte rompía la imagen para el propio
 * anfitrión. El razonamiento era "en local la señalización va en otro puerto", que es cierto en
 * `next dev` y falso en el contenedor: quien levanta la imagen y abre `http://localhost:7787` tiene
 * el `/ws` ahí mismo. Al descartarlo se caía en `ws://localhost:8787`, donde no hay nada, y la sala
 * se quedaba en *reconectando…* para siempre. Lo que distingue los dos casos no es la máquina, es
 * **quién sirve la página** — y eso lo dice `devServer`, no el nombre del host.
 */
function sameOrigin(origin: string | null | undefined): string | null {
  if (!origin) return null;
  try {
    const url = new URL(origin);
    return `${url.protocol === 'https:' ? 'wss:' : 'ws:'}//${url.host}/ws`;
  } catch {
    return null;
  }
}

/**
 * Decide la señalización a usar, por orden de mando:
 *
 *   1. la que trajo el enlace del QR (`?s=`) — te invitaron a la mesa de otro;
 *   2. la que se recordó en esta sesión — recargaste la página a media partida;
 *   3. la fijada en el build (`NEXT_PUBLIC_SIGNAL_URL`) — un deploy con configuración explícita;
 *   4. la del propio sitio (`/ws`) — la imagen todo-en-uno, que es el caso normal al desplegar;
 *   5. `localhost:8787` — desarrollo.
 *
 * `devServer` es lo único que distingue el paso 4 del 5, y hay que pasárselo porque **no se puede
 * deducir de la URL**: `http://localhost:3000` (dos terminales, señalización aparte) y
 * `http://localhost:7787` (contenedor, señalización en `/ws`) se parecen demasiado. Lo que las
 * separa es quién sirve la página, no dónde está.
 */
export function resolveSignalUrl(
  search: string,
  remembered: string | null,
  origin?: string | null,
  devServer = false,
): string {
  const fromLink = validateSignalUrl(new URLSearchParams(search).get('s'));
  if (fromLink) return fromLink;
  return (
    validateSignalUrl(remembered) ??
    validateSignalUrl(CONFIGURED) ??
    (devServer ? null : sameOrigin(origin)) ??
    DEV_FALLBACK
  );
}

/** El enlace de invitación que va dentro del QR: dónde está la web, la sala y la señalización. */
export function buildInviteUrl(pageUrl: string, roomId: string, signal: string): string {
  const url = new URL(pageUrl);
  url.search = '';
  url.hash = '';
  url.searchParams.set('r', roomId);
  url.searchParams.set('s', signal);
  return url.toString();
}

/**
 * ¿Este enlace solo funciona en esta computadora? `localhost` no significa nada para el móvil que
 * escanea el QR: apunta a SU propio navegador. Vale la pena avisarlo antes de la feria y no
 * durante.
 */
export function isLocalOnly(url: string): boolean {
  return /(^|\/\/)(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(url);
}

/** La sala que venía en el enlace (`?r=AB12`), normalizada. */
export function invitedRoom(search: string): string | null {
  const code = new URLSearchParams(search).get('r')?.trim().toUpperCase().slice(0, 6);
  return code ? code : null;
}

// --- Envoltorios de navegador -----------------------------------------------------------------
// Lo único que hacen es traer el estado del navegador y delegar en las funciones de arriba.

/** URL de señalización a usar: la que trajo el QR, la del build, o la del propio sitio (`/ws`). */
export function signalUrl(): string {
  if (typeof window === 'undefined') return CONFIGURED ?? DEV_FALLBACK;
  let remembered: string | null = null;
  try {
    remembered = sessionStorage.getItem(KEY);
  } catch {
    /* modo privado: sin memoria de sesión, se sigue igual */
  }

  // `next dev` es el único caso en que la web y la señalización viven en puertos distintos. Next
   // sustituye esto por una constante al compilar, así que en la imagen es literalmente `false`.
  const devServer = process.env.NODE_ENV === 'development';
  const resolved = resolveSignalUrl(
    window.location.search,
    remembered,
    window.location.origin,
    devServer,
  );

  // Se recuerda durante la sesión: si el jugador recarga a media partida, la pestaña vuelve al
  // mismo tablón aunque la URL ya no lleve el parámetro.
  try {
    if (resolved !== remembered) sessionStorage.setItem(KEY, resolved);
  } catch {
    /* idem */
  }
  return resolved;
}

export function inviteUrl(roomId: string): string {
  return buildInviteUrl(window.location.href, roomId, signalUrl());
}
