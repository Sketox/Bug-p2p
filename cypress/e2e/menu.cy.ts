// Lo primero que ve alguien en la feria: el menú.
//
// Estas pruebas parecen menores y no lo son. Los dos únicos fallos que llegaron a producción en
// este proyecto —el lobby que no se reabría y la tarjeta que desbordaba a 360 px— estaban aquí, y
// ningún test unitario los habría visto: uno era del ciclo de vida de React, el otro del cálculo
// de anchura de un `grid`. Solo aparecen en un navegador de verdad.

describe('menú principal', () => {
  beforeEach(() => {
    cy.visit('/');
  });

  it('no deja crear una sala sin nombre, y lo permite en cuanto lo hay', () => {
    cy.contains('button', 'Crear sala').should('be.disabled');
    cy.get('input').first().type('Ana');
    cy.contains('button', 'Crear sala').should('not.be.disabled');
  });

  it('unirse exige nombre Y código', () => {
    cy.contains('button', 'Unirse').should('be.disabled');
    cy.get('input').first().type('Ana');
    cy.contains('button', 'Unirse').should('be.disabled'); // falta el código
    cy.get('input').eq(1).type('AB12');
    cy.contains('button', 'Unirse').should('not.be.disabled');
  });

  it('el código de sala se escribe siempre en mayúsculas', () => {
    // Lo teclea la gente desde el móvil mirando la pantalla del anfitrión; si `ab12` y `AB12`
    // fueran salas distintas, la mitad no se encontraría.
    cy.get('input').eq(1).type('ab12').should('have.value', 'AB12');
  });

  it('las reglas se pueden leer sin empezar ninguna partida', () => {
    // Requisito de feria: el público llega, escanea el QR y no ha visto una carta de Bug nunca.
    cy.contains('button', 'Cómo se juega').click();
    cy.contains('El objetivo').should('be.visible');
    cy.contains('sin cartas').should('exist');
    cy.contains('button', 'cerrar').click();
    cy.contains('button', 'Crear sala').should('be.visible'); // vuelve al menú
  });

  it('cabe en un móvil de 360 px sin desbordar a lo ancho', () => {
    // El bug real: el menú usaba `grid place-items-center`, y en un grid la columna toma el
    // max-content del hijo (28rem), así que la tarjeta se salía de la pantalla. En la feria se
    // entra escaneando un QR, o sea que casi todo el mundo llega por aquí.
    cy.viewport(360, 740);
    cy.visit('/');
    cy.document().then((doc) => {
      expect(doc.documentElement.scrollWidth, 'ancho del contenido').to.be.at.most(360);
    });
    cy.contains('button', 'Crear sala').should('be.visible');
    cy.screenshot('01-menu-en-movil-360px', { overwrite: true });
  });
});

/** Entra a la sala del enlace y espera a que el lobby esté en pantalla. */
function entrarPorInvitacion(enlace: string): void {
  cy.visit(enlace);
  cy.get('input').first().type('Invitado');
  cy.contains('button', 'Entrar a la sala').should('not.be.disabled').click();
  cy.get('[data-testid="room-code"]', { timeout: 20_000 }).should('contain', 'QRTEST');
}

/** La señalización que la app decidió usar en esta sesión. */
function senalizacionGuardada(): Cypress.Chainable<string | null> {
  return cy.window().its('sessionStorage').invoke('getItem', 'bug:signal');
}

describe('invitación por QR', () => {
  it('quien llega con `?r=` solo tiene que poner su nombre', () => {
    cy.visit('/?r=QRTEST');
    cy.contains('te invitaron a la sala').should('be.visible');
    cy.contains('QRTEST').should('be.visible');
    cy.contains('button', 'Crear sala').should('not.exist');
    cy.contains('button', 'Entrar a la sala').should('be.disabled');
    cy.get('input').first().type('Invitado');
    cy.contains('button', 'Entrar a la sala').should('not.be.disabled');
    cy.screenshot('02-llegada-por-qr', { overwrite: true });
  });

  it('un enlace no puede elegir a qué se conecta tu navegador', () => {
    // El parámetro `s` transporta la señalización, así que cualquiera puede fabricar un enlace y
    // mandárselo a alguien. Solo se aceptan `ws://` y `wss://`; lo demás se descarta y se cae al
    // valor por defecto.
    //
    // La URL se resuelve al ENTRAR a la sala, no al cargar el menú, así que hay que entrar y
    // esperar al lobby antes de mirar qué quedó guardado.
    entrarPorInvitacion('/?r=QRTEST&s=javascript%3Aalert(1)');
    senalizacionGuardada().should((guardada) => {
      expect(guardada ?? '').to.match(/^wss?:\/\//);
      expect(guardada ?? '').to.not.include('javascript');
    });
  });

  it('acepta la señalización que venga en el enlace si es un WebSocket', () => {
    entrarPorInvitacion('/?r=QRTEST&s=ws%3A%2F%2Flocalhost%3A8787');
    senalizacionGuardada().should('include', 'localhost:8787');
  });
});
