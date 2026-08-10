#!/usr/bin/env node
// Prepara el laboratorio de V&V: espera a que SonarQube arranque, le cambia la contraseña por
// defecto, genera un token de análisis y lo deja en `vv/.env` para que Jenkins lo recoja.
//
// Existe para que montar todo esto no sea una lista de quince pasos manuales en una wiki que nadie
// vuelve a leer. Es idempotente: si el token ya existe, lo revoca y crea uno nuevo.
//
//   docker compose -f vv/docker-compose.yml up -d
//   node vv/setup.mjs
//
// Después, `docker compose -f vv/docker-compose.yml up -d --force-recreate jenkins` para que
// Jenkins arranque con la credencial puesta.

import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const aquí = dirname(fileURLToPath(import.meta.url));
const SONAR = process.env.SONAR_URL ?? 'http://localhost:9000';
const USUARIO = 'admin';
const CLAVE_INICIAL = 'admin';
// SonarQube obliga a cambiar la contraseña por defecto antes de dejar hacer nada, y su política
// —que solo cuenta al rechazarla, una regla por intento— pide 12 caracteres, una mayúscula, una
// minúscula, un número y un símbolo.
const CLAVE = process.env.SONAR_PASSWORD ?? 'Bug-VV-2026-lab!';
const NOMBRE_TOKEN = 'bug-p2p-ci';

const auth = (clave) => 'Basic ' + Buffer.from(`${USUARIO}:${clave}`).toString('base64');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function esperarASonar() {
  process.stdout.write('esperando a SonarQube');
  const limite = Date.now() + 5 * 60_000;
  for (;;) {
    try {
      const r = await fetch(`${SONAR}/api/system/status`);
      const { status } = await r.json();
      if (status === 'UP') {
        console.log(' — listo');
        return;
      }
      process.stdout.write(`.${status === 'STARTING' ? '' : status}`);
    } catch {
      process.stdout.write('.');
    }
    if (Date.now() > limite) throw new Error('SonarQube no arrancó en 5 minutos');
    await sleep(3000);
  }
}

/** Prueba las dos contraseñas posibles: la de fábrica (primer arranque) y la nuestra. */
async function claveQueFunciona() {
  for (const clave of [CLAVE, CLAVE_INICIAL]) {
    const r = await fetch(`${SONAR}/api/authentication/validate`, {
      headers: { Authorization: auth(clave) },
    });
    const { valid } = await r.json();
    if (valid) return clave;
  }
  throw new Error(
    'ni la contraseña de fábrica ni la del laboratorio sirven. ¿Se cambió a mano? ' +
      'Pásala en SONAR_PASSWORD.',
  );
}

async function main() {
  await esperarASonar();

  let clave = await claveQueFunciona();
  if (clave === CLAVE_INICIAL) {
    const r = await fetch(
      `${SONAR}/api/users/change_password?login=${USUARIO}&previousPassword=${CLAVE_INICIAL}&password=${encodeURIComponent(CLAVE)}`,
      { method: 'POST', headers: { Authorization: auth(CLAVE_INICIAL) } },
    );
    if (!r.ok && r.status !== 204) {
      throw new Error(`no se pudo cambiar la contraseña: ${r.status} ${await r.text()}`);
    }
    console.log(`contraseña de admin cambiada a "${CLAVE}"`);
    clave = CLAVE;
  }

  // Token nuevo. Si ya había uno con este nombre se revoca: no se pueden leer dos veces.
  await fetch(`${SONAR}/api/user_tokens/revoke?name=${NOMBRE_TOKEN}`, {
    method: 'POST',
    headers: { Authorization: auth(clave) },
  });
  const r = await fetch(`${SONAR}/api/user_tokens/generate?name=${NOMBRE_TOKEN}`, {
    method: 'POST',
    headers: { Authorization: auth(clave) },
  });
  if (!r.ok) throw new Error(`no se pudo generar el token: ${r.status} ${await r.text()}`);
  const { token } = await r.json();

  const env = resolve(aquí, '.env');
  const previo = existsSync(env)
    ? readFileSync(env, 'utf8')
        .split(/\r?\n/)
        .filter((l) => l && !l.startsWith('SONAR_TOKEN=') && !l.startsWith('SONAR_PASSWORD='))
    : [];
  writeFileSync(
    env,
    [...previo, `SONAR_TOKEN=${token}`, `SONAR_PASSWORD=${CLAVE}`, ''].join('\n'),
    'utf8',
  );

  console.log(`token de análisis escrito en ${env}`);
  console.log('\nsiguiente paso:');
  console.log('  docker compose -f vv/docker-compose.yml up -d --build jenkins');
  console.log(`  (Jenkins en http://localhost:8080 — admin / bug-vv)`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
