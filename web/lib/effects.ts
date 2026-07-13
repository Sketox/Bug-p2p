import type { Card } from '@bug/engine';

// Qué efecto visual dispara cada carta. Es puro y sin dependencias: se puede importar desde
// cualquier sitio sin arrastrar PixiJS (que pesa ~400 kB y solo se carga cuando hace falta).

export type EffectKind = 'bsod' | 'glitch' | 'coffee' | 'virus' | 'reboot';

/** El efecto que corresponde a una carta recién jugada, o `null` si no merece espectáculo. */
export function effectFor(card: Card): EffectKind | null {
  switch (card.kind) {
    case 'wild_draw4': // BSOD: la pantalla azul de la muerte
      return 'bsod';
    case 'skip': // se fue el WiFi
    case 'reverse': // Ctrl+Z
    case 'draw2': // actualización de Windows
    case 'copy_paste': // Copiar y Pegar
      return 'glitch';
    case 'wild': // Reinicio de Router
    case 'reboot': // Apagar y volver a prender
      return 'reboot';
    case 'coffee_spill':
      return 'coffee';
    case 'trojan':
      return 'virus';
    default:
      return null;
  }
}
