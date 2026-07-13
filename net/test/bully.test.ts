import { describe, expect, it } from 'vitest';
import { BullyElection, type BullyMessage } from '../src/bully.js';

// Elección de líder sobre una MALLA SIMULADA: varios nodos reales de `BullyElection` conectados
// por una red de mentira, con reloj virtual. Podemos matar nodos a voluntad (sus mensajes se
// pierden y deja de latir) y comprobar la propiedad que importa:
//
//   tras la caída del líder, TODOS los supervivientes acaban señalando al MISMO líder,
//   y ese líder es el peerId más alto que sigue vivo.

class Cluster {
  private readonly nodes = new Map<string, BullyElection>();
  /** Nodos apagados: no ejecutan nada y sus mensajes se pierden. */
  private readonly dead = new Set<string>();
  /**
   * A quién cree muerto cada nodo. La detección de fallos es LOCAL: un nodo puede seguir creyendo
   * vivo a alguien que ya cayó (aún no venció su timeout). Modelarlo así es lo que hace que el
   * test valga: las elecciones ocurren sobre información incompleta y desigual.
   */
  private readonly believedDead = new Map<string, Set<string>>();
  private queue: { from: string; to: string; msg: BullyMessage }[] = [];
  /** Líder que cada nodo cree tener. */
  readonly leaderOf = new Map<string, string>();
  now = 0;

  constructor(private readonly ids: string[]) {
    for (const self of ids) {
      this.believedDead.set(self, new Set());
      const node = new BullyElection({
        self,
        aliveNodes: () =>
          this.ids.filter((p) => p !== self && !this.believedDead.get(self)!.has(p)),
        send: (to, msg) => this.queue.push({ from: self, to, msg }),
        broadcast: (msg) => {
          for (const to of this.ids) if (to !== self) this.queue.push({ from: self, to, msg });
        },
        onLeader: (leader) => this.leaderOf.set(self, leader),
        answerTimeout: 1000,
        coordinatorTimeout: 2000,
      });
      this.nodes.set(self, node);
    }
  }

  node(id: string): BullyElection {
    return this.nodes.get(id)!;
  }

  /** Todos arrancan sabiendo quién es el anfitrión, sin haber votado. */
  assume(leader: string): void {
    for (const [id, node] of this.nodes) {
      node.assume(leader);
      this.leaderOf.set(id, leader);
    }
  }

  kill(id: string): void {
    this.dead.add(id);
    this.queue = this.queue.filter((m) => m.from !== id && m.to !== id);
  }

  /** Entrega los mensajes en vuelo (los de/para nodos muertos se pierden). */
  private flush(): void {
    for (let guard = 0; this.queue.length && guard < 500; guard++) {
      const { from, to, msg } = this.queue.shift()!;
      if (this.dead.has(to) || this.dead.has(from)) continue;
      this.nodes.get(to)!.receive(from, msg, this.now);
    }
  }

  /** Avanza el reloj a saltos, entregando mensajes y venciendo temporizadores por el camino. */
  run(ms: number, step = 100): void {
    const end = this.now + ms;
    while (this.now < end) {
      this.flush();
      this.now += step;
      for (const [id, node] of this.nodes) if (!this.dead.has(id)) node.tick(this.now);
    }
    this.flush();
  }

  /** Líderes que ven los supervivientes (deberían coincidir todos). */
  survivorsLeaders(): string[] {
    return this.ids.filter((id) => !this.dead.has(id)).map((id) => this.leaderOf.get(id)!);
  }

  /** Mete un mensaje en la red como si lo hubiera difundido `from`. */
  inject(from: string, msg: BullyMessage): void {
    for (const to of this.ids) if (to !== from) this.queue.push({ from, to, msg });
  }

  /**
   * Los detectores de fallos de `who` (por defecto, todos los supervivientes) declaran caído a
   * `peerId`. Se puede declarar en unos nodos y en otros no: así se simula que unos se enteran
   * antes que otros.
   */
  noticeDown(peerId: string, who?: string[]): void {
    for (const [id, node] of this.nodes) {
      if (this.dead.has(id)) continue;
      if (who && !who.includes(id)) continue;
      this.believedDead.get(id)!.add(peerId);
      node.onPeerDown(peerId, this.now);
    }
  }
}

describe('BullyElection', () => {
  it('el nodo más alto se proclama sin esperar a nadie', () => {
    const c = new Cluster(['a', 'b', 'c', 'd']);
    c.node('d').start(0);

    expect(c.node('d').leader).toBe('d'); // no hay superiores: victoria inmediata
    c.run(500);
    expect(c.survivorsLeaders()).toEqual(['d', 'd', 'd', 'd']);
  });

  it('si cae el líder, gana el peerId más alto de los que quedan', () => {
    const c = new Cluster(['a', 'b', 'c', 'd']);
    c.assume('d');

    c.kill('d');
    c.noticeDown('d'); // los detectores de fallos declaran caído al líder

    c.run(4000);
    expect(c.survivorsLeaders()).toEqual(['c', 'c', 'c']);
    expect(c.node('c').state).toBe('idle');
  });

  it('sobrevive a una segunda caída durante la propia elección', () => {
    const c = new Cluster(['a', 'b', 'c', 'd']);
    c.assume('d');

    // Cae el líder. 'a' y 'b' lo detectan y lanzan la elección; 'c' todavía no se ha enterado,
    // así que contesta ANSWER (es superior a ambos) y ellos se callan a esperar su COORDINATOR…
    c.kill('d');
    c.noticeDown('d', ['a', 'b']);
    c.run(200, 50);
    expect(c.node('a').state).toBe('awaiting-coordinator');

    // …pero 'c' cae también, a media elección. El anuncio nunca llega. Al vencer el plazo, 'a' y
    // 'b' reabren la elección y esta vez gana 'b': el más alto de los que quedan en pie.
    c.kill('c');
    c.run(8000);
    expect(c.survivorsLeaders()).toEqual(['b', 'b']);
  });

  it('quien recibe un anuncio de alguien inferior lo desafía y acaba mandando él', () => {
    const c = new Cluster(['a', 'b', 'c']);

    // 'a' y 'b' dieron por muerto a 'c' y eligieron a 'b'. Pero 'c' solo estaba lento: sigue vivo.
    c.node('b').assume('b');
    c.leaderOf.set('b', 'b');
    c.inject('b', { b: 'coordinator', leader: 'b' });
    c.run(3000);

    // 'c' es superior: al ver el anuncio de 'b' abre elección y se impone. Los tres convergen.
    expect(c.survivorsLeaders()).toEqual(['c', 'c', 'c']);
  });

  it('la caída de un nodo cualquiera (que no es el líder) no dispara elecciones', () => {
    const c = new Cluster(['a', 'b', 'c', 'd']);
    c.assume('d');

    c.kill('a');
    c.noticeDown('a');
    c.run(4000);

    expect(c.survivorsLeaders()).toEqual(['d', 'd', 'd']); // el líder sigue siendo el mismo
    expect(c.node('b').state).toBe('idle'); // nadie se molestó en votar
  });
});
