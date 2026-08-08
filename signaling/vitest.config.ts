import { defineConfig } from 'vitest/config';

// Los tests de señalización levantan el servidor de verdad en el puerto 0 y le hablan por WebSocket
// (no hay dobles), así que la cobertura mide el camino real del servidor.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Informe JUnit solo en CI: es lo que lee Jenkins para enseñar el detalle prueba a prueba.
    // Los cuatro paquetes escriben en la misma carpeta `reports/` de la raíz.
    reporters: process.env.CI ? ['default', 'junit'] : ['default'],
    outputFile: { junit: '../reports/junit-signaling.xml' },

    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'lcov'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
    },
  },
});
