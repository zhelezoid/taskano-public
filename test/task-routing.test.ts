import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import './helpers.js';
import { inOrg } from './helpers.js';
import { closePools, withGlobal, withSystem } from '../src/db/pool.js';
import { sha256 } from '../src/core/crypto.js';
import { movedLineKey } from '../src/bot/cards.js';
import { LANGS, t } from '../src/i18n/index.js';
import { callTool, connectClient } from './mcp-client.js';

// Перенос дела между личным пространством и компанией — спека task-routing, Acceptance.

afterAll(async () => { await closePools(); });

function parse(r: Awaited<ReturnType<typeof callTool>>): any {
  return JSON.parse((r.body.result as any).content[0].text);
}

const error = (r: Awaited<ReturnType<typeof callTool>>): string => JSON.stringify(r.body.result);

async function insertInviteCode(): Promise<string> {
  const code = `code-${randomUUID()}`;
  await withGlobal((db) => db.query(
    `insert into product_invite_codes(code_hash, note, created_by) values ($1, 'test', 'test')`, [sha256(code)]));
  return code;
}

interface Owner { email: string; token: string; org: string; personal: string }

/** Человек с коннектором и своей компанией. Вход по коду ограничен по IP — заводим людей один раз. */
async function owner(prefix: string): Promise<Owner> {
  const email = `${prefix}-${randomUUID()}@test.local`;
  const token = await connectClient(email);
  const invite = await insertInviteCode();
  const org = parse(await callTool(token, 'create_org', { name: `Org ${randomUUID().slice(0, 6)}`, invite_code: invite })).org_id as string;
  // Организации человека приходят полем `orgs` ответа whoami (слияние поверхности коннектора).
  const orgs = parse(await callTool(token, 'whoami', {})).orgs as { id: string; kind: string }[];
  return { email, token, org, personal: orgs.find((o) => o.kind === 'personal')!.id };
}

async function personalItem(token: string, title: string): Promise<{ id: string; org_id: string }> {
  return parse(await callTool(token, 'create_task', { org: 'personal', title, idempotency_key: randomUUID() }));
}

async function companyTask(o: Owner, title: string, extra: Record<string, unknown> = {}): Promise<string> {
  return parse(await callTool(o.token, 'create_task', {
    org: o.org, title, assignee: o.email, ...CONTEXT, idempotency_key: randomUUID(), ...extra,
  })).id as string;
}

/** Контекст, который компания требует от любого дела (правило полноты, спека task-context). */
const CONTEXT = {
  why: 'поставка держит весь заказ', done_criteria: 'срок подтверждён письмом', due_date: '2026-12-31',
  description: 'как делать: написать поставщику по почте, ответ приложить к делу',
  source: { kind: 'chat', title: 'разговор о поставке', quote: 'сказал, что поставка держит заказ' },
};

/** В каких организациях лежат строки таблицы по этому делу. */
async function orgsOf(table: string, taskId: string): Promise<string[]> {
  return withSystem(async (db) => {
    const r = await db.query(`select distinct org_id from ${table} where task_id = $1`, [taskId]);
    return r.rows.map((row) => row.org_id as string);
  });
}

async function movedEvents(taskId: string): Promise<{ org_id: string; data: Record<string, string> }[]> {
  return withSystem(async (db) => {
    const r = await db.query(`select org_id, data from events where task_id = $1 and type = 'task_moved' order by id`, [taskId]);
    return r.rows;
  });
}

let me: Owner;
let stranger: Owner;
let agent: string;

beforeAll(async () => {
  me = await owner('routing');
  stranger = await owner('stranger');
  agent = parse(await callTool(me.token, 'create_agent', { org: me.org, name: `agent-${randomUUID().slice(0, 6)}` })).id as string;
});

describe('move_to_org — дело переезжает между пространствами', () => {
  it('личное → компания: org_id задачи и её истории сменился, в истории есть task_moved', async () => {
    const item = await personalItem(me.token, 'договориться с поставщиком о сроке');
    await callTool(me.token, 'add_source', { org: 'personal', task: item.id, kind: 'chat', title: 'разговор 19 сентября', quote: 'успеть до пятницы' });
    await callTool(me.token, 'comment_task', { org: 'personal', task: item.id, text: 'звонил, не дозвонился' });

    const moved = parse(await callTool(me.token, 'move_to_org', { task: item.id, org: me.org, ...CONTEXT }));
    expect(moved.org_id).toBe(me.org);
    expect(moved.why).toBe(CONTEXT.why);
    expect(moved.done_criteria).toBe(CONTEXT.done_criteria);
    expect(moved.due_date).toBe(CONTEXT.due_date);
    // Поля личного разбора в компании не живут, пометка «рабочее» больше не нужна.
    expect(moved.category).toBeNull();
    expect(moved.shared_org_id).toBeNull();

    for (const table of ['events', 'task_sources', 'task_messages']) {
      expect(await orgsOf(table, item.id), table).toEqual([me.org]);
    }
    const events = await movedEvents(item.id);
    expect(events.length).toBe(1);
    expect(events[0]!.org_id).toBe(me.org);
    expect(events[0]!.data).toEqual({ from_org: me.personal, to_org: me.org });
  });

  it('между двумя компаниями дело не ходит: это был бы вынос данных одной к другой', async () => {
    // Человек работает на двух работодателей — обе организации «свои», но владельцы данных разные.
    const secondOrg = await owner('second');
    const invite = await insertInviteCode();
    const other = parse(await callTool(me.token, 'create_org', { name: `Org ${randomUUID().slice(0, 6)}`, invite_code: invite })).org_id as string;
    void secondOrg;

    const task = await companyTask(me, 'цена контракта');
    await callTool(me.token, 'comment_task', { org: me.org, agent, task, text: 'маржа 18%, ниже не идём' });

    const moved = parse(await callTool(me.token, 'move_to_org', { task, org: other, ...CONTEXT }));
    expect(moved.code).toBe('conflict');
    // Ничего не уехало: ни дело, ни его переписка.
    expect(await orgsOf('events', task)).toEqual([me.org]);
    expect(await orgsOf('task_messages', task)).toEqual([me.org]);
  });

  it('чужую постановку в своё личное не унести', async () => {
    const worker = await owner('worker');
    const invite = parse(await callTool(me.token, 'invite_person', {
      org: me.org, email: worker.email, name: 'Ким', language: 'ru',
    }));
    expect(invite.code ?? 'ok').not.toBe('validation_failed');
    await withSystem((db) => db.query(
      `update memberships set status = 'active' where org_id = $1 and user_id = (select user_id from user_emails where email = $2)`,
      [me.org, worker.email]));

    const task = parse(await callTool(me.token, 'create_task', {
      org: me.org, title: 'встретить поставщика', assignee: worker.email, ...CONTEXT, idempotency_key: randomUUID(),
    })).id as string;

    const moved = parse(await callTool(worker.token, 'move_to_org', { task, org: 'personal' }));
    expect(moved.code).toBe('conflict');
    expect(await orgsOf('events', task)).toEqual([me.org]);
  });

  it('чужое недоставленное уведомление не уезжает с делом', async () => {
    const item = await personalItem(me.token, 'забрать документы');
    const outsider = await owner('outsider');
    const outsiderId = await withSystem(async (db) => (await db.query(
      'select user_id from user_emails where email = $1', [outsider.email])).rows[0].user_id as string);
    const meId = await withSystem(async (db) => (await db.query(
      'select user_id from user_emails where email = $1', [me.email])).rows[0].user_id as string);

    // Два уведомления по делу: моё и чужое, оба ещё не доставлены.
    await withSystem((db) => db.query(
      `insert into notifications(org_id, user_id, task_id, kind, level)
       values ($1, $2, $3, 'task_comment', 'work'), ($1, $4, $3, 'task_comment', 'work')`,
      [item.org_id, meId, item.id, outsiderId]));

    const moved = parse(await callTool(me.token, 'move_to_org', { task: item.id, org: me.org, ...CONTEXT }));
    expect(moved.org_id).toBe(me.org);

    const rows = await withSystem(async (db) => (await db.query(
      'select user_id, org_id, delivered_at from notifications where task_id = $1', [item.id])).rows);
    const mine = rows.find((r: any) => r.user_id === meId)!;
    const theirs = rows.find((r: any) => r.user_id === outsiderId)!;
    expect(mine.org_id).toBe(me.org);                 // моё уехало вместе с делом
    expect(theirs.org_id).toBe(item.org_id);          // чужое осталось в прежней организации
    expect(theirs.delivered_at).not.toBeNull();       // и погашено: дела там больше нет
  });

  it('в компанию без why / done_criteria / due_date — validation_failed', async () => {
    const item = await personalItem(me.token, 'подписать договор аренды склада');
    expect(error(await callTool(me.token, 'move_to_org', { task: item.id, org: me.org }))).toContain('validation_failed');
    expect(error(await callTool(me.token, 'move_to_org', { task: item.id, org: me.org, why: CONTEXT.why }))).toContain('validation_failed');
    expect(error(await callTool(me.token, 'move_to_org', {
      task: item.id, org: me.org, why: CONTEXT.why, done_criteria: CONTEXT.done_criteria,
    }))).toContain('validation_failed');
    // Ничего не переехало: неполный перенос — не перенос.
    expect(await orgsOf('events', item.id)).toEqual([me.personal]);
  });

  it('агент перенести не может — forbidden, дело остаётся на месте', async () => {
    const item = await personalItem(me.token, 'проверить остатки на складе');
    const r = await callTool(me.token, 'move_to_org', { task: item.id, org: me.org, agent, ...CONTEXT });
    expect(error(r)).toContain('forbidden');
    expect(await orgsOf('events', item.id)).toEqual([me.personal]);
  });

  it('шаг плана и дело с агентом-автором в личное не переносятся — conflict', async () => {
    // Шаг заводит человек (без agent): в нём остаётся один запрет — план, и его видно отдельно
    // от запрета на дело агента-автора.
    const plan = parse(await callTool(me.token, 'create_plan', { org: me.org, agent, goal: 'наладить снабжение' })).id as string;
    const step = parse(await callTool(me.token, 'add_step', {
      org: me.org, plan, title: 'собрать цены трёх поставщиков', assignee: me.email, ...CONTEXT, idempotency_key: randomUUID(),
    }));
    expect(step.author_agent_id).toBeNull();
    expect(error(await callTool(me.token, 'move_to_org', { task: step.id, org: 'personal' }))).toContain('conflict');

    const byAgent = await companyTask(me, 'позвонить в банк', { agent });
    expect(error(await callTool(me.token, 'move_to_org', { task: byAgent, org: 'personal' }))).toContain('conflict');
    expect(await orgsOf('events', byAgent)).toEqual([me.org]);
  });

  it('закрытое дело не переносится — conflict', async () => {
    const item = await personalItem(me.token, 'оплатить страховку машины');
    await callTool(me.token, 'submit_task', { org: 'personal', task: item.id });
    expect(error(await callTool(me.token, 'move_to_org', { task: item.id, org: me.org, ...CONTEXT }))).toContain('conflict');
    expect(await orgsOf('events', item.id)).toEqual([me.personal]);
  });

  it('чужое дело перенести нельзя — not_found', async () => {
    const theirs = await personalItem(stranger.token, 'их личное дело');
    const r = await callTool(me.token, 'move_to_org', { task: theirs.id, org: me.org, ...CONTEXT });
    expect(error(r)).toContain('not_found');
    expect(await orgsOf('events', theirs.id)).toEqual([stranger.personal]);
  });

  it('повтор переноса в ту же организацию — успех без второго task_moved', async () => {
    const item = await personalItem(me.token, 'согласовать смету на ремонт');
    expect(parse(await callTool(me.token, 'move_to_org', { task: item.id, org: me.org, ...CONTEXT })).org_id).toBe(me.org);
    const again = await callTool(me.token, 'move_to_org', { task: item.id, org: me.org, ...CONTEXT });
    expect((again.body.result as any).isError).toBeFalsy();
    expect(parse(again).org_id).toBe(me.org);
    expect((await movedEvents(item.id)).length).toBe(1);
  });

  it('личное дело-ожидание уезжает в компанию ожиданием: срок проверки на месте, срока и критерия не просят', async () => {
    const item = parse(await callTool(me.token, 'create_task', {
      org: 'personal', title: 'ответ бухгалтера по акту', kind: 'waiting', waiting_for: 'бухгалтер',
      next_check_at: '2026-12-15', idempotency_key: randomUUID(),
    }));
    const moved = parse(await callTool(me.token, 'move_to_org', { task: item.id, org: me.org, why: CONTEXT.why }));
    expect(moved.org_id).toBe(me.org);
    expect(moved.kind).toBe('waiting');
    expect(moved.waiting.waiting_for).toBe('бухгалтер');
    expect(moved.waiting.next_check_at.slice(0, 10)).toBe('2026-12-15');
  });

  it('компания → личное: дело без плана и без агента-автора уходит вместе с историей', async () => {
    const task = await companyTask(me, 'продлить страховку машины');
    const moved = parse(await callTool(me.token, 'move_to_org', { task, org: 'personal' }));
    expect(moved.org_id).toBe(me.personal);
    // Контекст компании остаётся в деле: срок и «зачем» никуда не деваются.
    expect(moved.why).toBe(CONTEXT.why);
    expect(moved.due_date).toBe(CONTEXT.due_date);
    expect(await orgsOf('events', task)).toEqual([me.personal]);
    expect(parse(await callTool(me.token, 'find_task', { org: 'personal' })).tasks.some((x: { id: string }) => x.id === task)).toBe(true);
  });
});

  it('тот же внешний тикет уже есть у другого дела компании — перенос проходит', async () => {
    // Один объект внешней системы — основание нескольких дел (миграция 024): уникален он в
    // организации в пределах дела, а не на всю организацию. Прежняя проверка отказывала здесь,
    // хотя база такую пару уже принимает.
    const item = await personalItem(me.token, 'позвонить в поддержку трекера');
    const already = await companyTask(me, 'разобраться с тикетом');
    for (const [task, org] of [[already, me.org], [item.id, item.org_id]] as const) {
      const r = await callTool(me.token, 'add_source', {
        org, agent: org === me.org ? agent : undefined, task, kind: 'external',
        title: 'тикет трекера', system: 'tracker', external_id: 'T-777',
      });
      expect(JSON.stringify(r)).not.toContain('"error"');
    }

    const moved = parse(await callTool(me.token, 'move_to_org', { task: item.id, org: me.org, ...CONTEXT }));
    expect(moved.org_id).toBe(me.org);
    expect(await orgsOf('task_sources', item.id)).toEqual([me.org]);
    // Оба дела компании ссылаются на тот же тикет, каждое своей строкой.
    const linked = await withSystem(async (db) => (await db.query(
      `select task_id from task_sources where org_id = $1 and system = 'tracker' and external_id = 'T-777'`, [me.org])).rows
      .map((r) => r.task_id as string));
    expect(linked.sort()).toEqual([already, item.id].sort());
  });

describe('где перенос виден человеку', () => {
  it('в истории карточки бота — «Перенесено из личного» / «Перенесено в личное» на всех языках', async () => {
    const item = await personalItem(me.token, 'договориться о доставке');
    await callTool(me.token, 'move_to_org', { task: item.id, org: me.org, ...CONTEXT });
    expect(await inOrg(me.org, (db) => movedLineKey(db, item.id))).toBe('moved.from_personal');

    const task = await companyTask(me, 'записаться к врачу');
    await callTool(me.token, 'move_to_org', { task, org: 'personal' });
    expect(await inOrg(me.personal, (db) => movedLineKey(db, task))).toBe('moved.to_personal');

    for (const lang of LANGS) {
      for (const key of ['moved.from_personal', 'moved.to_personal']) {
        expect(t(lang, key), `${lang}.${key}`).not.toBe(key);
      }
    }
  });

  it('правило «чьё это дело» и move_to_org описаны в SKILL.md и review.md', () => {
    for (const file of ['skill/skills/taskano/SKILL.md', 'skill/skills/taskano/review.md']) {
      const text = readFileSync(file, 'utf8').toLowerCase().replace(/\s+/g, ' ');
      expect(text, file).toContain('move_to_org');
      expect(text, file).toContain('whose item is this');
      expect(text, file).toContain('who does it');
    }
  });
});
