# Plan de Verificación y Validación — Bug

> Proyecto integrador de Sistemas Distribuidos + Gestión para la V&V.
> Sistema bajo prueba: **Bug**, juego de cartas distribuido sin servidor de partida.

## 1. Qué se verifica y qué se valida

No son lo mismo, y en este proyecto la diferencia se nota mucho:

- **Verificación** — ¿está bien construido? Que el motor aplique las reglas, que los relojes de
  Lamport ordenen, que el testigo garantice exclusión mutua, que el detector de fallos detecte.
  Esto se comprueba con pruebas automáticas y análisis estático.
- **Validación** — ¿sirve para lo que se pidió? Que tres desconocidos en una feria escaneen un QR
  y jueguen, que la partida siga cuando a uno se le cae el WiFi, que se vea en el proyector lo que
  está pasando por dentro. Esto se comprueba en navegadores reales y con gente delante.

Un sistema distribuido añade una tercera pregunta que no encaja del todo en ninguna: **¿siguen
todos de acuerdo?** Es la que más atención recibe aquí, porque es la que sostiene el diseño: si las
réplicas divergen, no hay servidor al que preguntarle quién tiene razón.

## 2. Alcance

| Componente | Qué es | Cómo se prueba |
|---|---|---|
| `engine/` | Motor de reglas puro (sin red, sin UI) | Vitest — 74 pruebas unitarias, deterministas |
| `net/` | Malla WebRTC, Lamport, réplica, testigo, latidos, Bully | Vitest — 60 pruebas con mallas simuladas y reloj virtual |
| `signaling/` | Servidor WebSocket de arranque | Vitest contra el servidor real — 27 pruebas |
| `web/` | Interfaz Next.js | Vitest (lógica) + Cypress (navegador) |
| El sistema entero | Los cuatro juntos, con WebRTC de verdad | Cypress con tres nodos + bancos de V&V |

**Fuera de alcance:** el rendimiento gráfico de los efectos PixiJS (son decorativos y degradan
solos si no hay WebGL) y el comportamiento con más de 10 jugadores (el aforo lo impide).

## 3. Estrategia por niveles

```
        ┌───────────────────────────────────────────────┐
        │  Validación en feria (personas, móviles, QR)  │  manual
        ├───────────────────────────────────────────────┤
        │  Cypress: 3 nodos, WebRTC real, convergencia  │  19 pruebas
        ├───────────────────────────────────────────────┤
        │  Bancos de V&V: seguridad (11) y              │  automáticos,
        │  validación distribuida (7 propiedades)       │  con métricas
        ├───────────────────────────────────────────────┤
        │  Vitest: motor, red, señalización, web        │  190 pruebas
        ├───────────────────────────────────────────────┤
        │  SonarQube + TypeScript estricto              │  análisis estático
        └───────────────────────────────────────────────┘
```

La pirámide está deliberadamente ancha por abajo, pero con una excepción que conviene explicar: hay
cosas que **solo** se pueden probar arriba. `RTCPeerConnection` no existe en Node, así que la malla
de verdad únicamente se prueba en un navegador. Y los dos fallos que llegaron a producción en este
proyecto —el lobby que no se reabría con StrictMode y la tarjeta que desbordaba a 360 px— eran
exactamente de ese tipo: ninguna prueba unitaria los habría visto nunca.

## 4. Herramientas

| # | Herramienta | Versión | Qué hace aquí | Cuándo corre |
|---|---|---|---|---|
| 4.1 | **SonarQube Community Build** | 26.8.0 | Bugs, vulnerabilidades, *code smells*, duplicación, complejidad, cobertura | Cada commit (etapa del pipeline) y a mano con `sonar-scanner` |
| 4.2 | **Jenkins** | LTS (JDK 21) | Pipeline por commit: tipos, pruebas, cobertura, build, Sonar, seguridad, validación distribuida | Sondeo del repo cada minuto |
| 4.3 | **Cypress** | 13.17 | Pruebas funcionales y **distribuidas** (3 nodos con WebRTC real) | `npm run e2e`, y en el pipeline |
| 4.4 | **Burp Suite Community** | 2024.x | Interceptación y manipulación del WebSocket: spoofing, replay, flooding | Exploratorio, a mano; lo encontrado queda automatizado en `vv/security/` |
| 4.5 | **Bancos propios** | — | Validación distribuida con métricas (convergencia, orden causal, exclusión mutua, detección, elección, recuperación) | `npm run vv:distributed`, y en el pipeline |

Sobre 4.4: Burp es la herramienta con la que se **encuentran** los fallos, no con la que se
**vigilan**. Un hallazgo de seguridad que solo existe en la memoria de quien lo encontró vuelve a
aparecer en tres commits. Por eso los once ataques están escritos en `vv/security/attack-suite.mjs`
y corren en cada construcción; la guía para reproducirlos a mano está en
[`seguridad-burp.md`](seguridad-burp.md).

## 5. Criterios de aceptación

Una construcción se considera **aceptable** si, y solo si:

| Criterio | Umbral | Dónde se comprueba |
|---|---|---|
| Pruebas unitarias | 100 % en verde | Etapa *Pruebas + cobertura* |
| Tipos | `tsc --noEmit` sin errores en los 4 paquetes **y en la suite de Cypress** | Etapa *Tipos* |
| Cobertura del motor de reglas | ≥ 90 % de líneas | Informe de cobertura |
| Cobertura de la capa de red | ≥ 85 % de líneas | Informe de cobertura |
| Bugs de Sonar (severidad alta) | 0 | Quality gate |
| Vulnerabilidades de Sonar | 0 | Quality gate |
| Duplicación | < 3 % | Quality gate |
| Ataques de severidad alta/crítica que se cuelan | 0 | `npm run vv:security` |
| Propiedades distribuidas verificadas | 7 de 7 | `npm run vv:distributed` |
| Pruebas funcionales | 100 % en verde | `npm run e2e` |

La cobertura **no** se exige sobre la interfaz (`web/components`, `web/app`) ni sobre `room.ts`, y
está declarado en `sonar-project.properties` con su motivo: son las partes que necesitan un
navegador, y se prueban con Cypress. Poner un número de cobertura unitaria a un componente React
que solo falla al pintarse sería medir la sombra del problema.

## 6. Gestión de defectos

Los defectos encontrados se corrigen **en el mismo commit que añade la prueba que los detecta**. No
hay un sistema de tickets aparte: el repositorio es el registro. Cada corrección lleva en su mensaje
qué se rompía, por qué, y qué prueba lo vigila desde ahora.

Los defectos históricos —los que aparecieron jugando— están documentados en `PLAN.md` con el mismo
criterio. Es un registro deliberado: casi todos son de una clase que las pruebas unitarias no ven
(ciclo de vida de React, cálculo de anchura en CSS, `crypto.randomUUID` que no existe fuera de un
contexto seguro), y esa lista es el argumento de por qué la pirámide de arriba tiene la punta ancha.

## 7. Riesgos conocidos y cómo se cubren

| Riesgo | Impacto | Cobertura |
|---|---|---|
| Dos nodos divergen y nadie puede arbitrar | Partida rota, sin recuperación | D1, D6, `net/test/repair.test.ts`, huellas en la Pantalla Maestra |
| El líder cae y nadie lo sustituye | La mesa se queda sin coordinador | D5, `net/test/bully.test.ts` |
| El testigo se pierde con su poseedor | Turno bloqueado para siempre | D3, `net/test/recovery.test.ts` |
| Un jugador manipula su cliente | Ventaja injusta | Anti-spoof en la malla, S1/S3/S11, `replication.test.ts` |
| La señalización cae a media feria | Nadie nuevo puede entrar | `signaling-down.test.ts`: los que están siguen jugando |
| El WiFi de la feria es hostil (NAT simétrico) | No se abren los DataChannels | ICE configurable con TURN (Fase 3); **pendiente de probar entre casas** |
| Un asistente curiosea el tráfico | Fuga de información | S10 (el servidor solo revela un peer), cartas cifradas peer a peer |

## 8. Lo que este plan NO cubre

Vale la pena decirlo explícitamente, porque un plan de V&V que promete cubrirlo todo no es creíble:

- **Partida entre redes distintas de verdad** (dos casas). El código está (STUN + TURN
  configurable), pero la prueba requiere dos ubicaciones y no se ha hecho. Es el riesgo abierto más
  importante para la feria.
- **Carga real con 10 jugadores simultáneos en móviles**. Medido en simulación (D1, D7), no con
  diez teléfonos.
- **Accesibilidad** (lectores de pantalla, contraste). No es requisito del enunciado y no se ha
  auditado.

## 9. Cómo se ejecuta todo

```powershell
npm ci

# Verificación estática y unitaria
npm run typecheck
npm test
npm run test:coverage

# Bancos de V&V
npm run vv:security       # 11 ataques contra la señalización
npm run vv:distributed    # 7 propiedades distribuidas, con métricas

# Funcional en navegador (levanta señalización + web y corre Cypress)
npm run e2e

# Laboratorio de calidad e integración continua
docker compose -f vv/docker-compose.yml up -d
node vv/setup.mjs
docker compose -f vv/docker-compose.yml up -d --build jenkins
# SonarQube → http://localhost:9000   Jenkins → http://localhost:8080
```

Los resultados quedan en `vv/informes/` (JSON, uno por ejecución más una copia `-ultimo.json`) y
`reports/` (JUnit, que es lo que lee Jenkins).
