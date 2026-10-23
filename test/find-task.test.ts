import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { closePools } from '../src/db/pool.js';
import { createTask } from '../src/core/tasks.js';
import { transition } from '../src/core/lifecycle.js';
import { createProject } from '../src/core/projects.js';
import { buildMcpServer } from '../src/mcp/server.js';
import { addPerson, inOrg, makeOrg, MON_10, uniq } from './helpers.js';
import { withOrg } from '../src/db/pool.js';

// Поиск дела по словам названия (спека task-in-conversation): человек помнит слова, а не то,
// личное это дело или компании.

afterAll(closePools);

async function mcp(userId: string): Promise<Client> {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await buildMcpServer({ userId }).connect(serverT);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(clientT);
  return client;
}

interface Found { org_id: string; org_name: string; org_kind: string; id: string; title: string; status: string }

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; data: any }> {
  // Схема zod отсекает аргумент до вызова — SDK бросает это исключением, а не ответом инструмента.
  try {
    const r = await client.callTool({ name, arguments: args }) as { isError?: boolean; content: { type: string; text: string }[] };
    return { isError: !!r.isError, data: JSON.parse(r.content[0]!.text) };
  } catch (e) {
    return { isError: true, data: { message: String(e) } };
  }
}

const find = async (client: Client, query: string, extra: Record<string, unknown> = {}): Promise<Found[]> =>
  (await call(client, 'find_task', { query, ...extra })).data.tasks as Found[];

const base = { why: 'зачем', doneCriteria: 'критерий', dueDate: '2026-12-31', description: 'как делать: открыть таблицу и свериться' };

/** Проставить делу дату создания: в фикстурах все дела создаются одним `now`, и порядок по дате не проверить. */
async function createdAt(orgId: string, taskId: string, iso: string): Promise<void> {
  await withOrg(orgId, (db) => db.query('update tasks set created_at = $2 where id = $1', [taskId, iso]));
}

/** Владелец с компанией, одним делом про каналы продаж и личным делом про ремонт. */
async function world() {
  const { orgId, ownerId } = await makeOrg();
  const task = await inOrg(orgId, (db) => createTask(db, {
    ...base, title: 'диверсификация каналов продаж', description: 'сидим на одном маркетплейсе',
    assigneeUserId: ownerId, release: true,
  }, { kind: 'user', userId: ownerId }, MON_10));
  const owner = await mcp(ownerId);
  await call(owner, 'create_task', { org: 'personal', title: 'доделать ремонт на кухне', idempotency_key: randomUUID() });
  return { orgId, ownerId, task, owner };
}

describe('find_task (спека task-in-conversation)', () => {
  it('находит дело по словам названия в любом порядке и говорит, где оно лежит', async () => {
    const w = await world();

    const direct = await find(w.owner, 'диверсификация каналов');
    expect(direct.map((t) => t.id)).toContain(w.task.id);
    const row = direct.find((t) => t.id === w.task.id)!;
    expect(row.org_id).toBe(w.orgId);
    expect(row.org_kind).toBe('company');
    expect(row.org_name).toBeTruthy();

    // Порядок слов не важен, слово из описания тоже ищется.
    expect((await find(w.owner, 'продаж каналов')).map((t) => t.id)).toContain(w.task.id);
    expect((await find(w.owner, 'маркетплейсе')).map((t) => t.id)).toContain(w.task.id);
  });

  it('ищет сразу по личному пространству и компании', async () => {
    const w = await world();
    const personal = await find(w.owner, 'ремонт кухне');
    expect(personal).toHaveLength(1);
    expect(personal[0]!.org_kind).toBe('personal');

    // Ограничение одним пространством: в личном дела компании не ищем.
    expect(await find(w.owner, 'диверсификация каналов', { org: 'personal' })).toHaveLength(0);
  });

  it('все слова запроса должны встретиться', async () => {
    const w = await world();
    expect(await find(w.owner, 'диверсификация логистики')).toHaveLength(0);
  });

  it('закрытое дело выдаётся только по явной просьбе', async () => {
    const w = await world();
    await inOrg(w.orgId, (db) => transition(db, w.task.id, 'submit', { kind: 'user', userId: w.ownerId }));

    expect(await find(w.owner, 'диверсификация каналов')).toHaveLength(0);
    const closed = await find(w.owner, 'диверсификация каналов', { include_closed: true });
    expect(closed.map((t) => t.status)).toEqual(['done']);
  });

  it('дела в работе идут впереди закрытых', async () => {
    const w = await world();
    const older = await inOrg(w.orgId, (db) => createTask(db, {
      ...base, title: 'каналы продаж: договор с Acmeshop', assigneeUserId: w.ownerId, release: true,
    }, { kind: 'user', userId: w.ownerId }, MON_10));
    const live = await inOrg(w.orgId, (db) => createTask(db, {
      ...base, title: 'каналы продаж: посчитать маржу', assigneeUserId: w.ownerId, release: true,
    }, { kind: 'user', userId: w.ownerId }, MON_10));
    await inOrg(w.orgId, (db) => transition(db, older.id, 'submit', { kind: 'user', userId: w.ownerId }));

    const rows = await find(w.owner, 'каналы продаж', { include_closed: true });
    expect(rows[0]!.id).toBe(live.id);
    expect(rows.map((t) => t.id)).toContain(older.id);
  });

  it('чужое дело не находится', async () => {
    const w = await world();
    const stranger = await makeOrg();
    await inOrg(stranger.orgId, (db) => createTask(db, {
      ...base, title: 'диверсификация каналов продаж у соседа', assigneeUserId: stranger.ownerId, release: true,
    }, { kind: 'user', userId: stranger.ownerId }, MON_10));

    const rows = await find(w.owner, 'диверсификация каналов');
    expect(rows.every((t) => t.org_id === w.orgId)).toBe(true);
  });

  it('закрытый проект другого человека в выдачу не протекает', async () => {
    const { orgId, ownerId } = await makeOrg();
    const other = await addPerson(orgId, 'admin');
    const project = await inOrg(orgId, (db) => createProject(db, { name: `Тайный ${uniq()}`, private: true }, { kind: 'user', userId: other }), other);
    const hidden = await inOrg(orgId, (db) => createTask(db, {
      ...base, title: 'диверсификация каналов в закрытом проекте', assigneeUserId: other, project: project.id, release: true,
    }, { kind: 'user', userId: other }, MON_10), other);

    const ownerClient = await mcp(ownerId);
    expect((await find(ownerClient, 'диверсификация каналов')).map((t) => t.id)).not.toContain(hidden.id);

    // Хозяину закрытого проекта его дело видно.
    const otherClient = await mcp(other);
    expect((await find(otherClient, 'диверсификация каналов')).map((t) => t.id)).toContain(hidden.id);
  });

  it('свежее дело идёт первым: даты сравниваются как время, а не как текст', async () => {
    // Строковое сравнение дат сортирует по названию дня недели: пятница июня оказывалась ниже среды марта.
    const { orgId, ownerId } = await makeOrg();
    const mk = async (title: string, iso: string) => {
      const t = await inOrg(orgId, (db) => createTask(db, {
        ...base, title, assigneeUserId: ownerId, release: true,
      }, { kind: 'user', userId: ownerId }, MON_10));
      await createdAt(orgId, t.id, iso);
      return t;
    };
    const january = await mk('тендер склада январь', '2026-01-05T10:00:00Z');
    const june = await mk('тендер склада июнь', '2026-06-05T10:00:00Z');
    const march = await mk('тендер склада март', '2026-03-04T10:00:00Z');

    const rows = await find(await mcp(ownerId), 'тендер склада');
    expect(rows.map((t) => t.id)).toEqual([june.id, march.id, january.id]);
  });

  it('живое дело не вытесняется закрытыми, даже когда их больше лимита', async () => {
    // Лимит применяется в каждом пространстве: если резать по дате до правила «живое впереди»,
    // свежие закрытые вытеснят единственное дело в работе.
    const { orgId, ownerId } = await makeOrg();
    const live = await inOrg(orgId, (db) => createTask(db, {
      ...base, title: 'логистика склада: живое', assigneeUserId: ownerId, release: true,
    }, { kind: 'user', userId: ownerId }, MON_10));
    await createdAt(orgId, live.id, '2026-01-01T10:00:00Z');
    for (let i = 0; i < 3; i += 1) {
      const t = await inOrg(orgId, (db) => createTask(db, {
        ...base, title: `логистика склада: закрытое ${i}`, assigneeUserId: ownerId, release: true,
      }, { kind: 'user', userId: ownerId }, MON_10));
      await inOrg(orgId, (db) => transition(db, t.id, 'submit', { kind: 'user', userId: ownerId }));
      await createdAt(orgId, t.id, `2026-0${i + 2}-01T10:00:00Z`);
    }

    const rows = await find(await mcp(ownerId), 'логистика склада', { include_closed: true, limit: 3 });
    expect(rows[0]!.id).toBe(live.id);
  });

  it('знаки шаблона в запросе ищутся буквально, а не как «что угодно»', async () => {
    const w = await world();
    // `%` и `_` — метасимволы ilike: без экранирования такой запрос вывалил бы весь список всех пространств.
    expect(await find(w.owner, '% %')).toHaveLength(0);
    expect(await find(w.owner, '_ _')).toHaveLength(0);

    const discount = await inOrg(w.orgId, (db) => createTask(db, {
      ...base, title: 'скидка 50% поставщику', assigneeUserId: w.ownerId, release: true,
    }, { kind: 'user', userId: w.ownerId }, MON_10));
    expect((await find(w.owner, '50% поставщику')).map((t) => t.id)).toEqual([discount.id]);
  });

  it('слишком длинный запрос — отказ, а не тихо отброшенные слова', async () => {
    const w = await world();
    const long = 'один два три четыре пять шесть семь восемь девять';
    expect((await call(w.owner, 'find_task', { query: long })).isError).toBe(true);
  });

  it('находит дело по обозначению доски: NOR-12 (спека projects-stage2)', async () => {
    const w = await world();
    const row = (await find(w.owner, 'диверсификация каналов'))[0]!;
    const full = await call(w.owner, 'get_task', { org: row.org_id, task: row.id });
    const key = full.data.task.key as string | undefined;
    // Обозначение собирается из ключа доски и номера дела; ключ пилотной доски считается сервером.
    expect(key).toMatch(/^[A-Z][A-Z0-9]{1,4}-\d{3}$/);

    const byKey = await find(w.owner, key!);
    expect(byKey.map((t) => t.id)).toEqual([w.task.id]);
    // Регистр и лишние нули не мешают: человек пишет как помнит.
    const loose = key!.replace(/-0*(\d+)$/, '-$1').toLowerCase();
    expect((await find(w.owner, loose)).map((t) => t.id)).toEqual([w.task.id]);
  });

  it('пустой и однобуквенный запрос — отказ, а не весь список', async () => {
    const w = await world();
    expect((await call(w.owner, 'find_task', { query: 'д' })).isError).toBe(true);
    expect((await call(w.owner, 'find_task', { query: '  ' })).isError).toBe(true);
  });

  // Список дел по полям — тот же вопрос «какие есть дела», заданный не словами, а фильтрами
  // (слияние поверхности коннектора: отдельного list_tasks больше нет).
  it('списком по полям: без слов, с фильтром по человеку и по «моему»', async () => {
    const w = await world();
    const mate = await addPerson(w.orgId, 'member');
    const theirs = await inOrg(w.orgId, (db) => createTask(db, {
      ...base, title: 'счёт от перевозчика', assigneeUserId: mate, release: true,
    }, { kind: 'user', userId: w.ownerId }, MON_10));

    const byPerson = (await call(w.owner, 'find_task', { org: w.orgId, person: mate })).data.tasks as Found[];
    expect(byPerson.map((t) => t.id)).toEqual([theirs.id]);

    // Без слов и без фильтров — всё живое в этом пространстве.
    const all = (await call(w.owner, 'find_task', { org: w.orgId })).data.tasks as Found[];
    expect(all.map((t) => t.id)).toEqual(expect.arrayContaining([theirs.id, w.task.id]));

    // Поставленное мной — оба дела: их завёл владелец.
    const mineOnly = (await call(w.owner, 'find_task', { org: w.orgId, mine_only: true })).data.tasks as Found[];
    expect(mineOnly.map((t) => t.id)).toEqual(expect.arrayContaining([theirs.id, w.task.id]));

    // Статус спрашивается явно — тогда открытость не додумывается за человека.
    await inOrg(w.orgId, (db) => transition(db, theirs.id, 'submit', { kind: 'user', userId: mate }));
    const submitted = (await call(w.owner, 'find_task', { org: w.orgId, status: ['submitted'] })).data.tasks as Found[];
    expect(submitted.map((t) => t.id)).toEqual([theirs.id]);
  });

  it('человека нет в этом пространстве — оно просто не даёт строк, а не отказ на весь поиск', async () => {
    const w = await world();
    const mate = await addPerson(w.orgId, 'member');
    // Без `org` поиск идёт и по личному пространству, где такого человека нет.
    const r = await call(w.owner, 'find_task', { person: mate });
    expect(r.isError).toBe(false);
    expect(r.data.tasks).toEqual([]);
  });
  // Слитый сюда `personal_list` отдавал список в порядке «важное сверху, ближний срок раньше», и это
  // же обещает описание `create_task`. После слияния порядок был потерян: звезда «важно» перестала
  // поднимать дело (ревью слияний, CRIT).
  it('важное стоит выше обычного, даже когда обычное записано позже', async () => {
    const w = await world();
    const mk = async (title: string, extra: Record<string, unknown> = {}): Promise<string> =>
      (await call(w.owner, 'create_task', { org: 'personal', title, idempotency_key: randomUUID(), ...extra })).data.id as string;

    const important = await mk('забрать документы из налоговой', { priority: 'urgent' });
    const later = await mk('разобрать шкаф');

    const list = (await call(w.owner, 'find_task', { org: 'personal' })).data.tasks as Found[];
    const at = (id: string): number => list.findIndex((t) => t.id === id);
    expect(at(important)).toBeGreaterThanOrEqual(0);
    expect(at(important)).toBeLessThan(at(later));

    // И порядок должен решаться запросом, а не сортировкой после него: иначе лимит срезал бы важное
    // дело ещё в базе, и никакая сортировка в памяти его уже не вернула бы.
    const one = (await call(w.owner, 'find_task', { org: 'personal', limit: 1 })).data.tasks as Found[];
    expect(one.map((t) => t.id)).toEqual([important]);
  });

  it('среди равных по важности ближний срок идёт раньше, а дело без срока — последним', async () => {
    const w = await world();
    const mk = async (title: string, extra: Record<string, unknown> = {}): Promise<string> =>
      (await call(w.owner, 'create_task', { org: 'personal', title, idempotency_key: randomUUID(), ...extra })).data.id as string;

    const soon = await mk('продлить страховку', { due_date: '2026-10-01' });
    const later = await mk('записаться к стоматологу', { due_date: '2026-12-01' });
    const never = await mk('перебрать фотографии');

    const list = (await call(w.owner, 'find_task', { org: 'personal' })).data.tasks as Found[];
    const at = (id: string): number => list.findIndex((t) => t.id === id);
    expect(at(soon)).toBeLessThan(at(later));
    expect(at(later)).toBeLessThan(at(never));

    const one = (await call(w.owner, 'find_task', { org: 'personal', limit: 1 })).data.tasks as Found[];
    expect(one.map((t) => t.id)).toEqual([soon]);
  });
  // Пространства сливаются в одну выдачу уже в памяти — там правило порядка должно быть тем же,
  // иначе важное дело компании уходило бы вниз под свежие личные записи.
  it('важное дело компании стоит выше свежих личных записей в общей выдаче', async () => {
    const w = await world();
    await call(w.owner, 'update_task', { org: w.orgId, task: w.task.id, priority: 'urgent' });
    await call(w.owner, 'create_task', { org: 'personal', title: 'полить цветы', idempotency_key: randomUUID() });

    const all = (await call(w.owner, 'find_task', {})).data.tasks as Found[];

    expect(all[0]!.id).toBe(w.task.id);
  });
});

describe('find_task: человек по части имени (случай Ахмет, 29.09)', () => {
  it('«Ahmet» находит дела «Ahmet Özkan»; неизвестное имя — ошибка, а не пустой список', async () => {
    const { orgId, ownerId, owner } = await world();
    const ahmet = await addPerson(orgId, 'member', { name: `Ahmet Özkan ${uniq()}` });
    await inOrg(orgId, (db) => createTask(db, { ...base, title: 'фото полки', assigneeUserId: ahmet, release: true },
      { kind: 'user', userId: ownerId }, MON_10));
    const hit = await call(owner, 'find_task', { org: orgId, person: 'ahmet' });
    expect(hit.isError).toBe(false);
    expect((hit.data.tasks as Found[]).map((t) => t.title)).toContain('фото полки');
    // Номер, который видят люди, а не внутренний short_id.
    const shelf = (hit.data.tasks as (Found & { key: string | null })[]).find((t) => t.title === 'фото полки')!;
    expect(shelf.key).toMatch(/^[A-Z0-9]+-\d{3,}$/);
    // По фамилии — тоже: совпадение с началом любого слова имени.
    expect((await call(owner, 'find_task', { org: orgId, person: 'Özkan' })).data.tasks).toHaveLength(1);

    const miss = await call(owner, 'find_task', { person: `nobody-${uniq()}` });
    expect(miss.isError).toBe(true);
    expect(JSON.stringify(miss.data)).toMatch(/not found/);
  });

  it('два подходящих человека — ошибка с кандидатами, а не случайный выбор', async () => {
    const { orgId, owner } = await world();
    const tag = uniq();
    await addPerson(orgId, 'member', { name: `Ali${tag} Kaya` });
    await addPerson(orgId, 'member', { name: `Ali${tag} Demir` });
    const r = await call(owner, 'find_task', { org: orgId, person: `ali${tag}` });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.data)).toMatch(/ambiguous/);
  });
});
