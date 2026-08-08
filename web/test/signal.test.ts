import { describe, expect, it } from 'vitest';
import {
  buildInviteUrl,
  invitedRoom,
  isLocalOnly,
  resolveSignalUrl,
  validateSignalUrl,
} from '@/lib/signal';

// El QR trae la URL de la señalización dentro. Es cómodo (quien escanea no configura nada) y es
// fiel al modelo (no hay una señalización "oficial": la levanta quien crea la sala) — pero es
// también una entrada que viene de fuera, así que se valida.

const FALLBACK = 'ws://localhost:8787';

describe('qué señalización se usa', () => {
  it('sin parámetro ni memoria, la configurada en el build', () => {
    expect(resolveSignalUrl('', null)).toBe(FALLBACK);
  });

  it('el enlace del QR manda: la sala se juega en la señalización del anfitrión', () => {
    const url = resolveSignalUrl('?r=AB12&s=wss%3A%2F%2Ftunel.trycloudflare.com', null);
    expect(url).toBe('wss://tunel.trycloudflare.com/');
  });

  it('sin parámetro, vale la que se recordó de esta sesión (un F5 no te echa de la sala)', () => {
    // El jugador recarga y la URL ya no lleva la `s`: si volviera a la de casa, se quedaría
    // esperando solo en otro tablón mientras la partida sigue sin él.
    expect(resolveSignalUrl('', 'wss://tunel.trycloudflare.com/')).toBe(
      'wss://tunel.trycloudflare.com/',
    );
  });

  it('el enlace gana a la memoria (te acaban de invitar a otra sala)', () => {
    const url = resolveSignalUrl('?s=wss%3A%2F%2Fnueva.example', 'wss://vieja.example/');
    expect(url).toBe('wss://nueva.example/');
  });

  it('rechaza esquemas que no sean ws/wss', () => {
    // Un enlace es algo que cualquiera puede fabricar y mandarte. Que el anfitrión elija SU
    // señalización es el diseño; que un enlace elija a qué se conecta tu navegador, con el esquema
    // que le apetezca, no.
    for (const hostile of [
      'javascript:alert(1)',
      'http://evil.example',
      'https://evil.example',
      'file:///etc/passwd',
      'no-es-una-url',
    ]) {
      expect(validateSignalUrl(hostile)).toBeNull();
      expect(resolveSignalUrl(`?s=${encodeURIComponent(hostile)}`, null)).toBe(FALLBACK);
    }
  });

  it('una memoria corrupta tampoco cuela', () => {
    expect(resolveSignalUrl('', 'javascript:alert(1)')).toBe(FALLBACK);
  });
});

describe('señalización del propio sitio (imagen todo-en-uno)', () => {
  // El contenedor sirve la web y la señalización por el mismo puerto. Sin esto, quien lo levanta
  // tendría que rehacer el build con la URL de su túnel dentro — y la URL del túnel no existe hasta
  // que se abre. Así la imagen es portátil: la levantas donde sea y funciona.
  it('la deduce del origen cuando no hay nada configurado', () => {
    expect(resolveSignalUrl('', null, 'https://bug.ejemplo.com')).toBe('wss://bug.ejemplo.com/ws');
    expect(resolveSignalUrl('', null, 'http://192.168.1.50:8080')).toBe('ws://192.168.1.50:8080/ws');
  });

  it('en `next dev` no: ahí la señalización corre en su propio puerto', () => {
    expect(resolveSignalUrl('', null, 'http://localhost:3000', true)).toBe(FALLBACK);
    expect(resolveSignalUrl('', null, 'http://127.0.0.1:3000', true)).toBe(FALLBACK);
  });

  it('pero el CONTENEDOR en localhost sí la deduce de su origen', () => {
    // El fallo que dejaba al anfitrión sin poder hospedar: quien levanta la imagen y abre
    // `http://localhost:7787` tiene la señalización ahí mismo, en `/ws`. Descartarla por "es local"
    // lo mandaba a `ws://localhost:8787`, donde no hay nada, y su sala se quedaba en
    // *reconectando…* para siempre — con la imagen funcionando perfectamente por debajo.
    expect(resolveSignalUrl('', null, 'http://localhost:7787')).toBe('ws://localhost:7787/ws');
    expect(resolveSignalUrl('', null, 'http://127.0.0.1:7787')).toBe('ws://127.0.0.1:7787/ws');
  });

  it('el enlace del QR sigue mandando sobre el origen', () => {
    const url = resolveSignalUrl('?s=wss%3A%2F%2Fotro.example', null, 'https://bug.ejemplo.com');
    expect(url).toBe('wss://otro.example/');
  });
});

describe('enlace de invitación (el que va dentro del QR)', () => {
  it('lleva la sala y la señalización', () => {
    const invite = new URL(
      buildInviteUrl('https://bug.example/juego', 'AB12', 'wss://tunel.example/'),
    );
    expect(invite.origin + invite.pathname).toBe('https://bug.example/juego');
    expect(invite.searchParams.get('r')).toBe('AB12');
    expect(invite.searchParams.get('s')).toBe('wss://tunel.example/');
  });

  it('no arrastra la invitación anterior (el anfitrión pudo llegar por otro QR)', () => {
    const invite = new URL(
      buildInviteUrl('https://bug.example/?r=VIEJA&s=wss%3A%2F%2Fvieja.example', 'NUEVA', 'wss://x.example/'),
    );
    expect(invite.searchParams.get('r')).toBe('NUEVA');
    expect(invite.searchParams.get('s')).toBe('wss://x.example/');
  });
});

describe('sala invitada', () => {
  it('se lee del enlace y se normaliza', () => {
    expect(invitedRoom('?r=ab12')).toBe('AB12');
    expect(invitedRoom('?r=%20ab12%20')).toBe('AB12');
    expect(invitedRoom('')).toBeNull();
  });
});

describe('aviso de "solo funciona aquí"', () => {
  it('detecta las URLs locales, que no significan nada para el móvil que escanea', () => {
    expect(isLocalOnly('ws://localhost:8787')).toBe(true);
    expect(isLocalOnly('http://localhost:3000')).toBe(true);
    expect(isLocalOnly('ws://127.0.0.1:8787')).toBe(true);
    expect(isLocalOnly('wss://tunel.trycloudflare.com')).toBe(false);
    expect(isLocalOnly('https://bug.onrender.com')).toBe(false);
  });
});
