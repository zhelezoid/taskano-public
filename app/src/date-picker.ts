/**
 * Открыть системный календарь у поля даты. `showPicker()` есть не везде, а во фрейме
 * (Telegram Desktop и Web) бросает SecurityError — тогда `false`, и карточка показывает поле даты
 * открыто. На телефоне календарь открывает само нажатие: поле лежит прозрачным поверх кнопки.
 */
export function openPicker(el: { showPicker?: () => void }): boolean {
  if (typeof el.showPicker !== 'function') return false;
  try { el.showPicker(); return true; } catch { return false; }
}
