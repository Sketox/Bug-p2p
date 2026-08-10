# Reporte técnico final de V&V — Bug

> Sistema bajo prueba: **Bug**, juego de cartas distribuido sin servidor de partida.
> Documento de cierre del bloque de *Gestión para la Verificación y Validación del Software*.
> Acompaña al [Plan de V&V](plan-vv.md) y a la [Matriz de trazabilidad](matriz-trazabilidad.md).

## 1. Resumen ejecutivo

| Componente obligatorio | Herramienta | Resultado | Estado |
|---|---|---|---|
| 4.1 Calidad de código | SonarQube Community Build 26.8.0 | *(§2)* | ✅ |
| 4.2 Integración continua | Jenkins 2.568 LTS (JDK 21) | 7 etapas en verde en 7,2 min, por commit | ✅ |
| 4.3 Pruebas automatizadas | Cypress 13.17 + Vitest 2.1 | 19 E2E + 190 unitarias, 0 fallos | ✅ |
| 4.4 Seguridad | Burp Suite Community + banco propio | 11 ataques, 11 bloqueados, 6 vulnerabilidades corregidas | ✅ |
| 4.5 Validación distribuida | Banco propio con métricas | 7 de 7 propiedades verificadas | ✅ |
| 5 Documentación | — | Plan, matriz, reporte, guía de Burp, evidencias | ✅ |

**227 comprobaciones automatizadas** vigilan el sistema, y todas corren en el mismo pipeline: 190
unitarias, 19 funcionales en navegador, 11 ataques de seguridad y 7 propiedades distribuidas.

La conclusión que más peso tiene no es ninguno de esos números, sino de dónde salieron los defectos.
De los **dieciséis fallos** registrados en este proyecto, **once no eran detectables por una prueba
unitaria**: aparecieron al ejecutar en un navegador real, al jugar una partida entera o al atacar el
servidor a mano con Burp. Es el argumento que sostiene la forma de la estrategia de pruebas (§8).

Dos de esos defectos los encontró **el propio montaje de la V&V**, y no el producto en uso: un
`/health` que no atendía `HEAD` y una carrera en el arnés de tres nodos (§7). A ellos se suma algo
que no es un defecto del sistema pero sí del proceso: un **criterio de aceptación** que medía el
reloj de la máquina en vez del algoritmo (§6, D7). Montar el control de calidad es también
ejercitarlo.

## 2. Calidad de código — SonarQube

### 2.1 Configuración

El monorepo se analiza como **un solo proyecto**, no como cuatro. Es deliberado: los cuatro
*workspaces* se despliegan juntos en la misma imagen y comparten el motor de reglas, así que la
duplicación entre `engine` y `net` es duplicación de verdad y queremos verla. La configuración está
en `sonar-project.properties`, con cada exclusión acompañada de su motivo.

```
sonar.projectKey=bug-p2p
sonar.sources=engine/src,net/src,signaling/src,web/app,web/components,web/lib,docker,tools
sonar.tests=engine/test,net/test,signaling/test,web/test,cypress/e2e
sonar.javascript.lcov.reportPaths=coverage/lcov.info
```

El laboratorio se levanta con `docker compose -f vv/docker-compose.yml up -d` (SonarQube en el
9000, Jenkins en el 8080) y `node vv/setup.mjs`, que espera a que SonarQube arranque, cambia la
contraseña de fábrica, genera el token de análisis y lo deja donde Jenkins lo recoge. Existe para
que montar esto no sea una lista de quince pasos en una wiki que nadie vuelve a leer.

### 2.2 Cobertura medida

El `lcov` es uno solo, combinado por `tools/merge-coverage.mjs` con rutas relativas al repositorio,
porque Sonar analiza un proyecto y Vitest genera cuatro informes.

| Paquete | Cobertura de líneas | Umbral del plan | |
|---|---|---|---|
| `engine/src` | **93,13 %** (434/466) | ≥ 90 % | ✅ |
| `net/src` | **98,06 %** (304/310) | ≥ 85 % | ✅ |
| `signaling/src` | 83,03 % (225/271) | — | ✅ |
| `web/lib` | 64,65 % (128/198) | — (lo cubre Cypress) | ✅ |
| **Conjunto medido** | **87,63 %** (1091/1245) | — | |

Lo que queda fuera de la medición, y por qué — porque una exclusión sin motivo es una cifra
maquillada:

| Excluido | Líneas | Motivo |
|---|---|---|
| `web/lib/useBugRoom.ts` | 678 | Orquesta el ciclo de vida de React sobre WebRTC. Lo prueba Cypress. |
| `web/lib/pixiEffects.ts` | 214 | Necesita WebGL. |
| `net/src/room.ts` | 348 | Habla con `RTCPeerConnection`, que no existe en Node. |
| `signaling/src/smoke.ts` | 60 | Utilidad de desarrollo; no se despliega. |
| `web/lib/useBugGame.ts` | 43 | Igual que `useBugRoom`. |

Un matiz que conviene decir, porque juega en contra de la comodidad del número: `net/src/room.ts`
está excluido de la exigencia, pero los tests de malla simulada **sí lo recorren**, y lo dejan en
**320/348 líneas (92 %)**. Está excluido porque su parte de transporte no se puede afirmar desde
Node, no porque no se pruebe.

### 2.3 Métricas de calidad técnica

> Análisis del **2026-08-08** sobre el commit `3599411`, contra SonarQube 26.8.0 en el laboratorio
> local (`npm run test:coverage && sonar-scanner`), que es también la etapa *Calidad* del pipeline.

| Métrica | Valor | Umbral del plan | |
|---|---|---|---|
| **Quality gate** | **Passed** | — | ✅ |
| Líneas de código analizadas | 5 406 | — | |
| **Cobertura** (según Sonar, con sus exclusiones) | **89,0 %** · 100 % sobre el código nuevo | — | ✅ |
| **Bugs** | **0** · fiabilidad **A** | 0 de severidad alta | ✅ |
| **Vulnerabilidades** | **22** (todas la misma regla; analizadas abajo) | 0 | ⚠️ |
| *Security hotspots* | 0 | — | ✅ |
| *Code smells* | 161 · deuda técnica ≈ 750 min · calificación **A** | — | ✅ |
| **Duplicación** | **1,3 %** · 0,0 % sobre el código nuevo | < 3 % | ✅ |
| Complejidad ciclomática | 1 410 | — | |
| Complejidad cognitiva | 967 | — | |

El *quality gate* **no pasó a la primera**, y vale la pena contar por qué: falló con dos incidencias
sobre código nuevo… que había introducido la corrección del párrafo siguiente. Un análisis estático
también reacciona a lo que uno acaba de escribir para contentarlo.

**El bug (`typescript:S1082`)** estaba en el fondo del diálogo de jugada: cerraba al pulsarlo con el
ratón y no ofrecía nada equivalente por teclado. La regla tenía razón, y los dos parches evidentes
resultaron ser callejones sin salida:

1. Un `onKeyDown` en el `<div>` habría satisfecho la regla **sin funcionar nunca**: un `div` sin
   foco no recibe teclado.
2. Declararlo `role="presentation"` —que era honesto: el velo no es un control— cambió una queja
   por otras dos (`S6819`, y la original seguía).

La señal de que el arreglo estaba en otro sitio era esa: el elemento era el equivocado. Ahora es un
**`<dialog>` nativo** abierto con `showModal()`, que trae hecho lo que se estaba imitando a mano —
cierra con `Escape`, atrapa el foco, se anuncia como diálogo y pinta su propio `::backdrop`. Las 19
pruebas de Cypress pasaron sin tocarlas, que era la condición para dar el cambio por bueno.

Quedaron **dos incidencias que se marcaron como falso positivo, con la justificación escrita en
SonarQube**: el analizador trata el `<dialog>` como un elemento no interactivo y se queja de su
`onClick` — el que detecta el clic en el backdrop para cerrar, que es el patrón documentado por MDN.
Un `<dialog>` es interactivo por definición. Gestionar hallazgos incluye decidir cuáles no son
defectos; lo que no se puede es dejarlos sin mirar ni sin motivo.

Y un tercero, que sale de escribir en español: la regla `S1135` marcó un `TODO` pendiente donde el
comentario decía *"lo que **todo** el mundo intenta primero"*. Las reglas de análisis estático están
escritas para código comentado en inglés.

**Las 22 vulnerabilidades son la misma regla** (`typescript:S2245`, *"make sure that using this
pseudorandom number generator is safe here"*) sobre `Math.random`. Revisadas una a una, porque un
número que no se mira no significa nada:

| Dónde | Nº | Para qué | Veredicto |
|---|---|---|---|
| `web/lib/pixiEffects.ts` | 16 | Posición y velocidad de las partículas de los efectos | Decorativo. Sin efecto sobre el juego |
| `web/lib/useBugRoom.ts` | 2 | Código de sala (4 letras) y semilla de la partida | **Públicos por diseño**: el código se enseña en pantalla y la semilla la conocen los tres nodos — es lo que hace que todos calculen la misma partida |
| `net/src/room.ts` | 1 | Etiqueta para deduplicar los relays de la malla | No es seguridad: solo tiene que no repetirse |
| `web/lib/useBugGame.ts` | 1 | Semilla de la partida local (hot-seat) | Sin red de por medio |
| `web/lib/uid.ts` | 2 | **Último recurso** de `uid()`, que genera identidades **y el `secret` de reconexión** | El único que importaba (§5, S3). Analizado abajo |
| `docker/gateway.mjs` | 1 (menor) | Aviso sobre `PATH` en el arranque del contenedor | Ruta fija del contenedor |

El caso de `uid.ts` es el único que merecía dudar, y por eso se persiguió hasta el final: desde la
corrección de S3, esa función genera el secreto que impide echar a un jugador de su propia partida.
Un secreto predecible reabriría el ataque. Pero sus dos primeras ramas —`crypto.randomUUID` y
`crypto.getRandomValues`— son criptográficamente seguras, y la tercera es **inalcanzable para
cualquiera que pueda jugar**: un navegador sin `crypto.getRandomValues` es anterior a 2011 y
tampoco tiene `RTCPeerConnection`, así que no llega a entrar en una sala. Se deja como último
recurso para que la página no muera con una excepción — que es exactamente lo que hacía antes.

Conclusión: **0 vulnerabilidades explotables**, 22 avisos de una regla que no puede distinguir un
dado de una clave. Es la diferencia entre leer un informe y creérselo. Lo que sí se corrigió es la
documentación de `uid()`, que seguía diciendo que no servía "para nada secreto" cuando desde S3 sí
genera uno: un comentario que contradice al código es un defecto con retardo.

## 3. Integración continua — Jenkins

### 3.1 El pipeline

`Jenkinsfile`, siete etapas, ordenadas por **lo que falla más barato primero**: no tiene sentido
gastar cinco minutos construyendo Next.js para descubrir después que hay un error de tipos que se
detecta en veinte segundos.

| # | Etapa | Qué hace | Si falla |
|---|---|---|---|
| 1 | Dependencias | `npm ci` desde el lockfile, no `npm install` | rojo |
| 2 | Tipos | `tsc --noEmit` en los 4 workspaces **y en `cypress/`** | rojo |
| 3 | Pruebas + cobertura | Vitest ×4 + JUnit + `lcov` combinado | rojo |
| 4 | Build | `next build` y compilación de los paquetes | rojo |
| 5 | Calidad (SonarQube) | `sonar-scanner` con el token de `vv/setup.mjs` | **inestable** |
| 6 | Seguridad | `npm run vv:security` — 11 ataques contra la señalización real | rojo |
| 7 | Validación distribuida | `npm run vv:distributed` — 7 propiedades con métricas | rojo |

La etapa 5 es la única que no tumba la construcción, y es una decisión, no un descuido: si el
laboratorio de calidad está apagado, un commit sano no debería convertirse en un commit roto por
eso. Se marca **inestable** (amarillo): falta un dato, no sobra un defecto. La contrapartida de esa
tolerancia se cobró durante este cierre —el token no llegaba al contenedor y el síntoma era
idéntico al del laboratorio apagado, §3.3— y por eso queda como propuesta de mejora (§9).

### 3.2 Ejecución por cada commit

El requisito del enunciado es *"ejecución del pipeline por cada commit realizado"*. Se cumple con
`pollSCM` cada minuto, configurado como código en `vv/jenkins/casc.yaml` (Jenkins Configuration as
Code) — no a mano en la interfaz, para que el laboratorio se pueda reconstruir desde cero.

El repositorio se monta **en solo lectura** dentro del contenedor (`/repo-src`) y el job clona
desde ahí. Clonar en vez de construir sobre el propio directorio de trabajo es a propósito: si el
pipeline ensuciara el árbol desde el que se está desarrollando, el "pipeline por cada commit"
dejaría de ser reproducible.

### 3.3 Lo que costó que arrancara, y por qué se cuenta

El pipeline estaba escrito desde hacía semanas, pero **el laboratorio nunca se había levantado de
verdad**. Al hacerlo aparecieron cuatro fallos encadenados —cada uno tapado por el anterior, que
es como suelen venir— y ninguno se habría visto leyendo los archivos de configuración:

1. **Jenkins no arrancaba.** El Job DSL de `casc.yaml` usaba la forma *dinámica*
   (`cpsScmFlowDefinition` + `scmGit { remotes { … } }`), que el plugin genera a partir de los
   descriptores instalados. Con las versiones actuales, `remotes` no existe en ese contexto: el DSL
   falla, Configuration-as-Code se cae con él y Jenkins muere en el arranque (`BootFailure`,
   contenedor en `Exited (5)`). Reescrito con el DSL *estático* (`cpsScm` + `git { remote { … } }`),
   que es API documentada y no se mueve entre versiones.
2. **La configuración corregida no llegaba.** `casc.yaml` se copiaba a `/var/jenkins_home`, que es
   un volumen: Docker vuelca ahí el contenido de la imagen la primera vez y a partir de entonces
   manda el volumen. Corregir el YAML y reconstruir no servía de nada. Ahora vive en
   `/usr/share/jenkins/ref/`, fuera del volumen.
3. **La primera construcción moría en el checkout.** El plugin de Git se niega a clonar de una ruta
   local (`/repo-src`) porque en un Jenkins compartido un job podría leer así el espacio de trabajo
   de otro. Aquí ese "otro" no existe, así que se habilita explícitamente con
   `-Dhudson.plugins.git.GitSCM.ALLOW_LOCAL_CHECKOUT=true`.
4. **Y la siguiente moría en el mismo sitio, un paso más adentro.** Superado el bloqueo del plugin,
   quien se negaba era Git: el repo montado pertenece a otro usuario que el `jenkins` del
   contenedor, y un repositorio ajeno puede traer configuración que ejecuta comandos (*"detected
   dubious ownership"*). Se declara la excepción para esa ruta con `git config --system`, y el
   `--system` no es un detalle: `--global` escribe en `$HOME`, que es otra vez el volumen, y la
   corrección no habría llegado nunca a un laboratorio ya creado. El mismo error del punto 2, con
   otro disfraz.

Y uno más, silencioso, que es el que peor habría envejecido: el token de Sonar se generaba en
`vv/.env`, pero ese archivo solo alimenta la **interpolación del YAML** de Compose — no entra en el
contenedor. `casc.yaml` resolvía `${SONAR_TOKEN:-}` a cadena vacía, así que Jenkins habría saltado
la etapa de calidad en cada construcción marcándola *inestable*… exactamente igual que si el
laboratorio estuviera apagado. Un fallo que se disfraza del comportamiento tolerado es peor que uno
ruidoso: nadie lo investiga.

### 3.4 La construcción, ejecutada

Con los cuatro fallos corregidos y el trabajo ya versionado, el pipeline completo pasa:

| | |
|---|---|
| Resultado | **SUCCESS** — las 7 etapas |
| Duración | 7,2 min |
| Pruebas publicadas | 190, sin fallos |
| Análisis de Sonar | lanzado desde la etapa 5, `ANALYSIS SUCCESSFUL` |
| Seguridad | 11/11 ataques bloqueados |
| Validación distribuida | 7/7 propiedades verificadas |
| Artefactos archivados | `lcov.info`, `seguridad-*.json`, `distribuida-*.json` |

La evidencia está en `docs/vv/evidencias/laboratorio/06-jenkins-pipeline.png`.

Un detalle del montaje que conviene decir: las dos primeras ejecuciones fallaron en las etapas 5 y 7
**porque el trabajo de V&V todavía no estaba en un commit**. El job clona del repositorio, no del
árbol de trabajo — que es exactamente lo que debe hacer, y la razón por la que se clona en vez de
construir sobre el directorio de desarrollo (§3.2). Sonar no encontraba `cypress/e2e` y el
`package.json` clonado seguía apuntando a un `validate.mjs` que ya no existía. El pipeline estaba
diciendo la verdad: lo que no está commiteado, no está.

Los informes JUnit de las siete etapas se publican en Jenkins (`**/reports/junit-*.xml`), y los
informes JSON de los bancos de seguridad y validación distribuida se archivan como artefactos de
cada construcción. Eso convierte la serie de construcciones en una serie temporal: se puede ver si
la latencia de convergencia empeora commit a commit, no solo si hoy pasa.

## 4. Pruebas automatizadas — Cypress y Vitest

### 4.1 Reparto por nivel

| Suite | Casos | Qué cubre |
|---|---|---|
| `engine/test/` | 74 | Reglas del juego, deterministas, sin red ni UI |
| `net/test/` | 60 | Lamport, réplica, testigo, latidos, Bully, reparación, malla simulada |
| `signaling/test/` | 27 | Servidor WebSocket real: aforo, introductor, `bye`/`offline`, guardas, sondeo de salud |
| `web/test/` | 29 | Validación del enlace/QR, efectos, identidad de sesión |
| `cypress/e2e/` | **19** | Flujos de usuario y **la malla de tres nodos con WebRTC real** |

### 4.2 Las pruebas funcionales (componente 4.3)

Cypress cubre los cinco puntos que pide el enunciado:

- **Casos funcionales y flujos de usuario** — `menu.cy.ts` (8) y `partida-local.cy.ts` (6): no se
  puede crear sala sin nombre, el código se normaliza a mayúsculas, robar deja la carta si sirve y
  quita el turno si no, **nunca se puede pasar sin haber robado**, el turno rota.
- **Interfaz y comportamiento en tiempo real** — la mesa se repinta al llegar un evento por el
  canal, y el pozo cambia cuando lo cambia otro nodo.
- **Pruebas concurrentes y de interacción distribuida** — `distribuido/malla.cy.ts` (4): tres nodos
  simultáneos, cada uno en su propio contexto de navegación, con **WebRTC de verdad** entre ellos.
- **Evidencias y reportes** — informe JUnit por spec en `reports/`, capturas en
  `docs/vv/evidencias/`.

La suite distribuida merece un párrafo aparte, porque es la que ninguna otra capa puede dar. Los
tests de `net/` montan mallas simuladas y demuestran que el algoritmo converge; lo que no pueden
tocar es `RTCPeerConnection`, que no existe en Node. Los cuatro casos de `malla.cy.ts` prueban el
camino completo —señalización, handshake, DataChannels, difusión, convergencia— y lo afirman de la
única forma que no admite discusión: **comparando la huella del estado replicado de los tres
nodos**, que es el mismo número que muestra la Pantalla Maestra en el proyector.

Que el lobby lo muestre el anfitrión no bastaría, y por eso la prueba lo comprueba en los tres: el
que llega segundo se conecta con el tercero **por la malla**, no por el servidor.

### 4.3 Cómo se les da identidad a tres nodos en un solo navegador

Los tres nodos son `<iframe>` del mismo origen. Comparten `sessionStorage`, así que sin más se
pisarían la identidad entre ellos; `cypress/support/comandos.ts` los separa antes de que la
aplicación arranque. La alternativa —tres navegadores— habría hecho la suite imposible de correr en
un pipeline sin interfaz gráfica.

### 4.4 Sobre `window.__bug`

El stack de pruebas se levanta en modo desarrollo (`vv/stack.mjs`) y no con la imagen de
producción, por una razón concreta: la ventana de depuración `window.__bug` —que expone la semilla,
el log de eventos y la **huella del estado**— solo existe fuera de producción. Es lo que permite a
Cypress comprobar la convergencia sin deducirla mirando cartas en pantalla, y lo que permitió
cerrar el bug del Troyano reproduciendo en el motor una partida rota en el navegador.

## 5. Pruebas de seguridad — Burp Suite

Detalle completo, con los pasos para reproducir cada ataque a mano, en
[`seguridad-burp.md`](seguridad-burp.md). Resumen:

**11 ataques · 11 bloqueados · 6 vulnerabilidades encontradas y corregidas · 0 abiertas.**

| Severidad | Encontradas | Corregidas |
|---|---|---|
| Crítica | 2 (S3 secuestro de plaza, S8 malformados que **mataban el proceso**) | 2 |
| Alta | 2 (S1 suplantación del emisor, S2 inyección desde fuera de la sala) | 2 |
| Media | 2 (S6 agotamiento de conexiones, S7 mensaje de 32 MB) | 2 |

Los cinco ataques restantes (S4 replay, S5 flooding, S9 aforo, S10 fuga del censo, S11 `leave`
ajeno) encontraron el sistema ya defendido, y quedan automatizados para que siga estándolo.

El hallazgo con más consecuencias es **S8**: el servidor hacía `new Set([peerId, ...msg.tried])`.
Desparramar un número lanza una excepción, y una excepción dentro de un manejador de eventos de
Node sube hasta `uncaughtException` y **mata el proceso**. Un jugador cualquiera, desde la consola
del navegador, dejaba sin señalización a toda la feria con un mensaje de cuarenta caracteres.

El más instructivo es **S1**, porque enseña dónde está de verdad la confianza en este diseño: el
cifrado de WebRTC protege el contenido del canal, no la identidad de quien lo abrió. Esa la
garantiza la señalización, o no la garantiza nadie.

Y el resultado que más dice del sistema no es ningún ataque bloqueado, sino lo que **no aparece**
en el proxy: interceptando el WebSocket no se ve ni una carta. El WebSocket solo transporta el
handshake; la partida entera viaja por los DataChannels, cifrada con DTLS entre navegadores.

**Método:** Burp es la herramienta con la que se *encuentran* los fallos, no con la que se
*vigilan*. Un hallazgo que solo existe en la memoria de quien lo encontró vuelve a aparecer en tres
commits. Por eso los once están escritos en `vv/security/attack-suite.mjs` y corren en cada
construcción, contra el servidor real levantado en un puerto efímero.

## 6. Validación distribuida

`vv/distributed/validate.ts`, siete propiedades, **7 de 7 verificadas**. Cada una con métricas, no
con un verde: el enunciado pide *medir* latencia y tiempos, no solo aprobar.

| ID | Propiedad | Criterio | Medición |
|---|---|---|---|
| **D1** | Consistencia | 3/5/10 nodos, latencias de 5–120 ms y entregas duplicadas → todas las réplicas con la misma huella, igual al oráculo | 3 nodos: 120 eventos, 424 entregas, **64 duplicados**, convergen ✅ · 10 nodos: 682 entregas, 92 duplicados ✅ |
| **D2** | Ordenamiento causal | Tres eventos con el mismo sello de Lamport, entregados en 12 órdenes distintos | **12 órdenes → 1 sola huella**; el reloj respeta la causalidad ✅ |
| **D3** | Exclusión mutua | 200 cesiones del testigo sobre 5 nodos | **0 violaciones**, 200/200 instantes con poseedor único, 234 anuncios rezagados descartados ✅ |
| **D4** | Detección de fallos | Dos escalones por ausencia de latidos | sospechoso a **2 500 ms**, caído a **6 000 ms**, readmitido al volver, nadie se declara caído a sí mismo ✅ |
| **D5** | Elección de líder (Bully) | 3/5/10 nodos, con caída encadenada del favorito | acuerdo unánime ✅ |
| **D6** | Recuperación | Nodo rezagado y nodo corrupto | el rezagado converge al completar el log; **el corrupto NO** (tiene eventos de más) y necesita `adopt()` ✅ |
| **D7** | Rendimiento / latencia | Tres órdenes de entrega convergen; el trabajo de replay acotado | factor de replay **18,4× / 6,5× / 8,5×** (umbral 30×); malla 240 mensajes frente a 360 de un servidor ✅ |

Dos resultados merecen comentario.

**D6 justifica una decisión de diseño.** Un nodo al que le faltan eventos converge en cuanto se le
completa el log. Un nodo **corrupto** no: su log no solo tiene huecos, tiene eventos de más, y
añadirle los que le faltan no le quita los que le sobran. Por eso la reparación es `Replica.adopt()`
—tirar el log propio y adoptar el ajeno— y no `deliverAll()`. El banco lo mide en los dos sentidos:
`corruptoSigueDivergiendoTrasCompletarLog: true`, `corruptoConvergeAlAdoptar: true`.

**D7 cambió de criterio durante esta campaña, y el cambio es en sí un hallazgo.** Medía el caso
realista contra un techo de **2 segundos de reloj de pared**, y falló con la máquina cargada aun
cuando las tres réplicas habían convergido correctamente. Un criterio de aceptación que depende de
lo que haya de fondo en la máquina es un criterio que producirá construcciones rojas sin defecto
detrás — y un pipeline que se pone rojo sin motivo es un pipeline que se acaba ignorando. Ahora el
criterio es el **trabajo del algoritmo**: cuántas veces se aplica el reductor por evento recibido,
que sale idéntico en un portátil cargado y en el agente de Jenkins. Los tiempos se siguen midiendo
y anotando —el enunciado pide medir latencia— pero ya no deciden.

## 7. Defectos: registro y gestión

No hay sistema de tickets aparte: **el repositorio es el registro**. Cada defecto se corrige en el
mismo commit que añade la prueba que lo detecta, y el mensaje dice qué se rompía, por qué, y qué
prueba lo vigila desde ahora.

| # | Defecto | Cómo se encontró | Prueba que lo vigila |
|---|---|---|---|
| 1 | El líder se declaraba **caído a sí mismo** y se saltaba su turno cada ronda | Jugando una partida entera | `heartbeat.test.ts`, D4 |
| 2 | El Troyano podía dejarte con la mano vacía **sin ganar** (mesa muerta) | Jugando (200+ turnos) | `engine/test/` |
| 3 | La sala **no se creaba** en desarrollo (React StrictMode) | Navegador real | E2E |
| 4 | El menú **desbordaba** a 360 px | Navegador real | `menu.cy.ts` (360 px) |
| 5 | El comodín no decía su color en el pozo | Jugando | `partida-local.cy.ts` |
| 6 | Un evento que llegaba **antes de tener motor** se tiraba: divergencia permanente | Partida real + Pantalla Maestra | `repair.test.ts`, D6 |
| 7 | **Recargar la página te expulsaba** de tu propia partida | Navegador real | `session.test.ts`, R4.5 |
| 8 | Testigo perdido con su poseedor **vivo**: turno bloqueado para siempre | Móvil, partida real | `recovery.test.ts`, D3 |
| 9 | Dibujos descentrados (notación científica en el tokenizador de paths) | Inspección visual | desfase medido: 0.00 |
| 10 | **S1** Suplantación del emisor en las señales | Burp Suite | `attack-suite.mjs` S1 |
| 11 | **S2** Inyección de señales sin pertenecer a la sala | Burp Suite | S2 |
| 12 | **S3** Secuestro de plaza con el `peerId` de otro | Burp Suite | S3 |
| 13 | **S7/S6** Mensaje de 32 MB y agotamiento de conexiones | Banco automatizado | S6, S7 |
| 14 | **S8** Malformados que **mataban el proceso** del servidor | Burp Suite | S8 |
| 15 | `/health` no atendía **`HEAD`**: las pruebas E2E no llegaban a arrancar nunca | Montando la suite de Cypress | `signaling/test/health.test.ts` |
| 16 | El arnés de tres nodos perdía una **carrera sobre `sessionStorage`**: el nodo 2 entraba directo al lobby con el nombre del nodo 1 | Ejecutando la suite distribuida | `cypress/support/comandos.ts` (entrada por `?r=`) |
| 17 | `estadoDe()` devolvía **el `<iframe>`** en vez de `undefined` cuando el nodo aún no tenía partida | Compilando por primera vez los tipos de `cypress/` | Etapa *Tipos*, ahora incluye `cypress/tsconfig.json` |

Los dos últimos merecen su comentario, porque no salieron del producto en uso sino de montar la
V&V, y los dos habrían acabado en el mismo sitio: una prueba en la que nadie confía.

- **El 15** no era un problema de las pruebas. `wait-on` sondea con `HEAD` y el servidor solo
  atendía `GET`, así que estaba vivo y contestando mientras se le daba por caído durante los cinco
  minutos de espera. Quien sirve `GET` en un recurso sirve `HEAD` —es más barato, no pide el
  cuerpo— y Node no lo deriva solo. Cualquier balanceador que sondee así habría fallado igual.
- **El 16** era intermitente, que es la peor clase de defecto en una suite: enseña a desconfiar de
  las pruebas que sí funcionan. Los tres nodos son iframes del mismo origen y comparten el
  `sessionStorage` de la pestaña; el arnés borraba `bug:room` antes de montar cada uno, pero el
  nodo que ya está dentro la reescribe cuando su sala cambia de estado. Ahora los nodos entran por
  **invitación explícita** (`?r=`), que la app ya prioriza sobre la sesión guardada — y de paso
  recorren el mismo camino que en la feria: el del QR.
- **El 17** apareció al preguntarse por qué la etapa de tipos nunca había dicho nada de la suite de
  Cypress: porque no la miraba. `cypress/` tiene su propio `tsconfig.json` y los cuatro workspaces
  no lo alcanzan. Al compilarla por primera vez salieron cuatro errores, y uno no era cosmético:
  devolver `undefined` desde un `.then()` de Cypress no significa *"el resultado es `undefined`"*
  sino *"no cambio el sujeto"*, así que un nodo sin partida contestaba con su `<iframe>`. La
  comparación de huellas seguía funcionando por accidente —`$iframe?.hash` también es `undefined`—
  y ese "por accidente" es exactamente lo que no puede sostener una afirmación de convergencia. El
  `typecheck` del pipeline ahora incluye `cypress/`: el código de las pruebas es código.

Y uno más, encontrado escribiendo las pruebas y no ejecutándolas: perder el WebSocket se estaba
tratando como *irse de la partida*, y cerraba DataChannels que estaban perfectamente sanos. Ahora
`peer-left` lleva `reason` (`bye` / `offline`), porque el servidor es el único que puede
distinguirlas. Medido en 4 Chrome contra la imagen publicada: el escenario que daba **0 conexiones**
pasó a dar **3 de 3** (`mesh-signaling.test.ts`, `introductor.test.ts`).

## 8. Lo que este proceso demuestra sobre la propia V&V

De los dieciséis defectos de la tabla, **nueve** (los 1–9) son de una clase que ninguna prueba
unitaria habría visto nunca: ciclo de vida de React, cálculo de anchura en CSS, tokenizado de SVG,
un evento que llega en un momento imposible de reproducir en memoria. Cinco salieron de atacar el
servidor a mano, y los dos últimos de montar la propia V&V.

Eso no es un argumento contra las pruebas unitarias —son 190 y sostienen el motor y los
algoritmos—, sino contra leerlas como si fueran la V&V entera. La pirámide de este proyecto es
ancha por abajo **y** ancha por arriba, y las dos anchuras están justificadas por defectos reales,
no por doctrina.

Hay una segunda lección, más incómoda, y viene de D7 y del defecto 16: **el instrumento de medida
también puede estar mal**. Un criterio que depende del reloj de la máquina no mide el sistema, mide
el momento; un arnés que pierde una carrera produce rojos que no corresponden a nada. Las dos cosas
tienen el mismo efecto sobre un equipo: la primera vez se investiga, la segunda se vuelve a lanzar,
y a la tercera el rojo ya no significa nada. Encontrar eso es tan parte de la V&V como encontrar un
bug en el producto — y llega antes, porque lo primero que hay que poder creer es la medida.

Y una tercera, que se llevó la última tarde entera: **una configuración no está hecha hasta que se
ha ejecutado**. El pipeline llevaba semanas escrito, revisado y comentado, y no arrancaba: cuatro
fallos encadenados (§3.3), cada uno invisible hasta corregir el anterior. Nada de eso se ve leyendo
el `Jenkinsfile` —que estaba bien— porque ninguno estaba ahí: estaban en el arranque de Jenkins, en
un volumen de Docker y en los permisos de un directorio montado. Un entregable de CI que nunca se
ha visto en verde es una intención, exactamente igual que un requisito sin prueba.

## 9. Riesgos abiertos y mejora continua

Lo que este proceso **no** cubre, dicho explícitamente porque un informe que promete cubrirlo todo
no es creíble:

| Riesgo abierto | Impacto | Propuesta |
|---|---|---|
| **Partida entre redes distintas de verdad** (dos casas, NAT simétrico) | Los DataChannels podrían no abrirse en la feria | El código ya lleva STUN + TURN configurable; falta la prueba con dos ubicaciones. Es el riesgo abierto **más importante**. |
| Carga con 10 jugadores en móviles reales | Degradación no medida | Está medido en simulación (D1, D7), no con diez teléfonos |
| Accesibilidad (lectores de pantalla, contraste) | — | No es requisito del enunciado; no auditado |
| El pipeline no corre Cypress en cada commit | Retroalimentación más lenta en lo distribuido | Añadir una etapa con el navegador headless en la imagen del agente |
| Sonar solo en el laboratorio local | Sin histórico entre máquinas | Publicar el `quality gate` como comprobación obligatoria antes de fusionar |

Y tres mejoras de proceso que este semestre deja apuntadas:

1. **Que la etapa 5 deje de ser inestable por diseño.** Hoy se tolera que SonarQube esté apagado, y
   esa tolerancia ya se cobró una: con el token sin llegar al contenedor, el pipeline se habría
   saltado el análisis en cada construcción con el mismo amarillo de siempre, y nadie habría ido a
   mirar por qué. Con el laboratorio en marcha, la etapa debería ser roja cuando no puede analizar,
   y distinguir *"no hay servidor"* de *"no hay credencial"*: lo primero es una circunstancia, lo
   segundo es un error de configuración.
2. **Serie temporal de las métricas distribuidas.** Los JSON de `vv/informes/` ya se archivan por
   construcción; falta graficarlos para ver tendencias, no solo el último valor.
3. **Un caso E2E por cada defecto de la tabla §7 que aún no lo tenga.** Cuatro se vigilan hoy solo
   con pruebas unitarias, y son precisamente los que aparecieron en el navegador.

## 10. Evidencias

| Evidencia | Dónde |
|---|---|
| **Informe de resultados de pruebas** (las 227, una a una) | `docs/vv/informe-pruebas.html` y `.pdf` — lo genera `node vv/informe-pruebas.mjs --pdf` |
| **Presentación de defensa** | `docs/vv/presentacion.html` y `.pdf` — la genera `node vv/presentacion/construir.mjs --pdf` |
| Informes JUnit (Vitest y Cypress) | `reports/junit-*.xml` |
| Cobertura combinada (`lcov`) | `coverage/lcov.info` |
| Informes de seguridad (JSON, uno por ejecución) | `vv/informes/seguridad-*.json` y `seguridad-ultimo.json` |
| Informes de validación distribuida (JSON) | `vv/informes/distribuida-*.json` y `distribuida-ultimo.json` |
| Capturas del sistema | `docs/vv/evidencias/` (ver abajo) |
| Configuración del laboratorio | `vv/docker-compose.yml`, `vv/jenkins/`, `vv/setup.mjs` |

### Las capturas

No son capturas hechas a mano: **las produce la propia suite de Cypress** en los puntos donde ya
está afirmando algo, así que corresponden siempre a la última ejecución y no pueden envejecer
respecto al código. Cypress vacía la carpeta antes de cada `npm run e2e`.

| Archivo | Qué demuestra |
|---|---|
| `menu.cy.ts/01-menu-en-movil-360px.png` | La pantalla de entrada a 360 px sin desbordar (R5.2, y el defecto 4 de §7) |
| `menu.cy.ts/02-llegada-por-qr.png` | Quien escanea el QR solo tiene que poner su nombre (R5.1) |
| `partida-local.cy.ts/03-mesa-repartida.png` | Mesa repartida, siete cartas y turno asignado |
| `distribuido/malla.cy.ts/04-tres-nodos-convergen-<huella>.png` | **Los tres nodos con la misma huella de estado.** El nombre del archivo lleva la huella común |
| `distribuido/malla.cy.ts/05-cae-un-nodo-los-otros-siguen.png` | Se quita un nodo de golpe y los dos que quedan siguen de acuerdo (R4.2) |

La cuarta es la que resume el proyecto entero: tres réplicas independientes, cada una con su mano y
su `RTCPeerConnection`, de acuerdo en la misma partida sin que haya un servidor que arbitre. Si esa
imagen mostrara tres huellas distintas, el diseño no se sostendría.

### Cómo reproducir todo

```powershell
npm ci
npm run typecheck            # tipos en los 4 paquetes
npm run test:coverage        # 190 unitarias + lcov combinado
npm run vv:security          # 11 ataques contra la señalización
npm run vv:distributed       # 7 propiedades distribuidas, con métricas
npm run e2e                  # levanta el stack y corre las 19 de Cypress

docker compose -f vv/docker-compose.yml up -d
node vv/setup.mjs            # token de Sonar → Jenkins
sonar-scanner                # análisis estático (la cobertura debe existir antes)
```
