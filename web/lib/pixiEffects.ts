import type { Application, Container, Ticker } from 'pixi.js';
import type { EffectKind } from './effects';

// Efectos de pantalla con PixiJS (WebGL), sobre un canvas transparente que flota encima del
// tablero y no intercepta clics.
//
// PixiJS pesa ~400 kB: cargarlo en el arranque castigaría al que solo quiere ver el menú, y en la
// feria la gente entra por QR desde el móvil con datos. Por eso el `import('pixi.js')` vive aquí
// dentro, en un método asíncrono: el navegador solo descarga la librería cuando alguien juega la
// primera carta especial. Hasta entonces el juego funciona sin ella (y si la carga falla, también:
// quien la usa ignora el fallo y sigue sin efectos).
//
// Nada de esto toca la partida: son píxeles. El estado replicado no sabe que existen.

/** Duración de cada efecto en ms. */
const DURATION: Record<EffectKind, number> = {
  glitch: 800,
  bsod: 1600,
  coffee: 1300,
  virus: 1400,
  reboot: 1200,
};

type Frame = (t: number, ticker: Ticker) => void;

export class EffectStage {
  private constructor(
    private readonly pixi: typeof import('pixi.js'),
    private readonly app: Application,
  ) {}

  /** Carga PixiJS (una sola vez) y monta el canvas dentro de `host`. */
  static async create(host: HTMLElement): Promise<EffectStage> {
    const pixi = await import('pixi.js');
    const app = new pixi.Application();
    await app.init({
      resizeTo: host,
      backgroundAlpha: 0,
      antialias: false, // estética pixel: nada de suavizar bordes
      preference: 'webgl',
    });
    app.canvas.style.width = '100%';
    app.canvas.style.height = '100%';
    host.appendChild(app.canvas);
    return new EffectStage(pixi, app);
  }

  get width(): number {
    return this.app.screen.width;
  }
  get height(): number {
    return this.app.screen.height;
  }

  play(kind: EffectKind): void {
    switch (kind) {
      case 'glitch':
        return this.glitch();
      case 'bsod':
        return this.bsod();
      case 'coffee':
        return this.coffee();
      case 'virus':
        return this.virus();
      case 'reboot':
        return this.reboot();
    }
  }

  destroy(): void {
    this.app.destroy(true, { children: true });
  }

  // --- Motor de animación ----------------------------------------------------
  /**
   * Añade un contenedor al escenario y lo anima durante `duration` ms. `t` va de 0 a 1; al llegar
   * a 1 el contenedor se destruye solo. Que cada efecto se limpie a sí mismo es lo que evita que
   * una partida larga acabe con cien capas muertas encima del tablero.
   */
  private animate(layer: Container, duration: number, frame: Frame): void {
    this.app.stage.addChild(layer);
    let elapsed = 0;
    const tick = (ticker: Ticker) => {
      elapsed += ticker.deltaMS;
      const t = Math.min(1, elapsed / duration);
      frame(t, ticker);
      if (t >= 1) {
        this.app.ticker.remove(tick);
        layer.destroy({ children: true });
      }
    };
    this.app.ticker.add(tick);
  }

  // --- Efectos ---------------------------------------------------------------

  /** Interferencia: bandas RGB desplazadas, como una señal de vídeo rota. */
  private glitch(): void {
    const { Container, Graphics } = this.pixi;
    const { width: w, height: h } = this;
    const layer = new Container();

    const bands = Array.from({ length: 14 }, () => {
      const g = new Graphics();
      layer.addChild(g);
      return g;
    });
    const flash = new Graphics().rect(0, 0, w, h).fill({ color: 0xffffff, alpha: 1 });
    layer.addChild(flash);

    let next = 0;
    this.animate(layer, DURATION.glitch, (t, ticker) => {
      flash.alpha = Math.max(0, 0.35 - t * 1.4);

      // Las bandas se redibujan a saltos (cada ~45 ms), no en cada frame: el parpadeo irregular
      // es lo que hace que parezca una señal rota y no una animación suave.
      next -= ticker.deltaMS;
      if (next <= 0) {
        next = 45;
        for (const g of bands) {
          const y = Math.random() * h;
          const bh = 4 + Math.random() * 26;
          const dx = (Math.random() - 0.5) * 60;
          const color = [0x00ffff, 0xff00ff, 0xffffff, 0x50c878][(Math.random() * 4) | 0]!;
          g.clear()
            .rect(dx, y, w, bh)
            .fill({ color, alpha: 0.5 });
        }
      }
      layer.alpha = 1 - t * t; // se apaga hacia el final
    });
  }

  /** BSOD: la pantalla azul de la muerte, con su apagón CRT al final. */
  private bsod(): void {
    const { Container, Graphics, Text } = this.pixi;
    const { width: w, height: h } = this;
    const layer = new Container();

    const screen = new Container();
    screen.addChild(new Graphics().rect(0, 0, w, h).fill({ color: 0x1e4fa0 }));

    const face = new Text({
      text: ':(',
      style: { fontFamily: 'monospace', fontSize: Math.min(120, w * 0.2), fill: 0xffffff },
    });
    face.position.set(w * 0.12, h * 0.24);
    screen.addChild(face);

    const msg = new Text({
      text: 'Tu partida encontró un problema\ny necesita reiniciar.\n\nBSOD  0x0000BUG',
      style: {
        fontFamily: '"Press Start 2P", monospace',
        fontSize: Math.max(10, Math.min(16, w * 0.022)),
        fill: 0xffffff,
        lineHeight: Math.max(18, Math.min(28, w * 0.036)),
      },
    });
    msg.position.set(w * 0.12, h * 0.46);
    screen.addChild(msg);

    // Rayas de barrido: el toque CRT que vende el pixel art.
    const scan = new Graphics();
    for (let y = 0; y < h; y += 4) scan.rect(0, y, w, 2);
    scan.fill({ color: 0x000000, alpha: 0.12 });
    screen.addChild(scan);

    layer.addChild(screen);
    screen.pivot.set(0, h / 2);
    screen.position.set(0, h / 2);

    this.animate(layer, DURATION.bsod, (t) => {
      if (t < 0.1) {
        // entra de golpe desde arriba
        layer.alpha = t / 0.1;
        screen.y = h / 2 - (1 - t / 0.1) * h * 0.3;
      } else if (t < 0.8) {
        layer.alpha = 1;
        screen.y = h / 2;
        // parpadeo sutil, como una pantalla que agoniza
        screen.alpha = 0.94 + Math.random() * 0.06;
      } else {
        // apagón CRT: la imagen colapsa a una línea y se va
        const k = (t - 0.8) / 0.2;
        screen.alpha = 1;
        screen.scale.y = Math.max(0.01, 1 - k);
        layer.alpha = 1 - k * k;
      }
    });
  }

  /** Derrame de café: manchas que se expanden sobre el tablero. */
  private coffee(): void {
    const { Container, Graphics } = this.pixi;
    const { width: w, height: h } = this;
    const layer = new Container();

    const stains = Array.from({ length: 16 }, () => {
      const g = new Graphics();
      const r = 20 + Math.random() * 90;
      g.circle(0, 0, r).fill({ color: Math.random() < 0.5 ? 0x6f4e37 : 0x4a3226, alpha: 0.75 });
      g.position.set(Math.random() * w, Math.random() * h);
      g.scale.set(0);
      layer.addChild(g);
      return { g, delay: Math.random() * 0.4 };
    });

    this.animate(layer, DURATION.coffee, (t) => {
      for (const { g, delay } of stains) {
        const k = Math.max(0, Math.min(1, (t - delay) / 0.3));
        g.scale.set(k * (1 + 0.1 * Math.sin(t * 12))); // pequeño temblor al expandirse
      }
      layer.alpha = t < 0.7 ? 1 : 1 - (t - 0.7) / 0.3;
    });
  }

  /** Virus troyano: lluvia de código verde. */
  private virus(): void {
    const { Container, Graphics } = this.pixi;
    const { width: w, height: h } = this;
    const layer = new Container();

    layer.addChild(new Graphics().rect(0, 0, w, h).fill({ color: 0x50c878, alpha: 0.08 }));

    const drops = Array.from({ length: 70 }, () => {
      const g = new Graphics()
        .rect(0, 0, 3, 10 + Math.random() * 22)
        .fill({ color: 0x50c878, alpha: 0.3 + Math.random() * 0.7 });
      g.position.set(Math.random() * w, Math.random() * h - h);
      layer.addChild(g);
      return { g, speed: 0.4 + Math.random() * 1.2 };
    });

    this.animate(layer, DURATION.virus, (t, ticker) => {
      for (const { g, speed } of drops) {
        g.y += speed * ticker.deltaMS;
        if (g.y > h) g.y = -30;
      }
      layer.alpha = t < 0.65 ? 1 : 1 - (t - 0.65) / 0.35;
    });
  }

  /** Apagar y volver a prender: apagón CRT y reencendido. */
  private reboot(): void {
    const { Container, Graphics } = this.pixi;
    const { width: w, height: h } = this;
    const layer = new Container();

    const black = new Graphics().rect(0, 0, w, h).fill({ color: 0x000000 });
    black.pivot.set(0, h / 2);
    black.position.set(0, h / 2);
    layer.addChild(black);

    const line = new Graphics().rect(0, -2, w, 4).fill({ color: 0xffffff });
    line.position.set(0, h / 2);
    line.alpha = 0;
    layer.addChild(line);

    this.animate(layer, DURATION.reboot, (t) => {
      if (t < 0.25) {
        // se apaga
        black.alpha = t / 0.25;
        black.scale.y = 1;
      } else if (t < 0.45) {
        // colapso a una línea: el gesto clásico del tubo de rayos catódicos
        const k = (t - 0.25) / 0.2;
        black.alpha = 1;
        black.scale.y = Math.max(0.005, 1 - k);
        line.alpha = k;
      } else if (t < 0.6) {
        black.scale.y = 0.005;
        line.alpha = 1;
      } else {
        // vuelve a encender
        const k = (t - 0.6) / 0.4;
        black.alpha = 0;
        line.alpha = 1 - k;
        line.scale.y = 1 + k * 20;
      }
    });
  }
}
