#!/usr/bin/env node
// Validación distribuida con números. (Componente 4.5 del enunciado.)
//
// Los tests unitarios de `net/` responden "¿converge?" con un sí o un no. Aquí se responde con
// cuánto, cuántos y en cuánto tiempo: los datos que van al reporte de V&V y que permiten decir si
// el sistema mejora o empeora entre commits.
//
// Todo corre sobre una malla simulada con RELOJ VIRTUAL. Eso no es una limitación, es la única
// forma de medir bien: con relojes de verdad, "el líder se eligió en 1.400 ms" mide sobre todo lo
// ocupada que estuviera la máquina. Con reloj virtual se mide el ALGORITMO — cuántos mensajes
// necesita y cuántos milisegundos de protocolo tarda—, que es lo que se quiere comparar. Los
// tiempos de pared se miden aparte, en las pruebas de Cypress contra navegadores reales.
//
//   npm run vv:distributed

import {
  apply,
  createGame,
  makeRng,
  type CardKind,
  type GameEvent,
  type GameState,
} from '@bug/engine';
import {
  BullyElection,
  FailureDetector,
  LamportClock,
  Replica,
  TurnToken,
  compareStamped,
  stateHash,
  type BullyMessage,
  type Stamped,
} from '@bug/net';
import { guardarInforme } from '../lib/harness.mjs';

const SEED = 20260808;

interface Medicion {
  id: string;
  nombre: string;
  propiedad: string;
  criterio: string;
  cumple: boolean;
  metricas: Record<string, number | string | boolean>;
}

const mediciones: Medicion[] = [];

// --- Malla simulada -----------------------------------------------------------------------------

/**
 * Red con latencia variable y entregas fuera de orden, sobre tiempo virtual.
 *
 * No modela pérdidas a propósito: los DataChannels de WebRTC son fiables y ordenados por defecto,
 * así que fingir pérdidas mediría un sistema que no es el nuestro. Lo que sí modela es lo que de
 * verdad pasa en la malla: que dos mensajes salidos en un orden lleguen en otro (porque van por
 * caminos distintos) y que el mismo llegue varias veces (porque los relays inundan).
 */
class RedSimulada {
  private cola: { t: number; entregar: () => void; n: number }[] = [];
  private reloj = 0;
  private orden = 0;
  entregados = 0;
  duplicados = 0;

  constructor(
    private readonly rng: ReturnType<typeof makeRng>,
    private readonly latenciaMin = 5,
    private readonly latenciaMax = 120,
    /** Probabilidad de que un mensaje llegue por dos caminos (la malla inunda). */
    private readonly probDuplicado = 0.15,
  ) {}

  get ahora(): number {
    return this.reloj;
  }

  enviar(entregar: () => void): void {
    const latencia = this.latenciaMin + this.rng.int(this.latenciaMax - this.latenciaMin);
    this.cola.push({ t: this.reloj + latencia, entregar, n: this.orden++ });
    if (this.rng.int(100) < this.probDuplicado * 100) {
      const otra = this.latenciaMin + this.rng.int(this.latenciaMax - this.latenciaMin);
      this.cola.push({ t: this.reloj + otra, entregar, n: this.orden++ });
      this.duplicados++;
    }
  }

  /** Corre hasta que no queda nada por entregar. Devuelve el tiempo virtual transcurrido. */
  vaciar(): number {
    const t0 = this.reloj;
    while (this.cola.length > 0) {
      this.cola.sort((a, b) => a.t - b.t || a.n - b.n);
      const siguiente = this.cola.shift()!;
      this.reloj = Math.max(this.reloj, siguiente.t);
      this.entregados++;
      siguiente.entregar();
    }
    return this.reloj - t0;
  }

  avanzar(ms: number): void {
    this.reloj += ms;
  }
}

const jugadores = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `p${String(i).padStart(2, '0')}`, name: `J${i}` }));

const CAOS: readonly CardKind[] = ['copy_paste', 'reboot', 'coffee_spill', 'trojan'];

const valido = (state: GameState, event: GameEvent): boolean => {
  try {
    apply(state, event);
    return true;
  } catch {
    return false;
  }
};

/** Bot determinista: primera carta legal, y si no hay, roba. */
function jugada(state: GameState): GameEvent | null {
  const p = state.players[state.turn]!;
  for (const carta of p.hand) {
    if (CAOS.includes(carta.kind)) continue;
    const e: GameEvent = { type: 'PLAY', playerId: p.id, cardId: carta.id, chosenColor: 'code' };
    if (valido(state, e)) return e;
  }
  const robar: GameEvent = { type: 'DRAW', playerId: p.id };
  return valido(state, robar) ? robar : null;
}

const actor = (e: GameEvent): string => (e.type === 'CALL_BUG' ? e.accuserId : e.playerId);

/** Una partida completa, sellada con Lamport, para usar como carga de trabajo. */
function partida(nJugadores: number, maxEventos = 120): Stamped<GameEvent>[] {
  let estado = createGame(SEED, jugadores(nJugadores));
  const log: Stamped<GameEvent>[] = [];
  let lamport = 0;
  while (!estado.finished && log.length < maxEventos) {
    const e = jugada(estado);
    if (!e) break;
    estado = apply(estado, e);
    log.push({ lamport: ++lamport, origin: actor(e), event: e });
  }
  return log;
}

const nuevaReplica = (n: number) =>
  new Replica<GameState, GameEvent>({ initial: createGame(SEED, jugadores(n)), apply });

/**
 * Una réplica que además cuenta cuántas veces ha tenido que aplicar el reductor. Es la medida del
 * trabajo real del *rollback & replay*: un evento que llega tarde obliga a recalcular desde él
 * hasta el final del log, así que la cuenta crece con el desorden, no con el número de eventos.
 *
 * Se cuenta en vez de cronometrar porque el reloj mide la máquina —lo que haya de fondo, el JIT,
 * el turno del planificador— y esta cuenta mide el algoritmo: sale idéntica en un portátil cargado
 * y en el agente de Jenkins.
 */
function replicaContada(n: number): { replica: Replica<GameState, GameEvent>; aplicaciones: () => number } {
  let veces = 0;
  const contado = (s: GameState, e: GameEvent): GameState => {
    veces++;
    return apply(s, e);
  };
  return {
    replica: new Replica<GameState, GameEvent>({ initial: createGame(SEED, jugadores(n)), apply: contado }),
    aplicaciones: () => veces,
  };
}

// --- D1: convergencia con la red revuelta -------------------------------------------------------

function d1(): void {
  const tamanos = [3, 5, 10];
  const detalle: Record<string, number | string | boolean> = {};
  let todosConvergen = true;

  for (const n of tamanos) {
    const log = partida(n);
    const rng = makeRng(SEED + n);
    const red = new RedSimulada(rng);
    const replicas = Array.from({ length: n }, () => nuevaReplica(n));

    // Cada evento se difunde a todos los nodos: llega cuando llega, y a veces dos veces.
    const t0 = process.hrtime.bigint();
    for (const sellado of log) {
      for (const r of replicas) red.enviar(() => r.deliver(sellado));
    }
    const msVirtuales = red.vaciar();
    const msCpu = Number(process.hrtime.bigint() - t0) / 1e6;

    const huellas = new Set(replicas.map((r) => stateHash(r.state)));
    const convergen = huellas.size === 1;
    todosConvergen &&= convergen;

    // El oráculo: el mismo log aplicado en orden, sin red de por medio.
    const oraculo = log.reduce((s, st) => apply(s, st.event), createGame(SEED, jugadores(n)));
    const correcto = stateHash(replicas[0]!.state) === stateHash(oraculo);
    todosConvergen &&= correcto;

    detalle[`nodos_${n}_eventos`] = log.length;
    detalle[`nodos_${n}_entregas`] = red.entregados;
    detalle[`nodos_${n}_duplicados`] = red.duplicados;
    detalle[`nodos_${n}_convergen`] = convergen;
    detalle[`nodos_${n}_igual_al_oraculo`] = correcto;
    detalle[`nodos_${n}_ms_virtuales`] = msVirtuales;
    detalle[`nodos_${n}_ms_cpu`] = Number(msCpu.toFixed(1));
  }

  mediciones.push({
    id: 'D1',
    nombre: 'Convergencia de réplicas con la red revuelta',
    propiedad: 'Consistencia (todos los nodos acaban en el mismo estado)',
    criterio:
      'Con 3, 5 y 10 nodos, latencias de 5-120 ms y entregas duplicadas, todas las réplicas ' +
      'terminan con la misma huella de estado, y esa huella coincide con aplicar el log en orden.',
    cumple: todosConvergen,
    metricas: detalle,
  });
}

// --- D2: orden causal (Lamport) -----------------------------------------------------------------

function d2(): void {
  const log = partida(3, 40);
  const t = log[log.length - 1]!.lamport + 1;

  // Tres jugadores acusan a la vez: mismo sello, sin relación causal entre ellos. Es el caso que
  // obliga a tener un criterio de desempate — sin él, cada nodo los ordenaría como le llegaron.
  const concurrentes: Stamped<GameEvent>[] = ['p02', 'p00', 'p01'].map((quien) => ({
    lamport: t,
    origin: quien,
    event: { type: 'CALL_BUG', accuserId: quien, accusedId: 'p00' } as GameEvent,
  }));

  const rng = makeRng(SEED);
  const ordenes: string[][] = [];
  const huellas = new Set<string>();

  for (let intento = 0; intento < 12; intento++) {
    const r = nuevaReplica(3);
    const revuelto = [...concurrentes].sort(() => rng.int(3) - 1);
    for (const s of [...log, ...revuelto]) r.deliver(s);
    ordenes.push(r.events.slice(-3).map((e) => e.origin));
    huellas.add(stateHash(r.state));
  }

  const primero = JSON.stringify(ordenes[0]);
  const mismoOrden = ordenes.every((o) => JSON.stringify(o) === primero);

  // Y el reloj de Lamport tiene que cumplir su propiedad: si a → b, entonces L(a) < L(b).
  const reloj = new LamportClock();
  const a = reloj.tick();
  reloj.update(50); // llega un mensaje de un nodo más adelantado
  const b = reloj.tick();
  const causalidad = a < b && b > 50;

  mediciones.push({
    id: 'D2',
    nombre: 'Orden total de eventos concurrentes (Lamport + desempate)',
    propiedad: 'Ordenamiento causal',
    criterio:
      'Tres eventos con el mismo sello de Lamport, entregados en 12 órdenes distintos, quedan ' +
      'en la misma secuencia y producen el mismo estado en todos los nodos.',
    cumple: mismoOrden && huellas.size === 1 && causalidad,
    metricas: {
      ordenesProbados: ordenes.length,
      secuenciaAcordada: primero,
      huellasDistintas: huellas.size,
      relojRespetaCausalidad: causalidad,
    },
  });
}

// --- D3: exclusión mutua (el testigo de turno) --------------------------------------------------

function d3(): void {
  const n = 5;
  const ids = jugadores(n).map((p) => p.id);
  const testigos = ids.map((id) => new TurnToken(id, ids[0]!));

  let vecesConDosPoseedores = 0;
  let cesiones = 0;
  let rezagadosDescartados = 0;

  const rng = makeRng(SEED);
  for (let ronda = 0; ronda < 200; ronda++) {
    // Invariante: en cada instante hay exactamente UN nodo que se cree con el testigo.
    const conTestigo = testigos.filter((t) => t.held()).length;
    if (conTestigo !== 1) vecesConDosPoseedores++;

    const poseedor = testigos.find((t) => t.held())!;
    const siguiente = ids[(ids.indexOf(poseedor.holder) + 1) % n]!;
    const anuncio = poseedor.passTo(siguiente);
    if (!anuncio) continue;
    cesiones++;

    // El anuncio llega a todos… y a algunos les llega también uno viejo, rezagado por la red.
    for (const t of testigos) {
      if (t === poseedor) continue;
      if (rng.int(100) < 30) {
        const viejo = { seq: Math.max(0, anuncio.seq - 2), holder: ids[rng.int(n)]! };
        if (!t.receive(viejo)) rezagadosDescartados++;
      }
      t.receive(anuncio);
    }
  }

  // Un nodo que NO tiene el testigo no puede cederlo: no se regala lo que no se tiene.
  const impostor = testigos.find((t) => !t.held())!;
  const intentoIlegitimo = impostor.passTo(ids[0]!);

  mediciones.push({
    id: 'D3',
    nombre: 'Exclusión mutua sobre el turno (testigo con secuencia)',
    propiedad: 'Exclusión mutua',
    criterio:
      'En 200 cesiones sobre 5 nodos, nunca hay dos que se crean con el testigo, los anuncios ' +
      'rezagados se descartan por su número de secuencia, y quien no lo tiene no puede cederlo.',
    cumple: vecesConDosPoseedores === 0 && intentoIlegitimo === null && rezagadosDescartados > 0,
    metricas: {
      cesiones,
      instantesConPoseedorUnico: 200 - vecesConDosPoseedores,
      violacionesDeExclusionMutua: vecesConDosPoseedores,
      anunciosRezagadosDescartados: rezagadosDescartados,
      cesionSinTestigoRechazada: intentoIlegitimo === null,
    },
  });
}

// --- D4: detección de fallos --------------------------------------------------------------------

function d4(): void {
  const detector = new FailureDetector({
    self: 'p00',
    interval: 1000,
    suspectAfter: 2500,
    downAfter: 6000,
  });
  const ids = jugadores(4).map((p) => p.id);
  let t = 0;
  for (const id of ids) if (id !== 'p00') detector.watch(id, t);

  // Todos laten con normalidad durante diez segundos.
  for (; t <= 10_000; t += 500) {
    for (const id of ids) if (id !== 'p00') detector.beat(id, t);
    detector.sweep(t);
  }
  const sanosAlPrincipio = detector.alive().length;

  // A `p03` se le cae el WiFi: deja de latir. Los demás siguen.
  //
  // El silencio se cuenta desde su ÚLTIMO LATIDO, no desde que empieza este bucle: son dos
  // instantes distintos y confundirlos hacía que la medición saliera medio segundo corta, que es
  // exactamente el paso del bucle de arriba.
  const caida = t - 500;
  let tSospecha = -1;
  let tCaido = -1;
  for (; t <= caida + 12_000; t += 100) {
    for (const id of ids) if (id !== 'p00' && id !== 'p03') detector.beat(id, t);
    for (const cambio of detector.sweep(t)) {
      if (cambio.peerId !== 'p03') continue;
      if (cambio.to === 'suspect' && tSospecha < 0) tSospecha = t - caida;
      if (cambio.to === 'down' && tCaido < 0) tCaido = t - caida;
    }
  }

  // Vuelve: el detector tiene que readmitirlo, no guardarle rencor.
  const cambio = detector.beat('p03', t);
  const readmitido = cambio?.to === 'alive';

  // Y el nodo no se declara muerto a sí mismo por no mandarse latidos.
  const noSeMataSolo = !detector.down().includes('p00');

  mediciones.push({
    id: 'D4',
    nombre: 'Detección de caídas por latidos (dos escalones)',
    propiedad: 'Tolerancia a fallos — detección',
    criterio:
      'Un nodo que deja de latir pasa a sospechoso al superar 2,5 s de silencio y a caído al ' +
      'superar 6 s; al volver se readmite; ningún nodo se declara caído a sí mismo.',
    cumple:
      tSospecha > 2400 &&
      tSospecha < 3600 &&
      tCaido > 5900 &&
      tCaido < 7100 &&
      readmitido &&
      noSeMataSolo &&
      sanosAlPrincipio === 3,
    metricas: {
      vigilados: 3,
      msHastaSospechoso: tSospecha,
      msHastaCaido: tCaido,
      umbralSospechoso: 2500,
      umbralCaido: 6000,
      readmitidoAlVolver: readmitido,
      noSeDeclaraCaidoASiMismo: noSeMataSolo,
    },
  });
}

// --- D5: elección de líder (Bully) --------------------------------------------------------------

interface NodoBully {
  id: string;
  bully: BullyElection;
  vivo: boolean;
  lider: string | null;
}

function d5(): void {
  const detalle: Record<string, number | string | boolean> = {};
  let todoBien = true;

  for (const n of [3, 5, 10]) {
    const ids = jugadores(n).map((p) => p.id);
    const nodos = new Map<string, NodoBully>();
    let mensajes = 0;
    let reloj = 0;

    // Los mensajes se entregan en el acto (el coste que se mide aquí es el del PROTOCOLO: cuántos
    // mensajes y cuántos tiempos de espera necesita), y las esperas se simulan avanzando el reloj.
    const entregar = (de: string, a: string, msg: BullyMessage): void => {
      mensajes++;
      const destino = nodos.get(a);
      if (!destino?.vivo) return;
      destino.bully.receive(de, msg, reloj);
    };

    for (const id of ids) {
      const nodo: NodoBully = { id, bully: null as unknown as BullyElection, vivo: true, lider: null };
      nodo.bully = new BullyElection({
        self: id,
        aliveNodes: () => ids.filter((o) => o !== id && nodos.get(o)?.vivo !== false),
        send: (a, msg) => entregar(id, a, msg),
        broadcast: (msg) => ids.filter((o) => o !== id).forEach((o) => entregar(id, o, msg)),
        onLeader: (l) => {
          nodo.lider = l;
        },
      });
      nodos.set(id, nodo);
    }

    // Arranque: el mayor se proclama.
    const mayor = ids[ids.length - 1]!;
    for (const nodo of nodos.values()) nodo.bully.assume(mayor);

    // Se cae el líder. Todos los demás lo notan y abren elección.
    nodos.get(mayor)!.vivo = false;
    const t0 = reloj;
    for (const nodo of nodos.values()) if (nodo.vivo) nodo.bully.start(reloj);
    // Los tiempos de espera del algoritmo (nadie superior contesta → me proclamo).
    for (let paso = 0; paso < 12; paso++) {
      reloj += 500;
      for (const nodo of nodos.values()) if (nodo.vivo) nodo.bully.tick(reloj);
    }
    const msPrimera = reloj - t0;

    const vivos = [...nodos.values()].filter((x) => x.vivo);
    const esperado = ids[ids.length - 2]!; // el siguiente mayor
    const acuerdo = vivos.every((x) => x.lider === esperado);
    todoBien &&= acuerdo;

    // Y ahora el caso feo: el favorito se cae A MEDIA elección. La elección tiene que reabrirse
    // sola, o la partida se queda sin coordinador para siempre.
    nodos.get(esperado)!.vivo = false;
    const t1 = reloj;
    for (const nodo of nodos.values()) if (nodo.vivo) nodo.bully.start(reloj);
    for (let paso = 0; paso < 20; paso++) {
      reloj += 500;
      for (const nodo of nodos.values()) if (nodo.vivo) nodo.bully.tick(reloj);
    }
    const msSegunda = reloj - t1;
    const vivos2 = [...nodos.values()].filter((x) => x.vivo);
    const esperado2 = ids[ids.length - 3]!;
    const acuerdo2 = vivos2.every((x) => x.lider === esperado2);
    todoBien &&= acuerdo2;

    detalle[`nodos_${n}_mensajes`] = mensajes;
    detalle[`nodos_${n}_ms_eleccion`] = msPrimera;
    detalle[`nodos_${n}_lider`] = esperado;
    detalle[`nodos_${n}_acuerdo_unanime`] = acuerdo;
    detalle[`nodos_${n}_ms_reeleccion`] = msSegunda;
    detalle[`nodos_${n}_acuerdo_tras_doble_caida`] = acuerdo2;
  }

  mediciones.push({
    id: 'D5',
    nombre: 'Elección de líder con el algoritmo del matón (Bully)',
    propiedad: 'Tolerancia a fallos — reconfiguración dinámica',
    criterio:
      'Al caer el líder, los nodos vivos acuerdan por unanimidad el siguiente peerId mayor. Si ' +
      'el favorito se cae a media elección, esta se reabre y vuelven a acordar, sin quedarse sin ' +
      'coordinador.',
    cumple: todoBien,
    metricas: detalle,
  });
}

// --- D6: recuperación de un nodo desviado -------------------------------------------------------

function d6(): void {
  const n = 3;
  const log = partida(n);
  const sanos = [nuevaReplica(n), nuevaReplica(n)];
  for (const r of sanos) for (const s of log) r.deliver(s);

  // El tercero se perdió un trozo de la partida (entró tarde, o se le cayó la red).
  const rezagado = nuevaReplica(n);
  for (const s of log.slice(0, Math.floor(log.length / 2))) rezagado.deliver(s);

  const huellaSana = stateHash(sanos[0]!.state);
  const divergiaAntes = stateHash(rezagado.state) !== huellaSana;

  // Primer intento: completarle el log. Es lo que se hacía, y no basta si su propio log tiene
  // algo que los demás no tienen — por eso existe `adopt`.
  for (const s of log) rezagado.deliver(s);
  const bastaCompletar = stateHash(rezagado.state) === huellaSana;

  // Caso duro: un nodo con un evento que nadie más tiene.
  //
  // Se fabrica jugando de verdad desde su propio estado a media partida, para que sea una jugada
  // LEGAL en esa posición: un evento que el motor rechace no serviría de nada aquí, porque un
  // evento rechazado entra en el log pero no cambia el estado, y lo que se quiere reproducir es
  // una divergencia real. Es lo que pasa cuando un nodo emite una jugada y la malla se parte
  // antes de que llegue a los demás.
  const corrupto = nuevaReplica(n);
  for (const s of log) corrupto.deliver(s);
  const fantasma = jugada(corrupto.state)!;
  corrupto.deliver({
    lamport: log[log.length - 1]!.lamport + 1,
    origin: actor(fantasma),
    event: fantasma,
  });
  const corruptoDivergia = stateHash(corrupto.state) !== huellaSana;
  // Completar el log no le arregla nada: le sobra un evento, no le falta.
  for (const s of sanos[0]!.events) corrupto.deliver(s);
  const completarNoBasta = stateHash(corrupto.state) !== huellaSana;
  corrupto.adopt(sanos[0]!.events);
  const reparado = stateHash(corrupto.state) === huellaSana;

  mediciones.push({
    id: 'D6',
    nombre: 'Recuperación de un nodo desviado',
    propiedad: 'Tolerancia a fallos — recuperación',
    criterio:
      'Un nodo que se perdió media partida converge al recibir el log completo. Un nodo con un ' +
      'evento que nadie más tiene no converge completando el log —hay que adoptar el ajeno— y ' +
      'tras adoptarlo su huella coincide con la de la mesa.',
    cumple: divergiaAntes && bastaCompletar && corruptoDivergia && completarNoBasta && reparado,
    metricas: {
      eventosDeLaPartida: log.length,
      eventosQueLeFaltaban: log.length - Math.floor(log.length / 2),
      rezagadoDivergiaAntes: divergiaAntes,
      rezagadoConvergeAlCompletarLog: bastaCompletar,
      corruptoDivergia,
      corruptoSigueDivergiendoTrasCompletarLog: completarNoBasta,
      corruptoConvergeAlAdoptar: reparado,
    },
  });
}

// --- D7: coste de la convergencia según el tamaño de la malla -----------------------------------

function d7(): void {
  const detalle: Record<string, number | string | boolean> = {};
  let escalaBien = true;

  for (const n of [3, 5, 10]) {
    const log = partida(n);
    // Difusión completa: cada evento va de su origen a los otros n-1 nodos.
    const mensajesMalla = log.length * (n - 1);
    // Lo que habría costado con un servidor de partida: cliente → servidor → n-1 clientes.
    const mensajesServidor = log.length * n;

    const t1 = process.hrtime.bigint();
    const { replica: enOrden, aplicaciones: aplicacionesEnOrden } = replicaContada(n);
    for (const s of log) enOrden.deliver(s);
    const msEnOrden = Number(process.hrtime.bigint() - t1) / 1e6;

    // Caso realista: el desorden que produce la malla de verdad (latencias distintas por camino),
    // que es de unos pocos puestos, no una inversión.
    const rng = makeRng(SEED + n);
    const casiEnOrden = [...log];
    for (let i = 0; i < casiEnOrden.length - 1; i++) {
      if (rng.int(100) < 25) {
        const j = Math.min(casiEnOrden.length - 1, i + 1 + rng.int(3));
        [casiEnOrden[i], casiEnOrden[j]] = [casiEnOrden[j]!, casiEnOrden[i]!];
      }
    }
    const t2 = process.hrtime.bigint();
    const { replica: realista, aplicaciones: aplicacionesRealista } = replicaContada(n);
    for (const s of casiEnOrden) realista.deliver(s);
    const msRealista = Number(process.hrtime.bigint() - t2) / 1e6;

    // Cota superior: el log entero al revés. La malla no produce esto nunca —haría falta que
    // TODOS los mensajes adelantaran a TODOS los anteriores—, pero pone precio al peor caso del
    // rollback & replay: cada entrega obliga a recalcular la partida desde el principio.
    const t3 = process.hrtime.bigint();
    const { replica: alReves, aplicaciones: aplicacionesAlReves } = replicaContada(n);
    for (const s of [...log].reverse()) alReves.deliver(s);
    const msAlReves = Number(process.hrtime.bigint() - t3) / 1e6;

    const huella = stateHash(enOrden.state);
    const iguales = stateHash(realista.state) === huella && stateHash(alReves.state) === huella;

    // Trabajo de replay, normalizado: cuántas veces se aplica el reductor por evento recibido.
    // En orden natural vale 1 (cada evento se aplica una vez y no se deshace nada). El desorden de
    // la malla lo multiplica, y la cota del log invertido enseña hasta dónde podría llegar.
    const factorRealista = aplicacionesRealista() / aplicacionesEnOrden();
    escalaBien &&= iguales && factorRealista <= 30;

    detalle[`nodos_${n}_eventos`] = log.length;
    detalle[`nodos_${n}_mensajes_malla`] = mensajesMalla;
    detalle[`nodos_${n}_mensajes_si_hubiera_servidor`] = mensajesServidor;
    detalle[`nodos_${n}_aplicaciones_en_orden`] = aplicacionesEnOrden();
    detalle[`nodos_${n}_aplicaciones_desorden_realista`] = aplicacionesRealista();
    detalle[`nodos_${n}_aplicaciones_cota_log_invertido`] = aplicacionesAlReves();
    detalle[`nodos_${n}_factor_replay_realista`] = Number(factorRealista.toFixed(2));
    detalle[`nodos_${n}_ms_en_orden`] = Number(msEnOrden.toFixed(1));
    detalle[`nodos_${n}_ms_desorden_realista`] = Number(msRealista.toFixed(1));
    detalle[`nodos_${n}_ms_cota_log_invertido`] = Number(msAlReves.toFixed(1));
    detalle[`nodos_${n}_mismo_estado_en_los_tres`] = iguales;
  }

  mediciones.push({
    id: 'D7',
    nombre: 'Coste de la replicación (mensajes y tiempo de recálculo)',
    propiedad: 'Rendimiento / latencia',
    criterio:
      'Los tres órdenes de entrega (natural, desorden realista de la malla y log invertido) ' +
      'convergen al mismo estado, y el desorden realista no multiplica por más de 30 el trabajo ' +
      'del reductor. Los tiempos se anotan como medición de latencia, no como criterio: el reloj ' +
      'de pared mide la máquina que ejecuta el banco, no el algoritmo. El log invertido es la ' +
      'cota superior del rollback & replay, y no se le exige nada: la red no lo produce.',
    cumple: escalaBien,
    metricas: detalle,
  });
}

// --- Ejecución ----------------------------------------------------------------------------------

function main(): void {
  console.log('— Validación distribuida de Bug —\n');
  for (const medir of [d1, d2, d3, d4, d5, d6, d7]) medir();

  for (const m of mediciones) {
    console.log(`${m.id}  ${m.nombre}`);
    console.log(`    ${m.propiedad} — ${m.cumple ? 'CUMPLE' : '⚠️  NO CUMPLE'}`);
    for (const [k, v] of Object.entries(m.metricas)) console.log(`      ${k}: ${v}`);
    console.log();
  }

  const fallan = mediciones.filter((m) => !m.cumple);
  const informe = {
    suite: 'validación-distribuida',
    fecha: new Date().toISOString(),
    total: mediciones.length,
    cumplen: mediciones.length - fallan.length,
    mediciones,
  };
  const ruta = guardarInforme('distribuida', informe);

  console.log(`${informe.cumplen}/${informe.total} propiedades verificadas`);
  console.log(`informe: ${ruta}`);
  process.exit(fallan.length > 0 ? 1 : 0);
}

main();
