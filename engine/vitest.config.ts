import { defineConfig } from 'vitest/config';

// El motor es código puro: entra un estado y un evento, sale otro estado. No hay red ni DOM que
// simular, así que la cobertura de este paquete es la que más significa de las cuatro — si una
// rama de las reglas no está cubierta, es que nadie la ha probado.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Informe JUnit solo en CI: es lo que lee Jenkins para enseñar el detalle prueba a prueba.
    // Los cuatro paquetes escriben en la misma carpeta `reports/` de la raíz.
    reporters: process.env.CI ? ['default', 'junit'] : ['default'],
    outputFile: { junit: '../reports/junit-engine.xml' },

    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'lcov'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      // `index.ts` solo reexporta; contarlo infla el número sin probar nada.
      exclude: ['src/index.ts'],
    },
  },
});
