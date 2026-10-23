import { describe, expect, it } from 'vitest';
import { parseRichText, splitLinks } from '../app/src/rich-text.js';
import { elapsedLabel } from '../app/src/i18n.js';

// Текст дела приходит от людей и агентов как обычный текст. В карточке он выводился одной строкой:
// переносы схлопывались, перечисление было неотличимо от сплошного текста, ссылку нельзя было нажать
// (спека miniapp-task-card).

describe('разбор текста дела', () => {
  it('пустая строка делит абзацы, перенос внутри абзаца сохраняется', () => {
    const blocks = parseRichText('Первый абзац.\nЕго вторая строка.\n\nВторой абзац.');

    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ kind: 'paragraph' });
    expect((blocks[0] as { lines: unknown[] }).lines).toHaveLength(2);
    expect(blocks[1]).toMatchObject({ kind: 'paragraph' });
  });

  it('строки с маркером собираются в перечисление, маркер в текст не попадает', () => {
    const blocks = parseRichText('Сделать:\n- позвонить складу\n- сверить остатки');

    expect(blocks[0]).toMatchObject({ kind: 'paragraph' });
    expect(blocks[1]).toMatchObject({ kind: 'list', ordered: false });
    const items = (blocks[1] as { items: { text: string }[][] }).items;
    expect(items.map((i) => i[0]!.text)).toEqual(['позвонить складу', 'сверить остатки']);
  });

  it('нумерованное перечисление отличается от маркированного и не смешивается с ним', () => {
    const blocks = parseRichText('1. первый\n2) второй\n- другой список');

    expect(blocks[0]).toMatchObject({ kind: 'list', ordered: true });
    expect((blocks[0] as { items: unknown[] }).items).toHaveLength(2);
    expect(blocks[1]).toMatchObject({ kind: 'list', ordered: false });
  });

  it('ссылка в тексте выделяется куском, остальное остаётся текстом', () => {
    const pieces = splitLinks('смотри https://example.com/a/b и дальше');

    expect(pieces).toEqual([
      { kind: 'text', text: 'смотри ' },
      { kind: 'link', text: 'https://example.com/a/b', url: 'https://example.com/a/b' },
      { kind: 'text', text: ' и дальше' },
    ]);
  });

  it('знак препинания за ссылкой в адрес не попадает', () => {
    for (const [line, url] of [
      ['см. https://example.com/x, дальше', 'https://example.com/x'],
      ['адрес https://example.com/x.', 'https://example.com/x'],
      ['(https://example.com/x)', 'https://example.com/x'],
    ] as const) {
      const link = splitLinks(line).find((p) => p.kind === 'link');
      expect(link, line).toMatchObject({ url });
    }
  });

  it('парная скобка внутри адреса сохраняется', () => {
    const link = splitLinks('https://ru.wikipedia.org/wiki/Ключ_(значения)').find((p) => p.kind === 'link');
    expect(link).toMatchObject({ url: 'https://ru.wikipedia.org/wiki/Ключ_(значения)' });
  });

  it('чужая схема ссылкой не считается: нажимать в карточке можно только http(s)', () => {
    for (const line of ['javascript:alert(1)', 'file:///etc/passwd', 'tg://resolve?domain=x']) {
      expect(splitLinks(line).some((p) => p.kind === 'link'), line).toBe(false);
    }
  });

  it('разметка не разбирается: вывод агента — текст, а не язык разметки', () => {
    const blocks = parseRichText('**жирный** и <b>тег</b>');
    const line = (blocks[0] as { lines: { text: string }[][] }).lines[0]!;
    expect(line.map((p) => p.text).join('')).toBe('**жирный** и <b>тег</b>');
  });
});

// Таймер в шапке «в работе» (спека mini-app): цифры бегут, поэтому секунды показываются всегда.
describe('сколько человек сидит с делом', () => {
  const at = (seconds: number): Date => new Date(Date.parse('2026-09-21T10:00:00Z') + seconds * 1000);
  const started = '2026-09-21T10:00:00Z';

  it('до часа — минуты и секунды, час и больше — часы, минуты, секунды', () => {
    expect(elapsedLabel(started, at(0))).toBe('00:00');
    expect(elapsedLabel(started, at(7))).toBe('00:07');
    expect(elapsedLabel(started, at(72))).toBe('01:12');
    expect(elapsedLabel(started, at(3599))).toBe('59:59');
    expect(elapsedLabel(started, at(3600))).toBe('1:00:00');
    expect(elapsedLabel(started, at(4332))).toBe('1:12:12');
    expect(elapsedLabel(started, at(36305))).toBe('10:05:05');
  });

  it('время прежних подходов складывается с идущим', () => {
    // 40 минут наработано раньше, 32 секунды идёт сейчас.
    expect(elapsedLabel(started, at(32), 2400)).toBe('40:32');
    // Больше часа в сумме — формат с часами, хотя текущий подход только начался.
    expect(elapsedLabel(started, at(5), 3600)).toBe('1:00:05');
  });

  it('секунды идут: соседние мгновения дают разные цифры', () => {
    expect(elapsedLabel(started, at(41))).not.toBe(elapsedLabel(started, at(42)));
  });

  it('часы устройства отстали от сервера — показываем ноль, а не минус', () => {
    expect(elapsedLabel(started, at(-300))).toBe('00:00');
  });

  it('испорченная дата не роняет шапку', () => {
    expect(elapsedLabel('не дата', at(10))).toBe('');
  });
});

// Пункт без текста — всё ещё пункт: раньше обрезка хвоста съедала пробел после маркера, строка
// переставала быть пунктом, и список из трёх строк рисовался как список → «-» → список.
describe('пустой пункт не рвёт перечисление', () => {
  it('строка из одного маркера остаётся пунктом того же списка', () => {
    const blocks = parseRichText('- первый\n-   \n- третий');

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: 'list', ordered: false });
    const items = (blocks[0] as { items: { text: string }[][] }).items;
    expect(items.map((i) => i[0]!.text)).toEqual(['первый', '', 'третий']);
  });

  it('пустой пункт нумерованного списка не начинает новый', () => {
    const blocks = parseRichText('1. первый\n2.\n3. третий');

    expect(blocks).toHaveLength(1);
    expect((blocks[0] as { items: unknown[] }).items).toHaveLength(3);
  });
});

// Одинокий знак между абзацами — отбивка, а не начало списка: пустой пункт бывает только внутри
// уже начатого перечисления.
describe('одинокий маркер списком ничего не начинает', () => {
  it('строка «-» между абзацами остаётся текстом', () => {
    const blocks = parseRichText('Раздел итогов\n-\nдалее текст без списка');

    expect(blocks.map((b) => b.kind)).toEqual(['paragraph']);
  });

  it('но внутри начатого списка такой же знак — пустой пункт', () => {
    const blocks = parseRichText('- раз\n-\n- три');

    expect(blocks).toHaveLength(1);
    expect((blocks[0] as { items: unknown[] }).items).toHaveLength(3);
  });
});
