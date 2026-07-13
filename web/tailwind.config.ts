import type { Config } from 'tailwindcss';

// Paleta de "Bug" (de la propuesta de diseño).
const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        code: '#50C878', // 🟢 Código
        hardware: '#C9CDD4', // ⬜ Hardware (plata)
        internet: '#1E90FF', // 🔵 Internet
        survival: '#FF7F50', // 🟠 Supervivencia
        wildk: '#1b1b23', // comodines negros
        felt: '#0f2e22', // paño de la mesa
        ink: '#1a1130',
      },
      fontFamily: {
        pixel: ['"Press Start 2P"', 'ui-monospace', 'monospace'],
      },
      boxShadow: {
        pixel: '4px 4px 0 0 rgba(0,0,0,0.45)',
      },
    },
  },
  plugins: [],
};

export default config;
