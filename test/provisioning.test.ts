import { afterAll, describe, expect, it } from 'vitest';
import './helpers.js';
import { closePools, withGlobal } from '../src/db/pool.js';
import { provisionClient } from '../src/core/people.js';
import { ensureDefaultProject } from '../src/core/projects.js';
import { connectClient, callTool } from './mcp-client.js';
import { outbox } from '../src/email/send.js';
import { inOrg, uniq } from './helpers.js';

// Подписание клиента оператором (спека pilot-deploy, «Админка владельца продукта»): компания заведена
// ДО первого входа, поэтому клиент входит по почте и сразу работает — инвайт-код ему не нужен.

afterAll(closePools);

function parse(r: Awaited<ReturnType<typeof callTool>>): any {
  return JSON.parse(r.body.result.content[0].text);
}

describe('подписание клиента без инвайт-кода', () => {
  it('заводит человека, его личное пространство и компанию, где он владелец', async () => {
    const email = `client-${uniq()}@test.local`;
    const r = await withGlobal((db) => provisionClient(db, email, 'Acme'));
    expect(r.created).toBe(true);

    const rows = await withGlobal(async (db) => (await db.query(
      `select o.kind, o.name, o.language, o.timezone, m.role, m.status
         from memberships m join orgs o on o.id = m.org_id where m.user_id = $1 order by o.kind`, [r.userId])).rows);
    expect(rows).toHaveLength(2);
    const company = rows.find((x) => x.kind === 'company');
    const personal = rows.find((x) => x.kind === 'personal');
    expect(company).toMatchObject({ name: 'Acme', role: 'owner', status: 'active' });
    expect(personal).toMatchObject({ role: 'owner', status: 'active' });
    // Ни язык, ни часовой пояс за клиента не угаданы: нейтральные значения, клиент назовёт своё.
    expect(company.language).toBe('en');
    expect(company.timezone).toBe('UTC');
  });

  it('письмо владельцу объясняет три шага и называет адрес коннектора', async () => {
    const email = `client-${uniq()}@test.local`;
    await withGlobal((db) => provisionClient(db, email, 'Kahve', { language: 'ru' }));

    // Компания без письма — компания, о которой владелец не знает, что с ней делать: первый клиент
    // пилота так и просидел, разговаривая с Клодом без коннектора.
    const mail = outbox.filter((m) => m.to === email).at(-1);
    expect(mail, 'приветственное письмо не отправлено').toBeTruthy();
    expect(mail!.subject).toContain('Kahve');

    // Три шага и адрес коннектора — то, ради чего письмо и пишется.
    for (const must of ['skill', 'Connectors', '/mcp', 'github.com/example-org/taskano-skill']) {
      expect(mail!.text, `в письме нет «${must}»`).toContain(must);
      expect(mail!.html, `в вёрстке нет «${must}»`).toContain(must);
    }
    // И предупреждение про пустое приложение: именно на этом спотыкается живой человек.
    expect(mail!.text).toMatch(/коннектор не подключён/);

    // Письмо на языке, который назвал оператор.
    expect(mail!.subject).toMatch(/три шага/);
  });

  it('повтор команды не заводит вторую такую же компанию', async () => {
    const email = `client-${uniq()}@test.local`;
    const first = await withGlobal((db) => provisionClient(db, email, 'Acme'));
    const second = await withGlobal((db) => provisionClient(db, email, 'acme'));
    expect(second.created).toBe(false);
    expect(second.orgId).toBe(first.orgId);
    expect(second.userId).toBe(first.userId);
  });

  it('четыре одновременных вызова заводят одного человека и одну компанию', async () => {
    const email = `client-${uniq()}@test.local`;
    const results = await Promise.all([1, 2, 3, 4].map(() => withGlobal((db) => provisionClient(db, email, 'Acme'))));
    const orgIds = new Set(results.map((r) => r.orgId));
    const userIds = new Set(results.map((r) => r.userId));
    expect(orgIds.size).toBe(1);
    expect(userIds.size).toBe(1);
    // И ни одного человека-сироты без почты: вход ищет человека именно по ней.
    const orphans = await withGlobal(async (db) => (await db.query(
      `select count(*)::int as n from users u left join user_emails e on e.user_id = u.id where e.email is null`)).rows[0].n);
    expect(orphans).toBe(0);
  });

  it('мусорный часовой пояс отклоняется командой оператора, а не всплывает потом в тике', async () => {
    const email = `client-${uniq()}@test.local`;
    await expect(withGlobal((db) => provisionClient(db, email, 'Acme', { timezone: 'UTC+7' }))).rejects.toThrow(/time zone/i);
    const orgs = await withGlobal(async (db) => (await db.query(
      `select count(*)::int as n from orgs o join user_emails e on e.user_id = o.owner_user_id
        where e.email = $1 and o.kind = 'company'`, [email])).rows[0].n);
    expect(orgs).toBe(0);
  });

  it('клиент входит по почте и сразу видит свою компанию — create_org не нужен', async () => {
    const email = `client-${uniq()}@test.local`;
    const { orgId } = await withGlobal((db) => provisionClient(db, email, `Org ${uniq()}`));
    const token = await connectClient(email);

    const status = parse(await callTool(token, 'get_setup_status', {}));
    expect(status.has_org).toBe(true);

    // Никаких «сначала создайте организацию»: дело ставится в уже заведённую компанию.
    const task = parse(await callTool(token, 'create_task', {
      title: 'Первое дело', assignee: email, description: 'как делать: открыть Taskano и убедиться, что дело видно',
      why: 'проверка входа', done_criteria: 'дело создано',
      due_date: '2026-12-31', idempotency_key: `prov-${uniq()}`,
      source: { kind: 'chat', title: 'первый разговор', quote: 'давай заведём первое дело' },
    }));
    expect(task.org_id).toBe(orgId);
  });
});

describe('проект по умолчанию', () => {
  it('называется на языке организации, а не на языке пилота', async () => {
    const en = await withGlobal((db) => provisionClient(db, `client-${uniq()}@test.local`, `Org ${uniq()}`));
    const ru = await withGlobal((db) => provisionClient(db, `client-${uniq()}@test.local`, `Org ${uniq()}`, { language: 'ru' }));

    const nameOf = (orgId: string) => inOrg(orgId, async (db) => (await ensureDefaultProject(db, orgId)).name);
    expect(await nameOf(en.orgId)).toBe('General');
    expect(await nameOf(ru.orgId)).toBe('Разное');
  });
});

describe('настройки организации: имя и часовой пояс', () => {
  it('владелец переименовывает компанию и ставит свой часовой пояс', async () => {
    const email = `client-${uniq()}@test.local`;
    const { orgId } = await withGlobal((db) => provisionClient(db, email, 'Temporary name'));
    const token = await connectClient(email);

    const r = await callTool(token, 'update_org_settings', { name: 'Своё название', timezone: 'Asia/Ho_Chi_Minh', language: 'ru' });
    expect(parse(r)).toMatchObject({ ok: true });

    const org = await withGlobal(async (db) => (await db.query('select name, timezone, language from orgs where id = $1', [orgId])).rows[0]);
    expect(org).toMatchObject({ name: 'Своё название', timezone: 'Asia/Ho_Chi_Minh', language: 'ru' });
  });

  it('несуществующий часовой пояс отклоняется на входе, а не роняет расчёт календаря', async () => {
    const email = `client-${uniq()}@test.local`;
    const { orgId } = await withGlobal((db) => provisionClient(db, email, `Org ${uniq()}`));
    const token = await connectClient(email);

    const r = await callTool(token, 'update_org_settings', { timezone: 'Vietnam' });
    expect(r.body.result.isError).toBe(true);
    expect(parse(r).code).toBe('validation_failed');

    const window = await callTool(token, 'update_org_settings', {
      agent_window: { tz: 'GMT+7', days: [1, 2, 3, 4, 5], start: '09:00', end: '19:00' },
    });
    expect(window.body.result.isError).toBe(true);

    // Кривое значение в базу не попало — организация осталась на прежнем поясе.
    const org = await withGlobal(async (db) => (await db.query('select timezone from orgs where id = $1', [orgId])).rows[0]);
    expect(org.timezone).toBe('UTC');
  });

  it('трёхбуквенный алиас не проходит за часовой пояс', async () => {
    const email = `client-${uniq()}@test.local`;
    await withGlobal((db) => provisionClient(db, email, `Org ${uniq()}`));
    const token = await connectClient(email);

    // «IST» Intl понимает — как Индию, а не как Израиль, о чём никто бы не узнал. Такие имена
    // отклоняем: пояс называется полностью.
    for (const tz of ['IST', 'EST', 'PST', 'GMT', 'Turkey']) {
      const r = await callTool(token, 'update_org_settings', { timezone: tz });
      expect(r.body.result.isError, tz).toBe(true);
    }
    // Полные имена — проходят, включая те, которых нет в Intl.supportedValuesOf.
    for (const tz of ['Asia/Ho_Chi_Minh', 'America/Argentina/Buenos_Aires', 'Etc/GMT-7', 'UTC']) {
      const r = await callTool(token, 'update_org_settings', { timezone: tz });
      expect(parse(r), tz).toMatchObject({ ok: true });
    }
  });

  it('часовой пояс человека проверяется так же', async () => {
    const email = `client-${uniq()}@test.local`;
    await withGlobal((db) => provisionClient(db, email, `Org ${uniq()}`));
    const token = await connectClient(email);

    const bad = await callTool(token, 'set_person_settings', { person: email, timezone: 'UTC+3' });
    expect(bad.body.result.isError).toBe(true);
    const good = await callTool(token, 'set_person_settings', { person: email, timezone: 'America/Sao_Paulo' });
    expect(parse(good)).toMatchObject({ ok: true });
  });
});

// Слот и суточные лимиты держатся на том, что владелец функций 017/018 обходит RLS (на tasks стоит
// `force row level security`). Потеряй он это право — функции молча вернут одну компанию, и человек
// снова получит по делу «Сейчас» от каждой. Поломка обязана быть громкой.
describe('право владельца функций слота', () => {
  it('владелец функций обходит RLS — иначе слот считался бы по одной компании', async () => {
    const r = await withGlobal((db) => db.query(
      `select r.rolname, r.rolsuper or r.rolbypassrls as bypasses
         from pg_proc p join pg_roles r on r.oid = p.proowner
        where p.proname in ('person_slot_holders', 'person_agent_steps_since', 'person_daily_step_limit', 'person_reminders_since')`));
    expect(r.rowCount).toBe(4);
    for (const row of r.rows) expect(row.bypasses, row.rolname).toBe(true);
  });

  it('и само развёртывание это проверяет, а не полагается на удачу', async () => {
    const migrate = await import('node:fs').then((fs) => fs.readFileSync('src/db/migrate.ts', 'utf8'));
    expect(migrate).toContain('assertSlotFunctionsSeeEverything');
    // Проверка стоит в самой миграции: деплой падает на месте, а не через неделю у человека.
    expect(migrate.indexOf('await assertSlotFunctionsSeeEverything(client);')).toBeGreaterThan(-1);
  });
});
