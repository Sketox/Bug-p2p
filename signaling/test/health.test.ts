import { afterAll, describe, expect, it } from 'vitest';

// El endpoint de salud, contra el servidor de verdad.
//
// Existe este archivo por un fallo concreto: `/health` solo atendía `GET`, y las pruebas de extremo
// a extremo nunca llegaban a arrancar porque `wait-on` —que es quien espera a que el stack esté en
// pie— sondea con `HEAD`. El servidor estaba vivo, contestando, y aun así se le daba por caído
// durante los cinco minutos que dura la espera.
//
// No es un problema de las pruebas: es del servidor. HTTP dice que quien atiende `GET` en un
// recurso atiende `HEAD` en el mismo, y quien sondea salud tiene todo el derecho a usarlo — es más
// barato, porque no pide el cuerpo. Node no lo deriva solo.

process.env.PORT = '0'; // puerto que elija el sistema: los tests no pelean por el 8787
const { httpServer } = await import('../src/server.js');

const base = () => {
  const dir = httpServer.address();
  if (!dir || typeof dir === 'string') throw new Error('el servidor no está escuchando');
  return `http://127.0.0.1:${dir.port}`;
};

afterAll(() => {
  httpServer.close();
});

describe('endpoint de salud', () => {
  it('responde a GET en /health y en la raíz', async () => {
    for (const ruta of ['/health', '/']) {
      const r = await fetch(base() + ruta);
      expect(r.status, ruta).toBe(200);
      expect(await r.text()).toContain('bug-signaling');
    }
  });

  it('responde a HEAD igual que a GET, y sin cuerpo', async () => {
    for (const ruta of ['/health', '/']) {
      const r = await fetch(base() + ruta, { method: 'HEAD' });
      expect(r.status, ruta).toBe(200);
      expect(await r.text(), 'HEAD no lleva cuerpo').toBe('');
    }
  });

  it('lo que no es un sondeo de salud sigue siendo 404', async () => {
    const r = await fetch(base() + '/otra-cosa');
    expect(r.status).toBe(404);
  });
});
