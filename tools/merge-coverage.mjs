#!/usr/bin/env node
// Junta los `lcov.info` de los cuatro workspaces en uno solo, en `coverage/lcov.info`.
//
// Por qué hace falta: SonarQube analiza el monorepo entero como un proyecto, pero vitest corre una
// vez por workspace y deja un informe en cada uno. Y hay un detalle que rompe el análisis si no se
// arregla: v8 escribe las rutas en ABSOLUTO y con separadores de Windows
// (`SF:C:\devu\uno-p2p\engine\src\game.ts`). Si el escáner corre dentro de un contenedor, ese
// fichero no existe en su sistema de archivos y Sonar reporta 0 % de cobertura sin decir por qué.
//
// Así que reescribimos cada `SF:` a una ruta relativa a la raíz del repo y con `/`, que es lo que
// Sonar sabe resolver contra `sonar.projectBaseDir` corra donde corra.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workspaces = ['engine', 'net', 'signaling', 'web'];

const out = [];
const found = [];
const missing = [];

for (const ws of workspaces) {
  const report = resolve(repoRoot, ws, 'coverage', 'lcov.info');
  if (!existsSync(report)) {
    missing.push(ws);
    continue;
  }
  found.push(ws);
  const text = readFileSync(report, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('SF:')) {
      const raw = line.slice(3).trim();
      // Las rutas relativas del informe lo son al workspace, no al repo.
      const absolute = resolve(repoRoot, ws, raw);
      out.push(`SF:${relative(repoRoot, absolute).split('\\').join('/')}`);
    } else {
      out.push(line);
    }
  }
}

if (found.length === 0) {
  console.error('[cobertura] no hay ningún lcov.info. ¿Corriste `npm run test:coverage`?');
  process.exit(1);
}

mkdirSync(resolve(repoRoot, 'coverage'), { recursive: true });
writeFileSync(resolve(repoRoot, 'coverage', 'lcov.info'), out.join('\n'), 'utf8');

const files = out.filter((l) => l.startsWith('SF:')).length;
console.log(`[cobertura] coverage/lcov.info — ${files} ficheros de ${found.join(', ')}`);
if (missing.length) console.log(`[cobertura] sin informe (se ignoran): ${missing.join(', ')}`);
