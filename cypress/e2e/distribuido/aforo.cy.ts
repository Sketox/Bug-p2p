// El aforo, con diez navegadores de verdad.
//
// Ya había pruebas del aforo contra el servidor real (`signaling/test/aforo.test.ts`): dejan entrar
// a diez, rebotan al once, y el que ya estaba puede volver aunque esté llena. Todas hablan con el
// servidor por WebSocket, sin navegador de por medio.
//
// Lo que faltaba es esto: **diez pestañas abriendo diez mallas de WebRTC a la vez**. Diez nodos son
// cuarenta y cinco canales punto a punto, no diez; es el escenario que más carga mete y el que se
// va a dar en la feria si el stand se llena. Y en la interfaz nadie había comprobado nunca que al
// número once se le dice que no cabe, en vez de dejarlo esperando en una pantalla muerta.

const AFORO = 10;

describe('aforo: diez caben, el once no', () => {
  it('los diez entran y se ven entre ellos', () => {
    cy.abrirBanco();

    cy.montarNodo(1, 'J01', null).then((sala) => {
      for (let i = 2; i <= AFORO; i++) cy.montarNodo(i, `J${String(i).padStart(2, '0')}`, sala);

      // Se comprueba en el primero y en el último: el que abrió la sala y el que llegó al final,
      // que es el que más saltos ha tenido que dar por la malla para conocer a todos.
      for (const nodo of [1, AFORO]) {
        cy.enNodo(nodo)
          .contains(`${AFORO}/${AFORO}`, { timeout: 60_000 })
          .should('exist');
      }

      // Y que la malla se ASIENTE: el botón de la Pantalla Maestra se pone en rojo con un ⚠
      // mientras algún nodo vea a otro como sospechoso o caído. Con diez nodos son cuarenta y cinco
      // canales, y al principio siempre hay alguno sin su primer latido; lo que hay que exigir es
      // que eso pase, no que no ocurra nunca. Si se quedara en rojo, la mesa estaría avisando de que
      // con diez no se sostiene.
      for (let nodo = 1; nodo <= AFORO; nodo++) {
        cy.enNodo(nodo).contains('button', 'malla', { timeout: 45_000 }).should('not.contain', '⚠');
      }

      // Diez marcos de 400 px son cuatro mil de ancho: en una captura solo saldrían los cuatro
      // primeros, y la evidencia de «diez jugadores» enseñaría cuatro. Se ensancha la ventana y se
      // encogen los marcos para el retrato de familia.
      cy.viewport(2600, 860);
      encogerNodos(AFORO);
      cy.capturaEstable('09-diez-jugadores');
    });
  });

  it('con diez en la mesa, la partida arranca y todos ven lo mismo', () => {
    cy.abrirBanco();

    cy.montarNodo(1, 'J01', null).then((sala) => {
      for (let i = 2; i <= AFORO; i++) cy.montarNodo(i, `J${String(i).padStart(2, '0')}`, sala);
      cy.enNodo(1).contains(`${AFORO}/${AFORO}`, { timeout: 60_000 }).should('exist');

      cy.enNodo(1).contains('button', '¡Empezar!').click();

      // La afirmación es la de siempre y la única que vale: las diez réplicas con la misma huella.
      // Con diez nodos hay más margen de reparto, así que se espera más.
      cy.esperarConvergencia(Array.from({ length: AFORO }, (_, i) => i + 1));

      cy.estadoDe(1).then((d) => {
        expect(d?.state.players, 'diez en la mesa').to.have.length(AFORO);
      });
    });
  });

  it('al número once se le dice que no cabe, y no se queda colgado', () => {
    cy.abrirBanco();

    cy.montarNodo(1, 'J01', null).then((sala) => {
      for (let i = 2; i <= AFORO; i++) cy.montarNodo(i, `J${String(i).padStart(2, '0')}`, sala);
      cy.enNodo(1).contains(`${AFORO}/${AFORO}`, { timeout: 60_000 }).should('exist');

      // El once entra por su cuenta: `montarNodo` espera al lobby, y este no va a llegar nunca.
      cy.window().then((win) => {
        win.sessionStorage.removeItem('bug:room');
        win.sessionStorage.setItem(`bug:peer:${sala}`, 'nodo-11');
        win.sessionStorage.setItem(`bug:secret:${sala}`, 'secreto-del-nodo-11');
        const marco = win.document.createElement('iframe');
        marco.id = 'nodo-11';
        marco.style.cssText = 'width:400px;height:820px;border:0;background:#000';
        marco.src = `/?r=${encodeURIComponent(sala)}`;
        win.document.body.appendChild(marco);
      });

      cy.get('#nodo-11', { timeout: 60_000 }).should(($marco) => {
        const doc = ($marco[0] as HTMLIFrameElement).contentDocument;
        expect(doc?.querySelectorAll('input').length ?? 0, 'menú del nodo 11').to.be.greaterThan(0);
      });
      cy.enNodo(11).find('input').first().type('J11');
      cy.enNodo(11).contains('button', 'Entrar a la sala').click();

      // Y lo que importa: se le dice. No una pantalla en blanco ni un «reconectando…» eterno.
      cy.enNodo(11).contains('SALA LLENA', { timeout: 30_000 }).should('exist');
      // El nodo 11 está a cuatro mil píxeles a la derecha: sin traerlo a la vista, la captura de
      // «al once se le dice que no cabe» enseñaría a los primeros de la fila.
      cy.get('#nodo-11').scrollIntoView();
      cy.capturaEstable('10-sala-llena');

      // Los diez de dentro siguen a lo suyo: el rechazo no les afecta.
      cy.enNodo(1).contains(`${AFORO}/${AFORO}`).should('exist');
    });
  });
});

/** Encoge los marcos de los nodos para que quepan todos en una captura. */
function encogerNodos(cuantos: number): void {
  cy.window().then((win) => {
    for (let i = 1; i <= cuantos; i++) {
      const marco = win.document.getElementById(`nodo-${i}`);
      if (marco) marco.style.cssText = 'width:250px;height:800px;border:0;background:#000';
    }
  });
}
