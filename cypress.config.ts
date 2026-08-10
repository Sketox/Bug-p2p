import { defineConfig } from 'cypress';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

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
      // Pasar el tráfico por Burp, cuando se le pide.
      //
      //   BURP_PROXY=127.0.0.1:8081 npm run e2e
      //
      // Sirve para llenar el histórico de Burp con tráfico de verdad —tres jugadores entrando a una
      // sala— en vez de tener que jugar a mano para tener algo que interceptar.
      //
      // `--proxy-bypass-list=<-loopback>` no es opcional: Chrome se salta el proxy para `localhost`
      // por su cuenta, así que sin esto el juego se abre igual y por Burp no pasa ni un byte, sin
      // ningún aviso.
      on('before:browser:launch', (_navegador, opciones) => {
        const proxy = process.env.BURP_PROXY;
        if (proxy && Array.isArray(opciones.args)) {
          opciones.args.push(`--proxy-server=${proxy}`, '--proxy-bypass-list=<-loopback>');
        }
        return opciones;
      });

      // Los JUnit llevan un hash en el nombre —hace falta, porque si no los specs se pisarían el
      // archivo entre ellos— y por eso se acumulan ejecución tras ejecución. Sin limpiarlos, la
      // carpeta acaba mezclando el resultado de hoy con el de un run de hace tres horas que falló,
      // y cualquiera que lea `reports/` (o el informe que se genera a partir de ahí) ve fallos que
      // ya no existen. Se borran al empezar: lo que quede dentro es siempre esta ejecución.
      on('before:run', () => {
        const dir = resolve('reports');
        if (!existsSync(dir)) return;
        for (const f of readdirSync(dir)) {
          if (f.startsWith('junit-cypress-') && f.endsWith('.xml')) rmSync(join(dir, f));
        }
      });

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
    //
    // La subcarpeta `cypress/` importa: vaciar es vaciar, y con esto apuntando a `evidencias/` a
    // secas se llevó por delante las capturas del laboratorio (el panel de Sonar, la construcción
    // de Jenkins) que viven en `evidencias/laboratorio/` y no las produce nadie automáticamente.
    screenshotsFolder: 'docs/vv/evidencias/cypress',
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
