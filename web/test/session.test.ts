import { describe, expect, it } from 'vitest';
import { chooseSavedRoom } from '@/lib/session';

describe('arranque desde una invitación', () => {
  it('la sala explícita del enlace desplaza a la sala guardada en la pestaña', () => {
    expect(chooseSavedRoom({ code: 'IT71', name: 'Sesión vieja' }, 'YW1T')).toBeNull();
  });
});
