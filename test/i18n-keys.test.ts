import { describe, expect, it } from 'vitest';
import { dictKeys, LANGS, t } from '../src/i18n/index.js';

// Спека telegram-bot, acceptance: «Все строки интерфейса есть во всех четырёх языковых файлах».

describe('i18n — ключи бота', () => {
  it('одинаковый набор ключей у всех четырёх языков', () => {
    const ru = new Set(dictKeys('ru'));
    for (const lang of LANGS) {
      const keys = new Set(dictKeys(lang));
      const missing = [...ru].filter((k) => !keys.has(k));
      const extra = [...keys].filter((k) => !ru.has(k));
      expect({ lang, missing, extra }).toEqual({ lang, missing: [], extra: [] });
    }
  });

  it('нет пустых строк ни в одном языке', () => {
    for (const lang of LANGS) {
      for (const key of dictKeys(lang)) {
        expect(t(lang, key).trim(), `${lang}.${key}`).not.toBe('');
      }
    }
  });

  it('незнакомый ключ возвращает сам ключ, не падает', () => {
    expect(t('ru', 'no.such.key')).toBe('no.such.key');
  });

  it('нет языка → откат на en', () => {
    expect(t('xx', 'menu.now')).toBe(t('en', 'menu.now'));
  });

  it('подстановка параметров', () => {
    expect(t('ru', 'start.welcome', { org: 'Acme' })).toBe('Вы в организации Acme.');
  });

  // На карточке рядом стоят две остановки: «Остановить» отдаёт дело обратно в очередь, «⏹ …» всего
  // лишь останавливает счёт часов. В английском, турецком и вьетнамском они назывались одним словом
  // и различались только значком — человек, желавший поставить время на паузу, терял взятое дело.
  it('кнопка «Остановить» и кнопка счёта времени названы по-разному на каждом языке', () => {
    for (const lang of ['ru', 'en', 'tr', 'vi'] as const) {
      const task = t(lang, 'btn.stop');
      const timer = t(lang, 'btn.timer_stop').replace(/^[^\p{L}]+/u, '');
      expect(timer.toLowerCase(), lang).not.toBe(task.toLowerCase());
    }
  });

  // Тон бота (taskano-overview, «Тон бота»): не «просрочено», а «срок был вчера» — и так на всех языках.
  it('ни одна строка не использует слово «просрочено»/«overdue» и его аналоги', () => {
    const FORBIDDEN: Record<'ru' | 'en' | 'tr' | 'vi', RegExp> = {
      ru: /просроч/i,
      en: /overdue/i,
      tr: /süresi geçti|gecik/i,
      vi: /quá hạn/i,
    };
    for (const lang of ['ru', 'en', 'tr', 'vi'] as const) {
      const hits = dictKeys(lang).filter((key) => FORBIDDEN[lang].test(t(lang, key)));
      expect(hits, `${lang}: ${hits.join(', ')}`).toEqual([]);
    }
  });
});
