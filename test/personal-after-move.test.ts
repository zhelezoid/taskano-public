import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import './helpers.js';
import { closePools, withGlobal } from '../src/db/pool.js';
import { sha256 } from '../src/core/crypto.js';
import { callTool, connectClient } from './mcp-client.js';

// Личное после переезда в закрытые проекты (спека projects-stage2).
//
// Личное пространство перестало быть отдельной организацией и стало закрытым проектом человека
// внутри компании. Всё, что определяло «личное» по виду организации, на этом молча ломалось:
// коннектор искал старую пустую организацию и возвращал пустой список, хотя дела были на месте.
// Здесь проверяется путь целиком — от записи до закрытия — именно у человека с закрытым проектом.

afterAll(closePools);

const parse = (r: Awaited<ReturnType<typeof callTool>>): any => JSON.parse((r.body.result as any).content[0].text);
const error = (r: Awaited<ReturnType<typeof callTool>>): string => JSON.stringify(r.body.result);

async function inviteCode(): Promise<string> {
  const code = `code-${randomUUID()}`;
  await withGlobal((db) => db.query(
    `insert into product_invite_codes(code_hash, note, created_by) values ($1, 'test', 'test')`, [sha256(code)]));
  return code;
}

/** Человек с компанией и закрытым проектом в ней — то есть «переехавший» на projects-stage2. */
async function movedOwner(): Promise<{ token: string; org: string; board: string }> {
  const token = await connectClient(`moved-${randomUUID()}@test.local`);
  const org = parse(await callTool(token, 'create_org', { name: `Org ${randomUUID().slice(0, 6)}`, invite_code: await inviteCode() })).org_id as string;
  const board = parse(await callTool(token, 'create_project', { org, name: `Своё ${randomUUID().slice(0, 4)}`, private: true })).id as string;
  return { token, org, board };
}

describe('личное после переезда в закрытый проект', () => {
  // Вход по коду ограничен по IP — людей заводим один раз на файл.
  let me: { token: string; org: string; board: string };
  let other: { token: string; org: string; board: string };

  beforeAll(async () => {
    me = await movedOwner();
    other = await movedOwner();
  });

  it('записанное личное дело возвращается в личном списке, а не пропадает в старом пространстве', async () => {

    const item = parse(await callTool(me.token, 'create_task', { org: 'personal', title: 'позвонить в банк про счёт', idempotency_key: randomUUID() }));
    const list = parse(await callTool(me.token, 'find_task', { org: 'personal' })) as { tasks: { id: string }[] };

    expect(list.tasks.map((t) => t.id)).toContain(item.id);
  });

  it('дело, уже лежащее в закрытом проекте компании, видно в личном списке', async () => {
    const who = parse(await callTool(me.token, 'whoami', {})).user.id as string;
    // Так дело попадает в закрытый проект помимо create_task — из приложения или переносом.
    const task = parse(await callTool(me.token, 'create_task', {
      org: me.org, project: me.board, title: 'разобрать бумаги дома', assignee: who, idempotency_key: randomUUID(),
    })).id as string;

    const list = parse(await callTool(me.token, 'find_task', { org: 'personal' })) as { tasks: { id: string }[] };

    // Ровно то, что ломалось: список личного читался из старого пустого пространства.
    expect(list.tasks.map((t) => t.id)).toContain(task);
  });

  it('личное дело не требует «зачем» и срока, даже когда лежит внутри компании', async () => {

    // Одного названия достаточно: правила компании к личному не применяются.
    const r = await callTool(me.token, 'create_task', { org: 'personal', title: 'сходить к врачу', idempotency_key: randomUUID() });

    expect((r.body.result as any).isError).toBeFalsy();
    expect(parse(r).id).toBeTruthy();
  });

  it('«сделал» закрывает личное дело сразу, а не оставляет его ждать приёмки', async () => {
    const item = parse(await callTool(me.token, 'create_task', { org: 'personal', title: 'оплатить страховку', idempotency_key: randomUUID() }));

    const done = parse(await callTool(me.token, 'submit_task', { org: 'personal', task: item.id }));

    // Принимать личное дело некому — человек сам себе и автор, и исполнитель.
    expect(done.status).toBe('done');
  });

  it('чужое личное дело закрыть нельзя', async () => {
    const item = parse(await callTool(other.token, 'create_task', { org: 'personal', title: 'их дело', idempotency_key: randomUUID() }));

    expect(error(await callTool(me.token, 'submit_task', { org: 'personal', task: item.id }))).toContain('not_found');
  });
});
