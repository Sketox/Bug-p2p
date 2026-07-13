# Señalización por la malla (pendiente)

> **Estado:** idea, no implementada. Lo que hay hoy funciona; esto es a dónde debería ir.

## El problema

Hoy la señalización es un servidor: `signaling/src/server.ts`, que corre dentro del contenedor del
anfitrión. Presenta a los jugadores y se aparta — tanto que puedes matarlo a media partida y no
pasa nada (probado en `net/test/signaling-down.test.ts`).

Pero mientras la partida está viva, ese servidor sigue siendo **el único sitio** por el que se
puede entrar. Y eso chirría: si ya hay una malla de peers hablando entre ellos, ¿por qué hace falta
un servidor aparte para presentar a uno nuevo? Los que ya están **podrían presentarlo ellos**.

## Lo que NO se puede arreglar (y conviene tener claro antes de intentarlo)

**El bootstrap es irreducible.** Dos máquinas que no se conocen no pueden encontrarse solas: el
navegador de quien llega no puede adivinar la IP y los puertos de nadie. Siempre hace falta un
primer contacto que venga **de fuera del sistema**.

Eso no es un defecto de este diseño. Lo tienen todos:

| Sistema | Cómo resuelve el bootstrap |
| --- | --- |
| BitTorrent | Trackers (servidores) y, en su defecto, nodos DHT conocidos |
| Bitcoin | Semillas DNS **hardcodeadas en el binario** |
| IPFS | Lista de nodos bootstrap de arranque |
| WebRTC "a pelo" | Copiar y pegar el SDP a mano (por WhatsApp, por voz…) |

Fíjate en la última fila: **sí se puede hacer sin servidor**. WebRTC permite señalización manual —
copias tu SDP, se lo mandas a tu amigo, él pega el suyo. Funciona. Pero el canal de señalización
sigue existiendo: **es WhatsApp**. Y WhatsApp es el servidor de otro.

De ahí la conclusión que hay que defender en la feria:

> La señalización no es un componente que se pueda borrar. Es una **función** que alguien tiene que
> cumplir. Se puede cambiar *quién* la cumple, no *si* se cumple.

Lo que distingue un P2P honesto de un cliente-servidor disfrazado no es no tener servidor: es que
el servidor **no sea necesario para seguir funcionando**. Eso ya lo cumplimos.

## Lo que sí se puede hacer: que la malla presente a los nuevos

El objetivo realista no es eliminar el servidor, es **reducirlo al primer contacto**. Que un peer
nuevo necesite la señalización solo para encontrar a **un** miembro de la malla, y que sea la malla
la que lo presente a todos los demás.

### Cómo sería

Hoy, cuando entra un peer nuevo con N jugadores dentro, el servidor le reenvía **N handshakes**
(offer/answer/ICE con cada uno). Todo el tráfico de presentación pasa por el servidor.

La propuesta: el nuevo hace **un solo** handshake por el servidor, con cualquier peer de la malla
(el *introductor*). A partir de ahí, ya tiene un DataChannel. Y el resto de handshakes —con los
otros N-1 jugadores— viajan **por ese DataChannel**, retransmitidos por el introductor.

En la práctica, esto significa añadir al protocolo de la malla (`net/src/protocol.ts`, el que va
por los DataChannels, no el de señalización) un mensaje de reenvío:

```
RELAY_SIGNAL { from: peerId, to: peerId, data: Signal }
```

…y que los peers lo encaminen entre ellos. Es señalización, pero **sobre la propia malla**.

### Qué ganamos

- El servidor deja de ver los N-1 handshakes: solo el primero.
- Si el servidor se cae **después** de que el nuevo haya entrado, el nuevo puede seguir completando
  su malla (hoy se quedaría a medias).
- Es el modelo de IPFS y BitTorrent: los nodos bootstrap dan el primer contacto, la red hace el
  resto.

### Qué NO ganamos (y hay que decirlo)

- **El primer contacto sigue necesitando el servidor.** El nuevo peer sigue teniendo que alcanzar
  al introductor, que está detrás de un NAT. Necesitas la señalización, o un túnel, o algo.
- **Y la web hay que servirla de algún sitio.** Aunque la señalización fuera 100% por la malla, el
  navegador del nuevo tiene que descargar el juego. Eso sale del contenedor del anfitrión.

O sea: el servidor se encoge, pero no desaparece. Y eso está bien — es lo máximo que consigue
cualquiera.

## Por dónde empezar

1. Añadir `RELAY_SIGNAL` al protocolo de la malla y encaminarlo en `useBugRoom.ts`.
2. En `Room`, permitir que una `Signal` entre por el DataChannel además de por el WebSocket
   (`onPeerSignal` ya hace el trabajo; solo cambia de dónde llega).
3. Al entrar: pedir al servidor **un** peer, no el censo entero. El resto, por el introductor.
4. Un test en la línea de `signaling-down.test.ts`: matar la señalización **justo después** de que
   el nuevo peer haya conectado con el introductor, y comprobar que completa la malla igual.

El paso 4 es el que demuestra que sirvió de algo.
