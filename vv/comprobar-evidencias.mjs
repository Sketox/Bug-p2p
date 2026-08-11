#!/usr/bin/env node
// Comprueba que están TODAS las evidencias antes de dar por bueno un commit.
//
// Existe porque el mismo error ha ocurrido dos veces, y las dos por lo mismo: Cypress vacía la
// carpeta de capturas al empezar cada ejecución (`trashAssetsBeforeRuns`), así que si se corre un
// spec suelto —o uno temporal— quedan solo las suyas. Un `git add -A` después de eso **borra del
// repositorio** las demás sin que nadie lo note: la primera vez se subió la presentación con siete
// huecos y un compañero se la encontró rota; la segunda desaparecieron diez capturas.
//
// El generador de la presentación ya se niega a construir si falta una evidencia, pero eso solo
// protege a la presentación. Esto protege al repositorio.
//
//   node vv/comprobar-evidencias.mjs
//
// Devuelve 1 si falta alguna, con la lista y qué hay que ejecutar para recuperarla.

import { existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Lo que tiene que haber, y de dónde sale cada cosa. */
const ESPERADAS = [
  ['docs/vv/evidencias/cypress/menu.cy.ts/00-pantalla-de-entrada.png', 'npm run e2e'],
  ['docs/vv/evidencias/cypress/menu.cy.ts/01-menu-en-movil-360px.png', 'npm run e2e'],
  ['docs/vv/evidencias/cypress/menu.cy.ts/02-llegada-por-qr.png', 'npm run e2e'],
  ['docs/vv/evidencias/cypress/menu.cy.ts/07-como-se-juega.png', 'npm run e2e'],
  ['docs/vv/evidencias/cypress/partida-local.cy.ts/03-mesa-repartida.png', 'npm run e2e'],
  ['docs/vv/evidencias/cypress/distribuido/malla.cy.ts/04-tres-nodos-convergen.png', 'npm run e2e'],
  ['docs/vv/evidencias/cypress/distribuido/malla.cy.ts/05-cae-un-nodo-los-otros-siguen.png', 'npm run e2e'],
  ['docs/vv/evidencias/cypress/distribuido/malla.cy.ts/06-pantalla-maestra.png', 'npm run e2e'],
  ['docs/vv/evidencias/cypress/distribuido/aforo.cy.ts/09-diez-jugadores.png', 'npm run e2e'],
  ['docs/vv/evidencias/cypress/distribuido/aforo.cy.ts/10-sala-llena.png', 'npm run e2e'],
  ['docs/vv/evidencias/ui/11-ganaste.png', 'capturar la pantalla de victoria del navegador'],
  ['docs/vv/evidencias/ui/12-perdiste.png', 'capturar la pantalla de derrota del navegador'],
  ['docs/vv/evidencias/laboratorio/06-jenkins-pipeline.png', 'capturar el panel de Jenkins a mano'],
  ['docs/vv/evidencias/laboratorio/07-sonarqube-dashboard.png', 'capturar el panel de SonarQube a mano'],
  ['docs/vv/evidencias/laboratorio/08-burp-websockets.png', 'capturar Burp con vv/capturar-ventana.ps1'],
];

const faltan = ESPERADAS.filter(([ruta]) => !existsSync(join(raiz, ruta)));

if (faltan.length === 0) {
  console.log(`  ✓ las ${ESPERADAS.length} evidencias están en su sitio`);
  process.exit(0);
}

console.error(`\n  ✕ faltan ${faltan.length} de ${ESPERADAS.length} evidencias:\n`);
for (const [ruta, comoSeSaca] of faltan) console.error(`      ${ruta}\n        → ${comoSeSaca}`);
console.error(
  '\n  Cypress vacía `docs/vv/evidencias/cypress/` al empezar cada ejecución, así que correr un\n' +
    '  spec suelto deja solo las suyas. Antes de commitear, pasa la suite entera.\n',
);
process.exit(1);
