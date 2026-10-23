import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserFromGetMe } from 'grammy/types';
import { closePools, withGlobal } from '../src/db/pool.js';
import { createBot } from '../src/bot/bot.js';
import { deliverNotification } from '../src/bot/deliver.js';
import { notificationText, type NotifRow } from '../src/bot/notif-text.js';
import { createTask, updateTask } from '../src/core/tasks.js';
import { transition } from '../src/core/lifecycle.js';
import { fillSlot, stopTask, takeTask } from '../src/core/queue.js';
import { invitePerson } from '../src/core/invitations.js';
import { emit } from '../src/core/events.js';
import { encrypt, sha256 } from '../src/core/crypto.js';
import { runTaskTimers } from '../src/worker/timers.js';
import { runDelivery } from '../src/worker/delivery.js';
import { tickOrg } from '../src/worker/tick.js';
import { checkSilence } from '../src/runtime/fire.js';
import { dictKeys, humanDate, t } from '../src/i18n/index.js';
import { addPerson, inOrg, makeAgent, makeOrg, minutes, MON_10, uniq, waitForEvents } from './helpers.js';

// Спека bot-messages: ожидания не повторяются каждый день, «Сейчас» не дублируется, имя вместо «?»,
// тексты без рода, «вдвое больше оценки» — только в ленте, разметка HTML с экранированием, язык
// получателя, даты словами.

afterAll(closePools);

const BOT_INFO = {
  id: 1, is_bot: true, first_name: 'Taskano', username: 'Taskano_bot', can_join_groups: true,
  can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: true,
} as UserFromGetMe;

interface Sent { chatId: number; text: string; parseMode: string | undefined }
let sent: Sent[];

beforeEach(() => {
  sent = [];
  const bot = createBot({ token: 'test-token', botInfo: BOT_INFO });
  bot.api.config.use(async (_prev, method, payload) => {
    const p = payload as { chat_id?: number; text?: string; parse_mode?: string };
    if (method === 'sendMessage') {
      sent.push({ chatId: Number(p.chat_id), text: String(p.text ?? ''), parseMode: p.parse_mode });
      return { ok: true, result: { message_id: 1, date: 0, chat: { id: p.chat_id, type: 'private' }, text: p.text } } as any;
    }
    return { ok: true, result: true } as any;
  });
});

afterEach(() => { vi.useRealTimers(); });

const DAY = 86_400_000;
const base = { why: 'зачем', doneCriteria: 'критерий', dueDate: '2026-12-31', description: 'как делать: открыть таблицу и свериться' };
const user = (userId: string) => ({ kind: 'user' as const, userId });
const agent = (agentId: string, userId: string) => ({ kind: 'agent' as const, agentId, userId });

// telegram_links — глобальная таблица на весь прогон: у файла свой диапазон id, без случайности.
// Случайный id из 800–900 млн пересекался с последовательными диапазонами других файлов.
let tgSeq = 1_000_000_000;
async function linkTelegram(userId: string): Promise<number> {
  const tg = (tgSeq += 1);
  await withGlobal((db) => db.query('insert into telegram_links(telegram_user_id, user_id, chat_id) values ($1, $2, $1)', [tg, userId]));
  return tg;
}

/** Собрать и отправить дайджест человеку так, как это делает worker: уведомление `digest` → доставка. */
async function digestFor(orgId: string, userId: string): Promise<Sent> {
  const n = await inOrg(orgId, (db) => db.query(
    `insert into notifications(org_id, user_id, kind, level, deliver_after)
     values (current_setting('app.org_id')::uuid, $1, 'digest', 'work', now()) returning id`, [userId]));
  const before = sent.length;
  expect(await deliverNotification(orgId, n.rows[0].id)).toBe('sent');
  expect(sent.length).toBe(before + 1);
  return sent.at(-1)!;
}

async function deliverKind(orgId: string, userId: string, kind: string, taskId?: string): Promise<string> {
  const r = await inOrg(orgId, (db) => db.query(
    `select id, delivered_at from notifications where user_id = $1 and kind = $2 and ($3::uuid is null or task_id = $3) order by created_at desc limit 1`,
    [userId, kind, taskId ?? null]));
  expect(r.rowCount, `${kind} создан`).toBe(1);
  return r.rows[0].id as string;
}

async function countKind(orgId: string, kind: string, taskId: string, userId?: string): Promise<number> {
  const r = await inOrg(orgId, (db) => db.query(
    `select count(*)::int as n from notifications where kind = $1 and task_id = $2 and ($3::uuid is null or user_id = $3)`,
    [kind, taskId, userId ?? null]));
  return r.rows[0].n as number;
}

describe('ожидание: одно сообщение на дату проверки', () => {
  it('не отмеченное 3 дня — одно waiting_check, и все три дня строка в «На проверку сегодня»', async () => {
    const { orgId, ownerId } = await makeOrg();
    const person = await addPerson(orgId);
    await linkTelegram(person);
    const task = await inOrg(orgId, (db) => createTask(db, {
      kind: 'waiting', title: 'разрешение на работу', why: 'оформление', assigneeUserId: person,
      waiting: { waitingFor: 'миграционная служба', nextCheckAt: MON_10.toISOString() },
    }, user(ownerId), minutes(MON_10, -10 * 24 * 60)));

    vi.useFakeTimers({ toFake: ['Date'] });
    for (let day = 0; day < 3; day++) {
      const now = new Date(MON_10.getTime() + day * DAY);
      vi.setSystemTime(now);
      await inOrg(orgId, (db) => runTaskTimers(db, now));
      const digest = await digestFor(orgId, person);
      expect(digest.text, `день ${day + 1}`).toContain(`<b>${t('ru', 'digest.waiting_today')}</b>\n• разрешение на работу`);
    }
    expect(await countKind(orgId, 'waiting_check', task.id)).toBe(1);

    // Сообщение говорит, сколько ждём, словами — не датой из базы.
    const id = await deliverKind(orgId, person, 'waiting_check', task.id);
    vi.setSystemTime(minutes(MON_10, 60));
    expect(await deliverNotification(orgId, id)).toBe('sent');
    const text = sent.at(-1)!.text;
    expect(text).toContain(t('ru', 'notif.waiting_check', { days: '10 дней' }));
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}/);

    // Перенесли проверку — новая дата, снова одно сообщение.
    const moved = new Date(MON_10.getTime() + 5 * DAY);
    await inOrg(orgId, (db) => db.query(
      `update tasks set waiting = jsonb_set(waiting, '{next_check_at}', to_jsonb($2::text)) where id = $1`, [task.id, moved.toISOString()]));
    await inOrg(orgId, (db) => runTaskTimers(db, moved));
    await inOrg(orgId, (db) => runTaskTimers(db, minutes(moved, 24 * 60)));
    expect(await countKind(orgId, 'waiting_check', task.id)).toBe(2);
  });
});

describe('«Сейчас» не дублируется', () => {
  it('дело, которое человек откладывает и очередь возвращает, — одно task_now за час; после доработки — снова', async () => {
    const { orgId, ownerId } = await makeOrg();
    const agentId = await makeAgent(orgId, ownerId);
    const person = await addPerson(orgId);
    const task = await inOrg(orgId, (db) => createTask(
      db, { ...base, title: 'написать поставщику в LinkedIn', assigneeUserId: person }, agent(agentId, ownerId), MON_10));
    expect(task.status).toBe('active');

    // Как 22.09: «Взял» — «Остановить» — очередь ставит его обратно, несколько раз за час.
    for (let i = 1; i <= 4; i++) {
      const at = minutes(MON_10, i * 10);
      await inOrg(orgId, async (db) => {
        await takeTask(db, task.id, user(person), { now: at });
        await stopTask(db, task.id, person, { now: minutes(at, 1) });
        await fillSlot(db, person, minutes(at, 2));
      });
    }
    const status = (await inOrg(orgId, (db) => db.query('select status from tasks where id = $1', [task.id]))).rows[0].status;
    expect(status).toBe('active');
    expect(await countKind(orgId, 'task_now', task.id, person)).toBe(1);

    // Дело изменилось не перестановкой: сдали и вернули на доработку — о возврате снова говорим.
    await inOrg(orgId, async (db) => {
      await transition(db, task.id, 'submit', user(person), { now: minutes(MON_10, 50), result: { text: 'готово' } });
      await transition(db, task.id, 'rework', agent(agentId, ownerId), { now: minutes(MON_10, 55), text: 'не тот адрес' });
    });
    expect(await countKind(orgId, 'task_now', task.id, person)).toBe(2);
  });
});

describe('имя вместо «?»', () => {
  it('invitation_stalled называет приглашённого; agents_silent — агента', async () => {
    const { orgId, ownerId } = await makeOrg();
    const agentId = await makeAgent(orgId, ownerId, `Закупки ${uniq()}`);
    await linkTelegram(ownerId);

    const email = `invitee-${uniq()}@test.local`;
    await inOrg(orgId, (db) => invitePerson(db, { email, role: 'member' }, user(ownerId), MON_10));
    await inOrg(orgId, (db) => db.query(
      `update invitations set created_at = $2, reminded_at = $3 where email = $1`, [email, minutes(MON_10, -6 * 24 * 60), minutes(MON_10, -4 * 24 * 60)]));
    await tickOrg(orgId, MON_10);
    const invName = (await inOrg(orgId, (db) => db.query(
      `select coalesce(nullif(btrim(u.display_name), ''), i.email) as name from invitations i join users u on u.id = i.user_id where i.email = $1`, [email]))).rows[0].name;
    const stalledId = await deliverKind(orgId, ownerId, 'invitation_stalled');
    expect(await deliverNotification(orgId, stalledId)).toBe('sent');
    expect(sent.at(-1)!.text).toContain(t('ru', 'notif.invitation_stalled', { name: invName }));

    // agents_silent: источник кладёт id агентов, чьи события ждут.
    await inOrg(orgId, (db) => db.query(
      `insert into runners(org_id, fire_url, fire_token_enc, last_briefing_at) values ($1, $2, $3, $4)`,
      [orgId, 'https://example.test/fire', encrypt('fire-secret-token', orgId), MON_10]));
    const person = await addPerson(orgId);
    const task = await inOrg(orgId, (db) => createTask(
      db, { ...base, title: 'сверить остатки', assigneeUserId: person }, agent(agentId, ownerId), MON_10));
    await inOrg(orgId, (db) => emit(db, { type: 'question', agentId, taskId: task.id, actorUserId: person, data: { text: 'какой склад?' } }));
    await waitForEvents(orgId);
    await checkSilence(orgId, minutes(MON_10, 240));
    const silentId = await deliverKind(orgId, ownerId, 'agents_silent');
    const payload = (await inOrg(orgId, (db) => db.query('select payload from notifications where id = $1', [silentId]))).rows[0].payload;
    expect(payload.agent_ids).toContain(agentId);
    expect(await deliverNotification(orgId, silentId)).toBe('sent');
    const agentName = (await inOrg(orgId, (db) => db.query('select name from agents where id = $1', [agentId]))).rows[0].name;
    expect(sent.at(-1)!.text).toContain(agentName);
    expect(sent.at(-1)!.text).not.toContain('?');
  });

  it('с пустым payload — не отправляются', async () => {
    const { orgId, ownerId } = await makeOrg();
    await linkTelegram(ownerId);
    for (const kind of ['invitation_stalled', 'agents_silent', 'runner_broken', 'channel_dead', 'open_app']) {
      const n = await inOrg(orgId, (db) => db.query(
        `insert into notifications(org_id, user_id, kind, level, payload, deliver_after)
         values (current_setting('app.org_id')::uuid, $1, $2, 'glance', '{}', now()) returning id`, [ownerId, kind]));
      const before = sent.length;
      expect(await deliverNotification(orgId, n.rows[0].id), kind).toBe('skipped');
      expect(sent.length, kind).toBe(before);
    }
  });
});

describe('тексты без рода', () => {
  // Глаголы прошедшего времени, у которых по-русски есть род: «взял/взяла», «застрял/застряла»…
  const GENDERED = /(^|[^а-яё])(взял|застрял|откликнулся|ответил|отказался|закрыл|вернул|прислал|понял|заблокировал|принял|отправил|написал|сделал|сдал|начал|открыл|спросил)([^а-яё]|$)|[а-яё]+(лся|лась)([^а-яё]|$)/i;

  it('ни одна ru-строка notif.*/owner_task.* с {name} не говорит о человеке в прошедшем времени с родом', () => {
    const hits = dictKeys('ru')
      .filter((k) => (k.startsWith('notif.') || k.startsWith('owner_task.')) && t('ru', k).includes('{name}'))
      .filter((k) => GENDERED.test(t('ru', k)));
    expect(hits).toEqual([]);
  });

  it('not_acknowledged — по спеке', () => {
    expect(t('ru', 'notif.not_acknowledged', { name: 'Мария' })).toBe('Мария: задача ещё не взята');
  });
});

describe('«вдвое больше оценки» — только в ленте', () => {
  it('не доставляется отдельным сообщением и есть в «Ленте за вчера»', async () => {
    const { orgId, ownerId } = await makeOrg();
    const agentId = await makeAgent(orgId, ownerId);
    const person = await addPerson(orgId);
    await linkTelegram(ownerId);
    const task = await inOrg(orgId, (db) => createTask(
      db, { ...base, title: 'разобрать возвраты', estimateMinutes: 30, assigneeUserId: person }, agent(agentId, ownerId), MON_10));
    await inOrg(orgId, (db) => takeTask(db, task.id, user(person), { now: MON_10 }));
    await inOrg(orgId, (db) => runTaskTimers(db, minutes(MON_10, 90)));

    const row = (await inOrg(orgId, (db) => db.query(
      `select level, delivered_at from notifications where kind = 'estimate_diverged' and task_id = $1`, [task.id]))).rows[0];
    expect(row.level).toBe('feed');
    expect(row.delivered_at).not.toBeNull();
    await inOrg(orgId, (db) => runDelivery(db, orgId, new Date(Date.now() + DAY)));
    expect(sent.some((s) => s.text.includes(t('ru', 'notif.estimate_diverged')))).toBe(false);

    // Назавтра — в «Ленте за вчера» у владельца.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(Date.now() + DAY));
    const digest = await digestFor(orgId, ownerId);
    expect(digest.text).toContain(`<b>${t('ru', 'digest.feed_yesterday')}</b>`);
    expect(digest.text).toContain(`• ${t('ru', 'notif.line', { head: t('ru', 'notif.estimate_diverged'), title: 'разобрать возвраты' })}`);
  });
});

describe('оформление HTML', () => {
  it('уведомление и дайджест уходят с parse_mode HTML; название a < b & c экранировано', async () => {
    const { orgId, ownerId } = await makeOrg();
    const person = await addPerson(orgId);
    await linkTelegram(person);
    const task = await inOrg(orgId, (db) => createTask(
      db, { ...base, title: 'a < b & c', assigneeUserId: person }, user(ownerId), MON_10));

    const id = await deliverKind(orgId, person, 'task_now', task.id);
    expect(await deliverNotification(orgId, id)).toBe('sent');
    const msg = sent.at(-1)!;
    expect(msg.parseMode).toBe('HTML');
    expect(msg.text).toBe(`<b>${t('ru', 'notif.task_now')}</b>\n\na &lt; b &amp; c\nORG-001`);

    const digest = await digestFor(orgId, person);
    expect(digest.parseMode).toBe('HTML');
    expect(digest.text).toContain('a &lt; b &amp; c');
    expect(digest.text).not.toContain('a < b');
    expect(digest.text.startsWith(`<b>${t('ru', 'digest.header')}</b>\n\n<b>${t('ru', 'digest.now')}</b>\n• `)).toBe(true);
  });

  it('дело в очереди со сроком впереди — в разделе «В очереди» со сроком словами (30.09, Ахмет)', async () => {
    const { orgId, ownerId } = await makeOrg();
    const person = await addPerson(orgId);
    await linkTelegram(person);
    await inOrg(orgId, (db) => createTask(db, { ...base, title: 'текущее дело', assigneeUserId: person }, user(ownerId), MON_10));
    await inOrg(orgId, (db) => createTask(db, { ...base, title: 'термопринтер', dueDate: '2099-10-07', assigneeUserId: person }, user(ownerId), MON_10));
    const digest = await digestFor(orgId, person);
    expect(digest.text).toContain(`<b>${t('ru', 'digest.queue')}</b>\n• термопринтер — срок `);
    expect(digest.text).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    // Текущее дело — в «Сейчас», не в очереди.
    expect(digest.text).not.toContain('• текущее дело — срок');
  });

  it('реплика человека — отдельным абзацем-цитатой и тоже экранирована', async () => {
    const { orgId, ownerId } = await makeOrg();
    const person = await addPerson(orgId);
    const task = await inOrg(orgId, (db) => createTask(
      db, { ...base, title: 'сверить счёт', assigneeUserId: person }, user(ownerId), MON_10));
    await inOrg(orgId, (db) => db.query(
      `insert into task_messages(org_id, task_id, author_user_id, kind, text) values (current_setting('app.org_id')::uuid, $1, $2, 'comment', $3)`,
      [task.id, ownerId, 'сумма <b>не</b> та']));
    const row: NotifRow = { id: 'x', kind: 'task_comment', level: 'work', task_id: task.id, payload: {}, created_at: MON_10 };
    const text = await inOrg(orgId, (db) => notificationText(db, 'ru', row, person));
    const { owner, key } = await inOrg(orgId, async (db) => {
      const o = (await db.query('select display_name from users where id = $1', [ownerId])).rows[0].display_name as string;
      const k = (await db.query(`select p.key || '-' || lpad(t.number::text, 3, '0') as key from tasks t left join projects p on p.id = t.project_id where t.id = $1`, [task.id])).rows[0].key as string | null;
      return { owner: o, key: k };
    });
    // Кто написал — в заголовке; исполнителю «исполнитель: он сам» не пишется.
    const meta = key ? `\n${key}` : '';
    expect(text).toBe(`<b>${t('ru', 'notif.task_comment_by', { name: owner })}</b>\n\nсверить счёт${meta}\n\n<blockquote>сумма &lt;b&gt;не&lt;/b&gt; та</blockquote>`);
  });

  it('уведомление по делу называет обозначение и исполнителя, если пришло не ему', async () => {
    const { orgId, ownerId } = await makeOrg();
    const person = await addPerson(orgId, 'member', { name: 'Мария' });
    const task = await inOrg(orgId, (db) => createTask(
      db, { ...base, title: 'проверить вопрос в боте', assigneeUserId: person }, user(ownerId), MON_10));
    await inOrg(orgId, (db) => db.query(
      `insert into task_messages(org_id, task_id, author_user_id, kind, text) values (current_setting('app.org_id')::uuid, $1, $2, 'comment', 'я пропустила')`,
      [task.id, person]));
    const row: NotifRow = { id: 'y', kind: 'task_comment', level: 'work', task_id: task.id, payload: {}, created_at: MON_10 };
    const text = await inOrg(orgId, (db) => notificationText(db, 'ru', row, ownerId));
    expect(text).toContain(`<b>${t('ru', 'notif.task_comment_by', { name: 'Мария' })}</b>`);
    // Имя исполнителя уже в заголовке — второй раз его не пишем.
    expect(text).not.toContain(t('ru', 'notif.assignee', { name: 'Мария' }));

    const upd: NotifRow = { id: 'z', kind: 'task_updated', level: 'work', task_id: task.id, payload: {}, created_at: MON_10 };
    const updText = await inOrg(orgId, (db) => notificationText(db, 'ru', upd, ownerId));
    expect(updText).toContain(t('ru', 'notif.assignee', { name: 'Мария' }));
  });

  it('длинный дайджест режется по пунктам с «и ещё N» и не выходит за 4096', async () => {
    const { orgId, ownerId } = await makeOrg();
    const person = await addPerson(orgId);
    await linkTelegram(person);
    const long = 'очень длинное название задачи, чтобы дайджест не поместился в одно сообщение';
    await inOrg(orgId, async (db) => {
      for (let i = 0; i < 70; i++) await createTask(db, { ...base, title: `${long} №${i}`, assigneeUserId: person }, user(ownerId), MON_10);
      // Без даты — все в одну секцию «Без даты».
      await db.query(`update tasks set due_date = null where assignee_user_id = $1`, [person]);
    });
    const digest = await digestFor(orgId, person);
    expect(digest.text.length).toBeLessThanOrEqual(4096);
    const shown = digest.text.split('\n').filter((l) => l.startsWith('• ')).length;
    expect(digest.text.endsWith(t('ru', 'digest.more', { count: 70 - shown }))).toBe(true);
    expect(shown).toBeGreaterThan(10);
  });

  it('название в 5000 символов обрезается, шапка и секция остаются, длина ≤ 4096', async () => {
    const { orgId, ownerId } = await makeOrg();
    const person = await addPerson(orgId);
    await linkTelegram(person);
    const huge = `начало ${'я'.repeat(5000)}`;
    await inOrg(orgId, async (db) => {
      await createTask(db, { ...base, title: huge, assigneeUserId: person }, user(ownerId), MON_10);
    });
    const digest = await digestFor(orgId, person);
    expect(digest.text.length).toBeLessThanOrEqual(4096);
    expect(digest.text.startsWith(`<b>${t('ru', 'digest.header')}</b>`)).toBe(true);
    expect(digest.text).toContain(`<b>${t('ru', 'digest.now')}</b>\n• начало я`);
    expect(digest.text).toContain('…');
  });
});

describe('правка чужого дела — сообщением, а не молча', () => {
  // task_changed_by_manager записывался в notifications, но текста для него не было: доставка
  // помечала его пропущенным, и человек узнавал о чужой правке только по факту.
  it('владелец правит дело, которое поставил рядовой, — исполнитель получает сообщение с названием', async () => {
    const { orgId, ownerId } = await makeOrg();
    const author = await addPerson(orgId);
    const person = await addPerson(orgId);
    await linkTelegram(person);
    const task = await inOrg(orgId, (db) => createTask(
      db, { ...base, title: 'сверить <остатки>', assigneeUserId: person }, user(author), MON_10));

    await inOrg(orgId, (db) => updateTask(db, task.id, { dueDate: '2026-12-25' }, user(ownerId)));

    const id = await deliverKind(orgId, person, 'task_changed_by_manager', task.id);
    expect(await deliverNotification(orgId, id)).toBe('sent');
    const msg = sent.at(-1)!;
    expect(msg.parseMode).toBe('HTML');
    expect(msg.text).toBe(`<b>${t('ru', 'notif.task_changed_by_manager')}</b>\n\nсверить &lt;остатки&gt;\nORG-001`);
  });
});

describe('язык получателя', () => {
  it('получатель tr получает название русской задачи по-турецки — в уведомлении и в дайджесте', async () => {
    const { orgId, ownerId } = await makeOrg();
    const person = await addPerson(orgId, 'member', { language: 'tr' });
    await linkTelegram(person);
    const title = 'проверить кредитный лимит';
    const task = await inOrg(orgId, (db) => createTask(db, { ...base, title, assigneeUserId: person }, user(ownerId), MON_10));
    await inOrg(orgId, async (db) => {
      await db.query(`update tasks set source_language = 'ru' where id = $1`, [task.id]);
      await db.query(
        `insert into translations(org_id, object_type, object_id, field, lang, source_hash, text)
         values (current_setting('app.org_id')::uuid, 'task', $1, 'title', 'tr', $2, 'kredi limitini kontrol et')`,
        [task.id, sha256(title)]);
    });

    const id = await deliverKind(orgId, person, 'task_now', task.id);
    expect(await deliverNotification(orgId, id)).toBe('sent');
    expect(sent.at(-1)!.text).toBe(`<b>${t('tr', 'notif.task_now')}</b>\n\nkredi limitini kontrol et\nORG-001`);

    const digest = await digestFor(orgId, person);
    expect(digest.text).toContain('• kredi limitini kontrol et');
    expect(digest.text).not.toContain(title);
  });
});

describe('даты словами', () => {
  it('humanDate: вчера/сегодня/завтра и «22 сентября», не ISO', () => {
    expect(humanDate('ru', '2026-09-28', '2026-09-29')).toBe('вчера');
    expect(humanDate('ru', '2026-09-29', '2026-09-29')).toBe('сегодня');
    expect(humanDate('ru', '2026-09-30', '2026-09-29')).toBe('завтра');
    expect(humanDate('ru', '2026-09-22', '2026-09-29')).toBe('22 сентября');
    expect(humanDate('en', '2026-09-22', '2026-09-29')).toBe('September 22');
    for (const lang of ['ru', 'en', 'tr', 'vi']) expect(humanDate(lang, '2025-12-31', '2026-09-29')).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it('напоминание о сроке называет дату словами', async () => {
    const { orgId, ownerId } = await makeOrg();
    const person = await addPerson(orgId);
    const task = await inOrg(orgId, (db) => createTask(
      db, { ...base, title: 'сдать отчёт', dueDate: '2026-09-18', assigneeUserId: person }, user(ownerId), MON_10));
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(MON_10);
    const row: NotifRow = { id: 'x', kind: 'reminder', level: 'work', task_id: task.id, payload: { stage: 'overdue_3' }, created_at: MON_10 };
    const text = await inOrg(orgId, (db) => notificationText(db, 'ru', row, person));
    expect(text).toContain(t('ru', 'reminder.overdue', { date: '18 сентября' }));
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });
});
