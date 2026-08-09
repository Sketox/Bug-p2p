import { defineConfig } from 'cypress';

// Pruebas funcionales de extremo a extremo. (Componente 4.3 del enunciado.)
//
// Dos familias, y la diferencia importa:
//
//   `e2e/*.cy.ts`          — flujos de un usuario contra la aplicación real.
//   `e2e/distribuido/*`    — varios nodos a la vez, con WebRTC de verdad entre ellos. Es la parte
//                            que ningún test unitario puede cubrir: `RTCPeerConnection` no existe
//                            en Node, así que la malla solo se prueba de verdad en un navegador.
export default defineConfig({
  e2e: {
    setupNodeEvents(on) {
      // `cy.task('log', …)` imprime en la terminal, no solo en el navegador: es la única forma de
      // ver lo que pasa dentro de un iframe cuando la ejecución es sin interfaz.
      on('task', {
        log(mensaje: string) {
          // eslint-disable-next-line no-console
          console.log(mensaje);
          return null;
        },
      });
    },
    baseUrl: 'http://localhost:3000',
    specPattern: 'cypress/e2e/**/*.cy.ts',
    supportFile: 'cypress/support/e2e.ts',
    // La malla necesita su tiempo: abrir un DataChannel entre dos contextos son varios viajes de
    // ida y vuelta (oferta, respuesta, candidatos ICE), y con tres nodos son tres canales.
    defaultCommandTimeout: 12_000,
    pageLoadTimeout: 60_000,
    video: false,
    screenshotOnRunFailure: true,
    // Las capturas van a `docs/vv/evidencias/` y no a un rincón de `cypress/`, porque son un
    // entregable —"evidencias visuales y capturas del sistema"— y no un residuo de la ejecución.
    // Cypress vacía esta carpeta antes de cada run (`trashAssetsBeforeRuns`), así que lo que hay
    // dentro es siempre lo que produjo la última ejecución, no un archivo histórico que envejece.
    // Las capturas de los fallos caen aquí también, y está bien: llevan `(failed)` en el nombre y
    // son la evidencia más útil de todas.
    screenshotsFolder: 'docs/vv/evidencias',
    // Informe JUnit para que Jenkins muestre el detalle prueba a prueba, igual que con Vitest.
    reporter: 'junit',
    reporterOptions: {
      mochaFile: 'reports/junit-cypress-[hash].xml',
      toConsole: true,
    },
    retries: { runMode: 1, openMode: 0 },
    viewportWidth: 1280,
    viewportHeight: 900,
  },
});
