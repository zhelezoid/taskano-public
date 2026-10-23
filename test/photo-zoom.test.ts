import { describe, expect, it } from 'vitest';
import { clampView, IDENTITY, MAX_SCALE, zoomAt } from '../app/src/zoom.js';

// Просмотр фото в Mini App: приближение вокруг точки и границы сдвига.

describe('просмотр фото: приближение пальцами', () => {
  it('точка под пальцами остаётся на месте', () => {
    const v = zoomAt(IDENTITY, 2, 100, 50);
    // Точка (100, 50) экрана до и после: (100 - x) / scale — та же точка картинки.
    expect((100 - v.x) / v.scale).toBeCloseTo(100);
    expect((50 - v.y) / v.scale).toBeCloseTo(50);
  });

  it('масштаб не меньше 1 и не больше предела', () => {
    expect(zoomAt(IDENTITY, 0.3, 0, 0).scale).toBe(1);
    expect(zoomAt(IDENTITY, 50, 0, 0).scale).toBe(MAX_SCALE);
  });

  it('сдвиг не уводит картинку за край; при масштабе 1 сдвига нет', () => {
    expect(clampView({ scale: 1, x: 40, y: 40 }, 300, 600, 390, 800)).toEqual(IDENTITY);
    // Картинка 300×600 при ×2 = 600×1200 на экране 390×800: сдвиг до 105 по x и 200 по y.
    expect(clampView({ scale: 2, x: 999, y: -999 }, 300, 600, 390, 800)).toEqual({ scale: 2, x: 105, y: -200 });
  });
});
