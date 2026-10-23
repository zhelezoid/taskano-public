import { afterAll, describe, expect, it } from 'vitest';
import { closePools, withGlobal } from '../src/db/pool.js';
import { createTask } from '../src/core/tasks.js';
import { transition } from '../src/core/lifecycle.js';
import { notify } from '../src/core/notify.js';
import { addWorkingMinutes, loadUserSchedule } from '../src/core/calendar.js';
import { runTick, tickOrg } from '../src/worker/tick.js';
import { startTimer } from '../src/core/time.js';
import { notificationText, type NotifRow } from '../src/bot/notif-text.js';
import { addPerson, inOrg, makeAgent, makeOrg, minutes, MON_10 } from './helpers.js';

afterAll(closePools);

const base = { why: 'зачем', doneCriteria: 'критерий', dueDate: '2026-12-31', description: 'как делать: открыть таблицу и свериться' };
const agentActor = (agentId: string, userId: string) => ({ kind: 'agent' as const, agentId, userId });

async function notifications(orgId: string, kind: string, userId?: string) {
  return inOrg(orgId, (db) => db.query(
    userId ? `select * from notifications where kind = $1 and user_id = $2` : `select * from notifications where kind = $1`,
    userId ? [kind, userId] : [kind],
  ));
}

// Таймеры проверяются тиком своей организации (`tickOrg`), а не всей базы: `runTick` обходит ВСЕ
// организации, к концу прогона их сотни, и каждый такой тик стоил секунды — файл падал по таймауту
// в зависимости от того, каким по счёту vitest его запустил. Сам обход — отдельным тестом
// в конце файла.
describe('таймеры автопилота (runTick)', () => {
  it('нет нажатия на «Сейчас» 2 р.ч. — одно напоминание ack (идемпотентно)', async () => {
    const { orgId, ownerId } = await makeOrg();
    const person = await addPerson(orgId);
    const agent = await makeAgent(orgId, ownerId);
    const t = await inOrg(orgId, (db) => createTask(db, { ...base, title: 'ack', assigneeUserId: person }, agentActor(agent, ownerId), MON_10));
    expect(t.status).toBe('active'); // единственная задача человека — сразу в «Сейчас»

    await tickOrg(orgId, minutes(MON_10, 125));                 // 2 р.ч. + запас
    await tickOrg(orgId, minutes(MON_10, 130));                 // повторный тик не должен задвоить
    await tickOrg(orgId, minutes(MON_10, 135));                 // третий тик тем же днём — счётчик не должен ползти
    const r = await notifications(orgId, 'reminder', person);
    expect(r.rowCount).toBe(1);
    expect(r.rows[0].payload.stage).toBe('ack');

    // Три прохода таймера по активной задаче — реально ушло одно напоминание, счётчик равен ЕМУ,
    // а не числу тиков (баг NOR-001: счётчик рос безусловно на каждый тик, до 2628 при 2 реальных).
    const task = await inOrg(orgId, (db) => db.query('select reminded_count from tasks where id = $1', [t.id]));
    expect(task.rows[0].reminded_count).toBe(1);
  });

  it('вопрос без ответа 4 р.ч. — «Решение» владельцу агента', async () => {
    const { orgId, ownerId } = await makeOrg();
    const person = await addPerson(orgId);
    const agent = await makeAgent(orgId, ownerId);
    const t = await inOrg(orgId, (db) => createTask(db, { ...base, title: 'вопрос', assigneeUserId: person }, agentActor(agent, ownerId), MON_10));
    await inOrg(orgId, (db) => transition(db, t.id, 'take', { kind: 'user', userId: person }, { now: MON_10 }));
    await inOrg(orgId, (db) => transition(db, t.id, 'question', { kind: 'user', userId: person }, { now: MON_10, text: 'где взять материал?' }));

    await tickOrg(orgId, minutes(MON_10, 245));                  // 4 р.ч. + запас
    const r = await notifications(orgId, 'question_unanswered', ownerId);
    expect(r.rowCount).toBe(1);
  });

  it('submitted от автора-человека без приёмки 24 р.ч. — auto_accepted', async () => {
    const { orgId, ownerId } = await makeOrg();
    const person = await addPerson(orgId);
    const t = await inOrg(orgId, (db) => createTask(db, { ...base, title: 'для человека', assigneeUserId: person }, { kind: 'user', userId: ownerId }, MON_10));
    await inOrg(orgId, (db) => transition(db, t.id, 'take', { kind: 'user', userId: person }, { now: MON_10 }));
    await inOrg(orgId, (db) => transition(db, t.id, 'submit', { kind: 'user', userId: person }, { now: MON_10, result: { text: 'готово' } }));

    // 24 рабочих часа, не календарных: у автора (владельца) рабочий день 09–18 — это ~2.7 дня.
    const schedule = await inOrg(orgId, (db) => loadUserSchedule(db, ownerId));
    await tickOrg(orgId, addWorkingMinutes(schedule, MON_10, 24 * 60 + 5));
    const task = await inOrg(orgId, (db) => db.query('select status from tasks where id = $1', [t.id]));
    expect(task.rows[0].status).toBe('done');
    const ev = await inOrg(orgId, (db) => db.query(`select 1 from events where type = 'auto_accepted' and task_id = $1`, [t.id]));
    expect(ev.rowCount).toBe(1);
  });

  it('затухание просрочки: день+1 после срока — reminder stage overdue_1', async () => {
    const { orgId, ownerId } = await makeOrg();
    const person = await addPerson(orgId);
    const agent = await makeAgent(orgId, ownerId);
    const t = await inOrg(orgId, (db) => createTask(
      db, { ...base, title: 'просрочка', assigneeUserId: person, dueDate: '2026-09-21' }, agentActor(agent, ownerId), MON_10,
    ));
    const dayAfter = new Date('2026-09-22T07:00:00Z');    // вторник 10:00 Стамбул — due_date+1
    await tickOrg(orgId, dayAfter);
    const r = await inOrg(orgId, (db) => db.query(`select payload from notifications where kind = 'reminder' and task_id = $1`, [t.id]));
    expect(r.rows.some((row) => row.payload.stage === 'overdue_1')).toBe(true);
  });

  it('4-е напоминание за день человеку склеивается в reminder_digest', async () => {
    const { orgId, ownerId } = await makeOrg();
    const person = await addPerson(orgId);
    const agent = await makeAgent(orgId, ownerId);
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const t = await inOrg(orgId, (db) => createTask(
        db, { ...base, title: `t${i}`, assigneeUserId: person, dueDate: '2026-09-21' }, agentActor(agent, ownerId), MON_10,
      ));
      ids.push(t.id);
    }
    // Первая задача автоматически заняла «Сейчас» — уводим её в in_progress сразу, чтобы она не
    // попала ещё и под таймер ack (иначе получим 5 напоминаний вместо 4 и тест станет случайным).
    await inOrg(orgId, (db) => transition(db, ids[0]!, 'take', { kind: 'user', userId: person }, { now: MON_10 }));
    const dayAfter = new Date('2026-09-22T07:00:00Z');
    await tickOrg(orgId, dayAfter);
    const reminders = await inOrg(orgId, (db) => db.query(`select task_id from notifications where kind = 'reminder' and user_id = $1`, [person]));
    const digest = await inOrg(orgId, (db) => db.query(`select payload from notifications where kind = 'reminder_digest' and user_id = $1`, [person]));
    expect(reminders.rowCount).toBe(3);
    expect(digest.rowCount).toBe(1);
    expect(digest.rows[0].payload.task_ids).toHaveLength(1);
    expect(ids).toContain(digest.rows[0].payload.task_ids[0]);

    // Счётчик у каждой из четырёх задач — 1: реально поставленное напоминание, будь оно отдельным
    // `reminder` (три первые) или попаданием в сводку (четвёртая) — оба канала считаются одинаково.
    const counts = await inOrg(orgId, (db) => db.query(`select id, reminded_count from tasks where id = $1 or id = $2 or id = $3 or id = $4`, ids));
    const byId = new Map(counts.rows.map((row) => [row.id as string, row.reminded_count as number]));
    expect(ids.map((id) => byId.get(id))).toEqual([1, 1, 1, 1]);
  });

  it('тихие часы откладывают доставку без потери уведомления', async () => {
    const { orgId } = await makeOrg();
    const person = await addPerson(orgId);
    const quietNow = new Date('2026-09-21T19:00:00Z');    // 22:00 Стамбул — внутри тихих часов 21:00–08:00
    // Срок доставки задаём явно: без него он берётся из часов базы, и как только зашитая здесь дата
    // становится прошлым, «отложили на утро» оказывается раньше «сейчас» — тест падал по календарю,
    // а не по коду.
    await inOrg(orgId, (db) => notify(db, { userId: person, kind: 'digest', level: 'work', dedupeKey: `quiet-test-${person}`, deliverAfter: quietNow }));
    const before = await notifications(orgId, 'digest', person);
    await tickOrg(orgId, quietNow);
    const after = await notifications(orgId, 'digest', person);
    expect(after.rows[0].delivered_at).toBeNull();
    expect(new Date(after.rows[0].deliver_after).getTime()).toBeGreaterThan(new Date(before.rows[0].deliver_after).getTime());
    expect(new Date(after.rows[0].deliver_after).getTime()).toBeGreaterThan(quietNow.getTime());
  });

  it('дайджест — один раз в день на человека, даже при двух тиках в окне', async () => {
    const { orgId } = await makeOrg();
    const person = await addPerson(orgId);
    // Канонической организацией для дайджеста становится личное пространство человека (оно есть у
    // каждого) — уведомление уходит туда одно, не в каждую организацию (спека telegram-bot, «Дайджест»).
    const personalOrgId = (await withGlobal((db) => db.query(
      `select id from orgs where owner_user_id = $1 and kind = 'personal'`, [person],
    ))).rows[0].id as string;
    const workStart = new Date('2026-09-21T06:03:00Z');   // 09:03 Стамбул — начало рабочего дня + 3 мин
    for (const at of [workStart, minutes(workStart, 5)]) {
      for (const id of [orgId, personalOrgId]) await tickOrg(id, at);
    }
    const inCompanyOrg = await notifications(orgId, 'digest', person);
    const inPersonalOrg = await notifications(personalOrgId, 'digest', person);
    expect(inCompanyOrg.rowCount).toBe(0);
    expect(inPersonalOrg.rowCount).toBe(1);
  });

  it('ожидание: время проверки настало — уведомление; срок ожидания прошёл — external_overdue', async () => {
    const { orgId, ownerId } = await makeOrg();
    const person = await addPerson(orgId);
    const agent = await makeAgent(orgId, ownerId);

    const check = await inOrg(orgId, (db) => createTask(db, {
      kind: 'waiting', title: 'ждём документы', why: 'регистрация', assigneeUserId: person,
      waiting: { waitingFor: 'налоговая', nextCheckAt: MON_10.toISOString() },
    }, agentActor(agent, ownerId), MON_10));

    const overdue = await inOrg(orgId, (db) => createTask(db, {
      kind: 'waiting', title: 'ждём поставщика', why: 'поставка', assigneeUserId: person,
      waiting: { waitingFor: 'поставщик', expectedAt: minutes(MON_10, -60).toISOString() },
    }, agentActor(agent, ownerId), MON_10));

    await tickOrg(orgId, MON_10);

    const checkNotif = await inOrg(orgId, (db) => db.query(`select 1 from notifications where kind = 'waiting_check' and task_id = $1`, [check.id]));
    expect(checkNotif.rowCount).toBe(1);

    const ev = await inOrg(orgId, (db) => db.query(`select 1 from events where type = 'external_overdue' and task_id = $1`, [overdue.id]));
    expect(ev.rowCount).toBe(1);
    const notif = await notifications(orgId, 'external_overdue', ownerId);
    expect(notif.rowCount).toBe(1);

    // Повторный тик не плодит вторых уведомлений/событий.
    await tickOrg(orgId, minutes(MON_10, 1));
    const ev2 = await inOrg(orgId, (db) => db.query(`select count(*)::int as n from events where type = 'external_overdue' and task_id = $1`, [overdue.id]));
    expect(ev2.rows[0].n).toBe(1);
  });
  it('шаг стоит 2 рабочих дня без движения — person_stuck несёт число дней («2 дня»)', async () => {
    const { orgId, ownerId } = await makeOrg();
    const person = await addPerson(orgId);
    const agent = await makeAgent(orgId, ownerId);
    const t1 = await inOrg(orgId, (db) => createTask(db, { ...base, title: 'застряла', assigneeUserId: person }, agentActor(agent, ownerId), MON_10));
    await inOrg(orgId, (db) => transition(db, t1.id, 'take', { kind: 'user', userId: person }, { now: MON_10 }));

    const schedule = await inOrg(orgId, (db) => loadUserSchedule(db, person));
    await tickOrg(orgId, addWorkingMinutes(schedule, MON_10, 2 * 9 * 60 + 5)); // 2 рабочих дня (09–18) + запас
    const r = await notifications(orgId, 'person_stuck', ownerId);
    expect(r.rowCount).toBe(1);
    expect(r.rows[0].payload.days).toBe(2);

    const text = await inOrg(orgId, (db) => notificationText(db, 'ru', r.rows[0] as unknown as NotifRow, ownerId));
    expect(text).toContain('2 дня');
  });

  // Таймер не тикает без человека: вопрос через 2,5 ч без признаков жизни, остановка
  // через 3 ч или в конце рабочего дня. Расписание по умолчанию: 09:00–18:00, Стамбул; MON_10 — 10:00.
  const timerWorld = async (startAt: Date) => {
    const { orgId, ownerId } = await makeOrg();
    const person = await addPerson(orgId);
    const taskId = await inOrg(orgId, async (db) => {
      const t = await createTask(db, { ...base, title: 'таймер', assigneeUserId: person }, { kind: 'user', userId: ownerId }, MON_10);
      await startTimer(db, person, t.id, startAt);
      return t.id;
    });
    const count = (kind: string) => inOrg(orgId, async (db) =>
      (await db.query(`select count(*)::int as n from notifications where kind = $2 and task_id = $1`, [taskId, kind])).rows[0].n as number);
    const entry = () => inOrg(orgId, async (db) =>
      (await db.query(`select ended_at, minutes from time_entries where task_id = $1 and source = 'timer'`, [taskId])).rows[0] as { ended_at: Date | null; minutes: number | null });
    return { orgId, person, taskId, count, entry };
  };

  it('2,5 ч без признаков жизни — один вопрос «ещё работаешь?»; 3 ч — таймер закрыт на отметке 3 ч', async () => {
    const w = await timerWorld(MON_10);
    await tickOrg(w.orgId, minutes(MON_10, 2 * 60));
    expect(await w.count('timer_check')).toBe(0);
    await tickOrg(w.orgId, minutes(MON_10, 2 * 60 + 40));
    await tickOrg(w.orgId, minutes(MON_10, 2 * 60 + 45));
    expect(await w.count('timer_check')).toBe(1);
    expect((await w.entry()).ended_at).toBeNull();

    await tickOrg(w.orgId, minutes(MON_10, 3 * 60 + 30));
    const e = await w.entry();
    expect(new Date(e.ended_at!).toISOString()).toBe(minutes(MON_10, 3 * 60).toISOString());
    expect(e.minutes).toBe(180);
    expect(await w.count('timer_autostopped')).toBe(1);
  });

  it('отметка в боте продлевает таймер: 3 ч считаются от неё', async () => {
    const w = await timerWorld(MON_10);
    await withGlobal((db) => db.query('update users set last_seen_bot_at = $2 where id = $1', [w.person, minutes(MON_10, 2 * 60)]));
    await tickOrg(w.orgId, minutes(MON_10, 3 * 60 + 30));
    expect((await w.entry()).ended_at).toBeNull();
    await tickOrg(w.orgId, minutes(MON_10, 5 * 60 + 1));
    expect((await w.entry()).minutes).toBe(5 * 60);
  });

  it('начатый в рабочий день таймер закрывается в конце рабочего дня, даже если человек активен', async () => {
    const start = minutes(MON_10, 6 * 60); // 16:00 по Стамбулу
    const w = await timerWorld(start);
    await withGlobal((db) => db.query('update users set last_seen_bot_at = $2 where id = $1', [w.person, minutes(start, 90)]));
    await tickOrg(w.orgId, minutes(start, 2 * 60 + 5)); // 18:05
    const e = await w.entry();
    expect(new Date(e.ended_at!).toISOString()).toBe(minutes(start, 2 * 60).toISOString());
    expect(e.minutes).toBe(120);
    const reason = await inOrg(w.orgId, async (db) =>
      (await db.query(`select payload from notifications where kind = 'timer_autostopped' and task_id = $1`, [w.taskId])).rows[0].payload.reason);
    expect(reason).toBe('day_end');
  });

  it('таймер, начатый после рабочего дня, конец дня не режет — только бездействие', async () => {
    const start = minutes(MON_10, 9 * 60); // 19:00 по Стамбулу
    const w = await timerWorld(start);
    await tickOrg(w.orgId, minutes(start, 2 * 60));
    expect((await w.entry()).ended_at).toBeNull();
    await tickOrg(w.orgId, minutes(start, 3 * 60 + 1));
    expect((await w.entry()).minutes).toBe(180);
  });

  it('текст остановки — сколько записано и почему, на языке человека', async () => {
    const w = await timerWorld(MON_10);
    await tickOrg(w.orgId, minutes(MON_10, 3 * 60 + 5));
    const row = await inOrg(w.orgId, async (db) =>
      (await db.query(`select * from notifications where kind = 'timer_autostopped' and task_id = $1`, [w.taskId])).rows[0]);
    const text = await inOrg(w.orgId, (db) => notificationText(db, 'ru', row as unknown as NotifRow, w.person));
    expect(JSON.stringify(text)).toContain('180 мин');
    expect(JSON.stringify(text)).toContain('3 часа');
  });

  // Единственный тест на обход всей базы. Его цена растёт с числом организаций прогона, поэтому
  // таймаут с запасом: проверяется, что тик доходит до каждой организации, а не скорость обхода.
  it('runTick обходит все организации базы: отложенное дело новой организации выходит по сроку', async () => {
    const { orgId, ownerId } = await makeOrg();
    const later = minutes(MON_10, 3 * 60);
    const t = await inOrg(orgId, (db) => createTask(db, {
      ...base, title: 'отложенное', assigneeUserId: ownerId, activateAt: later.toISOString(), release: true,
    }, { kind: 'user', userId: ownerId }, MON_10));
    expect(t.status).toBe('scheduled');

    await runTick(later);

    const row = await inOrg(orgId, (db) => db.query('select status from tasks where id = $1', [t.id]));
    expect(row.rows[0].status).not.toBe('scheduled');
  }, 180_000);
});
