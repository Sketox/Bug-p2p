#!/usr/bin/env node
// Banco de ataques contra el servidor de señalización de Bug.
//
// Es la parte automatizada del bloque de seguridad de V&V. Lo que se hace aquí a mano con Burp
// Suite (interceptar el WebSocket, editar el mensaje, reenviarlo) queda aquí escrito para que se
// repita solo en cada commit: la gracia de un hallazgo de seguridad no es encontrarlo una vez, es
// que nadie pueda volver a introducirlo sin que el pipeline se ponga rojo.
//
// La correspondencia con Burp está en `vv/security/burp.md`, prueba por prueba.
//
//   node vv/security/attack-suite.mjs
//
// Sale con código 1 si algún ataque de severidad alta o crítica CONSIGUE lo que buscaba.

import { startSignaling, Cliente, sleep, guardarInforme } from '../lib/harness.mjs';
import WebSocket from 'ws';

const AFORO = 10; // el del servidor (signaling/src/server.ts)

const pruebas = [];

/**
 * Vuelve a levantar la señalización sobre el mismo objeto `srv`.
 *
 * Hace falta porque parte de la gracia del banco es tumbar el servidor: si una prueba lo mata, las
 * siguientes tienen que poder seguir corriendo contra uno vivo (y con una URL nueva, porque el
 * puerto se elige libre en cada arranque).
 */
async function relanzar(srv) {
  await srv.stop();
  Object.assign(srv, await startSignaling());
}

/**
 * Declara un ataque. `comprobar` devuelve `{ bloqueado, observado, detalle? }`:
 *   bloqueado = true  → el sistema resistió (la prueba PASA)
 *   bloqueado = false → el ataque funcionó (la prueba FALLA)
 */
function ataque(id, nombre, { categoria, severidad, objetivo, comprobar }) {
  pruebas.push({ id, nombre, categoria, severidad, objetivo, comprobar });
}

// --- S1 ----------------------------------------------------------------------------------------
ataque('S1', 'Suplantación del emisor en una señal WebRTC', {
  categoria: 'Spoofing',
  severidad: 'alta',
  objetivo:
    'Mallory está en la sala y manda una oferta SDP diciendo que viene de Alice. Si Bob la ' +
    'acepta, Mallory se coloca en medio del canal cifrado que Bob creía tener con Alice.',
  async comprobar(srv) {
    const sala = 'S1';
    const alice = await Cliente.abrir(srv.url, 'alice');
    alice.enviar({ t: 'join', room: sala, peerId: 'alice', name: 'Alice' });
    const bob = await Cliente.abrir(srv.url, 'bob');
    bob.enviar({ t: 'join', room: sala, peerId: 'bob', name: 'Bob' });
    const mallory = await Cliente.abrir(srv.url, 'mallory');
    mallory.enviar({ t: 'join', room: sala, peerId: 'mallory', name: 'Mallory' });
    await sleep(200);

    mallory.enviar({
      t: 'signal',
      room: sala,
      from: 'alice', // ← la mentira
      to: 'bob',
      data: { kind: 'offer', sdp: 'v=0 SDP-DE-MALLORY' },
    });

    const colada = await bob.espera(
      (m) => m.t === 'signal' && m.from === 'alice' && String(m.data?.sdp ?? '').includes('MALLORY'),
      1200,
    );
    [alice, bob, mallory].forEach((c) => c.cerrar());

    return {
      bloqueado: !colada,
      observado: colada
        ? 'Bob recibió una oferta SDP atribuida a Alice que en realidad envió Mallory.'
        : 'El servidor descartó la señal con emisor falsificado.',
    };
  },
});

// --- S2 ----------------------------------------------------------------------------------------
ataque('S2', 'Inyección de señales sin pertenecer a la sala', {
  categoria: 'Control de acceso',
  severidad: 'alta',
  objetivo:
    'Un cliente que nunca hizo `join` envía señales a una sala ajena. Con el código de sala ' +
    '(cuatro letras: se ve en la pantalla de quien juega, y se puede adivinar) bastaría para ' +
    'interferir en una partida desde fuera.',
  async comprobar(srv) {
    const sala = 'S2';
    const bob = await Cliente.abrir(srv.url, 'bob');
    bob.enviar({ t: 'join', room: sala, peerId: 'bob', name: 'Bob' });
    await sleep(150);

    const forastero = await Cliente.abrir(srv.url, 'forastero');
    forastero.enviar({
      t: 'signal',
      room: sala,
      from: 'forastero',
      to: 'bob',
      data: { kind: 'offer', sdp: 'v=0 DESDE-FUERA' },
    });

    const colada = await bob.espera(
      (m) => m.t === 'signal' && String(m.data?.sdp ?? '').includes('DESDE-FUERA'),
      1200,
    );
    [bob, forastero].forEach((c) => c.cerrar());

    return {
      bloqueado: !colada,
      observado: colada
        ? 'El servidor reenvió una señal de alguien que no está en la sala.'
        : 'El servidor exige pertenecer a la sala para enviar señales.',
    };
  },
});

// --- S3 ----------------------------------------------------------------------------------------
ataque('S3', 'Secuestro de plaza: `join` con el peerId de otro', {
  categoria: 'Spoofing / DoS dirigido',
  severidad: 'crítica',
  objetivo:
    'El servidor desaloja la sesión anterior cuando vuelve un peerId conocido — así funciona la ' +
    'reconexión tras un F5. Si cualquiera puede afirmar ser Alice, ese mecanismo se convierte en ' +
    'un botón para echar a Alice de su propia partida y ocupar su sitio.',
  async comprobar(srv) {
    const sala = 'S3';
    const alice = await Cliente.abrir(srv.url, 'alice');
    alice.enviar({
      t: 'join',
      room: sala,
      peerId: 'alice',
      name: 'Alice',
      epoch: 'e1',
      secret: 'el-secreto-de-alice',
    });
    await sleep(200);

    // Dos formas de intentarlo: inventándose un secreto, y no mandando ninguno (que es como se
    // colaría un cliente al que le quitaran esa parte del protocolo).
    const conSecretoFalso = await Cliente.abrir(srv.url, 'mallory1');
    conSecretoFalso.enviar({
      t: 'join',
      room: sala,
      peerId: 'alice',
      name: 'Alice',
      epoch: 'e2',
      secret: 'me-lo-invento',
    });
    const sinSecreto = await Cliente.abrir(srv.url, 'mallory2');
    sinSecreto.enviar({ t: 'join', room: sala, peerId: 'alice', name: 'Alice', epoch: 'e3' });
    await sleep(600);

    const expulsada = alice.cerrado;
    const rechazados = [conSecretoFalso, sinSecreto].filter((c) =>
      Boolean(c.recibidos.find((m) => m.t === 'error') || c.cerrado),
    ).length;

    // Y la reconexión legítima tiene que seguir funcionando: Alice recarga y vuelve con su secreto.
    const aliceVuelve = await Cliente.abrir(srv.url, 'alice-f5');
    aliceVuelve.enviar({
      t: 'join',
      room: sala,
      peerId: 'alice',
      name: 'Alice',
      epoch: 'e4',
      secret: 'el-secreto-de-alice',
    });
    const readmitida = await aliceVuelve.espera((m) => m.t === 'peers', 1500);
    [alice, conSecretoFalso, sinSecreto, aliceVuelve].forEach((c) => c.cerrar());

    return {
      bloqueado: !expulsada && rechazados === 2 && Boolean(readmitida),
      observado: expulsada
        ? 'La conexión legítima de Alice fue cerrada por un tercero que dijo llamarse Alice.'
        : rechazados < 2
          ? `Solo ${rechazados} de 2 impostores fueron rechazados.`
          : readmitida
            ? 'Los dos impostores fueron rechazados y Alice recuperó su sitio con su secreto.'
            : 'Los impostores fueron rechazados, pero Alice ya no puede volver tras un F5.',
      detalle: { impostoresRechazados: rechazados, reconexionLegitima: Boolean(readmitida) },
    };
  },
});

// --- S4 ----------------------------------------------------------------------------------------
ataque('S4', 'Replay de una oferta de handshake', {
  categoria: 'Replay',
  severidad: 'media',
  objetivo:
    'Reenviar 20 veces la misma oferta capturada. Aplicar dos veces una oferta rompe el estado ' +
    'de la conexión WebRTC del que la recibe, así que repetirla es una forma barata de impedir ' +
    'que dos jugadores lleguen a conectarse.',
  async comprobar(srv) {
    const sala = 'S4';
    const alice = await Cliente.abrir(srv.url, 'alice');
    alice.enviar({ t: 'join', room: sala, peerId: 'alice', name: 'Alice' });
    const bob = await Cliente.abrir(srv.url, 'bob');
    bob.enviar({ t: 'join', room: sala, peerId: 'bob', name: 'Bob' });
    await sleep(200);

    const oferta = {
      t: 'signal',
      room: sala,
      from: 'alice',
      to: 'bob',
      data: { kind: 'offer', sdp: 'v=0 OFERTA-REPETIDA' },
    };
    for (let i = 0; i < 20; i++) alice.enviar(oferta);
    await sleep(500);

    const copias = bob
      .de('signal')
      .filter((m) => String(m.data?.sdp ?? '').includes('OFERTA-REPETIDA')).length;
    [alice, bob].forEach((c) => c.cerrar());

    return {
      bloqueado: copias <= 1,
      observado: `A Bob le llegaron ${copias} copias de la misma oferta.`,
      detalle: { copias },
    };
  },
});

// --- S5 ----------------------------------------------------------------------------------------
ataque('S5', 'Inundación de mensajes desde una conexión', {
  categoria: 'Flooding / DoS',
  severidad: 'alta',
  objetivo:
    '20.000 mensajes tan rápido como el socket admita. Lo que se mide no es que el servidor no ' +
    'sude, sino que un jugador legítimo pueda seguir entrando a la sala mientras dura la ' +
    'inundación, y que el proceso siga en pie al terminar.',
  async comprobar(srv) {
    const sala = 'S5';
    const victima = await Cliente.abrir(srv.url, 'victima');
    victima.enviar({ t: 'join', room: sala, peerId: 'victima', name: 'Víctima' });
    await sleep(150);

    const atacante = await Cliente.abrir(srv.url, 'flood');
    atacante.enviar({ t: 'join', room: sala, peerId: 'flood', name: 'Flood' });
    await sleep(100);

    const basura = JSON.stringify({
      t: 'signal',
      room: sala,
      from: 'flood',
      to: 'victima',
      data: { kind: 'ice', candidate: { candidate: 'x'.repeat(400) } },
    });
    const t0 = Date.now();
    for (let i = 0; i < 20_000; i++) atacante.enviar(basura);

    // Mientras la avalancha se procesa, ¿puede entrar alguien nuevo?
    const tEntrada = Date.now();
    const legitimo = await Cliente.abrir(srv.url, 'legitimo');
    legitimo.enviar({ t: 'join', room: sala, peerId: 'legitimo', name: 'Legítimo' });
    const atendido = await legitimo.espera((m) => m.t === 'peers', 10_000);
    const msEntrada = Date.now() - tEntrada;

    const cortado = atacante.cerrado;
    const enPie = await srv.vivo();
    [victima, atacante, legitimo].forEach((c) => c.cerrar());

    return {
      // Resistir es: seguir en pie Y atender al legítimo en un tiempo usable.
      bloqueado: enPie && Boolean(atendido) && msEntrada < 3000,
      observado: !enPie
        ? 'El servidor dejó de responder a /health durante la inundación.'
        : !atendido
          ? 'Un jugador legítimo no llegó a ser atendido mientras duraba la inundación.'
          : `Jugador legítimo atendido en ${msEntrada} ms; el inundador ${cortado ? 'fue desconectado' : 'siguió conectado'}.`,
      detalle: {
        msEntradaLegitimo: msEntrada,
        msInundacion: Date.now() - t0,
        inundadorDesconectado: cortado,
        servidorEnPie: enPie,
      },
    };
  },
});

// --- S6 ----------------------------------------------------------------------------------------
ataque('S6', 'Agotamiento de memoria creando salas', {
  categoria: 'Flooding / DoS',
  severidad: 'media',
  objetivo:
    'Una máquina intenta abrir 3.000 conexiones, cada una con su sala. El servidor guarda un Map ' +
    'por sala; si nada lo limita, mantenerlas vivas es gratis para el atacante y caro para el ' +
    'anfitrión (que en este proyecto es el portátil de un jugador, no un centro de datos). Lo ' +
    'que se exige no es que el atacante falle, sino que el daño se quede en SU cuota: los demás ' +
    'tienen que poder seguir jugando y entrando.',
  async comprobar(srv) {
    const conexiones = [];
    const N = 3000;
    // El atacante sale por una dirección propia (127.0.0.3), y la víctima por la de siempre. Sin
    // esa separación la prueba no distingue "el servidor aguanta" de "el servidor se ahoga",
    // porque el atacante estaría gastando también la cuota del que mide.
    const DESDE = { localAddress: '127.0.0.3' };
    let aceptadas = 0;
    let rechazadas = 0;
    for (let tanda = 0; tanda < N / 250; tanda++) {
      for (let i = 0; i < 250; i++) {
        const n = tanda * 250 + i;
        const c = new WebSocket(srv.url, DESDE);
        c.on('error', () => rechazadas++);
        c.once('open', () => {
          c.send(JSON.stringify({ t: 'join', room: `X${n}`, peerId: `p${n}`, name: 'x' }));
          aceptadas++;
        });
        conexiones.push(c);
      }
      await sleep(120);
    }
    await sleep(600);

    // ¿Sigue sirviendo a un jugador normal mientras dura el asedio?
    const t0 = Date.now();
    let atendido = null;
    let normal = null;
    try {
      normal = await Cliente.abrir(srv.url, 'normal');
      normal.enviar({ t: 'join', room: 'S6', peerId: 'normal', name: 'Normal' });
      atendido = await normal.espera((m) => m.t === 'peers', 5000);
    } catch {
      /* ni siquiera pudo conectarse */
    }
    const msNormal = Date.now() - t0;
    const enPie = await srv.vivo();

    normal?.cerrar();
    conexiones.forEach((c) => {
      try {
        c.close();
      } catch {
        /* ya */
      }
    });
    await sleep(500); // que el servidor recupere sus descriptores antes de la prueba siguiente

    return {
      bloqueado: enPie && Boolean(atendido) && msNormal < 3000,
      observado:
        `${aceptadas} conexiones aceptadas y ${rechazadas} rechazadas de ${N} intentos; ` +
        `el servidor ${enPie ? 'sigue en pie' : 'dejó de responder'} y ` +
        `${atendido ? `atendió a un jugador normal en ${msNormal} ms` : 'no atendió a un jugador normal'}.`,
      detalle: { intentos: N, aceptadas, rechazadas, msJugadorNormal: msNormal, servidorEnPie: enPie },
    };
  },
});

// --- S7 ----------------------------------------------------------------------------------------
ataque('S7', 'Mensaje desmesurado (32 MB en un `signal`)', {
  categoria: 'Flooding / DoS',
  severidad: 'media',
  objetivo:
    'Una señal WebRTC legítima ocupa unos pocos kilobytes. Si el servidor acepta 32 MB en un ' +
    'solo mensaje, unas pocas conexiones bastan para llenar la memoria del anfitrión.',
  async comprobar(srv) {
    const sala = 'S7';
    const bob = await Cliente.abrir(srv.url, 'bob');
    bob.enviar({ t: 'join', room: sala, peerId: 'bob', name: 'Bob' });
    const gordo = await Cliente.abrir(srv.url, 'gordo');
    gordo.enviar({ t: 'join', room: sala, peerId: 'gordo', name: 'Gordo' });
    await sleep(200);

    gordo.enviar({
      t: 'signal',
      room: sala,
      from: 'gordo',
      to: 'bob',
      data: { kind: 'offer', sdp: 'A'.repeat(32 * 1024 * 1024) },
    });
    await sleep(1500);

    const entregado = bob.de('signal').some((m) => String(m.data?.sdp ?? '').length > 1024 * 1024);
    const rechazado = gordo.cerrado || gordo.recibidos.some((m) => m.t === 'error');
    const enPie = await srv.vivo();
    [bob, gordo].forEach((c) => c.cerrar());

    return {
      bloqueado: !entregado && rechazado && enPie,
      observado: entregado
        ? 'El servidor aceptó y reenvió 32 MB en un solo mensaje.'
        : rechazado
          ? 'El mensaje desmesurado fue rechazado y la conexión cerrada.'
          : 'No se reenvió, pero tampoco se rechazó explícitamente.',
      detalle: { entregado, rechazado, servidorEnPie: enPie },
    };
  },
});

// --- S8 ----------------------------------------------------------------------------------------
ataque('S8', 'Mensajes malformados y tipos inesperados', {
  categoria: 'Robustez de entrada',
  severidad: 'crítica',
  objetivo:
    'Nueve mensajes sintácticamente válidos pero con la forma equivocada. El peor es ' +
    '`introduce` con `tried` que no es una lista: el servidor lo desparrama con `...`, y una ' +
    'excepción dentro del manejador de mensajes se lleva por delante el proceso entero — un ' +
    'jugador tumbaría la señalización de toda la feria con un mensaje.',
  async comprobar(srv) {
    const sala = 'S8';
    const sano = await Cliente.abrir(srv.url, 'sano');
    sano.enviar({ t: 'join', room: sala, peerId: 'sano', name: 'Sano' });
    await sleep(150);

    const cargas = [
      '{ esto no es json',
      '[]',
      'null',
      '"cadena suelta"',
      JSON.stringify({ t: 'inventado' }),
      JSON.stringify({ t: 'join' }), // sin room/peerId
      JSON.stringify({ t: 'join', room: { $ne: null }, peerId: 42, name: [] }),
      JSON.stringify({ t: 'introduce', room: sala, peerId: 'x', tried: 7 }), // `...7` explota
      JSON.stringify({ t: 'signal', room: sala, from: null, to: null, data: undefined }),
    ];

    const caidas = [];
    for (const carga of cargas) {
      // Cada entrada va en su propia conexión, y si tumba el servidor se relanza para poder seguir
      // probando las demás: interesa saber CUÁNTAS lo matan, no solo que la primera lo hizo.
      let c;
      try {
        c = await Cliente.abrir(srv.url, 'fuzz');
      } catch {
        caidas.push(`(servidor ya caído) ${carga.slice(0, 40)}`);
        await relanzar(srv);
        continue;
      }
      c.enviar(carga);
      await sleep(200);
      if (!(await srv.vivo(2000))) {
        caidas.push(carga.slice(0, 60));
        await relanzar(srv);
      }
      c.cerrar();
    }

    // Y un cliente normal tiene que seguir siendo atendido después de todo eso.
    sano.cerrar();
    const nuevo = await Cliente.abrir(srv.url, 'sano2');
    nuevo.enviar({ t: 'join', room: sala, peerId: 'sano2', name: 'Sano' });
    await sleep(150);
    nuevo.enviar({ t: 'introduce', room: sala, peerId: 'sano2', tried: [] });
    const contesta = await nuevo.espera((m) => m.t === 'peers', 1500);
    nuevo.cerrar();

    return {
      bloqueado: caidas.length === 0 && Boolean(contesta),
      observado: caidas.length
        ? `El servidor se cayó con ${caidas.length} de ${cargas.length} entradas malformadas: ${caidas.join(' | ')}`
        : contesta
          ? `Sobrevivió a las ${cargas.length} entradas malformadas y siguió atendiendo.`
          : 'Sobrevivió, pero dejó de atender al cliente sano.',
      detalle: { entradas: cargas.length, caidas },
    };
  },
});

// --- S9 ----------------------------------------------------------------------------------------
ataque('S9', 'Saltarse el aforo de la sala', {
  categoria: 'Control de acceso',
  severidad: 'media',
  objetivo:
    'Meter a 15 jugadores en una sala de 10. El motor reparte de un mazo finito: si entran más ' +
    'de los que caben, la partida no arranca mal, arranca rota.',
  async comprobar(srv) {
    const sala = 'S9';
    const dentro = [];
    let llenos = 0;
    for (let i = 0; i < 15; i++) {
      const c = await Cliente.abrir(srv.url, `j${i}`);
      c.enviar({ t: 'join', room: sala, peerId: `j${i}`, name: `J${i}` });
      dentro.push(c);
      await sleep(60);
    }
    await sleep(400);
    llenos = dentro.filter((c) => c.recibidos.some((m) => m.t === 'room-full')).length;
    const admitidos = dentro.filter((c) => c.recibidos.some((m) => m.t === 'peers')).length;
    dentro.forEach((c) => c.cerrar());

    return {
      bloqueado: admitidos <= AFORO && llenos === 15 - AFORO,
      observado: `${admitidos} admitidos y ${llenos} rechazados con \`room-full\` (aforo ${AFORO}).`,
      detalle: { admitidos, rechazados: llenos, aforo: AFORO },
    };
  },
});

// --- S10 ---------------------------------------------------------------------------------------
ataque('S10', 'Fuga del censo de la sala a un curioso', {
  categoria: 'Fuga de información',
  severidad: 'baja',
  objetivo:
    'Entrar en una sala con cuatro jugadores y ver cuántas identidades entrega el servidor. ' +
    'Desde que la señalización pasa por la malla debería entregar UNA (el introductor): el ' +
    'resto del censo viaja cifrado entre navegadores, fuera del alcance del servidor.',
  async comprobar(srv) {
    const sala = 'S10';
    const mesa = [];
    for (let i = 0; i < 4; i++) {
      const c = await Cliente.abrir(srv.url, `m${i}`);
      c.enviar({ t: 'join', room: sala, peerId: `m${i}`, name: `Jugador ${i}` });
      mesa.push(c);
      await sleep(80);
    }
    const curioso = await Cliente.abrir(srv.url, 'curioso');
    curioso.enviar({ t: 'join', room: sala, peerId: 'curioso', name: 'Curioso' });
    const peers = await curioso.espera((m) => m.t === 'peers', 1500);
    const revelados = peers?.peers?.length ?? 0;
    [...mesa, curioso].forEach((c) => c.cerrar());

    return {
      bloqueado: revelados <= 1,
      observado: `El servidor reveló ${revelados} identidad(es) de una mesa de 4.`,
      detalle: { revelados, enLaMesa: 4 },
    };
  },
});

// --- S11 ---------------------------------------------------------------------------------------
ataque('S11', 'Expulsar a otro con un `leave` ajeno', {
  categoria: 'Spoofing',
  severidad: 'alta',
  objetivo:
    'Mandar `leave` con el peerId de Alice. Un `leave` se propaga como `bye`, que para los demás ' +
    'significa "se fue a propósito": la sacarían de la rotación de turnos y sus cartas volverían ' +
    'al mazo.',
  async comprobar(srv) {
    const sala = 'S11';
    const alice = await Cliente.abrir(srv.url, 'alice');
    alice.enviar({ t: 'join', room: sala, peerId: 'alice', name: 'Alice' });
    const bob = await Cliente.abrir(srv.url, 'bob');
    bob.enviar({ t: 'join', room: sala, peerId: 'bob', name: 'Bob' });
    const mallory = await Cliente.abrir(srv.url, 'mallory');
    mallory.enviar({ t: 'join', room: sala, peerId: 'mallory', name: 'Mallory' });
    await sleep(250);

    mallory.enviar({ t: 'leave', room: sala, peerId: 'alice' });
    await sleep(500);

    const echada = bob.de('peer-left').some((m) => m.peerId === 'alice');
    [alice, bob, mallory].forEach((c) => c.cerrar());

    return {
      bloqueado: !echada,
      observado: echada
        ? 'La mesa recibió un `peer-left` de Alice provocado por Mallory.'
        : 'El `leave` solo afecta a quien lo envía (el servidor ignora el peerId del mensaje).',
    };
  },
});

// --- Ejecución ---------------------------------------------------------------------------------

const PESO = { crítica: 4, alta: 3, media: 2, baja: 1 };

async function main() {
  console.log('— Banco de ataques contra la señalización de Bug —\n');
  const srv = await startSignaling();
  console.log(`señalización de pruebas en ${srv.url}\n`);

  const resultados = [];
  for (const p of pruebas) {
    process.stdout.write(`${p.id}  ${p.nombre} … `);
    let r;
    const t0 = Date.now();
    try {
      r = await p.comprobar(srv);
    } catch (e) {
      r = { bloqueado: false, observado: `La prueba reventó: ${e.message}` };
    }
    const ms = Date.now() - t0;

    // Que el servidor quede tocado DESPUÉS del ataque también es un resultado del ataque: no vale
    // resistir el golpe y morirse al soltar el aire.
    if (!(await srv.vivo())) {
      r = {
        bloqueado: false,
        observado: `${r.observado} Además, el servidor dejó de responder al terminar el ataque.`,
        detalle: r.detalle ?? null,
      };
      await relanzar(srv);
    }

    console.log(r.bloqueado ? `PASA (${ms} ms)` : `⚠️  FALLA (${ms} ms)`);
    if (!r.bloqueado) console.log(`     → ${r.observado}`);
    resultados.push({
      id: p.id,
      nombre: p.nombre,
      categoria: p.categoria,
      severidad: p.severidad,
      objetivo: p.objetivo,
      veredicto: r.bloqueado ? 'bloqueado' : 'vulnerable',
      observado: r.observado,
      detalle: r.detalle ?? null,
      ms,
    });
  }

  await srv.stop();

  const vulnerables = resultados.filter((r) => r.veredicto === 'vulnerable');
  const graves = vulnerables.filter((r) => PESO[r.severidad] >= 3);

  const informe = {
    suite: 'seguridad-señalización',
    fecha: new Date().toISOString(),
    objetivo: 'signaling/src/server.ts (WebSocket + HTTP)',
    total: resultados.length,
    bloqueados: resultados.length - vulnerables.length,
    vulnerables: vulnerables.length,
    graves: graves.length,
    resultados,
  };
  const ruta = guardarInforme('seguridad', informe);

  console.log(
    `\n${informe.bloqueados}/${informe.total} ataques bloqueados` +
      (vulnerables.length ? ` — ${vulnerables.length} vulnerabilidad(es), ${graves.length} de severidad alta o crítica` : ''),
  );
  console.log(`informe: ${ruta}`);

  process.exit(graves.length > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
