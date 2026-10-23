import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Выделение текста в Mini App (спека miniapp-task-card): текст дела копируется, нажимаемое — нет.
// Браузера в проекте нет, поэтому проверяем сам CSS: правила разбираются по селекторам.

const css = readFileSync('app/src/styles.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** Значение user-select у правила, в селекторах которого есть `selector` целиком (через запятую). */
function userSelect(selector: string): string | null {
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!m[1]!.split(',').map((s) => s.trim()).includes(selector)) continue;
    const v = m[2]!.match(/(?<![-\w])user-select:\s*([a-z]+)/);
    if (v) return v[1]!;
  }
  return null;
}

describe('выделение текста в приложении', () => {
  it('по умолчанию текст выделяется: body разрешает выделение, запрета на всём теле нет', () => {
    expect(userSelect('body')).toBe('text');
    expect(css).not.toMatch(/body\s*\{[^}]*user-select:\s*none/);
    // iOS: меню «Скопировать» глушит touch-callout: none.
    expect(css).not.toMatch(/touch-callout:\s*none/);
  });

  it('нажимаемое не выделяется: кнопки (в них строки списков и заголовки разделов), вкладки, галочка, заслон', () => {
    for (const sel of ['button', "[role='button']", "[role='tab']", '.segmented', '.grip', '.date-picker',
      "input[type='checkbox']", '.announcement-check', '.announcement-gate', '.photo-viewer']) {
      expect(userSelect(sel), sel).toBe('none');
    }
  });

  it('текст внутри заслона остаётся выделяемым, токен выбирается целиком', () => {
    expect(userSelect('.announcement-text')).toBe('text');
    expect(userSelect('.token-value')).toBe('all');
  });

  it('блоки карточки не запрещают выделение', () => {
    for (const sel of ['.task-title', '.task-block-text', '.source-quote']) {
      expect(userSelect(sel), sel).not.toBe('none');
    }
  });
});
