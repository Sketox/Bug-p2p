# Matriz de trazabilidad — Bug

De cada requisito del enunciado a la línea de código que lo implementa y a la prueba que lo vigila.
La columna que importa es la última: un requisito sin prueba es una intención, no un requisito.

Nomenclatura de las pruebas:
`S#` = ataque de seguridad (`vv/security/attack-suite.mjs`) ·
`D#` = propiedad distribuida medida (`vv/distributed/validate.ts`) ·
`E2E` = Cypress · el resto son pruebas unitarias con su archivo.

---

## Eje 1 — Comunicación bidireccional y concurrencia

| ID | Requisito | Implementación | Verificación | Estado |
|---|---|---|---|---|
| R1.1 | Comunicación bidireccional en tiempo real, sin *polling* | **WebSocket** para el arranque (`signaling/src/server.ts`) y **DataChannels de WebRTC** para el juego (`net/src/room.ts`) | `signaling/test/introductor.test.ts`, E2E `malla.cy.ts` | ✅ |
| R1.2 | Mínimo 3 nodos cliente simultáneos sobre el mismo estado | Malla completa: cada nodo abre un canal con cada otro | E2E `malla.cy.ts` (3 nodos, WebRTC real) y `aforo.cy.ts` (**10 nodos**, 45 canales), D1 (3/5/10 nodos) | ✅ |
| R1.3 | El estado es el mismo para todos | Replicación de máquina de estados: mismo estado inicial + mismo log | D1, `net/test/replication.test.ts` | ✅ |

> Nota sobre la rúbrica: el enunciado nombra WebSockets o gRPC. Aquí el WebSocket está —es el
> arranque— pero la partida viaja por WebRTC, que es lo que permite quitar el servidor de en medio.
> El razonamiento y sus consecuencias están en `docs/senalizacion-por-la-malla.md`.

## Eje 2 — Sincronización y ordenamiento lógico

| ID | Requisito | Implementación | Verificación | Estado |
|---|---|---|---|---|
| R2.1 | Ordenamiento causal de las jugadas | **Relojes de Lamport** (`net/src/lamport.ts`) | `net/test/lamport.test.ts`, D2 | ✅ |
| R2.2 | Orden **total**: los eventos concurrentes se ordenan igual en todos | Desempate por `peerId` (`compareStamped`) | D2 (12 órdenes de entrega distintos → la misma secuencia) | ✅ |
| R2.3 | Un evento que llega tarde no corrompe el estado | *Rollback & replay* (`net/src/replica.ts`) | `replication.test.ts`, D1, D7 | ✅ |
| R2.4 | Entregas duplicadas no se aplican dos veces | Deduplicación por `stampKey` | `replication.test.ts`, D1 (con duplicados en la red simulada) | ✅ |

## Eje 3 — Exclusión mutua y consistencia

| ID | Requisito | Implementación | Verificación | Estado |
|---|---|---|---|---|
| R3.1 | Exclusión mutua sobre el recurso crítico (el turno) | **Testigo con secuencia monotónica** (`net/src/token.ts`) | `net/test/recovery.test.ts`, D3 (200 cesiones, 0 violaciones) | ✅ |
| R3.2 | Los anuncios de testigo rezagados no confunden a nadie | El `seq` manda, no el emisor | D3 (234 anuncios rezagados descartados) | ✅ |
| R3.3 | Nadie puede ceder un testigo que no tiene | `passTo` devuelve `null` si no eres el poseedor | D3 | ✅ |
| R3.4 | Cada nodo mantiene una réplica local del estado | `Replica<GameState, GameEvent>` en cada navegador | D1, E2E (huellas iguales en los 3) | ✅ |
| R3.5 | Consistencia verificable en vivo | `stateHash` en cada latido y en la **Pantalla Maestra** (tecla `M`) | `net/test/repair.test.ts`, E2E `esperarConvergencia` | ✅ |
| R3.6 | Un nodo divergente se repara solo | `Replica.adopt()` al detectar huellas distintas | `repair.test.ts`, D6 | ✅ |

## Eje 4 — Tolerancia a fallos y reconfiguración dinámica

| ID | Requisito | Implementación | Verificación | Estado |
|---|---|---|---|---|
| R4.1 | Detección de caídas por latidos | `FailureDetector` con dos escalones (`net/src/heartbeat.ts`) | `heartbeat.test.ts`, D4 (sospechoso 2.500 ms, caído 6.000 ms) | ✅ |
| R4.2 | El sistema no se congela si un nodo cae | El caído pierde el turno por tiempo; la mesa sigue | `net/test/quit.test.ts`, E2E (se quita un nodo, los demás siguen de acuerdo) | ✅ |
| R4.3 | Elección de líder con **algoritmo del matón (Bully)** | `net/src/bully.ts` | `bully.test.ts`, D5 (3/5/10 nodos, acuerdo unánime) | ✅ |
| R4.4 | La elección se reabre si el favorito cae a media elección | Tiempo de espera de `coordinator` → nueva elección | `bully.test.ts`, D5 (segunda caída encadenada) | ✅ |
| R4.5 | Reconexión: un F5 te devuelve a tu sitio | Identidad estable por sala + desalojo de la sesión fantasma | `signaling/test/aforo.test.ts`, S3 (la reconexión legítima sigue funcionando) | ✅ |
| R4.6 | Recuperación del estado sin pedirlo a un servidor | Snapshot = semilla + log + testigo, servido por cualquier nodo | `recovery.test.ts`, D6 | ✅ |
| R4.7 | Que se caiga la señalización no tumba la partida | Las cartas van por los DataChannels; el WS solo sirve para entrar | `net/test/signaling-down.test.ts`, `mesh-signaling.test.ts` | ✅ |
| R4.8 | Distinguir "se fue" de "se cayó" | `reason: 'bye' \| 'offline'` + evento `QUIT` en el motor | `introductor.test.ts`, `engine/test/quit.test.ts` | ✅ |

## Requisitos de feria

| ID | Requisito | Implementación | Verificación | Estado |
|---|---|---|---|---|
| R5.1 | Entrar escaneando un QR, sin instalar nada | El QR lleva sala **y** señalización (`?r=&s=`) | E2E `menu.cy.ts` (invitación por QR) y `malla.cy.ts` (los tres nodos entran así), `web/test/signal.test.ts` | ✅ |
| R5.2 | Interfaz usable en un móvil | Responsive a dos tallas, `100dvh`, botones táctiles | E2E (360 px sin desbordar) | ✅ |
| R5.3 | Se puede aprender a jugar sin que nadie lo explique | Pantalla "Cómo se juega" con las cartas reales | E2E `menu.cy.ts` y `partida-local.cy.ts` | ✅ |
| R5.5 | El aforo se respeta en la interfaz, no solo en el servidor | `MAX_PLAYERS = 10`, pantalla `RoomFull` | E2E `aforo.cy.ts`: diez navegadores entran y se ven, la malla se estabiliza en los diez, la partida arranca y convergen; al once se le dice «SALA LLENA» | ✅ |
| R5.4 | **Pantalla Maestra** para proyector: salud, líder, testigo, huellas | `web/components/MasterScreen.tsx` (tecla `M`) | E2E `malla.cy.ts`: con tres nodos en partida, comprueba que hay líder, que el testigo está localizado, que los tres salen presentes y que su veredicto de convergencia coincide con el que calcula la prueba | ✅ |

## Componentes de V&V (bloque de la otra cátedra)

| ID | Requisito | Implementación | Evidencia | Estado |
|---|---|---|---|---|
| V1 | SonarQube: bugs, vulnerabilidades, *smells*, complejidad, duplicación | `sonar-project.properties`, `vv/docker-compose.yml` | [`reporte-final.md`](reporte-final.md) §2 | ✅ |
| V2 | Jenkins: build, pruebas, integración con Sonar, **pipeline por commit** | `Jenkinsfile`, `vv/jenkins/` (Configuration-as-Code) | [`reporte-final.md`](reporte-final.md) §3 | ✅ |
| V3 | Cypress: funcionales, tiempo real, **concurrentes/distribuidas**, informes | `cypress/e2e/`, informe JUnit | 19 pruebas, 3 nodos con WebRTC real | ✅ |
| V4 | Burp Suite: tráfico WS, manipulación, spoofing, replay, flooding | [`seguridad-burp.md`](seguridad-burp.md) + `vv/security/attack-suite.mjs` | 11 ataques, 6 vulnerabilidades corregidas | ✅ |
| V5 | Validación distribuida: sincronización, concurrencia, consistencia, latencia, tolerancia a fallos | `vv/distributed/validate.ts` | 7 propiedades con métricas | ✅ |
| V6 | Documentación: plan, matriz, reporte, métricas, evidencias | `docs/vv/` | [plan](plan-vv.md), esta matriz, [reporte final](reporte-final.md), [guía de Burp](seguridad-burp.md), [informe de resultados](informe-pruebas.html) (PDF) y las capturas de `evidencias/` | ✅ |

---

## Cobertura inversa: qué prueba cada suite

Leído al revés, para detectar pruebas que no defienden ningún requisito (y requisitos sin defensa).

| Suite | Nº | Requisitos que cubre |
|---|---|---|
| `engine/test/` | 74 | Las reglas del juego (base de R1.3, R3.4) |
| `net/test/` | 60 | R1.1–R1.3, R2.1–R2.4, R3.1–R3.6, R4.1–R4.8 |
| `signaling/test/` | 27 | R1.1, R4.5, R4.8, el sondeo de salud, y las defensas de S3–S8 |
| `web/test/` | 29 | R5.1 (validación del enlace), efectos, identidad |
| `cypress/e2e/` | 22 | R1.2, R3.5, R4.2, R5.1–R5.5 |
| `vv/security/` | 11 | S1–S11 (bloque V4) |
| `vv/distributed/` | 7 | D1–D7 (bloque V5), que refuerzan los ejes 2, 3 y 4 |

**Total automatizado: 230 comprobaciones.**
