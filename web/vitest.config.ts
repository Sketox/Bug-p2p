import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Tests del workspace `web`. Aquí no se prueba la UI (eso es Cypress, en el bloque de V&V), sino
// la lógica que la UI usa y que sí tiene reglas propias: qué URLs de señalización se aceptan al
// entrar por un QR, y qué efecto dispara cada carta.
//
// No hace falta un DOM simulado: esa lógica es pura y el navegador entra por parámetro — el mismo
// criterio con el que el detector de fallos recibe el reloj en vez de leerlo.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Informe JUnit solo en CI: es lo que lee Jenkins para enseñar el detalle prueba a prueba.
    // Los cuatro paquetes escriben en la misma carpeta `reports/` de la raíz.
    reporters: process.env.CI ? ['default', 'junit'] : ['default'],
    outputFile: { junit: '../reports/junit-web.xml' },

    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'lcov'],
      reportsDirectory: './coverage',
      // Solo `lib/`: los componentes y las pantallas los prueba Cypress contra un navegador de
      // verdad, que es donde aparecieron sus bugs (el lobby que no reabría, la tarjeta que
      // desbordaba a 360 px). Medirlos con unitarias daría un número peor Y una prueba peor.
      include: ['lib/**/*.ts'],
    },
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./', import.meta.url)),
    },
  },
});
