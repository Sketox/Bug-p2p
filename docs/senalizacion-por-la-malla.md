# Señalización por la malla

> **Estado:** implementada. El servidor de señalización ya solo interviene en el **primer
> contacto**; las demás presentaciones las hacen los propios peers.
>
> Código: `net/src/room.ts` (sección *Señalización por la malla*), `net/src/protocol.ts` (`MeshMsg`),
> `signaling/src/server.ts` (`pickIntroducer`).
> Pruebas: `net/test/mesh-signaling.test.ts`, `signaling/test/introductor.test.ts`.

## El problema

La señalización es un servidor: `signaling/src/server.ts`, que corre dentro del contenedor del
anfitrión. Presenta a los jugadores y se aparta — tanto que puedes matarlo a media partida y no
pasa nada (probado en `net/test/signaling-down.test.ts`).

Pero mientras la partida está viva, ese servidor seguía siendo **el único sitio** por el que se
podía entrar. Y eso chirriaba: si ya hay una malla de peers hablando entre ellos, ¿por qué hace
falta un servidor aparte para presentar a uno nuevo? Los que ya están **pueden presentarlo ellos**.

## Lo que NO se puede arreglar (y conviene tener claro)

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
el servidor **no sea necesario para seguir funcionando**. Eso ya lo cumplíamos para la partida; lo
que faltaba era cumplirlo también para *entrar*.

## Lo que sí se puede hacer, y es lo que se hizo

El servidor se reduce al primer contacto. Un peer nuevo lo necesita solo para encontrar a **un**
miembro de la malla, y es la malla la que lo presenta a los demás.

### Antes

Entra un peer con N jugadores dentro → el servidor le reenvía **N handshakes** (offer/answer/ICE con
cada uno). Todo el tráfico de presentación pasa por el servidor.

### Ahora

1. El servidor le presenta a **uno solo**: el **introductor** (`pickIntroducer` elige al más
   antiguo de la sala, que es el que más canales abiertos tiene y por tanto el que puede darle el
   censo más completo).
2. Ese **único** handshake va por el servidor. En cuanto se abre el DataChannel, el introductor le
   **cotillea su censo** (`roster`) por ese canal.
3. Las presentaciones con los otros N-1 jugadores viajan como **`relay`**: señales WebRTC dando
   saltos por los DataChannels que ya existen. Cada peer las encamina — directo si tiene canal con
   el destinatario, y si no, inundando a sus vecinos (con `hop` máximo y descarte por `id`, porque
   en una malla casi completa la misma señal llega por varios caminos).

Los mensajes están en `net/src/protocol.ts` (`MeshMsg`), bajo la clave reservada `~sig`, que `Room`
intercepta y **no** entrega a la capa de juego.

### Quién ofrece a quién (evitar el "glare")

Hay dos caminos, así que hay dos convenciones:

- **por el servidor** → inicia el que acaba de entrar; al introductor se le avisa (`peer-joined`)
  para que espere su oferta;
- **por la malla** → inicia el del **`peerId` mayor**. Los dos lados calculan lo mismo sin hablarlo,
  que es justo lo que hace falta cuando se descubren a la vez por el censo.

### El que vuelve (lo que este cambio estuvo a punto de romper)

Al dejar de avisar a toda la sala de las llegadas, el `peer-joined` de un jugador que **regresa**
(recargó la página, se le fue el WiFi) ya solo lo oye su introductor. Los demás lo tenían apuntado
como *ido* —eso sí se sigue difundiendo a todos— y no lo readmitían: volvía a una mesa donde una
sola persona le hablaba.

Se arregla con una fuente mejor que el servidor: **aparecer en el censo de alguien es la prueba de
vida**, porque solo se anuncian canales abiertos. Un peer que aparece en un `roster` —o que me manda
un `relay`— deja de estar en la lista de idos. Lo cubre el test *"el que se va y vuelve se reconecta
con TODA la mesa"*.

### El introductor fantasma

Al presentar a uno solo, ese uno pasa a ser la única puerta de entrada — y "tener el socket abierto"
no es "estar vivo": el portátil se cerró, el móvil se durmió, y el servidor no se entera. Si a los
`INTRODUCER_TIMEOUT` (5 s) el que llega **no tiene canal abierto con nadie**, pide otro
(`{ t: 'introduce', tried: [...] }`). Cuando se acaban los candidatos, el servidor contesta con la
lista vacía y el cliente deja de pedir.

## Qué ganamos (medido)

- **El servidor deja de ver los N-1 handshakes: solo el primero.** Con tres jugadores dentro, el
  cuarto genera **2 señales** en el servidor (oferta + respuesta) en vez de 6.
  `net/test/mesh-signaling.test.ts` lo cuenta explícitamente — si alguien devolviera los handshakes
  al servidor, el número deja de cuadrar y el test cae.
- **Si el servidor se cae DESPUÉS de que el nuevo haya entrado, el nuevo completa su malla igual.**
  Antes se quedaba a medias. El test mata el servidor en el instante exacto en que se abre el primer
  canal, y el recién llegado acaba conectado con los tres.
- Es el modelo de IPFS y BitTorrent: los nodos bootstrap dan el primer contacto, la red hace el
  resto.

## Qué NO ganamos (y hay que decirlo)

- **El primer contacto sigue necesitando el servidor.** El nuevo peer sigue teniendo que alcanzar al
  introductor, que está detrás de un NAT. Necesitas la señalización, o un túnel, o algo.
- **Y la web hay que servirla de algún sitio.** Aunque la señalización fuera 100 % por la malla, el
  navegador del nuevo tiene que descargar el juego. Eso sale del contenedor del anfitrión.
- **El aforo se sigue contando en el servidor**, y ahí seguirá: es el único sitio donde contar es
  fiable (ver `signaling/src/server.ts`).

O sea: el servidor se encoge hasta el arranque, pero no desaparece. Y eso está bien — es lo máximo
que consigue cualquiera.
