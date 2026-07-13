import { describe, expect, it } from 'vitest';
import { FailureDetector } from '../src/heartbeat.js';

// Detección de fallos con reloj VIRTUAL: el tiempo es un número que avanzamos a mano, así que
// "el nodo lleva 7 segundos callado" se prueba en microsegundos y sin flakiness.

const OPTS = { interval: 1000, suspectAfter: 2500, downAfter: 6000 };

describe('FailureDetector', () => {
  it('presume vivo al peer recién vigilado', () => {
    const d = new FailureDetector(OPTS);
    d.watch('bob', 0);
    expect(d.healthOf('bob')).toBe('alive');
    expect(d.sweep(0)).toEqual([]);
  });

  it('escala de vivo a sospechoso y de sospechoso a caído según el silencio', () => {
    const d = new FailureDetector(OPTS);
    d.watch('bob', 0);

    expect(d.sweep(2000)).toEqual([]); // aún dentro de lo normal
    expect(d.sweep(3000)).toEqual([{ peerId: 'bob', from: 'alive', to: 'suspect' }]);
    expect(d.sweep(4000)).toEqual([]); // ya estaba sospechoso: no se repite el aviso
    expect(d.sweep(6500)).toEqual([{ peerId: 'bob', from: 'suspect', to: 'down' }]);
    expect(d.isDown('bob')).toBe(true);
    expect(d.alive()).toEqual([]);
  });

  it('un latido rescata al sospechoso antes de declararlo caído', () => {
    const d = new FailureDetector(OPTS);
    d.watch('bob', 0);
    d.sweep(3000);
    expect(d.healthOf('bob')).toBe('suspect');

    expect(d.beat('bob', 3200)).toEqual({ peerId: 'bob', from: 'suspect', to: 'alive' });
    expect(d.sweep(5000)).toEqual([]); // el reloj de silencio se reinició con el latido
    expect(d.healthOf('bob')).toBe('alive');
  });

  it('un caído que vuelve a latir resucita (reconexión)', () => {
    const d = new FailureDetector(OPTS);
    d.watch('bob', 0);
    d.sweep(7000);
    expect(d.isDown('bob')).toBe(true);

    expect(d.beat('bob', 7100)).toEqual({ peerId: 'bob', from: 'down', to: 'alive' });
    expect(d.alive()).toEqual(['bob']);
  });

  it('cada caída se anuncia una sola vez, aunque se siga barriendo', () => {
    const d = new FailureDetector(OPTS);
    d.watch('bob', 0);
    d.watch('carol', 0);
    d.beat('carol', 5000);

    const changes = d.sweep(6100);
    expect(changes).toEqual([{ peerId: 'bob', from: 'alive', to: 'down' }]); // carol sigue viva
    expect(d.sweep(6200)).toEqual([]);
    expect(d.sweep(20000)).toEqual([{ peerId: 'carol', from: 'alive', to: 'down' }]);
  });

  it('el latido propio respeta el intervalo', () => {
    const d = new FailureDetector(OPTS);
    expect(d.shouldBeat(0)).toBe(true); // el primero sale de inmediato
    expect(d.shouldBeat(500)).toBe(false);
    expect(d.shouldBeat(1000)).toBe(true);
    expect(d.shouldBeat(1500)).toBe(false);
  });

  it('olvidar a un peer lo saca del informe (salida limpia)', () => {
    const d = new FailureDetector(OPTS);
    d.watch('bob', 0);
    d.forget('bob');
    expect(d.report(0)).toEqual([]);
    expect(d.sweep(99999)).toEqual([]); // ya no se le vigila: no genera una caída fantasma
  });

  it('uno NUNCA se da por caído a sí mismo', () => {
    // El fallo que costó una partida entera: un nodo no se manda latidos (no tendría sentido), así
    // que al preguntarle por sí mismo caía en el valor por defecto —"no sé nada de él, luego está
    // caído"—. En el líder era mortal: cuando le tocaba el turno, se lo saltaba a sí mismo con el
    // PASS de recuperación, ronda tras ronda. Nunca llegaba a jugar.
    const d = new FailureDetector({ ...OPTS, self: 'alice' });

    expect(d.isDown('alice')).toBe(false);
    expect(d.healthOf('alice')).toBe('alive');

    // Y sigue siendo verdad pase el tiempo que pase, porque nadie va a latir por él.
    d.watch('bob', 0);
    d.sweep(999_999);
    expect(d.isDown('alice')).toBe(false);
    expect(d.isDown('bob')).toBe(true); // el de al lado sí, que para eso está el detector
  });
});
