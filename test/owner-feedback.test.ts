import { afterAll, describe, expect, it } from 'vitest';
import { closePools, withGlobal } from '../src/db/pool.js';
import { ensurePersonalOrg } from '../src/core/people.js';
import { cancelTask, createTask, updateTask } from '../src/core/tasks.js';
import { transition } from '../src/core/lifecycle.js';
import { setTaskShare } from '../src/core/sharing.js';
import { ackBriefing, getBriefing } from '../src/runtime/briefing.js';
import { OWNER_ACTIVITY_OVERLAP_MS } from '../src/runtime/owner-activity.js';
import { addPerson, inOrg, makeAgent, makeOrg, minutes, MON_10 } from './helpers.js';

// Спека owner-feedback: агент узнаёт из сводки, что человек сделал сам.
// Личное попадает агентам только с пометкой «рабочее» (tasks.shared_org_id).

afterAll(closePools);

const base = { why: 'зачем', doneCriteria: 'критерий', dueDate: '2026-12-31', description: 'как делать: открыть таблицу и свериться' };

/** Личное дело заводит Claude в разговоре (create_task с org: personal) — в тестах создаём тем же ядром. */
async function personalTask(userId: string, title: string, now = MON_10): Promise<{ orgId: string; id: string }> {
  const orgId = await withGlobal((db) => ensurePersonalOrg(db, userId));
  const t = await inOrg(orgId, (db) => createTask(db, { title, assigneeUserId: userId }, { kind: 'user', userId }, now));
  return { orgId, id: t.id };
}

/** submit_task: в личном пространстве submit сразу закрывает дело. */
const personalDone = (orgId: string, taskId: string, userId: string, now = MON_10) =>
  inOrg(orgId, (db) => transition(db, taskId, 'submit', { kind: 'user', userId }, { now }));

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'no error';
  } catch (e) {
    return (e as { code?: string }).code ?? String(e);
  }
}

describe('owner_activity: что владелец сделал сам', () => {
  it('личное дело без пометки не попадает в сводку ни одной организации', async () => {
    const { orgId, ownerId } = await makeOrg();
    await makeAgent(orgId, ownerId);
    const p = await personalTask(ownerId, 'Разобрать шкаф');
    await personalDone(p.orgId, p.id, ownerId);

    const b = await inOrg(orgId, (db) => getBriefing(db, minutes(MON_10, 1)));
    expect(b.owner_activity.done).toEqual([]);
    expect(b.owner_activity.created).toEqual([]);
    expect(b.nothing_to_do).toBe(true);
    // Даже по прямому id: личное лежит в другой организации, RLS его не отдаёт.
    const raw = await inOrg(orgId, (db) => db.query('select count(*)::int as n from tasks where id = $1', [p.id]));
    expect(raw.rows[0].n).toBe(0);
  });

  it('помеченное «рабочее» личное дело → строка в owner_activity.done после сдачи; ack двигает окно', async () => {
    const { orgId, ownerId } = await makeOrg();
    await makeAgent(orgId, ownerId);
    const p = await personalTask(ownerId, 'Подписать договор аренды склада');
    await inOrg(p.orgId, (db) => setTaskShare(db, p.id, ownerId, orgId));
    await personalDone(p.orgId, p.id, ownerId);

    const b1 = await inOrg(orgId, (db) => getBriefing(db, minutes(MON_10, 1)));
    expect(b1.owner_activity.done).toHaveLength(1);
    expect(b1.owner_activity.done[0]).toMatchObject({ task: p.id, where: 'personal', by: 'owner' });
    // Текст человека — только под пометкой untrusted.
    expect(b1.owner_activity.done[0]!.title).toEqual({ untrusted: true, text: 'Подписать договор аренды склада' });
    // Поставлено и закрыто в одном окне — одна строка, в created дубля нет.
    expect(b1.owner_activity.created).toEqual([]);
    // Блок сам по себе будит routine: иначе агент не узнает, что дело сделано.
    expect(b1.nothing_to_do).toBe(false);

    await inOrg(orgId, (db) => ackBriefing(db, b1.cursor));
    // Окно подтверждается с запасом назад (OWNER_ACTIVITY_OVERLAP_MS): повтор строки безвреден, потеря — нет.
    expect(b1.owner_activity.since).toBe(null);
    const b2 = await inOrg(orgId, (db) => getBriefing(db, minutes(MON_10, 2)));
    expect(b2.owner_activity.since).toBe(new Date(minutes(MON_10, 1).getTime() - OWNER_ACTIVITY_OVERLAP_MS).toISOString());
    await inOrg(orgId, (db) => ackBriefing(db, b2.cursor));
    const b3 = await inOrg(orgId, (db) => getBriefing(db, minutes(MON_10, 20)));
    await inOrg(orgId, (db) => ackBriefing(db, b3.cursor));
    // Запас пройден — строки больше нет ни в одной следующей сводке.
    const b4 = await inOrg(orgId, (db) => getBriefing(db, minutes(MON_10, 25)));
    expect(b4.owner_activity.done).toEqual([]);
    expect(b4.nothing_to_do).toBe(true);
  });

  it('задача компании, поставленная человеком и закрытая им, → created, решение и done', async () => {
    const { orgId, ownerId } = await makeOrg();
    await makeAgent(orgId, ownerId);
    const person = await addPerson(orgId);
    const t = await inOrg(orgId, (db) => createTask(db, { ...base, title: 'Позвонить в банк', assigneeUserId: person },
      { kind: 'user', userId: ownerId }, MON_10));
    await inOrg(orgId, (db) => db.query(
      // Время задаётся явно и с запасом раньше окна: у блока есть перекрытие назад (5 минут,
      // чтобы не потерять строку из транзакции, закоммиченной после чтения). Пока время писала
      // база, реплика попадала во вторую сводку или нет в зависимости от часа прогона — тест был
      // зелёным по удаче.
      `insert into task_messages(org_id, task_id, author_user_id, kind, text, created_at)
       values (current_setting('app.org_id')::uuid, $1, $2, 'comment', $3, $4)`,
      [t.id, ownerId, 'Решение: счёт держим в одном банке, второй закрываем', minutes(MON_10, -10)]));

    const b1 = await inOrg(orgId, (db) => getBriefing(db, minutes(MON_10, 1)));
    expect(b1.owner_activity.created).toMatchObject([{ task: t.id, where: 'company', assignee: person }]);
    expect(b1.owner_activity.created[0]!.title).toEqual({ untrusted: true, text: 'Позвонить в банк' });
    expect(b1.owner_activity.decisions).toHaveLength(1);
    expect(b1.owner_activity.decisions[0]).toMatchObject({ task: t.id });
    expect(b1.owner_activity.decisions[0]!.text)
      .toEqual({ untrusted: true, text: 'Решение: счёт держим в одном банке, второй закрываем' });

    await inOrg(orgId, (db) => ackBriefing(db, b1.cursor));
    await inOrg(orgId, (db) => transition(db, t.id, 'submit', { kind: 'user', userId: person }, { now: minutes(MON_10, 5) }));
    await inOrg(orgId, (db) => transition(db, t.id, 'accept', { kind: 'user', userId: ownerId }, { now: minutes(MON_10, 6) }));

    const b2 = await inOrg(orgId, (db) => getBriefing(db, minutes(MON_10, 7)));
    expect(b2.owner_activity.done).toMatchObject([{ task: t.id, where: 'company', by: 'owner' }]);
    // Окно сдвинуто прошлым ack: ни постановка, ни решение не повторяются.
    expect(b2.owner_activity.created).toEqual([]);
    expect(b2.owner_activity.decisions).toEqual([]);
  });

  it('задача агента в блок не попадает: агент и так знает свои', async () => {
    const { orgId, ownerId } = await makeOrg();
    const agent = await makeAgent(orgId, ownerId);
    const person = await addPerson(orgId);
    const t = await inOrg(orgId, (db) => createTask(db, { ...base, title: 'Шаг агента', assigneeUserId: person },
      { kind: 'agent', agentId: agent, userId: ownerId }, MON_10));
    await inOrg(orgId, (db) => transition(db, t.id, 'submit', { kind: 'user', userId: person }, { now: minutes(MON_10, 1) }));
    await inOrg(orgId, (db) => transition(db, t.id, 'accept', { kind: 'user', userId: ownerId }, { now: minutes(MON_10, 2) }));

    const b = await inOrg(orgId, (db) => getBriefing(db, minutes(MON_10, 3)));
    expect(b.owner_activity.done).toEqual([]);
    expect(b.owner_activity.created).toEqual([]);
  });

  it('агент не правит и не отменяет помеченное личное дело — forbidden даже своему автору', async () => {
    const { orgId, ownerId } = await makeOrg();
    const personalOrg = await withGlobal((db) => ensurePersonalOrg(db, ownerId));
    const agent = await makeAgent(personalOrg, ownerId);
    const actor = { kind: 'agent' as const, agentId: agent, userId: ownerId };
    // Самый острый случай: дело завёл сам агент — по авторству правка была бы разрешена.
    const t = await inOrg(personalOrg, (db) => createTask(db, { title: 'Оплатить аренду', assigneeUserId: ownerId }, actor, MON_10));
    await inOrg(personalOrg, (db) => setTaskShare(db, t.id, ownerId, orgId));

    expect(await codeOf(inOrg(personalOrg, (db) => updateTask(db, t.id, { title: 'по-моему' }, actor)))).toBe('forbidden');
    expect(await codeOf(inOrg(personalOrg, (db) => cancelTask(db, t.id, actor, null)))).toBe('forbidden');
    const still = await inOrg(personalOrg, (db) => db.query('select title, status from tasks where id = $1', [t.id]));
    expect(still.rows[0]).toMatchObject({ title: 'Оплатить аренду', status: 'ready' });
    // Владелец своё дело по-прежнему ведёт сам.
    const mine = await inOrg(personalOrg, (db) => updateTask(db, t.id, { title: 'Оплатить аренду склада' }, { kind: 'user', userId: ownerId }));
    expect(mine.title).toBe('Оплатить аренду склада');
  });

  it('пометка — только на свою компанию: чужую организацию не назвать ни инструментом, ни запросом', async () => {
    const { orgId, ownerId } = await makeOrg();
    const foreign = await makeOrg();
    const p = await personalTask(ownerId, 'Дело про бизнес');

    expect(await codeOf(inOrg(p.orgId, (db) => setTaskShare(db, p.id, ownerId, foreign.orgId)))).toBe('forbidden');
    // Второй рубеж — триггер миграции 005: прямая запись в обход приложения тоже не проходит.
    await expect(inOrg(p.orgId, (db) => db.query('update tasks set shared_org_id = $2 where id = $1', [p.id, foreign.orgId])))
      .rejects.toThrow(/not a member/);
    // Личное пространство компанией не назвать.
    expect(await codeOf(inOrg(p.orgId, (db) => setTaskShare(db, p.id, ownerId, p.orgId)))).toBe('validation_failed');
    const after = await inOrg(p.orgId, (db) => db.query('select shared_org_id from tasks where id = $1', [p.id]));
    expect(after.rows[0].shared_org_id).toBeNull();

    // Своя компания — можно, и пометка снимается тем же путём.
    await inOrg(p.orgId, (db) => setTaskShare(db, p.id, ownerId, orgId));
    await inOrg(p.orgId, (db) => setTaskShare(db, p.id, ownerId, null));
    await personalDone(p.orgId, p.id, ownerId, minutes(MON_10, 1));
    const b = await inOrg(orgId, (db) => getBriefing(db, minutes(MON_10, 2)));
    expect(b.owner_activity.done).toEqual([]);
  });
});
