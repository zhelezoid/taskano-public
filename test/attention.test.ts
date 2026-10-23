import { afterAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { closePools } from '../src/db/pool.js';
import { createTask } from '../src/core/tasks.js';
import { createProject } from '../src/core/projects.js';
import { takeTask } from '../src/core/queue.js';
import { transition } from '../src/core/lifecycle.js';
import { addHumanComment } from '../src/core/comments.js';
import { buildMcpServer } from '../src/mcp/server.js';
import { addPerson, inOrg, makeOrg, MON_10, minutes, uniq } from './helpers.js';
import type { Actor } from '../src/core/types.js';

// Блок «внимание» сводки (спека owner-attention): реплика без отклика дольше часа
// рабочего времени, сданное без приёмки, открытые дела каждого со ссылкой — для проверки владельца.

afterAll(closePools);

async function briefing(userId: string, args: Record<string, unknown> = {}): Promise<any> {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await buildMcpServer({ userId }).connect(serverT);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(clientT);
  const r = await client.callTool({ name: 'get_briefing', arguments: args }) as { isError?: boolean; content: { text: string }[] };
  expect(r.isError ?? false).toBe(false);
  return JSON.parse(r.content[0]!.text);
}

const user = (userId: string): Actor => ({ kind: 'user', userId });
const base = { why: 'зачем', doneCriteria: 'критерий', dueDate: '2026-12-31', description: 'как делать: открыть таблицу' };

describe('get_briefing: attention', () => {
  it('без attention: true блока нет', async () => {
    const { ownerId } = await makeOrg();
    expect((await briefing(ownerId)).attention).toBeUndefined();
  });

  it('реплика исполнителя без отклика — в unanswered со ссылкой; после ответа автора уходит', async () => {
    const { orgId, ownerId } = await makeOrg();
    const a = await addPerson(orgId, 'member');
    const t = await inOrg(orgId, (db) => createTask(db, { ...base, title: `кредит ${uniq()}`, assigneeUserId: a }, user(ownerId), MON_10), ownerId);
    // Реплика неделей раньше «сейчас»: рабочих часов прошло заведомо больше одного.
    await inOrg(orgId, (db) => addHumanComment(db, t.id, a, 'ждём ответа бухгалтера', minutes(MON_10, 10)), a);

    const before = (await briefing(ownerId, { attention: true })).attention;
    expect(before.unanswered.map((x: { task: string }) => x.task)).toEqual([t.id]);
    const row = before.unanswered[0];
    expect(row.link).toMatch(new RegExp(`\\?start=t_${row.short_id}$`));
    expect(row.text).toEqual({ untrusted: true, text: 'ждём ответа бухгалтера' });
    expect(row.waiting_working_minutes).toBeGreaterThanOrEqual(60);

    await inOrg(orgId, (db) => addHumanComment(db, t.id, ownerId, 'спасибо, жду', minutes(MON_10, 20)), ownerId);
    expect((await briefing(ownerId, { attention: true })).attention.unanswered).toEqual([]);
  });

  it('свежая реплика (меньше часа рабочего времени) и реплика автора в своё дело — не в unanswered', async () => {
    const { orgId, ownerId } = await makeOrg();
    const a = await addPerson(orgId, 'member');
    const fresh = await inOrg(orgId, (db) => createTask(db, { ...base, title: 'свежее', assigneeUserId: a }, user(ownerId), MON_10), ownerId);
    await inOrg(orgId, (db) => addHumanComment(db, fresh.id, a, 'только что написал'), a);
    const own = await inOrg(orgId, (db) => createTask(db, { ...base, title: 'своё', assigneeUserId: a }, user(ownerId), MON_10), ownerId);
    await inOrg(orgId, (db) => addHumanComment(db, own.id, ownerId, 'заметка себе', minutes(MON_10, 5)), ownerId);

    expect((await briefing(ownerId, { attention: true })).attention.unanswered).toEqual([]);
  });

  it('сданное без приёмки — в waiting_review; открытые дела — у каждого человека; закрытого проекта нет', async () => {
    const { orgId, ownerId } = await makeOrg();
    const a = await addPerson(orgId, 'member');
    const b = await addPerson(orgId, 'member');
    const handed = await inOrg(orgId, (db) => createTask(db, { ...base, title: 'сжать видео', assigneeUserId: a }, user(ownerId), MON_10), ownerId);
    await inOrg(orgId, (db) => takeTask(db, handed.id, user(a), { now: MON_10 }), a);
    await inOrg(orgId, (db) => addHumanComment(db, handed.id, a, 'всё готово, сдаю', minutes(MON_10, 4)), a);
    await inOrg(orgId, (db) => transition(db, handed.id, 'submit', user(a), { now: minutes(MON_10, 5) }), a);
    const other = await inOrg(orgId, (db) => createTask(db, { ...base, title: 'сжать видео для сайта', assigneeUserId: b }, user(ownerId), MON_10), ownerId);

    const secret = await inOrg(orgId, (db) => createProject(db, { name: `Найм ${uniq()}`, private: true }, user(ownerId)), ownerId);
    await inOrg(orgId, (db) => db.query('insert into project_members(org_id, project_id, user_id) values ($1, $2, $3) on conflict do nothing', [orgId, secret.id, b]), ownerId);
    const hidden = await inOrg(orgId, (db) => createTask(db, { ...base, title: 'оффер кандидату', assigneeUserId: b, project: secret.id }, user(ownerId), MON_10), ownerId);

    const att = (await briefing(ownerId, { attention: true })).attention;
    expect(att.waiting_review.map((x: { task: string }) => x.task)).toEqual([handed.id]);
    // «Сдаю» и сдал — дело в отчёте один раз.
    expect(att.unanswered).toEqual([]);
    const all = att.people.flatMap((p: { tasks: { task: string; link: string }[] }) => p.tasks);
    expect(all.map((x: { task: string }) => x.task).sort()).toEqual([handed.id, other.id].sort());
    expect(all.every((x: { link: string }) => /start=t_\d+$/.test(x.link))).toBe(true);
    expect(all.map((x: { task: string }) => x.task)).not.toContain(hidden.id);
  });
});
