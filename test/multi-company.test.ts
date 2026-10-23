process.env.TASKANO_DISABLE_RATE_LIMIT = '1';

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Update, UserFromGetMe } from 'grammy/types';
import './helpers.js';
import { closePools, withGlobal, withSystem } from '../src/db/pool.js';
import { addMember, ensurePersonalOrg } from '../src/core/people.js';
import { createTask } from '../src/core/tasks.js';
import { transition } from '../src/core/lifecycle.js';
import { fillSlot, takeTask } from '../src/core/queue.js';
import { moveTaskToOrg } from '../src/core/routing.js';
import { createProject } from '../src/core/projects.js';
import type { Task } from '../src/core/types.js';
import { runTaskTimers } from '../src/worker/timers.js';
import { tickOrg } from '../src/worker/tick.js';
import { buildCard } from '../src/bot/card-view.js';
import { notificationText, type NotifRow } from '../src/bot/notif-text.js';
import { findTaskByShortId } from '../src/bot/lookup.js';
import { createBot } from '../src/bot/bot.js';
import { deliverNotification } from '../src/bot/deliver.js';
import { t } from '../src/i18n/index.js';
import { addPerson, inOrg, makeAgent, makeOrg, makeUser, minutes, MON_10, uniq } from './helpers.js';

// Спека multi-company, машинные пункты Acceptance. Правило, которым всё это объясняется: человек
// один — значит и «Сейчас» у него одно, и счёт внимания один; компания называется там, где её можно
// перепутать, и молчит там, где путать не с чем.

afterAll(closePools);

const base = { why: 'зачем', doneCriteria: 'критерий', dueDate: '2026-12-31', description: 'как делать: открыть таблицу и свериться' };
const user = (userId: string) => ({ kind: 'user' as const, userId });
const agent = (agentId: string, userId: string) => ({ kind: 'agent' as const, agentId, userId });

const renameOrg = (orgId: string, name: string): Promise<unknown> =>
  withGlobal((db) => db.query('update orgs set name = $2 where id = $1', [orgId, name]));

const fresh = (orgId: string, taskId: string, asUser?: string): Promise<Task> =>
  inOrg(orgId, async (db) => (await db.query('select * from tasks where id = $1', [taskId])).rows[0] as Task, asUser);

// Дело закрытого проекта видно только его участникам, поэтому иногда надо смотреть глазами человека.
const statusOf = async (orgId: string, taskId: string, asUser?: string): Promise<string> => (await fresh(orgId, taskId, asUser)).status;

/** Один человек в двух компаниях — та самая картина, из-за которой писалась спека. */
async function twoCompanies() {
  const a = await makeOrg();
  const b = await makeOrg();
  const nameA = `Апельсин ${uniq()}`;
  const nameB = `Гранат ${uniq()}`;
  await renameOrg(a.orgId, nameA);
  await renameOrg(b.orgId, nameB);
  const person = await addPerson(a.orgId);
  await withGlobal((db) => addMember(db, b.orgId, person, 'member'));
  return {
    orgA: a.orgId, ownerA: a.ownerId, nameA, agentA: await makeAgent(a.orgId, a.ownerId),
    orgB: b.orgId, ownerB: b.ownerId, nameB, agentB: await makeAgent(b.orgId, b.ownerId),
    person,
  };
}

describe('слот «Сейчас» — один на человека', () => {
  it('взятое дело компании А не даёт активироваться делу компании Б', async () => {
    const w = await twoCompanies();
    const first = await inOrg(w.orgA, (db) => createTask(
      db, { ...base, title: 'свериться с поставщиком', assigneeUserId: w.person }, agent(w.agentA, w.ownerA), MON_10));
    expect(first.status).toBe('active');
    await inOrg(w.orgA, (db) => takeTask(db, first.id, user(w.person), { now: minutes(MON_10, 1) }));

    const second = await inOrg(w.orgB, (db) => createTask(
      db, { ...base, title: 'подготовить отчёт', assigneeUserId: w.person }, agent(w.agentB, w.ownerB), minutes(MON_10, 2)));
    // Человек занят целиком, а не в пределах компании: очередь второй компании стоит.
    expect(second.status).toBe('ready');
    await inOrg(w.orgB, (db) => fillSlot(db, w.person, minutes(MON_10, 3)));
    expect(await statusOf(w.orgB, second.id)).toBe('ready');

    // Очередь не пропала — она ждала: дело сдано, и компания Б получает своё «Сейчас».
    await inOrg(w.orgA, (db) => transition(db, first.id, 'submit', user(w.person), { now: minutes(MON_10, 10) }));
    await inOrg(w.orgB, (db) => fillSlot(db, w.person, minutes(MON_10, 11)));
    expect(await statusOf(w.orgB, second.id)).toBe('active');
  });
});

describe('слот один на человека — на всех путях, не только в очереди', () => {
  it('«Взял» в компании Б снимает дело компании А, а не даёт второе «Сейчас»', async () => {
    const w = await twoCompanies();
    const inA = await inOrg(w.orgA, (db) => createTask(
      db, { ...base, title: 'дело компании А', assigneeUserId: w.person }, agent(w.agentA, w.ownerA), MON_10));
    await inOrg(w.orgA, (db) => takeTask(db, inA.id, user(w.person), { now: minutes(MON_10, 1) }));
    const inB = await inOrg(w.orgB, (db) => createTask(
      db, { ...base, title: 'дело компании Б', assigneeUserId: w.person }, agent(w.agentB, w.ownerB), minutes(MON_10, 2)));
    expect(inB.status).toBe('ready');

    // Человек переключается на дело второй компании — первое обязано вернуться в очередь.
    await inOrg(w.orgB, (db) => takeTask(db, inB.id, user(w.person), { now: minutes(MON_10, 5) }));

    expect(await statusOf(w.orgB, inB.id)).toBe('in_progress');
    expect(await statusOf(w.orgA, inA.id)).toBe('ready');
  });

  it('слот освободился в компании А — тик компании Б выдаёт её дело сам, без чужой помощи', async () => {
    const w = await twoCompanies();
    const inA = await inOrg(w.orgA, (db) => createTask(
      db, { ...base, title: 'дело компании А', assigneeUserId: w.person }, agent(w.agentA, w.ownerA), MON_10));
    const inB = await inOrg(w.orgB, (db) => createTask(
      db, { ...base, title: 'дело компании Б', assigneeUserId: w.person }, agent(w.agentB, w.ownerB), minutes(MON_10, 1)));
    expect(inB.status).toBe('ready');

    await inOrg(w.orgA, (db) => transition(db, inA.id, 'submit', user(w.person), { now: minutes(MON_10, 10) }));
    // В компании Б ничего не произошло: её очередь наполнить может только её же тик.
    await tickOrg(w.orgB, minutes(MON_10, 11));

    expect(await statusOf(w.orgB, inB.id)).toBe('active');
  });

  it('дело компании, куда человека только позвали, слот не держит', async () => {
    const w = await twoCompanies();
    // Членство в Б — приглашение, которое человек ещё не принял: дел этой компании он не видит.
    await withGlobal((db) => db.query(
      `update memberships set status = 'invited' where org_id = $1 and user_id = $2`, [w.orgB, w.person]));
    const inB = await inOrg(w.orgB, (db) => createTask(
      db, { ...base, title: 'дело компании, куда не входил', assigneeUserId: w.person }, agent(w.agentB, w.ownerB), MON_10));
    await inOrg(w.orgB, (db) => transition(db, inB.id, 'activate', { kind: 'system' }, { now: minutes(MON_10, 1) }))
      .catch(() => undefined);

    const inA = await inOrg(w.orgA, (db) => createTask(
      db, { ...base, title: 'дело действующей компании', assigneeUserId: w.person }, agent(w.agentA, w.ownerA), minutes(MON_10, 2)));

    // Иначе человек остался бы вообще без «Сейчас»: невидимое дело держало бы его слот.
    expect(inA.status).toBe('active');
  });
});

describe('суточные лимиты — на человека', () => {
  /** Сколько уведомлений такого вида человек получил — по обеим его компаниям вместе. */
  async function notifications(orgIds: string[], userId: string, kind: string): Promise<number> {
    let total = 0;
    for (const orgId of orgIds) {
      const r = await inOrg(orgId, (db) => db.query(
        'select count(*)::int as n from notifications where user_id = $1 and kind = $2', [userId, kind]));
      total += r.rows[0].n as number;
    }
    return total;
  }

  it('не больше трёх напоминаний в день на человека при делах в двух компаниях', async () => {
    const w = await twoCompanies();
    const ids: { orgId: string; id: string }[] = [];
    for (const [orgId, agentId, ownerId] of [[w.orgA, w.agentA, w.ownerA], [w.orgB, w.agentB, w.ownerB]] as const) {
      for (let i = 0; i < 2; i += 1) {
        const task = await inOrg(orgId, (db) => createTask(
          db, { ...base, title: `дело ${orgId.slice(0, 4)}-${i}`, assigneeUserId: w.person, dueDate: '2026-09-21' },
          agent(agentId, ownerId), MON_10));
        ids.push({ orgId, id: task.id });
      }
    }
    // Первое дело заняло «Сейчас» — уводим его в in_progress, иначе к напоминаниям о сроке
    // добавится напоминание «не взял в работу» и счёт перестанет быть про лимит.
    await inOrg(ids[0]!.orgId, (db) => transition(db, ids[0]!.id, 'take', user(w.person), { now: MON_10 }));

    const dayAfter = new Date('2026-09-22T07:00:00Z');       // вторник 10:00 Стамбул — день после срока
    for (const orgId of [w.orgA, w.orgB]) await inOrg(orgId, (db) => runTaskTimers(db, dayAfter));

    // Три в день — счёт внимания человека, а не аппетита каждой компании (было 2 + 2).
    expect(await notifications([w.orgA, w.orgB], w.person, 'reminder')).toBe(3);
    expect(await notifications([w.orgA, w.orgB], w.person, 'reminder_digest')).toBe(1);
  });

  it('день считается в поясе человека, а не по часам базы', async () => {
    // Человек в Окленде (UTC+12): его рабочее утро приходится на прошлые сутки по Гринвичу.
    // Считай мы день календарной датой базы — утренние напоминания и дневные попадали бы в разные
    // сутки, и лимит «три в день» пропускал бы лишние.
    const a = await makeOrg();
    const b = await makeOrg();
    const person = await makeUser({ tz: 'Pacific/Auckland' });
    await withGlobal(async (db) => { await addMember(db, a.orgId, person, 'member'); await addMember(db, b.orgId, person, 'member'); });
    const agentA = await makeAgent(a.orgId, a.ownerId);
    const agentB = await makeAgent(b.orgId, b.ownerId);

    for (const [orgId, agentId, ownerId] of [[a.orgId, agentA, a.ownerId], [b.orgId, agentB, b.ownerId]] as const) {
      for (let i = 0; i < 2; i += 1) {
        await inOrg(orgId, (db) => createTask(
          db, { ...base, title: `окленд ${orgId.slice(0, 4)}-${i}`, assigneeUserId: person, dueDate: '2026-09-21' },
          agent(agentId, ownerId), MON_10));
      }
    }

    // 21:00 UTC понедельника — это 09:00 вторника в Окленде: начало его рабочего дня.
    const morning = new Date('2026-09-21T21:00:00Z');
    for (const orgId of [a.orgId, b.orgId]) await inOrg(orgId, (db) => runTaskTimers(db, morning));
    expect(await notifications([a.orgId, b.orgId], person, 'reminder')).toBeGreaterThan(0);

    // 02:00 UTC среды — это 14:00 того же вторника в Окленде: день у человека не сменился.
    const afternoon = new Date('2026-09-22T02:00:00Z');
    for (const orgId of [a.orgId, b.orgId]) await inOrg(orgId, (db) => runTaskTimers(db, afternoon));

    expect(await notifications([a.orgId, b.orgId], person, 'reminder')).toBe(3);
  });

  it('два агента одной компании делят одну квоту, а не получают по своей', async () => {
    const { orgId, ownerId } = await makeOrg();
    const person = await addPerson(orgId);
    const first = await makeAgent(orgId, ownerId);
    const second = await makeAgent(orgId, ownerId);
    await inOrg(orgId, (db) => db.query(
      `insert into queue_settings(org_id, user_id, daily_step_limit)
       values (current_setting('app.org_id')::uuid, $1, 2)
       on conflict (org_id, user_id) do update set daily_step_limit = 2`, [person]));

    const made = [];
    for (const agentId of [first, first, second]) {
      made.push(await inOrg(orgId, (db) => createTask(
        db, { ...base, title: `шаг ${made.length}`, assigneeUserId: person }, agent(agentId, ownerId), MON_10)));
    }

    // Третий шаг — сверх квоты, хотя второй агент выдал его впервые: считается внимание человека.
    expect(made[2]!.status).toBe('draft');
  });

  it('дневная квота шагов — тоже на человека: вторая компания добирает не свою квоту, а его', async () => {
    const w = await twoCompanies();
    // Пороги разные: в А человека ограничили двумя шагами, в Б настройку не трогали (по умолчанию
    // 20). Одинаковые числа прятали бы главное — чей порог действует.
    await inOrg(w.orgA, (db) => db.query(
      `insert into queue_settings(org_id, user_id, daily_step_limit) values ($1, $2, 2)`, [w.orgA, w.person]));
    await inOrg(w.orgB, (db) => db.query(
      `insert into queue_settings(org_id, user_id, daily_step_limit) values ($1, $2, 20)`, [w.orgB, w.person]));
    for (let i = 0; i < 2; i += 1) {
      await inOrg(w.orgA, (db) => createTask(
        db, { ...base, title: `шаг ${i}`, assigneeUserId: w.person }, agent(w.agentA, w.ownerA), MON_10));
    }

    const third = await inOrg(w.orgB, (db) => createTask(
      db, { ...base, title: 'третий за день', assigneeUserId: w.person }, agent(w.agentB, w.ownerB), MON_10));
    // Квота лежит в queue_settings по человеку — значит и считается по человеку: сверх лимита шаг
    // остаётся черновиком с предложением владельцу агента.
    expect(third.status).toBe('draft');
    const proposals = await inOrg(w.orgB, (db) => db.query(
      `select 1 from proposals where task_id = $1 and type = 'step_limit'`, [third.id]));
    expect(proposals.rowCount).toBe(1);
  });
});

describe('компания названа, когда их больше одной', () => {
  const notifRow = (orgId: string, userId: string, kind: string): Promise<NotifRow> => inOrg(orgId, async (db) =>
    (await db.query(
      `select id, kind, level, task_id, payload, created_at from notifications
        where user_id = $1 and kind = $2 order by created_at desc limit 1`, [userId, kind])).rows[0] as NotifRow);

  it('карточка называет компанию — свою у каждого дела', async () => {
    const w = await twoCompanies();
    const inA = await inOrg(w.orgA, (db) => createTask(
      db, { ...base, title: 'свериться с поставщиком', assigneeUserId: w.person }, agent(w.agentA, w.ownerA), MON_10));
    const inB = await inOrg(w.orgB, (db) => createTask(
      db, { ...base, title: 'подготовить отчёт', assigneeUserId: w.person }, agent(w.agentB, w.ownerB), MON_10));

    const cardA = await inOrg(w.orgA, (db) => buildCard(db, inA, 'ru', { sourceLang: 'ru', personal: false, viewerUserId: w.person }));
    const cardB = await inOrg(w.orgB, (db) => buildCard(db, inB, 'ru', { sourceLang: 'ru', personal: false, viewerUserId: w.person }));
    expect(cardA.text).toContain(t('ru', 'card.company', { text: w.nameA }));
    expect(cardB.text).toContain(t('ru', 'card.company', { text: w.nameB }));
    // Проект по умолчанию в обеих компаниях зовётся одинаково — по нему их и путали.
    expect(cardA.text).toContain(t('ru', 'project.default'));
    expect(cardB.text).toContain(t('ru', 'project.default'));
  });

  it('у человека с одной компанией карточка о компании молчит', async () => {
    const { orgId, ownerId } = await makeOrg();
    await renameOrg(orgId, `Единственная ${uniq()}`);
    const person = await addPerson(orgId);
    const agentId = await makeAgent(orgId, ownerId);
    const task = await inOrg(orgId, (db) => createTask(
      db, { ...base, title: 'свериться с поставщиком', assigneeUserId: person }, agent(agentId, ownerId), MON_10));

    const card = await inOrg(orgId, (db) => buildCard(db, task, 'ru', { sourceLang: 'ru', personal: false, viewerUserId: person }));
    // Лишнее слово в каждом сообщении раздражает больше, чем помогает.
    expect(card.text).not.toContain('Компания');
    expect(card.text).toContain('свериться с поставщиком');
  });

  it('уведомление называет компанию при двух компаниях и молчит при одной', async () => {
    const w = await twoCompanies();
    const inA = await inOrg(w.orgA, (db) => createTask(
      db, { ...base, title: 'свериться с поставщиком', assigneeUserId: w.person }, agent(w.agentA, w.ownerA), MON_10));
    const row = await notifRow(w.orgA, w.person, 'task_now');
    const text = await inOrg(w.orgA, (db) => notificationText(db, 'ru', row, w.person));
    // Строка обозначения дела — после названия; здесь важна компания в заголовке.
    expect(text).toMatch(new RegExp(`^<b>${t('ru', 'notif.task_now')}</b> · ${w.nameA}\\n\\n${inA.title}\\n[A-Z0-9]+-\\d{3}$`));

    const { orgId, ownerId } = await makeOrg();
    const alone = await addPerson(orgId);
    const agentId = await makeAgent(orgId, ownerId);
    const task = await inOrg(orgId, (db) => createTask(
      db, { ...base, title: 'позвонить в банк', assigneeUserId: alone }, agent(agentId, ownerId), MON_10));
    const aloneRow = await notifRow(orgId, alone, 'task_now');
    const aloneText = await inOrg(orgId, (db) => notificationText(db, 'ru', aloneRow, alone));
    expect(aloneText).toMatch(new RegExp(`^<b>${t('ru', 'notif.task_now')}</b>\\n\\n${task.title}\\n[A-Z0-9]+-\\d{3}$`));
  });
});

describe('дело, уехавшее в личное, выходит из очереди', () => {
  it('возвращается в ready и отдаёт слот следующему делу компании', async () => {
    const { orgId } = await makeOrg();
    const person = await addPerson(orgId);
    const personal = await withGlobal((db) => ensurePersonalOrg(db, person));
    const mine = await inOrg(orgId, (db) => createTask(
      db, { ...base, title: 'записаться к врачу', assigneeUserId: person }, user(person), MON_10), person);
    const next = await inOrg(orgId, (db) => createTask(
      db, { ...base, title: 'свериться с поставщиком', assigneeUserId: person }, user(person), MON_10), person);
    expect(mine.status).toBe('active');
    expect(next.status).toBe('ready');

    const moved = await moveTaskToOrg(user(person), mine.id, personal, {}, minutes(MON_10, 5));

    // В личном нет ни очереди, ни «Сейчас» — дело возвращается в общий список дел.
    expect(moved.org_id).toBe(personal);
    expect(await statusOf(personal, mine.id)).toBe('ready');
    // Слот освободился по-настоящему: очередь компании двинулась сама.
    expect(await statusOf(orgId, next.id)).toBe('active');
  });

  it('дело в работе: таймер закрывается, отрезок остаётся в worked_seconds', async () => {
    const { orgId } = await makeOrg();
    const person = await addPerson(orgId);
    const personal = await withGlobal((db) => ensurePersonalOrg(db, person));
    const mine = await inOrg(orgId, (db) => createTask(
      db, { ...base, title: 'разобрать почту', assigneeUserId: person }, user(person), MON_10), person);
    await inOrg(orgId, (db) => takeTask(db, mine.id, user(person), { now: minutes(MON_10, 10) }), person);
    expect(await statusOf(orgId, mine.id)).toBe('in_progress');

    await moveTaskToOrg(user(person), mine.id, personal, {}, minutes(MON_10, 40));

    const after = await fresh(personal, mine.id, person);
    expect(after.status).toBe('ready');
    expect(after.worked_seconds).toBe(30 * 60);
    // Таймер не остался открытым при деле в очереди: иначе он держал бы единственный открытый
    // таймер человека, а отчёты считали бы час, которого не было.
    const entries = await withSystem(async (db) => (await db.query(
      `select org_id, ended_at, minutes from time_entries where task_id = $1 and source = 'timer'`, [mine.id])).rows);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ org_id: personal, minutes: 30 });
    expect(entries[0].ended_at).not.toBeNull();
  });
});

// ---------------------------------------------------------------- бот (сеть Telegram перехвачена)

const BOT_INFO: UserFromGetMe = {
  id: 10, is_bot: true, first_name: 'Taskano', username: 'taskano_test_bot',
  can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false,
  can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false,
  allows_users_to_create_topics: false, can_manage_bots: false, supports_join_request_queries: false,
};

let nextUpdateId = 1;
let nextMessageId = 1;
let nextTgId = 700_000;

interface SentCall { method: string; payload: Record<string, unknown> }
let sent: SentCall[];
let bot: ReturnType<typeof createBot>;

beforeEach(() => {
  sent = [];
  bot = createBot({ token: 'test-token', botInfo: BOT_INFO });
  bot.api.config.use(async (_prev, method, payload) => {
    sent.push({ method, payload: payload as Record<string, unknown> });
    const chatId = (payload as { chat_id?: number }).chat_id;
    if (method === 'sendMessage') {
      return {
        ok: true,
        result: { message_id: nextMessageId++, date: 0, chat: { id: chatId, type: 'private' }, text: String((payload as { text?: string }).text ?? '') },
      } as never;
    }
    return { ok: true, result: true } as never;
  });
});

function tgUser(id: number): NonNullable<Update['message']>['from'] {
  return { id, is_bot: false, first_name: 'Person', language_code: 'ru' };
}

function messageUpdate(from: NonNullable<Update['message']>['from'], text: string): Update {
  return {
    update_id: nextUpdateId++,
    message: {
      message_id: nextMessageId++, date: Math.floor(Date.now() / 1000),
      chat: { id: from!.id, type: 'private', first_name: 'Person' }, from, text,
    },
  } as unknown as Update;
}

function callbackUpdate(from: NonNullable<Update['message']>['from'], data: string, messageId: number): Update {
  return {
    update_id: nextUpdateId++,
    callback_query: {
      id: String(nextUpdateId), from, chat_instance: 'x', data,
      message: {
        message_id: messageId, date: Math.floor(Date.now() / 1000),
        chat: { id: from!.id, type: 'private', first_name: 'Person' }, text: 'card',
      },
    },
  } as unknown as Update;
}

async function linkTelegram(userId: string): Promise<NonNullable<Update['message']>['from']> {
  const telegramUserId = nextTgId++;
  await withGlobal((db) => db.query(
    `insert into telegram_links(telegram_user_id, user_id, chat_id) values ($1, $2, $3)`, [telegramUserId, userId, telegramUserId]));
  return tgUser(telegramUserId);
}

const texts = (method = 'sendMessage'): string[] => sent.filter((s) => s.method === method).map((s) => String(s.payload.text ?? ''));

describe('бот показывает только те компании, куда человек вошёл', () => {
  /**
   * Человек работает в компании А и числится позванным в компанию Б, но живого приглашения нет
   * (отозвано, истекло). Приглашённый по живому приглашению теперь пускается — это
   * проверяет test/multi-company-person.test.ts; здесь — что без него дел не видно.
   */
  async function invitedToSecond() {
    const a = await makeOrg();
    const b = await makeOrg();
    const person = await addPerson(a.orgId);
    await withGlobal((db) => addMember(db, b.orgId, person, 'member', 'invited'));
    const mine = await inOrg(a.orgId, (db) => createTask(
      db, { ...base, title: 'своё дело в своей компании', assigneeUserId: person }, user(a.ownerId), MON_10));
    const theirs = await inOrg(b.orgId, (db) => createTask(
      db, { ...base, title: 'чужое дело чужой компании', assigneeUserId: person }, user(b.ownerId), MON_10));
    return { person, mine, theirs, from: await linkTelegram(person) };
  }

  it('дела компании, куда человек только приглашён, в списке не показываются', async () => {
    const w = await invitedToSecond();

    await bot.handleUpdate(messageUpdate(w.from, t('ru', 'menu.list')));

    expect(texts().join('\n')).toContain(w.mine.title);
    // Приглашение, которое не приняли, — ещё не работа; приложение так и считает (miniapp-api).
    expect(texts().join('\n')).not.toContain(w.theirs.title);
  });

  it('по такому делу нельзя и ответить: бот его не находит', async () => {
    const w = await invitedToSecond();
    expect(await findTaskByShortId(w.person, String(w.theirs.short_id))).toBeNull();

    await bot.handleUpdate(callbackUpdate(w.from, `a:q:${w.theirs.short_id}:${w.theirs.version}`, 555));

    expect(texts().at(-1)).toBe(t('ru', 'start.task_not_found'));
  });
});

// «Начатый ответ не затирается молча» заменён правилом «диалог по делу» (спека
// multi-company-person, п.1): второе нажатие больше ничего не отменяет, ответ уходит своему делу —
// проверки в test/multi-company-person.test.ts.

describe('дайджест называет компанию по тому же правилу', () => {
  it('у человека с одной компанией заголовка компании в дайджесте нет', async () => {
    const { orgId, ownerId } = await makeOrg();
    const name = `Единственная ${uniq()}`;
    await renameOrg(orgId, name);
    const agentId = await makeAgent(orgId, ownerId);
    const person = await addPerson(orgId);
    await linkTelegram(person);
    await inOrg(orgId, (db) => createTask(
      db, { ...base, title: 'свериться с остатками', assigneeUserId: person }, agent(agentId, ownerId), MON_10));
    const n = await inOrg(orgId, (db) => db.query(
      `insert into notifications(org_id, user_id, kind, level, deliver_after)
       values (current_setting('app.org_id')::uuid, $1, 'digest', 'work', now()) returning id`, [person]));

    expect(await deliverNotification(orgId, n.rows[0].id)).toBe('sent');

    // Личное пространство есть у каждого, и считать его второй организацией значило бы поставить
    // заголовок компании всем подряд — при одной компании называть нечего.
    const digest = texts().join('\n');
    expect(digest).toContain('свериться с остатками');
    expect(digest).not.toContain(name);
  });
});

// Дело закрытого проекта видно только его участникам, и решает это `app.actor_user_id`. Гася
// прежнее «Сейчас» в чужой компании, мы этого человека не называли — и его собственное дело
// оказывалось невидимым для него же: «Взять» во второй компании отвечало «дела не существует».
describe('закрытый проект не мешает работать во второй компании', () => {
  it('держишь дело своего закрытого проекта в А — «Взять» в Б срабатывает, дело А уходит в очередь', async () => {
    const w = await twoCompanies();
    const secret = await inOrg(w.orgA, (db) => createProject(
      db, { name: `Закрытый ${uniq()}`, private: true }, user(w.person)), w.person);
    const inA = await inOrg(w.orgA, (db) => createTask(
      db, { ...base, title: 'дело закрытого проекта', assigneeUserId: w.person, project: secret.id, release: true },
      user(w.person), MON_10), w.person);
    await inOrg(w.orgA, (db) => takeTask(db, inA.id, user(w.person), { now: minutes(MON_10, 1) }), w.person);
    expect(await statusOf(w.orgA, inA.id, w.person)).toBe('in_progress');

    const inB = await inOrg(w.orgB, (db) => createTask(
      db, { ...base, title: 'дело компании Б', assigneeUserId: w.person }, agent(w.agentB, w.ownerB), minutes(MON_10, 2)));

    await inOrg(w.orgB, (db) => takeTask(db, inB.id, user(w.person), { now: minutes(MON_10, 5) }));

    expect(await statusOf(w.orgB, inB.id)).toBe('in_progress');
    expect(await statusOf(w.orgA, inA.id, w.person)).toBe('ready');
  });
});
