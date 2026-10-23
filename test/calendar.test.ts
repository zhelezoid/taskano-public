import { afterAll, describe, expect, it } from 'vitest';
import './helpers.js';
import { addWorkingMinutes, isQuietTime, isWorkingTime, loadUserSchedule, localDate, workingMinutesBetween, type Schedule } from '../src/core/calendar.js';
import { closePools, withGlobal } from '../src/db/pool.js';
import { makeUser } from './helpers.js';

afterAll(closePools);

const IST: Schedule = { tz: 'Europe/Istanbul', days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00', holidays: new Set() };

describe('рабочий календарь', () => {
  it('пятница 17:30 + 60 рабочих минут = понедельник 09:30', () => {
    const fri = new Date('2026-09-25T14:30:00Z');      // 17:30 Стамбул
    expect(addWorkingMinutes(IST, fri, 60).toISOString()).toBe('2026-09-28T06:30:00.000Z');
  });
  it('праздник пропускается', () => {
    const s = { ...IST, holidays: new Set(['2026-10-29']) };
    const wed = new Date('2026-10-28T14:00:00Z');       // ср 17:00
    expect(addWorkingMinutes(s, wed, 120).toISOString()).toBe('2026-10-30T07:00:00.000Z');  // пт 10:00
  });
  it('минуты между моментами через выходные', () => {
    expect(workingMinutesBetween(IST, new Date('2026-09-25T14:00:00Z'), new Date('2026-09-28T07:00:00Z'))).toBe(120);
  });
  it('вьетнамский пояс режет день по местной полуночи', () => {
    expect(localDate(new Date('2026-09-21T17:30:00Z'), 'Asia/Ho_Chi_Minh')).toBe('2026-09-22');
    expect(isWorkingTime({ ...IST, tz: 'Asia/Ho_Chi_Minh' }, new Date('2026-09-21T02:30:00Z'))).toBe(true);
  });
  it('тихие часы через полночь', () => {
    expect(isQuietTime('Europe/Istanbul', '21:00', '08:00', new Date('2026-09-21T20:00:00Z'))).toBe(true);
    expect(isQuietTime('Europe/Istanbul', '21:00', '08:00', new Date('2026-09-21T09:00:00Z'))).toBe(false);
  });
});

describe('праздники в этой версии не учитываются', () => {
  it('график человека со страной их не подтягивает, хотя даты в базе есть', async () => {
    const userId = await makeUser({ language: 'tr', country: 'TR' });
    const schedule = await withGlobal((db) => loadUserSchedule(db, userId));
    expect(schedule.holidays.size).toBe(0);

    // Сами даты никуда не делись — праздники вернутся следующей версией, сейчас их просто не читают.
    const seeded = await withGlobal(async (db) => (await db.query(
      `select count(*)::int as n from holidays where country = 'TR'`)).rows[0].n);
    expect(seeded).toBeGreaterThan(0);
  });
});
