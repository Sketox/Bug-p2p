import { describe, expect, it } from 'vitest';
import type { Card, CardKind } from '@bug/engine';
import { effectFor } from '@/lib/effects';

// Los efectos son decoración, pero la tabla que decide cuál toca sí es lógica — y una carta sin
// efecto asignado se traduce en una animación que no se ve nunca.

const card = (kind: CardKind): Card => ({ id: `${kind}-1`, kind });

describe('efecto de cada carta', () => {
  it('el BSOD (+4) tiene su pantalla azul', () => {
    expect(effectFor(card('wild_draw4'))).toBe('bsod');
  });

  it('los especiales de color interfieren la señal', () => {
    expect(effectFor(card('skip'))).toBe('glitch');
    expect(effectFor(card('reverse'))).toBe('glitch');
    expect(effectFor(card('draw2'))).toBe('glitch');
  });

  it('las de reinicio apagan y prenden la pantalla', () => {
    expect(effectFor(card('wild'))).toBe('reboot'); // Reinicio de Router
    expect(effectFor(card('reboot'))).toBe('reboot'); // Apagar y prender
  });

  it('cada carta de caos tiene el suyo', () => {
    expect(effectFor(card('coffee_spill'))).toBe('coffee');
    expect(effectFor(card('trojan'))).toBe('virus');
    expect(effectFor(card('copy_paste'))).toBe('glitch');
  });

  it('los números no montan espectáculo (si no, la partida sería un epiléptico)', () => {
    expect(effectFor({ id: 'n', kind: 'number', color: 'code', value: 5 })).toBeNull();
  });

  it('ninguna carta especial se queda sin efecto', () => {
    const specials: CardKind[] = [
      'skip',
      'reverse',
      'draw2',
      'wild',
      'wild_draw4',
      'copy_paste',
      'reboot',
      'coffee_spill',
      'trojan',
    ];
    for (const kind of specials) expect(effectFor(card(kind))).not.toBeNull();
  });
});
