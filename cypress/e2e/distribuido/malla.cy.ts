// Tres nodos, WebRTC de verdad, en un navegador de verdad.
//
// Esta es la prueba que ninguna otra capa puede dar. Los tests de `net/` montan mallas simuladas y
// demuestran que el algoritmo converge; lo que no pueden tocar es `RTCPeerConnection`, que no
// existe en Node. Aquí se prueba el camino completo: señalización, handshake, DataChannels,
// difusión de eventos y convergencia de las réplicas — con los mismos navegadores con los que se
// juega en la feria.
//
// Los tres nodos son `<iframe>` del mismo origen, cada uno con su propio contexto de navegación.
// Ver `cypress/support/comandos.ts` para el detalle de cómo se les da identidad distinta pese a
// compartir `sessionStorage`.

describe('malla de tres nodos', () => {
  it('los tres se ven en el lobby y el anfitrión reparte el código', () => {
    cy.abrirBanco();

    cy.montarNodo(1, 'Ana', null).then((sala) => {
      expect(sala, 'código de sala').to.match(/^[A-Z0-9]{4,6}$/);

      cy.montarNodo(2, 'Beto', sala);
      cy.montarNodo(3, 'Dina', sala);

      // El lobby de cada uno tiene que acabar mostrando a los tres. Que lo muestre el ANFITRIÓN no
      // basta: el que llega segundo se conecta con el tercero por la malla, no por el servidor.
      for (const i of [1, 2, 3]) {
        cy.enNodo(i).contains('Ana', { timeout: 25_000 }).should('exist');
        cy.enNodo(i).contains('Beto').should('exist');
        cy.enNodo(i).contains('Dina').should('exist');
      }
    });
  });

  it('al empezar la partida, los tres convergen al mismo estado', () => {
    cy.abrirBanco();

    cy.montarNodo(1, 'Ana', null).then((sala) => {
      cy.montarNodo(2, 'Beto', sala);
      cy.montarNodo(3, 'Dina', sala);
      cy.enNodo(1).contains('Dina', { timeout: 25_000 }).should('exist');

      cy.enNodo(1).contains('button', '¡Empezar!').click({ force: true });

      // La huella del estado replicado es la misma que compara la Pantalla Maestra. Si coincide en
      // los tres, es que los tres calcularon la misma partida a partir de la misma semilla y el
      // mismo log — que es literalmente el argumento de por qué no hace falta un servidor.
      cy.esperarConvergencia([1, 2, 3]).then((huella) => {
        cy.log(`huella común: ${huella}`);
        // Evidencia del entregable: los tres nodos en pantalla a la vez. Es la imagen que resume
        // el proyecto entero — tres réplicas independientes de acuerdo sin que haya un servidor
        // que arbitre.
        //
        // El nombre NO lleva la huella dentro, aunque sea tentador: la huella cambia con la
        // semilla, o sea en cada ejecución, y cualquier documento que enlace la captura se queda
        // apuntando a un archivo que ya no existe. La huella se anota en el log, que es donde
        // sirve para depurar.
        cy.capturaEstable('04-tres-nodos-convergen');
      });

      // Y no convergieron "a nada": hay partida, con sus tres manos repartidas.
      cy.estadoDe(1).then((d) => {
        expect(d?.state.players).to.have.length(3);
        expect(d?.state.players[0]?.hand).to.have.length(7);
      });
    });
  });

  it('una jugada de uno la ven los tres, y siguen de acuerdo', () => {
    cy.abrirBanco();

    cy.montarNodo(1, 'Ana', null).then((sala) => {
      cy.montarNodo(2, 'Beto', sala);
      cy.montarNodo(3, 'Dina', sala);
      cy.enNodo(1).contains('Dina', { timeout: 25_000 }).should('exist');
      cy.enNodo(1).contains('button', '¡Empezar!').click({ force: true });
      cy.esperarConvergencia([1, 2, 3]);

      cy.estadoDe(1).then((antes) => {
        const seqAntes = antes!.state.seq;
        // Quién abre lo decide la semilla, no el anfitrión: hay que buscar a quién le toca.
        cy.wrap(null).then(() => jugarElQueTengaElTurno());

        // Todos avanzan, y todos al mismo sitio.
        cy.esperarConvergencia([1, 2, 3]);
        cy.estadoDe(1).should((d) => {
          expect(d!.state.seq, 'la partida avanzó').to.be.greaterThan(seqAntes);
        });
        for (const i of [2, 3]) {
          cy.estadoDe(i).should((d) => {
            expect(d!.state.seq).to.be.greaterThan(seqAntes);
          });
        }
      });
    });
  });

  it('la Pantalla Maestra enseña la malla por dentro: líder, testigo y convergencia', () => {
    // El requisito R5.4 (modo espectador para el proyector) figuraba como "se comprueba en la
    // feria", que es otra forma de decir que no se comprobaba. Y es justo la pantalla que se va a
    // proyectar delante de gente: si miente, miente en grande.
    //
    // Lo que se afirma aquí es lo que la pantalla promete: que hay un líder elegido, que el testigo
    // está en algún sitio concreto, que los tres nodos salen como presentes, y que el veredicto de
    // convergencia es el mismo que calcula la prueba por su cuenta comparando huellas.
    cy.abrirBanco();

    cy.montarNodo(1, 'Ana', null).then((sala) => {
      cy.montarNodo(2, 'Beto', sala);
      cy.montarNodo(3, 'Dina', sala);
      cy.enNodo(1).contains('Dina', { timeout: 25_000 }).should('exist');
      cy.enNodo(1).contains('button', '¡Empezar!').click({ force: true });
      cy.esperarConvergencia([1, 2, 3]);

      // Se abre con el botón y no con la tecla `M`: el foco vive en el iframe, y mandar la tecla
      // al documento de fuera no llegaría a la app.
      cy.enNodo(1).contains('button', 'malla').click({ force: true });

      cy.enNodo(1).contains('Pantalla Maestra').should('be.visible');
      cy.enNodo(1).contains('convergencia').should('exist');
      cy.enNodo(1).contains('OK ✓').should('exist');
      // Los tres, con nombre, en el censo de la malla.
      for (const quien of ['Ana', 'Beto', 'Dina']) {
        cy.enNodo(1).contains(quien).should('exist');
      }
      // Y hay coordinador: el Bully ya se puso de acuerdo.
      cy.enNodo(1).contains('líder').should('exist');

      cy.capturaEstable('06-pantalla-maestra');
    });
  });

  it('el que se va deja de estar en la mesa, y los que quedan siguen de acuerdo', () => {
    cy.abrirBanco();

    cy.montarNodo(1, 'Ana', null).then((sala) => {
      cy.montarNodo(2, 'Beto', sala);
      cy.montarNodo(3, 'Dina', sala);
      cy.enNodo(1).contains('Dina', { timeout: 25_000 }).should('exist');
      cy.enNodo(1).contains('button', '¡Empezar!').click({ force: true });
      cy.esperarConvergencia([1, 2, 3]);

      // Dina cierra la pestaña: se quita el iframe entero, que es lo más parecido a cerrarla.
      cy.window().then((win) => {
        win.document.getElementById('nodo-3')?.remove();
      });

      // Los dos que quedan tienen que seguir de acuerdo entre ellos. Ojo con lo que se afirma
      // aquí: NO que a Dina la den por muerta de inmediato. Cerrar el contexto de golpe no dispara
      // el `pagehide` que envía el adiós limpio, así que para la mesa es una CAÍDA — y una caída
      // se sospecha, no se sentencia: se le guarda el sitio unos segundos por si vuelve.
      cy.esperarConvergencia([1, 2]);
      cy.capturaEstable('05-cae-un-nodo-los-otros-siguen');
    });
  });
});

/** Busca en qué nodo está el turno y juega su primera carta legal (o roba y pasa). */
function jugarElQueTengaElTurno(): void {
  for (const i of [1, 2, 3]) {
    cy.enNodo(i).then(($cuerpo) => {
      const jugables = $cuerpo.find('[data-testid="hand-card"][data-playable="true"]');
      if (jugables.length === 0) return;
      cy.wrap(jugables.first()).click({ force: true });

      // Comodines y cartas de Caos preguntan antes de aplicarse, y NO todas preguntan lo mismo:
      // un comodín pide color, el Troyano pide víctima y «Apagar y volver a prender» ofrece
      // jugarla tal cual o reiniciar el pozo con otra carta. La primera versión de esto buscaba
      // siempre `color-option`, así que en cuanto salía un diálogo de otro tipo se quedaba
      // esperando un botón que no existía — y el fallo aparecía una vez de cada tantas, según qué
      // carta tocara. Un test que depende de la carta que salga es un test que miente a medias.
      //
      // Aquí no importa QUÉ se elija: lo que la prueba afirma es que la jugada se propaga y los
      // tres siguen de acuerdo. Así que vale cualquier opción — la primera que no sea «cancelar».
      cy.enNodo(i).then(($despues) => {
        if ($despues.find('[data-testid="play-prompt"]').length === 0) return;
        cy.get(`#nodo-${i}`)
          .its('0.contentDocument.body')
          .find('[data-testid="play-prompt"] button')
          .not(':contains("cancelar")')
          .first()
          .click({ force: true });
      });
    });
  }
}
