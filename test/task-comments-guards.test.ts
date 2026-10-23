import { afterAll, describe, expect, it } from 'vitest';
import { closePools } from '../src/db/pool.js';
import { createTask, updateTask } from '../src/core/tasks.js';
import { addHumanComment, COMMENT_MAX_LENGTH } from '../src/core/comments.js';
import { addComment } from '../src/mcp/tools/tasks.js';
import { ackBriefing, getBriefing } from '../src/runtime/briefing.js';
import { ownerActivityBriefing } from '../src/runtime/owner-activity.js';
import { checkSilence } from '../src/runtime/fire.js';
import { encrypt } from '../src/core/crypto.js';
import { emit } from '../src/core/events.js';
import { addPerson, inOrg, makeAgent, makeOrg, minutes, MON_10, waitForEvents } from './helpers.js';

// Границы канала «человек → агент» (спека task-comments), найденные ревью: длина реплики, чьи
// решения попадают в память направления, окно блока, агент на паузе, молчание рутины, членство.

afterAll(closePools);

const base = { why: 'зачем', doneCriteria: 'критерий', dueDate: '2026-12-31', description: 'как делать: открыть таблицу и свериться' };
const ZERO = '0000-00-00';

/** Организация с агентом, его задачей и исполнителем, которому есть что дописать. */
async function world() {
  const { orgId, ownerId } = await makeOrg();
  const agent = await makeAgent(orgId, ownerId);
  const person = await addPerson(orgId);
  const task = await inOrg(orgId, (db) => createTask(
    db, { ...base, title: 'поставка стеллажей', assigneeUserId: person }, { kind: 'agent', agentId: agent, userId: ownerId }, MON_10));
  return { orgId, ownerId, agent, person, task: task.id };
}

describe('границы реплик (спека task-comments)', () => {
  it('реплика длиннее предела не принимается: сводка не раздувается', async () => {
    const w = await world();
    await expect(inOrg(w.orgId, (db) => addHumanComment(db, w.task, w.person, 'x'.repeat(COMMENT_MAX_LENGTH + 1))))
      .rejects.toMatchObject({ code: 'validation_failed' });

    // Ровно по границе — проходит.
    await inOrg(w.orgId, (db) => addHumanComment(db, w.task, w.person, 'y'.repeat(COMMENT_MAX_LENGTH)));
    await waitForEvents(w.orgId);
    const b = await inOrg(w.orgId, (db) => getBriefing(db, minutes(MON_10, 2)));
    const a = b.agents.find((x) => x.id === w.agent)!;
    expect(a.comments).toHaveLength(1);
    expect(JSON.stringify(b).length).toBeLessThan(COMMENT_MAX_LENGTH * 4);
  });

  it('«Решение: …» от исполнителя не выдаётся агенту за решение владельца', async () => {
    const w = await world();
    await inOrg(w.orgId, (db) => addHumanComment(db, w.task, w.person, 'Решение: берём поставщика подороже', minutes(MON_10, 1)));
    const fromWorker = await inOrg(w.orgId, (db) => ownerActivityBriefing(db, w.orgId, w.ownerId, minutes(MON_10, 2), ZERO));
    expect(fromWorker.decisions).toHaveLength(0);

    // У владельца та же фраза — решение: блок ровно для этого и заведён.
    await inOrg(w.orgId, (db) => addHumanComment(db, w.task, w.ownerId, 'Решение: берём поставщика подороже', minutes(MON_10, 2)));
    const fromOwner = await inOrg(w.orgId, (db) => ownerActivityBriefing(db, w.orgId, w.ownerId, minutes(MON_10, 3), ZERO));
    expect(fromOwner.decisions).toHaveLength(1);
    expect(fromOwner.decisions[0]!.text).toMatchObject({ untrusted: true, text: 'Решение: берём поставщика подороже' });
  });

  it('старые реплики в блок не попадают и не вытесняют свежие', async () => {
    const w = await world();
    await inOrg(w.orgId, (db) => addHumanComment(db, w.task, w.person, 'это было давно'));
    await inOrg(w.orgId, (db) => db.query(
      `update task_messages set created_at = now() - interval '180 days' where task_id = $1`, [w.task]));
    await inOrg(w.orgId, (db) => addHumanComment(db, w.task, w.person, 'а это сегодня'));

    await waitForEvents(w.orgId);

    const b = await inOrg(w.orgId, (db) => getBriefing(db, minutes(MON_10, 2)));
    const a = b.agents.find((x) => x.id === w.agent)!;
    expect(a.comments).toHaveLength(1);
    expect(a.comments[0]!.text).toMatchObject({ text: 'а это сегодня' });
  });

  it('реплика к делу агента на паузе не будит рутину каждый час', async () => {
    const w = await world();
    await inOrg(w.orgId, (db) => db.query(`update agents set status = 'paused' where id = $1`, [w.agent]));
    await inOrg(w.orgId, (db) => addHumanComment(db, w.task, w.person, 'жду счёта'));

    await waitForEvents(w.orgId);

    const b = await inOrg(w.orgId, (db) => getBriefing(db, minutes(MON_10, 2)));
    // Реплику агент видит, но ответить не может — поводом для запуска она не становится.
    expect(b.nothing_to_do).toBe(true);
    const a = b.agents.find((x) => x.id === w.agent)!;
    expect(a.paused).toBe(true);
    expect(a.comments).toHaveLength(1);
  });

  it('вопрос к делу агента на паузе рутину будит: молча вопрос не хоронится', async () => {
    const w = await world();
    await inOrg(w.orgId, (db) => db.query(`update agents set status = 'paused' where id = $1`, [w.agent]));
    await inOrg(w.orgId, (db) => emit(db, {
      type: 'question', agentId: w.agent, taskId: w.task, actorUserId: w.person, data: { text: 'какой адрес?' },
    }));

    await waitForEvents(w.orgId);

    const b = await inOrg(w.orgId, (db) => getBriefing(db, minutes(MON_10, 2)));
    // Пауза глушит только реплики (спека task-comments): блокирующее событие остаётся поводом прийти.
    expect(b.nothing_to_do).toBe(false);
  });

  it('одна реплика не поднимает владельцу тревогу «агенты молчат»', async () => {
    const w = await world();
    await inOrg(w.orgId, (db) => db.query(
      `insert into runners(org_id, fire_url, fire_token_enc, last_briefing_at) values ($1, $2, $3, $4)`,
      [w.orgId, 'https://example.test/fire', encrypt('fire-secret-token', w.orgId), MON_10]));
    // Сначала разбираем всё, что накопилось от постановки задачи: в очереди должна остаться
    // ровно одна реплика, иначе тревога поднимется не из-за неё. Слив отдаёт только транзакции
    // старше горизонта видимости (спека core-data-model), поэтому иногда нужен второй заход —
    // см. черновик events-horizon-holdback.
    await waitForEvents(w.orgId);
    await waitForEvents(w.orgId);
    const seen = await inOrg(w.orgId, (db) => getBriefing(db, minutes(MON_10, 1)));
    await inOrg(w.orgId, (db) => ackBriefing(db, seen.cursor));
    await inOrg(w.orgId, (db) => addHumanComment(db, w.task, w.person, 'поставщик перенёс на четверг'));

    // Четыре часа рабочего времени спустя: молчание из-за одной реплики — не поломка раннера.
    // Реплика должна быть уже видна ленте — иначе «тихо» ничего не доказывает.
    await waitForEvents(w.orgId);
    await checkSilence(w.orgId, minutes(MON_10, 240));
    const quiet = await inOrg(w.orgId, (db) => db.query(
      `select count(*)::int as n from notifications where kind = 'agents_silent'`));
    expect(quiet.rows[0].n).toBe(0);

    // А блокирующее событие — поднимает: тревога работает, просто не от реплик.
    await inOrg(w.orgId, (db) => emit(db, {
      type: 'question', agentId: w.agent, taskId: w.task, actorUserId: w.person, data: { text: 'а какой адрес?' },
    }));
    await waitForEvents(w.orgId);
    await checkSilence(w.orgId, minutes(MON_10, 240));
    const loud = await inOrg(w.orgId, (db) => db.query(
      `select count(*)::int as n from notifications where kind = 'agents_silent'`));
    expect(loud.rows[0].n).toBe(1);
  });

  it('имя автора реплики приходит агенту под untrusted', async () => {
    const w = await world();
    await inOrg(w.orgId, (db) => addHumanComment(db, w.task, w.person, 'сделал половину'));
    await waitForEvents(w.orgId);
    const b = await inOrg(w.orgId, (db) => getBriefing(db, minutes(MON_10, 2)));
    const a = b.agents.find((x) => x.id === w.agent)!;
    expect(a.comments[0]!.author).toMatchObject({ untrusted: true });
  });

  it('ответ агента убирает реплику, а вычеркнутый из организации автор виден как бывший', async () => {
    const w = await world();
    await inOrg(w.orgId, (db) => addHumanComment(db, w.task, w.person, 'поставщик перенёс на четверг'));
    await inOrg(w.orgId, (db) => db.query(
      `update memberships set status = 'removed' where org_id = current_setting('app.org_id')::uuid and user_id = $1`, [w.person]));

    await waitForEvents(w.orgId);

    const b = await inOrg(w.orgId, (db) => getBriefing(db, minutes(MON_10, 2)));
    const a = b.agents.find((x) => x.id === w.agent)!;
    expect(a.comments[0]!.author).toMatchObject({ untrusted: true, text: 'former employee' });

    await inOrg(w.orgId, (db) => addComment(db, w.task, { kind: 'agent', agentId: w.agent, userId: w.ownerId }, 'учёл, перенёс срок'));
    await waitForEvents(w.orgId);
    const after = await inOrg(w.orgId, (db) => getBriefing(db, minutes(MON_10, 30)));
    expect(after.agents.find((x) => x.id === w.agent)!.comments).toHaveLength(0);
  });


  it('суточный лимит — на одного человека и на одно дело, и сутки кончаются', async () => {
    const w = await world();
    const second = await addPerson(w.orgId);
    const other = await inOrg(w.orgId, (db) => createTask(
      db, { ...base, title: 'второе дело', assigneeUserId: w.person }, { kind: 'agent', agentId: w.agent, userId: w.ownerId }, MON_10));

    for (let i = 0; i < 20; i++) await inOrg(w.orgId, (db) => addHumanComment(db, w.task, w.person, `реплика ${i}`));
    await expect(inOrg(w.orgId, (db) => addHumanComment(db, w.task, w.person, 'двадцать первая')))
      .rejects.toMatchObject({ code: 'limit_exceeded' });

    // Лимит не общий: у другого человека и у другого дела свой счёт.
    await inOrg(w.orgId, (db) => db.query(
      `update memberships set status = 'active' where user_id = $1 and org_id = current_setting('app.org_id')::uuid`, [second]));
    await expect(inOrg(w.orgId, (db) => addHumanComment(db, other.id, w.person, 'к другому делу'))).resolves.toBeTruthy();
    await expect(inOrg(w.orgId, (db) => addHumanComment(db, w.task, w.ownerId, 'от другого человека'))).resolves.toBeTruthy();

    // Сутки прошли — можно снова: окно скользящее, а не «навсегда».
    await inOrg(w.orgId, (db) => db.query(
      `update task_messages set created_at = created_at - interval '25 hours' where task_id = $1 and author_user_id = $2`,
      [w.task, w.person]));
    await expect(inOrg(w.orgId, (db) => addHumanComment(db, w.task, w.person, 'на следующий день'))).resolves.toBeTruthy();
  });

  it('отвеченной считается только реплика, на которую агент ответил ПОСЛЕ неё', async () => {
    const w = await world();
    // Агент написал по делу заранее — это не ответ на то, чего ещё не было.
    await inOrg(w.orgId, (db) => addComment(db, w.task, { kind: 'agent', agentId: w.agent, userId: w.ownerId }, 'начинаем'));
    await inOrg(w.orgId, (db) => addHumanComment(db, w.task, w.person, 'поставщик перенёс на четверг'));

    await waitForEvents(w.orgId);

    const b = await inOrg(w.orgId, (db) => getBriefing(db, minutes(MON_10, 2)));
    expect(b.agents.find((x) => x.id === w.agent)!.comments).toHaveLength(1);
  });

  it('правка задачи тоже считается ответом на реплику, не только comment_task', async () => {
    const w = await world();
    await inOrg(w.orgId, (db) => addHumanComment(db, w.task, w.person, 'срок не успеваем'));
    await inOrg(w.orgId, (db) => updateTask(db, w.task, { dueDate: '2027-01-15' }, { kind: 'agent', agentId: w.agent, userId: w.ownerId }, minutes(MON_10, 5)));

    await waitForEvents(w.orgId);

    const b = await inOrg(w.orgId, (db) => getBriefing(db, minutes(MON_10, 10)));
    expect(b.agents.find((x) => x.id === w.agent)!.comments).toHaveLength(0);
  });

  it('реплик больше предела: приходят самые старые, остальные — событиями', async () => {
    const w = await world();
    for (let i = 0; i < 12; i++) {
      await inOrg(w.orgId, (db) => addHumanComment(db, w.task, w.person, `реплика ${i}`));
      await inOrg(w.orgId, (db) => db.query(
        `update task_messages set created_at = now() - interval '1 hour' * $2 where text = $1`, [`реплика ${i}`, 12 - i]));
    }
    await waitForEvents(w.orgId);
    const b = await inOrg(w.orgId, (db) => getBriefing(db, minutes(MON_10, 2)));
    const got = b.agents.find((x) => x.id === w.agent)!.comments;
    expect(got.length).toBeGreaterThan(1);
    // Старые первыми: агент разбирает очередь с головы, а не с хвоста.
    expect(got[0]!.text).toMatchObject({ text: 'реплика 0' });
    expect(new Date(got[0]!.at).getTime()).toBeLessThan(new Date(got[1]!.at).getTime());
  });

  it('постановщик-человек пишет к делу, которое ведёт не он', async () => {
    const { orgId } = await makeOrg();
    const author = await addPerson(orgId, 'admin');   // задачу человеком ставит владелец или админ
    const worker = await addPerson(orgId);
    const outsider = await addPerson(orgId);
    const task = await inOrg(orgId, (db) => createTask(
      db, { ...base, title: 'встретить поставщика', assigneeUserId: worker }, { kind: 'user', userId: author }, MON_10));

    await expect(inOrg(orgId, (db) => addHumanComment(db, task.id, author, 'поставщик будет во вторник'))).resolves.toBeTruthy();
    // Посторонний из той же организации — нет: карточки он и не видит.
    await expect(inOrg(orgId, (db) => addHumanComment(db, task.id, outsider, 'а я мимо проходил')))
      .rejects.toMatchObject({ code: 'forbidden' });
  });

  it('приглашённый, ещё не принявший приглашение, не пишет ни одним каналом', async () => {
    const w = await world();
    await inOrg(w.orgId, (db) => db.query(
      `update memberships set status = 'invited' where user_id = $1 and org_id = current_setting('app.org_id')::uuid`, [w.person]));
    await expect(inOrg(w.orgId, (db) => addHumanComment(db, w.task, w.person, 'я ещё не вошёл, но пишу')))
      .rejects.toMatchObject({ code: 'forbidden' });
  });
});
