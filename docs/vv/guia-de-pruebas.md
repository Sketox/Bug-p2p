# Guía de pruebas — cómo se ejecuta todo, y por qué se hizo así

> Esta guía tiene dos mitades y las dos importan. La primera es **operativa**: qué comando corre qué
> y en qué orden. La segunda es la que suele faltar: **por qué cada herramienta está ahí** y qué
> pregunta responde que las demás no pueden.
>
> Para el detalle de resultados, ver el [reporte final](reporte-final.md) y el
> [informe de resultados](informe-pruebas.html). Para el plan formal, el [plan de V&V](plan-vv.md).

---

## Parte 1 · Cómo se ejecuta

### Lo mínimo, en orden

```powershell
npm ci                       # desde el lockfile, no `npm install`

npm run typecheck            # TypeScript estricto en los 4 paquetes Y en cypress/
npm run test:coverage        # 190 unitarias + el lcov combinado
npm run vv:security          # 11 ataques contra la señalización real
npm run vv:distributed       # 7 propiedades distribuidas, con métricas
npm run e2e                  # levanta el stack y corre las 22 de Cypress
```

Cada comando es independiente y se puede correr suelto. El orden de arriba es el del pipeline, y no
es arbitrario: **lo que falla más barato, primero**. No tiene sentido gastar cinco minutos
construyendo Next.js para descubrir después un error de tipos que se detecta en veinte segundos.

### Qué hace cada uno

| Comando | Qué levanta | Cuánto tarda | Qué deja escrito |
|---|---|---|---|
| `npm run typecheck` | nada | ~20 s | — |
| `npm run test:coverage` | nada | ~40 s | `coverage/lcov.info`, `reports/junit-*.xml` |
| `npm run vv:security` | la señalización real en un puerto efímero | ~40 s | `vv/informes/seguridad-*.json` |
| `npm run vv:distributed` | nada (red simulada en memoria) | ~30 s | `vv/informes/distribuida-*.json` |
| `npm run e2e` | señalización + web (`vv/stack.mjs`) | ~6 min | `reports/junit-cypress-*.xml`, capturas en `docs/vv/evidencias/cypress/` |

> **Los informes JUnit solo se generan con `CI=true`.** En local, Vitest imprime en pantalla y ya;
> para producir los XML que lee Jenkins (y que alimentan el informe de resultados):
> `CI=true npm run test:coverage`.

### El laboratorio de calidad (SonarQube + Jenkins)

```powershell
docker compose -f vv/docker-compose.yml up -d      # SonarQube :9000 · Jenkins :8080
node vv/setup.mjs                                  # espera a Sonar, crea el token y lo deja en vv/.env
docker compose -f vv/docker-compose.yml up -d --build jenkins   # que lo recoja
```

`vv/setup.mjs` existe para que montar esto no sea una lista de quince pasos en una wiki que nadie
vuelve a leer: espera a que SonarQube arranque, cambia la contraseña de fábrica, genera el token de
análisis y lo escribe donde Compose lo va a buscar. Es idempotente.

Para lanzar un análisis **a mano** (el pipeline lo hace solo en su etapa 5):

```powershell
npm run test:coverage        # la cobertura tiene que existir ANTES: el escáner no ejecuta pruebas
docker run --rm --network bug-vv_default `
  -v "${PWD}:/usr/src" `
  -e SONAR_HOST_URL=http://sonarqube:9000 `
  -e SONAR_TOKEN=<el de vv/.env> `
  sonarsource/sonar-scanner-cli
```

Credenciales del laboratorio local: Jenkins `admin` / `bug-vv`; SonarQube `admin` con la contraseña
que dejó `setup.mjs` en `vv/.env`.

### Los entregables

```powershell
npm run vv:entregables       # = vv:informe + vv:presentacion
```

- `vv:informe` → `docs/vv/informe-pruebas.html` y `.pdf` — las 230 comprobaciones, una a una.
- `vv:presentacion` → `docs/vv/presentacion.html` y `.pdf` — las diapositivas de defensa.

Ninguno de los dos se escribe a mano: **salen de los artefactos** (los JUnit, los JSON de los bancos
y el `lcov`). Un informe redactado a mano envejece en cuanto alguien toca una prueba; este solo puede
envejecer si se deja de ejecutar — y entonces lo dice su fecha.

### Antes de dar algo por bueno

Un aviso que costó una tarde: **el pipeline clona del repositorio, no de tu carpeta**. Si has
añadido archivos y no los has commiteado, Jenkins no los ve — y falla diciendo la verdad. Lo mismo
vale para el escáner de Sonar, que analiza lo que hay en el clon.

---

## Parte 2 · Por qué cada herramienta

El enunciado nombra cinco componentes obligatorios. Ninguno está por cumplir el expediente: cada uno
responde una pregunta que los otros no pueden.

### El problema de fondo: aquí no hay a quién preguntarle la verdad

En una aplicación con backend, comprobar el estado es fácil: se le pregunta a la base de datos. En
Bug **no hay a quién preguntar**. Hay tres réplicas del estado, una por navegador, y ninguna manda.

Eso convierte la pregunta central de la V&V en una tercera, distinta de las dos clásicas:

- **Verificación** — ¿está bien construido?
- **Validación** — ¿sirve para lo que se pidió?
- **Y aquí además** — **¿siguen todos de acuerdo?**

Con dos agravantes: `RTCPeerConnection` **no existe en Node**, así que la malla de verdad solo se
puede probar dentro de un navegador; y los escenarios que importan —un evento que llega tarde, un
nodo que cae a media elección, dos jugadas en el mismo milisegundo— **no se reproducen a mano: hay
que provocarlos**.

### 4.1 · SonarQube — para lo que las pruebas no pueden ver

Una prueba solo puede juzgar el código **que ejecuta**. El análisis estático lee todo, incluido lo
que nadie llama nunca, y contesta preguntas que las pruebas ni se plantean: ¿hay duplicación? ¿qué
función se ha vuelto impenetrable? ¿cuánta deuda hay? ¿la cobertura sube o baja respecto a la
semana pasada?

Dos decisiones de configuración que conviene poder defender:

- **El monorepo se analiza como UN proyecto**, no como cuatro. Los cuatro paquetes se despliegan
  juntos en la misma imagen y comparten el motor de reglas, así que la duplicación entre `engine` y
  `net` es duplicación de verdad y queremos verla.
- **La cobertura excluye la interfaz**, y cada exclusión lleva su motivo escrito en
  `sonar-project.properties`. Poner un número de cobertura unitaria a un componente React que solo
  falla al pintarse sería medir la sombra del problema; lo prueba Cypress, en un navegador.

*Qué encontró:* 1 bug de accesibilidad (real, corregido cambiando el elemento por un `<dialog>`
nativo) y 22 avisos de `Math.random` que hubo que revisar uno a uno — ninguno explotable, pero uno
de ellos obligó a repasar de dónde sale el secreto de reconexión.

### 4.2 · Jenkins — para que la calidad no dependa de la memoria de nadie

Todo lo anterior existe solo si **se ejecuta**. Sin integración continua, las pruebas se corren
cuando uno se acuerda — o sea, cuando ya sospecha algo. El pipeline por commit convierte 230
comprobaciones en un hábito automático.

Y da algo que ninguna otra herramienta da: **ejecutar en una máquina que no es la tuya**. Buena parte
de los fallos de este semestre eran de la familia "en mi equipo funciona".

Las siete etapas y su criterio están en el [reporte final](reporte-final.md) §3. La única que no
tumba la construcción es la de Sonar, y es una decisión: un servidor de métricas apagado no debería
convertir un commit sano en un commit roto.

*Qué encontró:* que el propio laboratorio no arrancaba. Cuatro fallos encadenados, ninguno visible
leyendo los archivos de configuración (§3.3 del reporte).

### 4.3 · Cypress — porque corre *dentro* del navegador

El enunciado deja elegir entre Selenium y Cypress. Aquí la elección la decidió una necesidad
concreta: para afirmar que **tres réplicas convergieron** hay que leer la huella de estado de cada
nodo, que es un objeto vivo en la memoria de la página.

- **Cypress se ejecuta en el mismo bucle de eventos que la aplicación.** Puede entrar en `window`,
  leer `window.__bug` y comparar las tres huellas directamente.
- **Selenium conduce el navegador desde fuera**, por el protocolo WebDriver: todo lo que quiera leer
  tiene que serializarse por ese puente.
- Y los tres nodos son **iframes del mismo origen** en una sola pestaña, con Cypress hablándole a
  cada uno por separado. Con tres navegadores de verdad, la suite no cabría en un pipeline.

*Qué encontró:* el lobby que no se reabría con StrictMode, el menú que desbordaba a 360 px, y —
montando el arnés — una carrera sobre `sessionStorage` que hacía que dos nodos compartieran nombre.

### 4.4 · Burp Suite — porque un atacante no usa la interfaz

Todas las pruebas anteriores usan el sistema *como está previsto*. Un atacante no: coge un mensaje
del protocolo, lo edita a mano y lo reenvía. Para eso hay que sentarse **en medio del tráfico**, y
eso es Burp — un proxy de interceptación que además **entiende WebSocket**, que es justo por donde
pasa aquí lo único centralizado.

Con *Repeater* se reenvía un mensaje cambiando un campo; con *Intruder* se repite veinte mil veces.
Ninguna prueba unitaria "descubre" un ataque: hay que jugar con el protocolo y ver qué se rompe.

Pero —y esto es la mitad del método— **Burp es con lo que se encuentran los fallos, no con lo que se
vigilan**. Un hallazgo que solo existe en la memoria de quien lo encontró vuelve a aparecer en tres
commits. Por eso los once ataques están escritos en `vv/security/attack-suite.mjs` y corren en cada
construcción contra el servidor real. La guía para reproducirlos a mano está en
[`seguridad-burp.md`](seguridad-burp.md).

*Qué encontró:* 6 vulnerabilidades, dos críticas. La peor, `S8`: un mensaje de cuarenta caracteres
enviado desde la consola del navegador **mataba el proceso** del servidor.

### 4.5 · Banco propio — porque nadie vende un medidor de *tu* protocolo

Sonar mide código, Cypress conduce navegadores, Burp manipula tráfico. Ninguno sabe qué es "el
testigo de turno de Bug" ni qué significa que dos réplicas hayan convergido. Esas propiedades **son
del diseño**, así que el instrumento hay que escribirlo.

`vv/distributed/validate.ts` monta una **red simulada con reloj virtual**: elige latencias de 5 a
120 ms, duplica entregas, reordena mensajes y provoca caídas encadenadas. Cosas que en una red de
verdad ocurren una vez cada mil partidas y nunca cuando estás mirando.

Y no devuelve un verde: devuelve **números**. El enunciado pide medir latencia y tiempos de
respuesta, no aprobar.

*Qué encontró:* además de verificar las siete propiedades, que **uno de sus propios criterios estaba
mal** — D7 medía el reloj de la máquina en vez del trabajo del algoritmo, y fallaba con el portátil
cargado aunque las réplicas hubieran convergido perfectamente.

---

## Parte 3 · Cómo se decide qué prueba va en qué capa

La regla es sencilla: **cada cosa se prueba en el nivel más barato donde se pueda afirmar de verdad**.

| Si lo que quieres afirmar… | Va en | Por qué |
|---|---|---|
| depende solo de las reglas del juego | `engine/test/` | Es puro: mismo input, mismo output, sin red ni reloj |
| depende del protocolo o de un algoritmo distribuido | `net/test/` | Malla simulada + reloj virtual: se pueden provocar carreras a voluntad |
| depende del servidor real (aforo, guardas, identidad) | `signaling/test/` | Se levanta el servidor de verdad en un puerto efímero |
| depende de cómo se pinta o de un ciclo de vida de React | `cypress/e2e/` | Solo se ve en un navegador; ahí aparecieron sus fallos |
| depende de que haya **varias** `RTCPeerConnection` de verdad | `cypress/e2e/distribuido/` | Es la única capa que puede: no existe en Node |
| depende de cuánta gente cabe, y de qué ve el que no cabe | `cypress/e2e/distribuido/aforo.cy.ts` | Diez navegadores son 45 canales: el servidor solo no lo demuestra |
| es una propiedad del sistema con métrica | `vv/distributed/` | Hace falta controlar la red y medir, no solo pasar |
| es un abuso del protocolo | `vv/security/` | Hay que hablarle al servidor fuera de lo previsto |

Y el corolario, que es la conclusión del semestre: de los 17 defectos encontrados, **11 eran
invisibles para una prueba unitaria**. No es un argumento contra las unitarias —son 190 y sostienen
el motor y los algoritmos— sino contra leerlas como si fueran la V&V entera.

---

## Si algo va mal

| Síntoma | Causa probable |
|---|---|
| `npm run e2e` se queda esperando y muere a los 5 min | La señalización no arrancó. Compruébala suelta: `npm run signaling` y `curl localhost:8787/health` |
| Cypress falla solo en el primer caso de `malla.cy.ts` | Arranque en frío de `next dev` con la máquina cargada. La espera es de 60 s; si tarda más, no es la prueba |
| El pipeline falla en Sonar o en la validación distribuida | Casi siempre, trabajo sin commitear: el job clona del repo |
| SonarQube pide login para ver el panel | `sonar.forceAuthentication` está en `true`. En el laboratorio local se puede poner en `false` para proyectarlo |
| Jenkins arranca y el job no existe | Falló el Job DSL: `docker logs bug-jenkins \| grep SEVERE` |
| Jenkins responde **431 Request Header Fields Too Large** | Cookies de otros proyectos abiertos en `localhost`. El navegador manda las de *todos* los puertos del mismo dominio, y suman más de lo que Jetty acepta por defecto. Ya está subido a 64 KB en `vv/docker-compose.yml` (`JENKINS_OPTS`); si aun así aparece, borra las cookies de `localhost` o ábrelo en una ventana privada |
