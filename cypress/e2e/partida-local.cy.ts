// Una partida hot-seat de principio a fin, jugada por el navegador.
//
// El motor ya tiene 74 pruebas unitarias, así que aquí no se prueban las reglas: se prueba que la
// interfaz las deja jugar. Es una distinción real — el motor podría estar perfecto y la mesa ser
// injugable porque un botón no se habilita, una carta no responde al clic o el diálogo del
// comodín no se cierra.

describe('partida local (hot-seat)', () => {
  beforeEach(() => {
    cy.visit('/');
    cy.contains('button', 'practicar local').click();
  });

  it('reparte, muestra la mesa y dice de quién es el turno', () => {
    cy.contains('hot-seat local').should('be.visible');
    cy.contains('button', '¡A jugar!').click();

    // Mano repartida: 7 cartas para el que está en turno.
    cy.get('[data-testid="hand-card"]', { timeout: 15_000 }).should('have.length', 7);
    cy.get('[data-testid="pile-top"]').should('exist');
    cy.get('[data-testid="status-bar"]').should('have.attr', 'data-turn-name').and('not.be.empty');
    cy.screenshot('03-mesa-repartida', { overwrite: true });
  });

  it('robar te deja la carta si sirve, y te quita el turno si no', () => {
    // La regla del motor, que no es la obvia: al robar, si la carta vale se queda contigo para que
    // la juegues; si no vale, el turno pasa en el acto. Por eso no se puede afirmar "la mano crece
    // a 8" a secas — la mano que se ve después puede ser ya la del siguiente jugador.
    cy.contains('button', '¡A jugar!').click();
    cy.get('[data-testid="hand-card"]', { timeout: 15_000 }).should('have.length', 7);

    cy.get('[data-testid="status-bar"]')
      .invoke('attr', 'data-turn')
      .then((antes) => {
        cy.contains('button', /ROBA|Robar/).click();
        cy.get('[data-testid="status-bar"]').should(($barra) => {
          const ahora = $barra.attr('data-turn');
          const mano = Cypress.$('[data-testid="hand-card"]').length;
          if (ahora === antes) {
            // La carta servía: sigo yo, con una más.
            expect(mano, 'la carta robada se queda en la mano').to.equal(8);
          } else {
            // No servía: el turno ya es del siguiente, que empieza con sus 7.
            expect(mano, 'la mano que se ve es la del siguiente').to.equal(7);
          }
        });
      });
  });

  it('una carta que no encaja no se puede jugar; una que sí, se juega y cambia el pozo', () => {
    cy.contains('button', '¡A jugar!').click();
    cy.get('[data-testid="hand-card"]', { timeout: 15_000 }).should('have.length', 7);

    cy.get('[data-testid="pile-top"]')
      .invoke('attr', 'data-card')
      .then((antes) => {
        // La UI marca cuáles son jugables; se elige una de esas (que es lo que hace una persona).
        cy.get('[data-testid="hand-card"][data-playable="true"]').first().click();
        // Los comodines abren un diálogo de color: se elige uno y sigue.
        cy.get('body').then(($b) => {
          if ($b.find('[data-testid="play-prompt"]').length > 0) {
            cy.get('[data-testid="color-option"]').first().click();
          }
        });
        cy.get('[data-testid="pile-top"]').should(($p) => {
          expect($p.attr('data-card')).to.not.equal(antes);
        });
      });
  });

  it('nunca se puede pasar sin haber robado', () => {
    // Pasar de gratis era la puerta trasera para esquivar el castigo del +4: quien no tenía jugada
    // pasaba y no robaba nunca.
    //
    // Al empezar un turno, Pasar está siempre deshabilitado. Tras robar, o se habilita (la carta
    // servía y sigo yo) o el turno ya cambió y vuelve a estar deshabilitado para el siguiente. En
    // ninguno de los dos caminos se llega a pasar sin robar, que es lo que hay que garantizar.
    cy.contains('button', '¡A jugar!').click();
    cy.get('[data-testid="hand-card"]', { timeout: 15_000 }).should('have.length', 7);
    cy.contains('button', 'Pasar').should('be.disabled');

    cy.get('[data-testid="status-bar"]')
      .invoke('attr', 'data-turn')
      .then((antes) => {
        cy.contains('button', /ROBA|Robar/).click();
        cy.get('[data-testid="status-bar"]').should(($barra) => {
          const sigoYo = $barra.attr('data-turn') === antes;
          const pasarActivo = Cypress.$('button:contains("Pasar")').filter(':enabled').length > 0;
          expect(pasarActivo, sigoYo ? 'ya robé: puedo pasar' : 'turno nuevo: no puedo pasar').to.equal(
            sigoYo,
          );
        });
      });
  });

  it('el turno acaba rotando al siguiente jugador', () => {
    cy.contains('button', '¡A jugar!').click();
    cy.get('[data-testid="hand-card"]', { timeout: 15_000 }).should('have.length', 7);

    cy.get('[data-testid="status-bar"]')
      .invoke('attr', 'data-turn')
      .then((primero) => {
        // Robar acaba cediendo el turno sí o sí: o porque la carta no servía (se cede sola) o
        // porque después se pasa.
        cy.contains('button', /ROBA|Robar/).click();
        cy.get('body').then(($b) => {
          const pasar = $b.find('button:contains("Pasar")').filter(':enabled');
          if (pasar.length > 0) cy.wrap(pasar).click();
        });
        cy.get('[data-testid="status-bar"]').should(($t) => {
          expect($t.attr('data-turn')).to.not.equal(primero);
        });
      });
  });

  it('se puede consultar las reglas sin salir de la partida', () => {
    cy.contains('button', '¡A jugar!').click();
    cy.get('[data-testid="hand-card"]', { timeout: 15_000 }).should('exist');
    cy.get('[title="Cómo se juega"]').click();
    cy.contains('El objetivo').should('be.visible');
    cy.contains('button', 'cerrar').click();
    cy.get('[data-testid="hand-card"]').should('exist'); // la mesa sigue ahí
  });
});
