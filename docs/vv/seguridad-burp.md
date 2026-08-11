# Pruebas de seguridad con Burp Suite

> Componente 4.4 del enunciado. Objetivo: análisis del tráfico WebSocket, manipulación de mensajes,
> **spoofing, replay y flooding**, control de acceso y robustez.

Este documento tiene dos mitades y conviene entender por qué:

- **Burp Suite Community** es la herramienta con la que se *encontraron* los fallos. Se intercepta
  el WebSocket, se edita un mensaje a mano y se observa el efecto. Es exploración: rápida para
  descubrir, imposible de repetir igual dos veces.
- **`vv/security/attack-suite.mjs`** es donde quedaron *escritos* los once ataques una vez
  entendidos. Corre en cada commit desde Jenkins. La gracia de un hallazgo de seguridad no es
  encontrarlo una vez: es que nadie pueda volver a introducirlo sin que el pipeline se ponga rojo.

La correspondencia entre ambas está en la tabla del final: cada ataque automatizado se puede
reproducir a mano en Burp, paso a paso.

---

## 1. Montar el laboratorio

```powershell
# Levanta la web y la señalización de una vez (es lo mismo que usan las pruebas de Cypress)
npm run vv:stack             # http://localhost:3000  ·  ws://localhost:8787
```

> **Antes de nada, el puerto.** Burp escucha por defecto en `127.0.0.1:8080`, que es **donde está
> Jenkins**. Si el laboratorio de calidad está levantado, el listener de Burp no arranca y no se ve
> ni un mensaje — sin decir por qué. Dos salidas: cambiar el listener a **`127.0.0.1:8081`**
> (*Proxy → Proxy settings → Proxy listeners → Edit*), o apagar Jenkins mientras se ataca
> (`docker compose -f vv/docker-compose.yml stop jenkins`). Lo primero es más cómodo.

Abrir el navegador de Burp (**Proxy → Intercept → Open browser**), que ya viene con el certificado
instalado, y entrar a `http://localhost:3000`.

> **Sobre el «proyecto» de Burp:** la edición **Community no puede guardar proyectos en disco** —
> solo permite *temporary project*, que se pierde al cerrar. Por eso en el repositorio no hay ningún
> archivo `.burp` que abrir: al arrancar se elige «Temporary project» → «Use Burp defaults» y se
> reproduce lo de abajo. Lo que sí es permanente son los once ataques, escritos como prueba
> automática en `vv/security/attack-suite.mjs` — precisamente porque un hallazgo que solo vive
> dentro de una sesión de Burp se pierde con ella.

Crear una sala y abrir una segunda pestaña que se una con el código. En **Proxy → WebSockets
history** aparece el tráfico de señalización: los `join`, los `peers`, y las `signal` con las
ofertas SDP.

> ⚠️ **Mira la columna URL antes de dar la captura por buena.** En desarrollo, lo primero que llena
> ese historial es `localhost:3000/_next/webpack-hmr`: el recargador automático de Next.js, que
> también es un WebSocket. Es tráfico del servidor de desarrollo, **no del juego** — y una captura
> llena de filas `webpack-hmr` no demuestra nada de lo que dice demostrar. La señalización se
> reconoce porque va a **`localhost:8787/ws`**. Merece la pena filtrar por ahí.

Si hace falta tráfico de señalización **a demanda** —para una captura, o para tener algo que
interceptar sin montar dos navegadores— hay un generador:

```powershell
node vv/security/trafico-por-burp.mjs                          # proxy 127.0.0.1:8081
node vv/security/trafico-por-burp.mjs http://127.0.0.1:8080    # si el listener está en el 8080
```

Levanta dos jugadores que entran a la misma sala **a través del proxy** y cruzan un handshake WebRTC
completo (oferta, respuesta y candidato ICE), así que el historial se llena de mensajes del juego de
verdad. Y avisa: **Burp no repinta su ventana mientras está minimizada**, así que si se va a
capturar, hay que dejarla a la vista antes de lanzar el tráfico o la captura devolverá el fotograma
anterior.

> **Lo que NO se va a ver ahí, y es el resultado más importante de todo el capítulo:** las cartas.
> Ni una jugada, ni una mano, ni el mazo. El WebSocket solo transporta el handshake; a partir del
> primer contacto la partida entera viaja por los DataChannels de WebRTC, cifrados con DTLS entre
> navegadores. Un proxy que se sienta en medio del WebSocket no ve el juego porque el juego no pasa
> por ahí. Esa es la diferencia entre este diseño y uno con servidor de partida.

---

## 2. Los ataques, uno a uno

### S1 · Suplantación del emisor (spoofing)

1. En **WebSockets history**, localizar un mensaje `{"t":"signal", ...}` que salga del navegador.
2. Botón derecho → **Send to Repeater**.
3. En Repeater, cambiar el campo `from` por el `peerId` de otro jugador (se ve en los mensajes
   `peers` / `peer-joined`), y poner en `data.sdp` cualquier marca reconocible.
4. **Send**.

**Antes de la corrección:** el mensaje llegaba a la víctima con `from` falsificado. Eso no es un
detalle de protocolo — es un ataque de intermediario completo: Mallory manda *su* oferta SDP
diciendo que es de Alice, Bob la acepta, y el canal "cifrado extremo a extremo" de Bob acaba
cifrado contra Mallory. Conviene tener claro por qué el cifrado de WebRTC no ayuda aquí: protege el
contenido del canal, no la identidad de quien lo abrió. Esa la garantiza la señalización, o no la
garantiza nadie.

**Después:** el servidor ignora el `from` del mensaje y pone el de la conexión
(`signaling/src/server.ts`, caso `signal`). El mensaje se descarta con un `error`.

### S2 · Inyección desde fuera de la sala

Igual que S1, pero desde una conexión que **nunca hizo `join`**. Con Burp: cerrar la pestaña del
juego, coger un `signal` del histórico, enviarlo por Repeater sobre una conexión WebSocket nueva.

El código de sala son cuatro letras y está a la vista de cualquiera que mire la pantalla del que
juega. Bastaba con eso para interferir en una partida ajena. Ahora el servidor exige pertenecer a
la sala.

### S3 · Secuestro de plaza

1. Coger un `{"t":"join", ...}` del histórico → Repeater.
2. Cambiar nada más que la `epoch` y volver a enviarlo.

El servidor desaloja la sesión anterior cuando vuelve un `peerId` conocido: es así como funciona la
reconexión tras un F5. Y el `peerId` es público, porque viaja en el censo que los jugadores se
cotillean por la malla. Las dos cosas juntas eran un botón para **echar a alguien de su propia
partida y ocupar su sitio**.

La corrección no puede ser quitar el desalojo (rompería la reconexión, que es un requisito de
tolerancia a fallos), así que se ata la identidad a un secreto: `join` lleva un `secret` que la
pestaña genera y guarda junto a su `peerId`, y un `peerId` ya presente solo se recupera presentando
el mismo. En Burp se ve: el `join` manipulado recibe `{"t":"error","message":"esa identidad ya está
en uso"}` y la conexión se cierra.

### S4 · Replay

**Repeater → Send** veinte veces seguidas sobre la misma oferta capturada.

Reaplicar una oferta deja la `RTCPeerConnection` del que la recibe en un estado del que no vuelve,
así que repetirla es la forma más barata de impedir que dos jugadores se conecten. Ahora el
servidor descarta señales byte a byte idénticas dentro de una ventana de cinco segundos. Se puede
descartar por igualdad exacta sin estorbar al tráfico legítimo por cómo es WebRTC: cada SDP lleva
su `ice-ufrag` y su `ice-pwd`, sorteados por sesión, y cada candidato ICE es distinto del anterior.

### S5 · Flooding

Con **Intruder**: coger un `signal`, payload tipo *Null payloads*, 20.000 repeticiones, *Resource
pool* sin limitar. (El banco automatizado lo hace por socket directo, que aprieta más.)

Ahora hay un cubo de fichas por conexión: 40 mensajes por segundo con ráfagas de 120. La ráfaga
importa —entrar a una sala son varios mensajes de golpe, y el navegador escupe los candidatos ICE
en tanda—, lo que no es legítimo es sostener el ritmo.

### S6 · Agotamiento de conexiones

Fuera del alcance de Burp Community (hace falta abrir miles de sockets en paralelo); está en el
banco automatizado. Se corta en el socket TCP, no en el WebSocket: rechazar al abrirse el WebSocket
llega tarde, porque para entonces ya se pagó el handshake HTTP de cada intento, que es justo el
trabajo que el atacante quiere que hagas.

### S7 · Mensaje desmesurado

En Repeater, alargar el `sdp` a decenas de megabytes (pegar `A` repetida). El servidor ahora
declara `maxPayload` de 64 KB; una señal real ronda los 2-4 KB.

### S8 · Malformados — el más grave de todos

En Repeater, enviar `{"t":"introduce","room":"AB12","peerId":"x","tried":7}`.

El servidor hacía `new Set([peerId, ...msg.tried])`. Desparramar un número lanza una excepción, y
una excepción dentro de un manejador de eventos de Node sube hasta `uncaughtException` y **mata el
proceso**. Un jugador cualquiera, desde la consola del navegador, dejaba sin señalización a toda la
feria con un mensaje de cuarenta caracteres.

Corregido en dos capas: `parseClientMsg` valida tipo, longitud y forma de todo lo que entra, y el
manejador va envuelto en un `try/catch` para el fallo que no se nos ocurrió.

### S9 · Aforo · S10 · Fuga del censo · S11 · `leave` ajeno

Los tres estaban ya bien y se comprueban para que sigan estándolo. S10 merece un comentario: al
entrar en una sala de cuatro, el servidor revela **una** identidad (el introductor), no cuatro. No
es una defensa que se añadiera pensando en privacidad — salió de descentralizar la señalización—,
pero el efecto es ese y se mide.

---

## 3. Resultado

| # | Ataque | Severidad | Antes | Después |
|---|--------|-----------|-------|---------|
| S1 | Suplantación del emisor | Alta | 🔴 Vulnerable | 🟢 Bloqueado |
| S2 | Inyección desde fuera de la sala | Alta | 🔴 Vulnerable | 🟢 Bloqueado |
| S3 | Secuestro de plaza | Crítica | 🔴 Vulnerable | 🟢 Bloqueado |
| S4 | Replay de handshake | Media | 🔴 Vulnerable | 🟢 Bloqueado |
| S5 | Inundación de mensajes | Alta | 🟢 Resistió | 🟢 Bloqueado |
| S6 | Agotamiento de conexiones | Media | 🔴 Vulnerable | 🟢 Bloqueado |
| S7 | Mensaje de 32 MB | Media | 🔴 Vulnerable | 🟢 Bloqueado |
| S8 | Malformados (`tried: 7`) | Crítica | 🔴 Tumbaba el proceso | 🟢 Bloqueado |
| S9 | Saltarse el aforo | Media | 🟢 Resistió | 🟢 Bloqueado |
| S10 | Fuga del censo | Baja | 🟢 Resistió | 🟢 Bloqueado |
| S11 | `leave` en nombre de otro | Alta | 🟢 Resistió | 🟢 Bloqueado |

**5/11 → 11/11.** Seis vulnerabilidades encontradas, dos de ellas críticas, todas corregidas y
todas con prueba automatizada que las vigila.

Las mitigaciones viven en `signaling/src/guard.ts` (validación, cubo de fichas, detector de
repeticiones) y en `signaling/src/server.ts` (identidad por secreto, `from` de la conexión, techo de
sockets por IP). Cada función lleva anotado el ataque que la justifica; `signaling/test/guard.test.ts`
las prueba en aislamiento.

## 4. Hallazgos aceptados (no corregidos)

Conviene decir también lo que se decidió **no** arreglar, y por qué:

- **Quien escanea un QR ajeno confía en la señalización de quien lo generó.** No le ve las cartas
  —viajan cifradas peer a peer— pero sí sabe quién juega con quién y desde qué IP. Es inherente al
  modelo de "la señalización la levanta el anfitrión": el que invita es el que pone el punto de
  encuentro. Se valida el esquema del parámetro (`ws://` o `wss://`, ver `web/lib/signal.ts`) para
  que un enlace no pueda elegir a qué se conecta tu navegador.
- **No hay autenticación de jugadores.** Es un juego de feria al que se entra escaneando un QR: pedir
  una cuenta destruiría el requisito de "el público se une de inmediato, sin instalar nada". El
  `secret` de S3 no es una credencial: solo ata un `peerId` a la pestaña que lo creó, mientras dura
  la partida.
- **Un jugador de la sala puede mentirle al motor.** Puede, y no le sirve de nada: cada nodo valida
  con su propia copia de las reglas y el anti-spoof de la malla impide actuar en nombre de otro (ver
  `web/lib/useBugRoom.ts`). Es la diferencia entre "no puedes decirlo" y "puedes decirlo y nadie te
  hace caso"; aquí se eligió lo segundo a propósito, porque no hay servidor que arbitre.
