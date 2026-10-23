import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { openPicker } from '../app/src/date-picker.js';

// Мария, 07.10: в карточке «сегодня ✏» не нажималось, календарь не открывался. Поле даты было
// скрыто (`pointer-events: none`) и открывалось из кода; во фрейме Telegram `showPicker()` бросает
// SecurityError, а `click()` по скрытому полю календаря не открывает. Теперь нажатие получает само поле.

describe('календарь срока в карточке', () => {
  it('showPicker сработал — календарь открыт', () => {
    let opened = false;
    expect(openPicker({ showPicker: () => { opened = true; } })).toBe(true);
    expect(opened).toBe(true);
  });

  it('showPicker бросает (фрейм) или его нет — false, карточка покажет поле даты открыто', () => {
    expect(openPicker({ showPicker: () => { throw new DOMException('cross-origin', 'SecurityError'); } })).toBe(false);
    expect(openPicker({})).toBe(false);
  });

  it('поле даты лежит поверх кнопки и принимает нажатие, а не скрыто от него', () => {
    const css = readFileSync(new URL('../app/src/styles.css', import.meta.url), 'utf8');
    const over = /\.date-input-over\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(over).toMatch(/inset:\s*0/);
    expect(over).not.toMatch(/pointer-events:\s*none/);
    expect(css).not.toMatch(/date-input-hidden/);
    const app = readFileSync(new URL('../app/src/App.tsx', import.meta.url), 'utf8');
    const picker = app.slice(app.indexOf('function DuePicker'), app.indexOf('/** Наибольшая сторона фото'));
    expect(picker).toContain('class="date-input-over"');
    expect(picker).toContain('onChange={pick}');
    expect(picker).not.toMatch(/<button/);
  });
});
