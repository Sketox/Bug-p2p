import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const monorepoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Salida autocontenida para la imagen de Docker: Next emite un `server.js` con solo las
  // dependencias que de verdad usa, en vez de arrastrar el `node_modules` entero del monorepo.
  output: 'standalone',
  // Sin esto, Next busca la raíz del proyecto y se equivoca en un monorepo con workspaces.
  outputFileTracingRoot: monorepoRoot,
  // El motor se distribuye como TypeScript sin compilar; Next lo transpila.
  transpilePackages: ['@bug/engine', '@bug/net'],
  webpack: (config) => {
    // El motor usa imports ESM con extensión explícita (`./rng.js`); permitir que
    // webpack los resuelva contra los fuentes `.ts`.
    config.resolve.extensionAlias = {
      '.js': ['.ts', '.tsx', '.js'],
      '.mjs': ['.mts', '.mjs'],
    };
    return config;
  },
};

export default nextConfig;
