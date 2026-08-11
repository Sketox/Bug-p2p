/// <reference types="cypress" />

// Comandos para montar VARIOS nodos de Bug a la vez, en la misma página, y hablarles por separado.
//
// Por qué hace falta esto y no basta con `cy.visit`: Cypress conduce una sola pestaña, y aquí lo
// que hay que probar es una malla. Los nodos se montan como `<iframe>` del mismo origen dentro de
// una página de banco de pruebas, así que son contextos de navegación independientes —cada uno con
// su `RTCPeerConnection`— y a la vez accesibles desde el test.
//
// El detalle que lo hace funcionar (y que costó ver): los iframes del mismo origen COMPARTEN el
// `sessionStorage` de la pestaña, y ahí es donde la app guarda la identidad del jugador
// (`bug:peer:<sala>`). Montados a lo bruto, los tres nodos serían el mismo jugador peleándose por
// el mismo sitio en la mesa. Pero la identidad se lee UNA sola vez, al entrar a la sala, así que
// basta con sembrar la clave justo antes de que cada nodo entre: cada uno se queda con la suya en
// memoria y da igual lo que pase después con el almacén.

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Cypress {
    interface Chainable {
      /** Abre la página vacía donde se montan los nodos (no toca el producto: se sirve del vuelo). */
      abrirBanco(): Chainable<void>;
      /** Monta un nodo. Si `sala` es null, crea una nueva y devuelve su código. */
      montarNodo(indice: number, nombre: string, sala: string | null): Chainable<string>;
      /** El `body` del nodo, envuelto en jQuery, para buscar dentro con `.find(...)`. */
      enNodo(indice: number): Chainable<JQuery<Document>>;
      /** La ventana de depuración del nodo (`window.__bug`), o `undefined` si aún no hay partida. */
      estadoDe(indice: number): Chainable<BugDebug | undefined>;
      /** Espera a que todos los nodos indicados tengan la MISMA huella de estado. */
      esperarConvergencia(indices: number[]): Chainable<string>;
      /** Captura para el informe, dando tiempo a que el navegador termine de dibujar. */
      capturaEstable(nombre: string): Chainable<void>;
    }
  }
}

export interface BugDebug {
  me: string;
  hash: string;
  events: { lamport: number; origin: string }[];
  state: {
    seq: number;
    turn: number;
    finished: boolean;
    players: { id: string; name: string; hand: unknown[]; status: string }[];
  };
}

const RUTA_BANCO = '/vv-banco-de-nodos';

Cypress.Commands.add('abrirBanco', () => {
  // Una página en blanco servida por intercepción: mismo origen que la app (así los iframes son
  // accesibles) sin tener que añadir un archivo de pruebas a `web/public/`, que acabaría
  // desplegándose en la imagen de producción.
  cy.intercept('GET', RUTA_BANCO, {
    statusCode: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
    body: `<!doctype html><meta charset="utf-8"><title>banco de nodos</title>
           <body style="margin:0;display:flex;gap:4px;background:#111"></body>`,
  }).as('banco');
  cy.visit(RUTA_BANCO);
  cy.get('body').should('exist');
  // Los tests comparten pestaña, y `sessionStorage` es de la pestaña: sin esto, la sala que dejó
  // apuntada el spec anterior se cuela en el primer nodo de este.
  cy.window().then((win) => win.sessionStorage.clear());
});

Cypress.Commands.add('montarNodo', (indice: number, nombre: string, sala: string | null) => {
  return cy.window().then((win) => {
    // La otra cara del `sessionStorage` compartido, y esta sí que despista: la app recuerda en qué
    // sala estabas (`bug:room`) para devolverte a ella tras un F5. Como el nodo 1 ya está dentro de
    // una, el nodo 2 se encuentra esa memoria al arrancar y **entra directo al lobby**, sin pasar
    // por el menú — sin campos donde teclear, y la espera se agota sin explicación aparente.
    //
    // Borrar la clave antes de montar NO basta, y esa fue la primera versión de esto: el nodo que
    // ya está dentro la vuelve a escribir en cuanto su sala cambia de estado, así que entre el
    // borrado y el arranque del iframe hay una carrera que se pierde la mitad de las veces. El
    // síntoma era una prueba intermitente, que es la peor clase de prueba: la que enseña a
    // desconfiar de las demás.
    //
    // Lo que sí es firme es entrar por **invitación explícita** (`?r=`), porque la app ya da
    // prioridad a la URL sobre la sesión guardada (`chooseSavedRoom`) — precisamente para que un
    // enlace no acabe metiéndote en otra sala. De paso, los nodos recorren el mismo camino que en
    // la feria: el del QR.
    win.sessionStorage.removeItem('bug:room');

    if (sala) {
      // La identidad se siembra justo antes de que este nodo entre: la app la lee una sola vez, al
      // entrar a la sala, así que cada nodo se queda con la suya en memoria.
      win.sessionStorage.setItem(`bug:peer:${sala}`, `nodo-${indice}`);
      win.sessionStorage.setItem(`bug:secret:${sala}`, `secreto-del-nodo-${indice}`);
    }

    const marco = win.document.createElement('iframe');
    marco.id = `nodo-${indice}`;
    marco.setAttribute('data-nodo', String(indice));
    marco.style.cssText = 'width:400px;height:820px;border:0;background:#000';
    marco.src = sala ? `/?r=${encodeURIComponent(sala)}` : '/';
    win.document.body.appendChild(marco);

    // Esperar a que la app del iframe pinte su menú.
    //
    // Dos detalles que costaron un rato:
    //
    //  1. Hay que reconsultar el `contentDocument` en cada intento, y por eso el `should` cuelga
    //     del IFRAME y no del documento. Un iframe recién creado arranca en `about:blank`, con su
    //     propio `body`; `its('0.contentDocument.body')` se queda con ESE objeto y reintenta la
    //     aserción contra él para siempre — el documento de la app llega después, en otro objeto
    //     distinto, y la espera nunca termina.
    //  2. No basta con "el body no está vacío": lo primero que aparece dentro es el sprite de las
    //     cartas (700 KB de SVG incrustados en el HTML), así que el body deja de estar vacío mucho
    //     antes de que exista el menú. Se espera a que haya campos con los que interactuar.
    //  3. El margen es holgado a propósito. Lo que se espera aquí no es nada que esta prueba
    //     afirme: es que `next dev` sirva y el navegador hidrate una app con 700 KB de sprite
    //     incrustado, tres veces. Con la máquina ocupada eso pasa de sobra de 40 s, y un fallo ahí
    //     no dice nada del sistema — solo de lo que hubiera de fondo.
    return cy
      .get(`#nodo-${indice}`, { timeout: 60_000 })
      .should(($marco) => {
        const doc = ($marco[0] as HTMLIFrameElement).contentDocument;
        expect(doc?.querySelectorAll('input').length ?? 0, 'menú del nodo pintado').to.be.greaterThan(0);
      })
      .then(() => {
        cy.enNodo(indice).find('input').first().type(nombre);

        if (sala === null) {
          cy.enNodo(indice).contains('button', 'Crear sala').click();
          // El código lo inventa la app: se lee del lobby y se devuelve para los demás nodos.
          return cy
            .enNodo(indice)
            .find('[data-testid="room-code"]', { timeout: 20_000 })
            .invoke('text')
            .then((texto) => String(texto).trim());
        }

        // Llega invitado (`?r=`): la sala ya la sabe, solo pone su nombre. No hay campo de código.
        cy.enNodo(indice).contains('button', 'Entrar a la sala').click();
        cy.enNodo(indice).find('[data-testid="room-code"]', { timeout: 20_000 }).should('exist');
        return cy.wrap(sala);
      });
  });
});

Cypress.Commands.add('enNodo', (indice: number) => {
  // El `body` se vuelve a pedir al iframe en cada uso, en vez de guardarlo: la app repinta
  // constantemente y un elemento capturado antes se queda obsoleto (ver la nota de `montarNodo`).
  return cy.get(`#nodo-${indice}`, { log: false }).then(($marco) => {
    const doc = ($marco[0] as HTMLIFrameElement).contentDocument;
    if (!doc) throw new Error(`el nodo ${indice} no tiene documento`);
    return cy.wrap(doc.body as unknown as Document, { log: false });
  });
});

Cypress.Commands.add('estadoDe', (indice: number) => {
  return cy.get(`#nodo-${indice}`, { log: false }).then(($marco) => {
    const win = ($marco[0] as HTMLIFrameElement).contentWindow;
    const bug = (win as unknown as { __bug?: BugDebug } | null)?.__bug;
    // `cy.wrap` y no `return bug` a secas: devolver `undefined` desde un `.then()` no significa
    // "el resultado es undefined" — significa "no cambio el sujeto", y lo que sigue recibiría el
    // iframe. Un nodo que aún no tiene partida tiene que contestar `undefined`, no un `<iframe>`
    // del que nadie va a poder sacar una huella.
    return cy.wrap(bug, { log: false });
  });
});

/**
 * Una captura que no sale a medio dibujar.
 *
 * Las capturas de este proyecto son un entregable —van al informe y a la presentación— y salían
 * vacías una y otra vez. La causa es siempre la misma y conviene dejarla escrita en un solo sitio:
 * **el DOM no sabe cuándo el navegador ha pintado**. Las aserciones dicen que el elemento existe,
 * que es visible y que su opacidad ya es 1 —todo cierto— y aun así el fotograma que captura Chrome
 * puede ser anterior al dibujo, sobre todo con las cartas: cada una es un SVG que referencia un
 * símbolo del sprite, que a su vez referencia más figuras.
 *
 * No hay nada que esperar en el DOM, así que se espera un poco de reloj. Es la única espera fija de
 * la suite y solo afecta a las capturas: ninguna prueba decide nada por ella.
 */
Cypress.Commands.add('capturaEstable', (nombre: string) => {
  // eslint-disable-next-line cypress/no-unnecessary-waiting
  cy.wait(600);
  cy.screenshot(nombre, { overwrite: true });
});

Cypress.Commands.add('esperarConvergencia', (indices: number[]) => {
  const comprobar = (intentos: number): Cypress.Chainable<string> => {
    const huellas: (string | undefined)[] = [];
    // Las huellas se piden en cadena y no en paralelo: los comandos de Cypress se encolan, y
    // encadenarlos es la única forma de leer los tres en el mismo instante lógico.
    const paso = () => cy.wrap(null as unknown, { log: false });
    let cadena: Cypress.Chainable<unknown> = paso();
    for (const i of indices) {
      cadena = cadena.then(() =>
        cy.estadoDe(i).then((d) => {
          huellas.push(d?.hash);
          return paso();
        }),
      );
    }
    return cadena.then(() => {
      const definidas = huellas.filter(Boolean);
      const acuerdo = definidas.length === indices.length && new Set(definidas).size === 1;
      if (acuerdo) return cy.wrap(definidas[0] as string, { log: false });
      if (intentos <= 0) {
        throw new Error(
          `los nodos no convergieron: ${huellas.map((h, n) => `${indices[n]}=${h ?? '—'}`).join(', ')}`,
        );
      }
      // eslint-disable-next-line cypress/no-unnecessary-waiting
      return cy.wait(500, { log: false }).then(() => comprobar(intentos - 1));
    }) as Cypress.Chainable<string>;
  };
  return comprobar(40); // hasta 20 s: abrir tres DataChannels lleva su tiempo
});

export {};
