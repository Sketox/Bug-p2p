# 🐛 Jugar a Bug

**Imagen:** [`sketox/bug`](https://hub.docker.com/r/sketox/bug) · `docker pull sketox/bug`

Esta es la guía para **jugar**. Si quieres tocar el código, eso está en el `README.md`.

---

## Primero, lo que hay que entender (o no funcionará)

Bug es **P2P**: las cartas viajan directas de un navegador a otro, sin pasar por ningún servidor.
Pero dos navegadores que no se conocen **no pueden encontrarse solos**. Necesitan un punto de
encuentro donde presentarse. Eso es lo único que hay dentro de la imagen, más la web del juego.

Por eso **no vale que cada uno levante el contenedor en su casa**: seríais dos personas esperando en
dos tablones distintos, sin verse nunca. **Uno solo hace de anfitrión**; los demás abren su enlace.

Y una vez os habéis encontrado, el anfitrión **deja de pintar nada**: si su contenedor se cae a media
partida, la partida sigue. No es un servidor de juego. No ve una sola carta.

---

## Caso 1 — Estáis en la misma WiFi

### El anfitrión

```bash
docker run --rm -p 7787:7787 sketox/bug
```

Espera a ver esto:

```
[bug] escuchando en :7787  (web en /, señalización en /ws)
```

1. Abre `http://localhost:7787`.
2. Escribe tu nombre → **Crear sala**.
3. Anota el **código de 4 caracteres** que aparece arriba.
4. Averigua tu IP local:
   - Windows: `ipconfig` → *Dirección IPv4* (p. ej. `192.168.1.42`)
   - Linux/macOS: `ip -4 addr` / `ifconfig`
5. Pásales a los demás: `http://192.168.1.42:7787` **y el código**.

> La primera vez, Windows preguntará si permites el acceso a la red. Hay que decir que **sí** (redes
> privadas), o tus invitados no llegarán.

### Los demás

1. Abren `http://192.168.1.42:7787` — **la IP del anfitrión**, no `localhost` (eso apunta a su
   propio ordenador).
2. Escriben su nombre, teclean el código → **Unirse**.
3. O directamente **escanean el QR** del anfitrión, que ya lleva la sala dentro: solo ponen nombre.

Cuando estéis todos (mínimo 2, máximo 10), el anfitrión pulsa **¡Empezar!**.

---

## Caso 2 — Estáis en casas distintas

Tu casa **no tiene dirección pública**: el router hace NAT y nadie de fuera puede iniciar una
conexión hacia tu máquina. El túnel le presta una dirección pública **mientras dura la partida**. Es
el precio del internet doméstico, no una grieta del diseño.

El túnel **viene dentro de la imagen**, así que no hay que bajarse ni instalar nada más:

```bash
docker run --rm -e TUNNEL=1 sketox/bug
```

Sin `-p`: el túnel habla con la web por dentro del contenedor, así que no ocupa ningún puerto tuyo.
Y esta consola **se queda ocupada**: es lo que quieres, porque la URL sale ahí y se para con
`Ctrl+C`.

### Cómo ves el enlace

A los pocos segundos, **en esa misma consola**, aparece dentro de un recuadro:

```
┌─────────────────────────────────────────────────┐
│  https://algo-que-rima-random.trycloudflare.com  │
└─────────────────────────────────────────────────┘
  Esa es la invitación: quien abra ese enlace entra a jugar.
  No necesita Docker, ni el código, ni instalar nada.
```

**Ese es el enlace que repartes.** Tarda entre 5 y 20 segundos en salir; hasta entonces la consola
parece parada, y es normal.

Si lo lanzaste en segundo plano (con `-d`), la consola no te enseña nada. Entonces se pide así:

```bash
docker logs bug                        # lo que ha dicho el contenedor hasta ahora
docker logs -f bug                     # o quedarse mirando hasta que salga (Ctrl+C para dejar de mirar)
docker logs bug | findstr trycloudflare   # solo la línea del enlace (Windows)
docker logs bug | grep trycloudflare      # solo la línea del enlace (Linux/macOS)
```

Si `docker logs` todavía no enseña ninguna URL, es que el túnel sigue abriéndose: espera unos
segundos y repite.

1. **Abre tú esa URL**, pon tu nombre → **Crear sala**.
2. Pulsa **copiar enlace 🔗** y mándaselo a los demás por donde quieras.
3. Ellos lo abren y les sale directamente *"te invitaron a la sala XXXX"*: ponen su nombre, pulsan
   **Entrar a la sala** y ya están dentro. **No hay código que teclear ni nada que configurar** — el
   enlace lleva la sala y el punto de encuentro dentro.
4. **¡Empezar!**

Tus amigos **no necesitan Docker**. Solo abren el enlace.

> ⚠️ **Dos cosas sobre esa URL.**
>
> Es **pública** mientras el contenedor esté vivo: cualquiera que la tenga puede entrar en la sala.
> Es una partida de cartas, pero conviene saberlo.
>
> Y **caduca sola**. Los túneles gratuitos de Cloudflare se caen a las pocas horas sin avisar: el
> contenedor sigue sano y el juego funciona en `localhost`, pero la dirección pública deja de
> responder. Si va a haber público, **levanta el túnel poco antes**, no la noche anterior. Cuando
> pase, se arregla parando y volviendo a lanzar — y la URL nueva será otra.

---

## Cómo parar (y la variante en segundo plano)

Si lo lanzaste con `--rm` como arriba, **basta con `Ctrl+C`** en esa consola: el contenedor se para y
se borra solo.

Si prefieres que no te ocupe la ventana, lánzalo **en segundo plano** con `-d` y ponle nombre:

```bash
docker run -d --name bug --rm -e TUNNEL=1 sketox/bug
docker logs bug           # el enlace sale aquí (ver «Cómo ves el enlace», arriba)
```

Y para pararlo:

```bash
docker rm -f bug
```

> **Si al lanzarlo te dice `name is already in use`**, es que ya lo tienes corriendo. Míralo con
> `docker ps`. Solo si quieres empezar de cero: primero `docker rm -f bug`, y luego el `run`.

---

## Durante la partida

- **Tecla `M`** (o el botón *🖥 malla*): la **Pantalla Maestra**. Muestra cada jugador, si está vivo,
  quién es el líder, dónde está el testigo de turno y si todos han convergido al mismo estado.
- **Se te acaba el tiempo**: cada turno dura 30 segundos. Si no juegas, robas 2 y pasas.
- **Recargar la página no te echa** de la partida: vuelves con tu misma mano. Irse de verdad es el
  botón **🚪 salir**.
- **Si a alguien se le cae la conexión**, los demás le guardan el sitio y le van saltando el turno.
  Cuando vuelve, recupera su mano.

---

## Si algo va mal

| Síntoma | Qué pasa |
| --- | --- |
| La sala dice **"reconectando…"** para siempre | El navegador no alcanza la señalización. En la misma WiFi: comprueba la IP y el firewall. Con túnel: mira si salió el "Error 1033". |
| Los invitados ven **"Application error"** | Están abriendo `localhost` en vez de tu IP, o tienes una versión antigua de la imagen: `docker pull sketox/bug`. |
| **Error 1033** al abrir el enlace del túnel | El túnel tiene URL pero no conectó (casi siempre, firewall bloqueando la salida). El contenedor lo avisa por consola a los 30 s. Prueba `-e TUNNEL_PROTOCOL=quic`, o jugad por la WiFi. |
| Entran pero **no se ven las cartas de otro** | WebRTC no atravesó el NAT. Hace falta un TURN — ver el `README.md`. |
| **"La sala está llena"** | Son 10 como máximo. |
| El enlace del túnel **dejó de abrir** de golpe | El túnel caducó (ver arriba). El contenedor sigue vivo: párala y vuelve a lanzarlo para tener URL nueva. |
| `name is already in use` al lanzar | Ya lo tienes corriendo. `docker ps` para verlo; `docker rm -f bug` si quieres empezar de cero. |

---

## Lo que hace la imagen por dentro

Un solo puerto (**7787**) que sirve tres cosas:

| Ruta | Qué es |
| --- | --- |
| `/` | La web del juego (Next.js) |
| `/ws` | La señalización: presenta a los peers y se aparta |
| `/health` | `bug ok` |

Van juntas **a propósito**: así el navegador deduce la señalización de su propio origen y la imagen
funciona en cualquier URL sin rehacer el build — que es lo que permite que el túnel, cuya dirección
no existe hasta que se abre, funcione sin configurar nada.

Y la señalización hace **menos** de lo que parece: solo presenta al que llega con **un** jugador de
la sala. Las presentaciones con el resto viajan por la propia malla, de navegador a navegador. Si el
contenedor muere justo después de que alguien entre, esa persona **termina de conectarse igual**.
