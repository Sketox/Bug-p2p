import { defineConfig } from 'vitest/config';

// La capa de red se prueba en memoria: los tests montan mallas simuladas con reloj virtual, así
// que la cobertura aquí sí es medible. La excepción es `room.ts`: la mitad de su cuerpo habla con
// `RTCPeerConnection`, que no existe en Node — esa parte la cubre Cypress contra navegadores de
// verdad, y se declara excluida de cobertura en Sonar en vez de fingir que la tocan las unitarias.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Informe JUnit solo en CI: es lo que lee Jenkins para enseñar el detalle prueba a prueba.
    // Los cuatro paquetes escriben en la misma carpeta `reports/` de la raíz.
    reporters: process.env.CI ? ['default', 'junit'] : ['default'],
    outputFile: { junit: '../reports/junit-net.xml' },

    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'lcov'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts'],
    },
  },
});
