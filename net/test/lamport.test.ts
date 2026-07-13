import { describe, expect, it } from 'vitest';
import { compareStamped, LamportClock, stampKey, type Stamped } from '../src/lamport.js';
import { TurnToken } from '../src/token.js';

describe('LamportClock', () => {
  it('avanza de uno en uno al emitir eventos propios', () => {
    const c = new LamportClock();
    expect(c.tick()).toBe(1);
    expect(c.tick()).toBe(2);
    expect(c.time).toBe(2);
  });

  it('al recibir un sello ajeno se sincroniza a max(propio, ajeno) + 1', () => {
    const c = new LamportClock();
    c.tick(); // t = 1
    c.update(7); // ajeno más adelantado → salta a 8
    expect(c.time).toBe(8);
    c.update(3); // ajeno rezagado → solo avanza uno
    expect(c.time).toBe(9);
  });

  it('preserva la causalidad: si A causa B, lamport(A) < lamport(B)', () => {
    const alice = new LamportClock();
    const bob = new LamportClock();

    const a = alice.tick(); // Alice emite
    bob.update(a); // Bob lo recibe...
    const b = bob.tick(); // ...y reacciona

    expect(a).toBeLessThan(b);
  });
});

describe('orden total', () => {
  const ev = (lamport: number, origin: string): Stamped<string> => ({
    lamport,
    origin,
    event: 'x',
  });

  it('ordena por sello de Lamport', () => {
    expect(compareStamped(ev(1, 'a'), ev(2, 'a'))).toBeLessThan(0);
    expect(compareStamped(ev(3, 'a'), ev(2, 'a'))).toBeGreaterThan(0);
  });

  it('desempata eventos concurrentes por peerId, igual en todos los nodos', () => {
    // Mismo sello = eventos concurrentes (sin relación causal). El desempate por peerId es lo
    // que hace que todos los nodos elijan LA MISMA secuencia sin hablar entre ellos.
    expect(compareStamped(ev(5, 'alice'), ev(5, 'bob'))).toBeLessThan(0);
    expect(compareStamped(ev(5, 'bob'), ev(5, 'alice'))).toBeGreaterThan(0);
    expect(compareStamped(ev(5, 'alice'), ev(5, 'alice'))).toBe(0);
  });

  it('dos nodos ordenan un lote desordenado de forma idéntica', () => {
    const lote = [ev(2, 'bob'), ev(1, 'carol'), ev(2, 'alice'), ev(1, 'alice')];
    const nodo1 = [...lote].sort(compareStamped);
    const nodo2 = [...lote].reverse().sort(compareStamped);
    expect(nodo1).toEqual(nodo2);
    expect(nodo1.map(stampKey)).toEqual(['1:alice', '1:carol', '2:alice', '2:bob']);
  });
});

describe('TurnToken (exclusión mutua)', () => {
  it('solo el poseedor puede actuar', () => {
    const alice = new TurnToken('alice', 'alice');
    const bob = new TurnToken('bob', 'alice');

    expect(alice.held()).toBe(true);
    expect(bob.held()).toBe(false);
  });

  it('quien no tiene el testigo no puede cederlo', () => {
    const bob = new TurnToken('bob', 'alice');
    expect(bob.passTo('carol')).toBeNull();
    expect(bob.holder).toBe('alice');
  });

  it('el testigo circula y hay exactamente un poseedor en todo momento', () => {
    const nodos = ['alice', 'bob', 'carol'];
    const tokens = nodos.map((n) => new TurnToken(n, 'alice'));

    const poseedores = () => tokens.filter((t) => t.held()).length;
    expect(poseedores()).toBe(1);

    // Alice cede a Bob y lo anuncia por la malla.
    const anuncio = tokens[0]!.passTo('bob')!;
    for (const t of tokens.slice(1)) t.receive(anuncio);

    expect(poseedores()).toBe(1);
    expect(tokens[1]!.held()).toBe(true);
    expect(tokens[0]!.held()).toBe(false);
  });

  it('descarta anuncios rezagados (fantasmas de una vuelta anterior)', () => {
    const carol = new TurnToken('carol', 'alice');
    carol.receive({ seq: 5, holder: 'carol' });
    expect(carol.held()).toBe(true);

    // Llega tarde un anuncio viejo que daba el testigo a Bob: se ignora.
    expect(carol.receive({ seq: 3, holder: 'bob' })).toBe(false);
    expect(carol.held()).toBe(true);
  });

  it('la regeneración tras una elección gana sobre el testigo perdido (Fase 5)', () => {
    const bob = new TurnToken('bob', 'alice');
    bob.receive({ seq: 4, holder: 'alice' });

    // Alice se cayó con el testigo. Tras la elección, Bob lo regenera para sí.
    const nuevo = bob.regenerate('bob');
    expect(nuevo.seq).toBeGreaterThan(4);
    expect(bob.held()).toBe(true);

    // Alice resucita y reanuncia su testigo viejo: no puede reclamarlo.
    expect(bob.receive({ seq: 4, holder: 'alice' })).toBe(false);
    expect(bob.held()).toBe(true);
  });
});
