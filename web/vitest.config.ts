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
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./', import.meta.url)),
    },
  },
});
