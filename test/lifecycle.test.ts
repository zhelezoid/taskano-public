import { afterAll, describe, expect, it } from 'vitest';
import { closePools } from '../src/db/pool.js';
import { createTask, createPlan, noChangeWaiting, resolveWaiting, updateTask } from '../src/core/tasks.js';
import { transition } from '../src/core/lifecycle.js';
import { fillSlot } from '../src/core/queue.js';
import { createProposal, decideProposal, expireProposals, rollbackVetoable } from '../src/core/proposals.js';
import { addPerson, inOrg, makeAgent, makeOrg, MON_10, minutes } from './helpers.js';

afterAll(closePools);
const base = { why: 'зачем', doneCriteria: 'критерий', dueDate: '2026-12-31', description: 'как делать: открыть таблицу и свериться' };

describe('жизненный цикл шага', () => {
  // Дело через коннектор — основной путь продукта: автор у него агент, а отвечает хозяин агента.
  // Пока уведомление слали только при авторе-человеке, вопрос исполнителя не доходил ни до кого, и
  // первым о нём узнавали через четыре рабочих часа эскалацией «вопрос без ответа».
  it('вопрос по делу от агента доходит до хозяина агента сразу, а не по таймеру', async () => {
    const { orgId, ownerId } = await makeOrg();
    const person = await addPerson(orgId);
    const agent = await makeAgent(orgId, ownerId);
    const t = await inOrg(orgId, (db) => createTask(
      db, { ...base, title: 'свериться с поставщиком', assigneeUserId: person },
      { kind: 'agent', agentId: agent, userId: ownerId }, MON_10));

    await inOrg(orgId, (db) => transition(db, t.id, 'question', { kind: 'user', userId: person },
      { now: minutes(MON_10, 5), text: 'какой именно поставщик?' }));

    const n = await inOrg(orgId, (db) => db.query(
      `select kind from notifications where user_id = $1 and task_id = $2`, [ownerId, t.id]));
    expect(n.rows.map((r) => r.kind)).toContain('task_question');
  });


  it('«Завершить» сдаёт и без затребованного результата; результат, если есть, сохраняется', async () => {
    const { orgId, ownerId } = await makeOrg();
    const person = await addPerson(orgId);
    const agent = await makeAgent(orgId, ownerId);
    const t = await inOrg(orgId, (db) => createTask(db, { ...base, title: 'фото склада', assigneeUserId: person, expectedResult: { type: 'photo', required: false } },
      { kind: 'agent', agentId: agent, userId: ownerId }, MON_10));
    const me = { kind: 'user' as const, userId: person };
    const bare = await inOrg(orgId, (db) => transition(db, t.id, 'submit', me, { now: MON_10 }));
    expect(bare.status).toBe('submitted');
    const t2 = await inOrg(orgId, (db) => createTask(db, { ...base, title: 'фото склада 2', assigneeUserId: person, expectedResult: { type: 'photo', required: false } },
      { kind: 'agent', agentId: agent, userId: ownerId }, MON_10));
    const done = await inOrg(orgId, (db) => transition(db, t2.id, 'submit', me, { now: MON_10, result: { files: [{ telegram_file_id: 'x', kind: 'photo' }] } }));
    expect(done.status).toBe('submitted');
    const saved = await inOrg(orgId, (db) => db.query('select count(*)::int as n from task_results where task_id = $1', [t2.id]));
    expect(saved.rows[0].n).toBe(1);
  });

  it('обязательные поля шага и валидация', async () => {
    const { orgId, ownerId } = await makeOrg();
    const person = await addPerson(orgId);
    const agent = await makeAgent(orgId, ownerId);
    await expect(inOrg(orgId, (db) => createTask(db, { title: 'x', assigneeUserId: person }, { kind: 'agent', agentId: agent, userId: ownerId }, MON_10)))
      .rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('blocked держит слот ровно 1 рабочий час: пятница 17:30 → понедельник 09:30', async () => {
    const { orgId, ownerId } = await makeOrg();
    const person = await addPerson(orgId);
    const agent = await makeAgent(orgId, ownerId);
    const act = { kind: 'agent' as const, agentId: agent, userId: ownerId };
    const fri = new Date('2026-09-25T14:30:00Z');
    const t1 = await inOrg(orgId, (db) => createTask(db, { ...base, title: 't1', assigneeUserId: person }, act, fri));
    await inOrg(orgId, (db) => createTask(db, { ...base, title: 't2', assigneeUserId: person }, act, fri));
    await inOrg(orgId, (db) => transition(db, t1.id, 'question', { kind: 'user', userId: person }, { now: fri, text: 'где?' }));
    const at = async (d: Date) => {
      await inOrg(orgId, (db) => fillSlot(db, person, d));
      return (await inOrg(orgId, (db) => db.query(`select title from tasks where assignee_user_id = $1 and status = 'active'`, [person]))).rows.map((r) => r.title);
    };
    expect(await at(new Date('2026-09-28T06:29:00Z'))).toEqual([]);
    expect(await at(new Date('2026-09-28T06:31:00Z'))).toEqual(['t2']);
  });

  it('предложение истекает через 24 рабочих часа, деньги никогда не принимаются сами', async () => {
    const { orgId, ownerId } = await makeOrg();
    const agent = await makeAgent(orgId, ownerId);
    const p1 = await inOrg(orgId, (db) => createProposal(db, { agentId: agent, type: 'money', summary: 'оплатить 500$' }, MON_10));
    await inOrg(orgId, (db) => expireProposals(db, minutes(MON_10, 60)));
    let st = await inOrg(orgId, (db) => db.query('select status from proposals where id = $1', [p1.id]));
    expect(st.rows[0].status).toBe('pending');
    await inOrg(orgId, (db) => expireProposals(db, minutes(MON_10, 60 * 24 * 7)));
    st = await inOrg(orgId, (db) => db.query('select status from proposals where id = $1', [p1.id]));
    expect(st.rows[0].status).toBe('expired');
    const ev = await inOrg(orgId, (db) => db.query(`select data from events where type = 'proposal_decided' and agent_id = $1`, [agent]));
    expect(ev.rows[0].data.decision).toBe('expired');
  });

  it('смена цели плана через предложение применяется только после «Давай»', async () => {
    const { orgId, ownerId } = await makeOrg();
    const agent = await makeAgent(orgId, ownerId);
    const plan = await inOrg(orgId, (db) => createPlan(db, agent, 'старая цель', { kind: 'agent', agentId: agent, userId: ownerId }));
    const p = await inOrg(orgId, (db) => createProposal(db, { agentId: agent, planId: plan.id, type: 'goal_change', summary: 'новая', payload: { goal: 'новая цель' } }, MON_10));
    let g = await inOrg(orgId, (db) => db.query('select goal from plans where id = $1', [plan.id]));
    expect(g.rows[0].goal).toBe('старая цель');
    await inOrg(orgId, (db) => decideProposal(db, p.id, 'accept', ownerId, { now: MON_10 }));
    g = await inOrg(orgId, (db) => db.query('select goal from plans where id = $1', [plan.id]));
    expect(g.rows[0].goal).toBe('новая цель');
  });

  it('вето-перенос срока откатывается в течение 24 ч и не откатывается после', async () => {
    const { orgId, ownerId } = await makeOrg();
    const person = await addPerson(orgId);
    const agent = await makeAgent(orgId, ownerId);
    const act = { kind: 'agent' as const, agentId: agent, userId: ownerId };
    const t = await inOrg(orgId, (db) => createTask(db, { ...base, dueDate: '2026-09-22', title: 't', assigneeUserId: person }, act, MON_10));
    await inOrg(orgId, (db) => updateTask(db, t.id, { dueDate: '2026-10-20' }, act, MON_10));
    const ch = await inOrg(orgId, (db) => db.query(`select id from vetoable_changes where kind = 'reschedule'`));
    await expect(inOrg(orgId, (db) => rollbackVetoable(db, ch.rows[0].id, ownerId, minutes(MON_10, 60 * 25)))).rejects.toMatchObject({ code: 'conflict' });
    await inOrg(orgId, (db) => rollbackVetoable(db, ch.rows[0].id, ownerId, minutes(MON_10, 60)));
    const d = await inOrg(orgId, (db) => db.query(`select to_char(due_date, 'YYYY-MM-DD') as d from tasks where id = $1`, [t.id]));
    expect(d.rows[0].d).toBe('2026-09-22');
  });

  it('ожидание: проверки за 7/3/1 день, «Без изменений» сдвигает, «Пришло» — событие', async () => {
    const { orgId, ownerId } = await makeOrg();
    const person = await addPerson(orgId);
    const agent = await makeAgent(orgId, ownerId);
    const act = { kind: 'agent' as const, agentId: agent, userId: ownerId };
    const expected = new Date(MON_10.getTime() + 10 * 86400000);
    const w = await inOrg(orgId, (db) => createTask(db, { kind: 'waiting', title: 'документы', why: 'регистрация', assigneeUserId: person,
      waiting: { waitingFor: 'налоговая', expectedAt: expected.toISOString() } }, act, MON_10));
    expect(new Date(w.waiting!.next_check_at).getTime()).toBe(expected.getTime() - 7 * 86400000);
    const w2 = await inOrg(orgId, (db) => noChangeWaiting(db, w.id, { kind: 'user', userId: person }, new Date(expected.getTime() - 7 * 86400000)));
    expect(new Date(w2.waiting!.next_check_at).getTime()).toBe(expected.getTime() - 3 * 86400000);
    await inOrg(orgId, (db) => resolveWaiting(db, w.id, { kind: 'user', userId: person }, MON_10));
    const ev = await inOrg(orgId, (db) => db.query(`select count(*)::int as n from events where type = 'waiting_resolved' and agent_id = $1`, [agent]));
    expect(ev.rows[0].n).toBe(1);
  });

  it('21-й шаг агента одному человеку за день становится предложением', async () => {
    const { orgId, ownerId } = await makeOrg();
    const person = await addPerson(orgId);
    const agent = await makeAgent(orgId, ownerId);
    const act = { kind: 'agent' as const, agentId: agent, userId: ownerId };
    let last;
    for (let i = 0; i < 21; i++) last = await inOrg(orgId, (db) => createTask(db, { ...base, title: `t${i}`, assigneeUserId: person }, act, MON_10));
    expect(last!.status).toBe('draft');
    const p = await inOrg(orgId, (db) => db.query(`select count(*)::int as n from proposals where type = 'step_limit'`));
    expect(p.rows[0].n).toBe(1);
  });
});

describe('вето-откат не воскрешает закрытую задачу (ревью ядра)', () => {
  it('перенос откатывается только датой, закрытую задачу не трогает', async () => {
    const { orgId, ownerId } = await makeOrg();
    const person = await addPerson(orgId);
    const agent = await makeAgent(orgId, ownerId);
    const act = { kind: 'agent' as const, agentId: agent, userId: ownerId };
    const t = await inOrg(orgId, (db) => createTask(db, { ...base, dueDate: '2026-09-22', title: 't', assigneeUserId: person }, act, MON_10));
    await inOrg(orgId, (db) => updateTask(db, t.id, { dueDate: '2027-02-01' }, act, MON_10));
    await inOrg(orgId, (db) => transition(db, t.id, 'submit', { kind: 'user', userId: person }, { now: MON_10 }));
    await inOrg(orgId, (db) => transition(db, t.id, 'accept', act, { now: MON_10 }));
    const ch = await inOrg(orgId, (db) => db.query(`select id from vetoable_changes where kind = 'reschedule'`));
    await expect(inOrg(orgId, (db) => rollbackVetoable(db, ch.rows[0].id, ownerId, minutes(MON_10, 30)))).rejects.toMatchObject({ code: 'conflict' });
    const s = await inOrg(orgId, (db) => db.query('select status from tasks where id = $1', [t.id]));
    expect(s.rows[0].status).toBe('done');
  });
});
