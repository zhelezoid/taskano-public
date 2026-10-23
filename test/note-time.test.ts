import { describe, expect, it } from 'vitest';
import { noteTime } from '../app/src/i18n.js';

// Время реплики в карточке дела (30.09): владелец не видел, когда оставлен комментарий.

describe('noteTime', () => {
  const now = new Date(2026, 8, 30, 12, 0);          // 30 сентября, полдень по часам «телефона»
  const at = (d: number, h: number, m: number): string => new Date(2026, 8, d, h, m).toISOString();

  it('сегодня и вчера — словом, дальше — датой; всегда со временем', () => {
    expect(noteTime('ru', at(30, 9, 5), now)).toMatch(/^сегодня, 09:05$/);
    expect(noteTime('ru', at(29, 23, 40), now)).toMatch(/^вчера, 23:40$/);
    const older = noteTime('ru', at(26, 17, 40), now);
    expect(older).toMatch(/26/);
    expect(older).toMatch(/17:40$/);
    expect(older).not.toMatch(/2026/);             // год — только если не текущий
  });

  it('прошлый год — с годом; язык турецкий', () => {
    expect(noteTime('ru', new Date(2025, 11, 31, 10, 0).toISOString(), now)).toMatch(/2025/);
    expect(noteTime('tr', at(29, 8, 0), now)).toMatch(/^dün, 08:00$/);
  });
});
