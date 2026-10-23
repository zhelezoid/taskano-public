import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import './helpers.js';
import { closePools, withGlobal, withSystem } from '../src/db/pool.js';
import { addMember, createCompanyOrg, ensureUserByEmail } from '../src/core/people.js';
import { demoCodeHash, generateDemoCode } from '../src/core/demo-code.js';
import { outbox } from '../src/email/send.js';
import { createTask } from '../src/core/tasks.js';
import { DEMO_COMPANY, DEMO_OWNER_EMAIL, DEMO_PEOPLE_DOMAIN, demoReset, type DemoSummary } from '../src/admin/demo-seed.js';
import { addPerson, inOrg, makeOrg, makeUser } from './helpers.js';
import { callTool, connectClient } from './mcp-client.js';

// Демо-компания для ревьюера каталога (спека demo-access): сброс идемпотентен, чужого не трогает, и в
// демо есть на чём показать каждый инструмент — дело в каждом состоянии, вопрос, ждущий ответа, и
// результат, ждущий приёмки.

afterAll(closePools);

// Демо-вход включён: без него demoReset отказывается работать (письма демо-владельцу не глушились бы).
const CODE = generateDemoCode();
const enableDemo = () => {
  process.env.DEMO_LOGIN_EMAIL = DEMO_OWNER_EMAIL;
  process.env.DEMO_LOGIN_CODE_SHA256 = demoCodeHash(CODE);
};
enableDemo();

// Состояния жизненного цикла ядра (src/core/types.ts, TaskStatus) — демо обязано показать каждое.
const ALL_STATUSES = [
  'draft', 'scheduled', 'ready', 'active', 'in_progress', 'blocked', 'waiting_external',
  'submitted', 'rework', 'done', 'declined', 'cancelled', 'waiting', 'resolved',
];

const demoCompanies = async (): Promise<string[]> => withGlobal(async (db) => (await db.query(
  `select o.id from orgs o join user_emails e on e.user_id = o.owner_user_id
    where e.email = $1 and o.kind = 'company'`, [DEMO_OWNER_EMAIL])).rows.map((r) => r.id as string));

// Счёт мимо RLS: закрытые проекты не должны прятать дела от проверки «ничего не пропало».
const orgFootprint = (orgId: string) => withSystem(async (db) => {
  const q = async (sql: string) => (await db.query(sql, [orgId])).rows[0].n as number;
  return {
    tasks: await q('select count(*)::int as n from tasks where org_id = $1'),
    projects: await q('select count(*)::int as n from projects where org_id = $1'),
    members: await q('select count(*)::int as n from memberships where org_id = $1'),
    messages: await q('select count(*)::int as n from task_messages where org_id = $1'),
    events: await q('select count(*)::int as n from events where org_id = $1'),
  };
});

describe('demo-reset', () => {
  let other: { orgId: string; ownerId: string };
  let before: Awaited<ReturnType<typeof orgFootprint>>;
  let first: DemoSummary;
  let second: DemoSummary;
  let realPerson: string;
  let token: string;

  beforeAll(async () => {
    // Чужая компания с живыми делами — сброс демо не вправе её задеть.
    other = await makeOrg();
    const worker = await addPerson(other.orgId);
    await inOrg(other.orgId, async (db) => {
      for (const title of ['Other org task one', 'Other org task two']) {
        await createTask(db, {
          title, assigneeUserId: worker, description: 'how', why: 'why', doneCriteria: 'done', dueDate: '2026-12-31',
        }, { kind: 'user', userId: other.ownerId });
      }
    }, other.ownerId);
    before = await orgFootprint(other.orgId);

    first = await demoReset();
    // Ревьюер пригласил в демо настоящего человека: сброс уберёт его из демо, но не из продукта.
    realPerson = await makeUser();
    await withGlobal((db) => addMember(db, first.org_id, realPerson, 'member'));
    // Коннектор ревьюера подключён до сброса — после сброса он обязан работать дальше.
    token = await connectClient(DEMO_OWNER_EMAIL, { code: CODE });
    second = await demoReset();
  });

  it('два сброса подряд — одна демо-компания, заведённая заново', async () => {
    const orgs = await demoCompanies();
    expect(orgs).toEqual([second.org_id]);
    expect(second.org_id).not.toBe(first.org_id);
    // Прежняя организация снесена целиком, вместе со своим слоем.
    expect(await orgFootprint(first.org_id)).toEqual({ tasks: 0, projects: 0, members: 0, messages: 0, events: 0 });
    const org = await withGlobal(async (db) => (await db.query('select name, language, timezone from orgs where id = $1', [second.org_id])).rows[0]);
    expect(org).toEqual({ name: DEMO_COMPANY, language: 'en', timezone: 'Europe/London' });
  });

  it('владелец demo@taskano.app тот же человек после сброса — его токены переживают сброс', async () => {
    expect(second.owner.user_id).toBe(first.owner.user_id);
    const owner = await withGlobal(async (db) => (await db.query(
      `select m.role, m.status from memberships m where m.org_id = $1 and m.user_id = $2`, [second.org_id, second.owner.user_id])).rows[0]);
    expect(owner).toEqual({ role: 'owner', status: 'active' });
  });

  it('чужая организация и её дела не тронуты', async () => {
    expect(await orgFootprint(other.orgId)).toEqual(before);
  });

  it('вымышленные люди не копятся, настоящий приглашённый остаётся в продукте, но не в демо', async () => {
    const fictional = await withGlobal(async (db) => (await db.query(
      `select count(*)::int as n from user_emails where lower(email::text) like $1`, [`%@${DEMO_PEOPLE_DOMAIN}`])).rows[0].n);
    expect(fictional).toBe(4);
    // Прежних вымышленных именно удалили, а не нашли заново по почте.
    expect(second.wiped).toEqual({ companies: 1, people: 4, people_kept: 0, other_companies_kept: 0 });
    const real = await withGlobal(async (db) => (await db.query(
      `select (select count(*)::int from users where id = $1) as user,
              (select count(*)::int from memberships where user_id = $1 and org_id = $2) as in_demo`, [realPerson, second.org_id])).rows[0]);
    expect(real).toEqual({ user: 1, in_demo: 0 });
  });

  it('четыре человека на разных языках, один приглашён; открытый и закрытый проекты', async () => {
    expect(second.people.map((p) => p.language).sort()).toEqual(['en', 'ru', 'tr', 'vi']);
    expect(second.people.filter((p) => p.status === 'invited')).toHaveLength(1);
    expect(second.people.filter((p) => p.status === 'active')).toHaveLength(3);
    const projects = await withSystem(async (db) => (await db.query(
      `select p.name, p.private, (select count(*)::int from project_members m where m.project_id = p.id) as members
         from projects p where p.org_id = $1`, [second.org_id])).rows);
    expect(projects).toContainEqual({ name: 'Website relaunch', private: false, members: 0 });
    expect(projects).toContainEqual({ name: 'Q4 hiring', private: true, members: 2 });
    // «Без проекта» — это проект по умолчанию: в нём несколько дел.
    const loose = await withSystem(async (db) => (await db.query(
      `select count(*)::int as n from tasks t join projects p on p.id = t.project_id
        where t.org_id = $1 and p.name = 'General' and not p.private`, [second.org_id])).rows[0].n);
    expect(loose).toBeGreaterThanOrEqual(3);
  });

  it('в демо есть дело каждого состояния жизненного цикла', async () => {
    const statuses = await withSystem(async (db) => (await db.query(
      'select distinct status from tasks where org_id = $1', [second.org_id])).rows.map((r) => r.status as string));
    for (const s of ALL_STATUSES) expect(statuses, `нет дела в состоянии ${s}`).toContain(s);
    // Сводка команды считает то же, что лежит в базе.
    expect(Object.keys(second.tasks.by_status).sort()).toEqual([...ALL_STATUSES].sort());
  });

  it('есть вопрос исполнителя без ответа и сданный результат, ждущий приёмки', async () => {
    const r = await withSystem(async (db) => {
      const question = await db.query(
        `select t.id from tasks t join task_messages m on m.task_id = t.id
          where t.org_id = $1 and t.status = 'blocked' and m.kind = 'question' and m.answered_at is null
            and m.author_user_id = t.assignee_user_id`, [second.org_id]);
      const submitted = await db.query(
        `select t.id from tasks t join task_results r on r.task_id = t.id
          where t.org_id = $1 and t.status = 'submitted' and t.author_agent_id is null`, [second.org_id]);
      return { question: question.rowCount, submitted: submitted.rowCount };
    });
    expect(r.question).toBeGreaterThanOrEqual(1);
    expect(r.submitted).toBeGreaterThanOrEqual(1);
  });

  it('завершённые дела и часы — за последние две недели, план агента с решением и заметкой', async () => {
    const r = await withSystem(async (db) => (await db.query(
      `select
         (select count(*)::int from tasks where org_id = $1 and status = 'done' and status_changed_at > now() - interval '14 days') as done,
         (select count(*)::int from time_entries where org_id = $1 and started_at > now() - interval '14 days') as time,
         (select count(*)::int from tasks where org_id = $1 and plan_id is not null) as steps,
         (select count(*)::int from plan_decisions where org_id = $1) as decisions,
         (select count(*)::int from agent_notes where org_id = $1) as notes,
         (select count(*)::int from task_messages where org_id = $1 and kind in ('comment', 'owner_instruction')) as comments`,
      [second.org_id])).rows[0]);
    expect(r.done).toBeGreaterThanOrEqual(3);
    expect(r.time).toBeGreaterThanOrEqual(3);
    expect(r.steps).toBeGreaterThanOrEqual(3);
    expect(r.decisions).toBeGreaterThanOrEqual(1);
    expect(r.notes).toBeGreaterThanOrEqual(1);
    expect(r.comments).toBeGreaterThanOrEqual(2);
  });

  it('у владельца есть личное дело и сброс записан в аудит', async () => {
    const personal = await withSystem(async (db) => (await db.query(
      `select count(*)::int as n from tasks t join projects p on p.id = t.project_id
        where t.org_id = $1 and p.private and p.owner_user_id = $2 and t.assignee_user_id = $2 and t.author_user_id = $2`,
      [second.org_id, second.owner.user_id])).rows[0].n);
    expect(personal).toBe(1);
    const audit = await withGlobal(async (db) => (await db.query(
      `select count(*)::int as n from admin_audit where action = 'demo_reset' and payload->>'org_id' = $1`, [second.org_id])).rows[0].n);
    expect(audit).toBe(1);
  });

  // Сценарий ревьюера (спека demo-access, человеческий пункт) — в машинном виде, последним: он меняет демо.
  it('коннектор, подключённый до сброса, проходит сценарий ревьюера', async () => {
    const parse = (r: Awaited<ReturnType<typeof callTool>>) => {
      expect(r.body.result.isError, JSON.stringify(r.body.result)).toBeFalsy();
      return JSON.parse(r.body.result.content[0].text);
    };
    const ids = await withSystem(async (db) => (await db.query(
      `select (select id from tasks where org_id = $1 and status = 'blocked' limit 1) as blocked,
              (select id from tasks where org_id = $1 and status = 'submitted' and author_agent_id is null limit 1) as submitted`,
      [second.org_id])).rows[0]);
    expect(parse(await callTool(token, 'answer_question', { task: ids.blocked, text: 'Point them to /journal.' })).status)
      .toMatch(/^(ready|in_progress|active)$/);
    expect(parse(await callTool(token, 'review_result', { task: ids.submitted })).status).toBe('done');
    const report = parse(await callTool(token, 'time_report', {
      from: new Date(Date.now() - 14 * 86400000).toISOString(), to: new Date(Date.now() + 86400000).toISOString(),
    }));
    expect(report.totalMinutes).toBeGreaterThan(0);
    // Часы правдоподобны: таймеры сценария тянулись бы днями от «Взять» до «Сдать» (130 ч у Эммы
    // за две недели — так увидел ревьюер каталога ChatGPT). Сутки на всю команду за две недели — потолок.
    expect(report.totalMinutes).toBeLessThan(24 * 60);
    const timers = await withSystem(async (db) => (await db.query(
      `select count(*)::int as n from time_entries where org_id = $1 and source = 'timer'`, [second.org_id])).rows[0].n);
    expect(timers).toBe(0);
    // «Личное» владельца — его закрытая доска в демо, а не закрытый проект найма.
    const own = parse(await callTool(token, 'create_task', { org: 'personal', title: 'Call the accountant', idempotency_key: 'demo-personal-1' }));
    const board = await withSystem(async (db) => (await db.query('select name from projects where id = $1', [own.project_id])).rows[0].name);
    expect(board).toBe('My notes');
  });
});

describe('demo-reset: чужое рядом с демо', () => {
  it('ни письма демо-владельцу, ни вымышленным людям при сбросе не уходит', async () => {
    const before = outbox.length;
    await demoReset();
    expect(outbox.slice(before).filter((m) => m.to === DEMO_OWNER_EMAIL || m.to.endsWith(`@${DEMO_PEOPLE_DOMAIN}`))).toEqual([]);
  });

  it('вымышленный человек, состоящий в чужой компании, остаётся — и его членство там тоже', async () => {
    const other = await makeOrg();
    const ghost = await withGlobal(async (db) => {
      const { user } = await ensureUserByEmail(db, `ghost-${Date.now()}@${DEMO_PEOPLE_DOMAIN}`);
      await addMember(db, other.orgId, user.id, 'member');
      return user.id;
    });
    const r = await demoReset();
    expect(r.wiped.people_kept).toBeGreaterThanOrEqual(1);
    const left = await withSystem(async (db) => (await db.query(
      'select count(*)::int as n from memberships where org_id = $1 and user_id = $2', [other.orgId, ghost])).rows[0].n);
    expect(left).toBe(1);
  });

  it('другая компания демо-владельца не сносится, а называется в сводке', async () => {
    const side = await withGlobal(async (db) => {
      const owner = (await db.query('select user_id from user_emails where email = $1', [DEMO_OWNER_EMAIL])).rows[0].user_id as string;
      return createCompanyOrg(db, owner, 'Reviewer Side Project');
    });
    const r = await demoReset();
    expect(r.wiped.other_companies_kept).toBe(1);
    expect(r.wiped.companies).toBe(1);
    const still = await withGlobal(async (db) => (await db.query('select count(*)::int as n from orgs where id = $1', [side])).rows[0].n);
    expect(still).toBe(1);
  });

  it('без демо-входа сброс отказывается работать', async () => {
    delete process.env.DEMO_LOGIN_EMAIL;
    try {
      await expect(demoReset()).rejects.toThrow(/DEMO_LOGIN_EMAIL/);
    } finally {
      enableDemo();
    }
  });
});
