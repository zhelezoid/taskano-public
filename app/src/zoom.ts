// Математика просмотра фото: приближение вокруг точки и границы сдвига. Отдельно от
// компонента, чтобы её можно было проверить без браузера.

export interface View { scale: number; x: number; y: number }

export const MIN_SCALE = 1;
export const MAX_SCALE = 5;
/** Двойное касание приближает до этого масштаба, второе — возвращает целиком. */
export const DOUBLE_TAP_SCALE = 2.5;

export const IDENTITY: View = { scale: 1, x: 0, y: 0 };

/**
 * Новый масштаб с неподвижной точкой (fx, fy) — координаты относительно центра экрана: то, что было
 * под пальцами, остаётся под пальцами. Масштаб — в пределах MIN_SCALE…MAX_SCALE.
 */
export function zoomAt(v: View, scale: number, fx: number, fy: number): View {
  const s = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
  const k = s / v.scale;
  return { scale: s, x: fx - (fx - v.x) * k, y: fy - (fy - v.y) * k };
}

/**
 * Сдвиг не уводит картинку за край: при масштабе s картинка размером (w, h) может сдвинуться от
 * центра на половину того, на что она больше экрана (vw, vh). При s = 1 сдвига нет.
 */
export function clampView(v: View, w: number, h: number, vw: number, vh: number): View {
  if (v.scale <= MIN_SCALE) return IDENTITY;
  const mx = Math.max(0, (w * v.scale - vw) / 2);
  const my = Math.max(0, (h * v.scale - vh) / 2);
  return { scale: v.scale, x: Math.min(mx, Math.max(-mx, v.x)), y: Math.min(my, Math.max(-my, v.y)) };
}
