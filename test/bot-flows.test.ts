process.env.TASKANO_DISABLE_RATE_LIMIT = '1';

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Update, UserFromGetMe } from 'grammy/types';
import { closePools, withGlobal } from '../src/db/pool.js';
import { transition } from '../src/core/lifecycle.js';
import { createTask } from '../src/core/tasks.js';
import { createProposal } from '../src/core/proposals.js';
import { createBot } from '../src/bot/bot.js';
import { deliverNotification } from '../src/bot/deliver.js';
import { outbox } from '../src/email/send.js';
import { invitePerson } from '../src/core/invitations.js';
import { tickOrg } from '../src/worker/tick.js';
import { localDate } from '../src/core/calendar.js';
import { t } from '../src/i18n/index.js';
import { addPerson, inOrg, makeAgent, makeOrg, makeUser, MON_10 } from './helpers.js';

afterAll(closePools);

const BOT_INFO: UserFromGetMe = {
  id: 10, is_bot: true, first_name: 'Taskano', username: 'taskano_test_bot',
  can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false,
  can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false,
  allows_users_to_create_topics: false, can_manage_bots: false, supports_join_request_queries: false,
};

let nextUpdateId = 1;
let nextMessageId = 1;
let nextTgId = 1000;

interface SentCall { method: string; payload: Record<string, unknown> }

let sent: SentCall[];
let bot: ReturnType<typeof createBot>;
let blockChatIds: Set<number>;

beforeEach(() => {
  sent = [];
  blockChatIds = new Set();
  bot = createBot({ token: 'test-token', botInfo: BOT_INFO });
  // Перехват сети — как в спеке («перехватывать исходящие вызовы через bot.api.config.use»).
  bot.api.config.use(async (_prev, method, payload) => {
    sent.push({ method, payload: payload as Record<string, unknown> });
    const chatId = (payload as { chat_id?: number }).chat_id;
    if (method === 'sendMessage' && chatId !== undefined && blockChatIds.has(chatId)) {
      return { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' } as any;
    }
    if (method === 'sendMessage') {
      return {
        ok: true,
        result: { message_id: nextMessageId++, date: 0, chat: { id: chatId, type: 'private' }, text: String((payload as { text?: string }).text ?? '') },
      } as any;
    }
    return { ok: true, result: true } as any;
  });
});

function tgUser(id: number, lang = 'ru'): NonNullable<Update['message']>['from'] {
  return { id, is_bot: false, first_name: 'Person', language_code: lang };
}

function messageUpdate(opts: { from: NonNullable<Update['message']>['from']; text?: string; chatId?: number }): Update {
  // grammY определяет команду по entities (bot_command), не по сырому тексту.
  const commandMatch = /^\/([a-zA-Z0-9_]+)/.exec(opts.text ?? '');
  const entities = commandMatch ? [{ type: 'bot_command', offset: 0, length: commandMatch[0].length }] : undefined;
  return {
    update_id: nextUpdateId++,
    message: {
      message_id: nextMessageId++, date: Math.floor(Date.now() / 1000),
      chat: { id: opts.chatId ?? opts.from!.id, type: 'private', first_name: 'Person' },
      from: opts.from, text: opts.text, entities,
    },
  } as unknown as Update;
}

function callbackUpdate(opts: { from: NonNullable<Update['message']>['from']; data: string; chatId?: number; messageId?: number }): Update {
  const messageId = opts.messageId ?? nextMessageId++;
  return {
    update_id: nextUpdateId++,
    callback_query: {
      id: String(nextUpdateId), from: opts.from, chat_instance: 'x', data: opts.data,
      message: {
        message_id: messageId, date: Math.floor(Date.now() / 1000),
        chat: { id: opts.chatId ?? opts.from!.id, type: 'private', first_name: 'Person' },
        text: 'card',
      },
    },
  } as unknown as Update;
}

async function linkTelegram(userId: string, telegramUserId: number, chatId = telegramUserId): Promise<void> {
  await withGlobal((db) => db.query(
    `insert into telegram_links(telegram_user_id, user_id, chat_id) values ($1, $2, $3)`,
    [telegramUserId, userId, chatId],
  ));
}

function lastSent(method = 'sendMessage'): SentCall | undefined {
  return [...sent].reverse().find((s) => s.method === method);
}

function extractInviteToken(mailText: string): string {
  const m = /start=inv_([^\s"<]+)/.exec(mailText);
  if (!m) throw new Error('invite token not found in outbox mail');
  return m[1]!;
}

const base = { why: 'зачем', doneCriteria: 'критерий', dueDate: '2026-12-31', description: 'как делать: открыть таблицу и свериться' };

describe('вход по приглашению', () => {
  it('/start inv_… без «Да, это я» не активирует приглашение', async () => {
    const { orgId, ownerId } = await makeOrg();
    outbox.length = 0;
    await inOrg(orgId, (db) => invitePerson(db, { email: `ahmet-${Date.now()}@test.local`, role: 'member' }, { kind: 'user', userId: ownerId }));
    const token = extractInviteToken(outbox.at(-1)!.text);
    const from = tgUser(nextTgId++);

    await bot.handleUpdate(messageUpdate({ from, text: `/start inv_${token}` }));
    const confirm = lastSent();
    expect(confirm?.payload.text).toContain('ahmet-');
    expect(JSON.stringify(confirm?.payload.reply_markup)).toContain('inv:yes');

    await bot.handleUpdate(callbackUpdate({ from, data: 'inv:no' }));

    const inv = await inOrg(orgId, (db) => db.query('select status from invitations where org_id = $1', [orgId]));
    expect(inv.rows[0].status).toBe('pending');
    const mem = await withGlobal((db) => db.query(`select status from memberships where org_id = $1 and user_id <> $2`, [orgId, ownerId]));
    expect(mem.rows[0].status).toBe('invited');
    const link = await withGlobal((db) => db.query('select 1 from telegram_links where telegram_user_id = $1', [from!.id]));
    expect(link.rowCount).toBe(0);
  });

  it('с «Да» — активирует приглашение и предлагает выбор языка', async () => {
    const { orgId, ownerId } = await makeOrg();
    outbox.length = 0;
    await inOrg(orgId, (db) => invitePerson(db, { email: `ayse-${Date.now()}@test.local`, role: 'member' }, { kind: 'user', userId: ownerId }));
    const token = extractInviteToken(outbox.at(-1)!.text);
    const from = tgUser(nextTgId++, 'ru');

    await bot.handleUpdate(messageUpdate({ from, text: `/start inv_${token}` }));
    await bot.handleUpdate(callbackUpdate({ from, data: 'inv:yes' }));

    const inv = await inOrg(orgId, (db) => db.query('select status from invitations where org_id = $1', [orgId]));
    expect(inv.rows[0].status).toBe('accepted');
    const link = await withGlobal((db) => db.query('select 1 from telegram_links where telegram_user_id = $1', [from!.id]));
    expect(link.rowCount).toBe(1);

    const langMsg = sent.filter((s) => s.method === 'editMessageText' || s.method === 'sendMessage').at(-1);
    expect(langMsg?.payload.text).toBe(t('ru', 'start.choose_language'));
    expect(JSON.stringify(langMsg?.payload.reply_markup)).toContain('lang:ru');
  });
});

describe('кнопка приложения слева', () => {
  it('смена языка ставит кнопку «открыть приложение» на языке человека', async () => {
    const { orgId } = await makeOrg();
    const personId = await addPerson(orgId);
    const from = tgUser(nextTgId++);
    await linkTelegram(personId, from!.id);
    await bot.handleUpdate(callbackUpdate({ from, data: 'lang:tr' }));
    const call = sent.find((c) => c.method === 'setChatMenuButton');
    expect(call?.payload.menu_button).toMatchObject({ type: 'web_app', text: t('tr', 'menu.app_button') });
    expect(JSON.stringify(call?.payload.menu_button)).toContain('/app/');
  });
});

describe('карточка задачи', () => {
  // Своё дело закрывается сдачей (спека skill-roles): «ушло на проверку» было бы неправдой.
  it('«Готово» по своему делу компании — «Готово.», дело сделано', async () => {
    const { orgId, ownerId } = await makeOrg();
    const task = await inOrg(orgId, (db) => createTask(db, {
      ...base, title: 'своё дело', assigneeUserId: ownerId,
    }, { kind: 'user', userId: ownerId }, MON_10));
    const from = tgUser(nextTgId++);
    await linkTelegram(ownerId, from!.id);

    await bot.handleUpdate(callbackUpdate({ from, data: `a:done:${task.short_id}:${task.version}` }));
    // Карточка не затирается: текст остаётся, итог дописан строкой «✓ …».
    expect(lastSent('editMessageText')?.payload.text).toMatch(new RegExp(`\\n\\n✓ ${t('ru', 'done.done_personal')}$`));
    const row = await inOrg(orgId, (db) => db.query('select status from tasks where id = $1', [task.id]));
    expect(row.rows[0].status).toBe('done');
  });

  it('«Завершить» сдаёт сразу, даже если результат затребован', async () => {
    const { orgId, ownerId } = await makeOrg();
    const personId = await addPerson(orgId);
    const agentId = await makeAgent(orgId, ownerId);
    const task = await inOrg(orgId, (db) => createTask(db, {
      ...base, title: 'фото склада', assigneeUserId: personId, expectedResult: { type: 'photo', required: false },
    }, { kind: 'agent', agentId, userId: ownerId }, MON_10));
    expect(task.status).toBe('active');

    const from = tgUser(nextTgId++);
    await linkTelegram(personId, from!.id);

    await bot.handleUpdate(callbackUpdate({ from, data: `a:done:${task.short_id}:${task.version}` }));
    const row = await inOrg(orgId, (db) => db.query('select status from tasks where id = $1', [task.id]));
    expect(row.rows[0].status).toBe('submitted');
    const dialog = await withGlobal((db) => db.query(`select state from bot_dialogs where user_key = $1`, [`tg:${from!.id}`]));
    expect(dialog.rows[0]?.state ?? 'idle').not.toBe('await_done_result');
  });

  // «Остановить» в боте не было вовсе: взяв дело, человек мог вернуть его в очередь только
  // настоящим действием — сдать, отказаться, спросить. В приложении это одна кнопка, и слот «Сейчас»
  // общий, так что бот держал человека занятым.
  it('«Остановить» возвращает взятое дело в очередь, а у невзятого кнопки нет', async () => {
    const { orgId, ownerId } = await makeOrg();
    const personId = await addPerson(orgId);
    const agentId = await makeAgent(orgId, ownerId);
    const task = await inOrg(orgId, (db) => createTask(db, {
      ...base, title: 'свериться с остатками', assigneeUserId: personId,
    }, { kind: 'agent', agentId, userId: ownerId }, MON_10));

    const from = tgUser(nextTgId++);
    await linkTelegram(personId, from!.id);

    // Дело предложено, но не взято — останавливать нечего.
    await bot.handleUpdate(messageUpdate({ from, text: `/start t_${task.short_id}` }));
    const beforeTake = JSON.stringify(lastSent()?.payload.reply_markup ?? {});
    expect(beforeTake).not.toContain(t('ru', 'btn.stop'));
    expect(beforeTake).toContain(t('ru', 'btn.take'));

    await bot.handleUpdate(callbackUpdate({ from, data: `a:take:${task.short_id}:${task.version}` }));
    const taken = await inOrg(orgId, (db) => db.query('select status, version from tasks where id = $1', [task.id]));
    expect(taken.rows[0].status).toBe('in_progress');

    // Взятое дело показывает «Остановить» вместо «Взять» — то же место в ряду, что в приложении.
    const afterTake = JSON.stringify(lastSent('editMessageText')?.payload.reply_markup ?? {});
    expect(afterTake).toContain(t('ru', 'btn.stop'));
    expect(afterTake).not.toContain(t('ru', 'btn.take'));

    await bot.handleUpdate(callbackUpdate({ from, data: `a:stp:${task.short_id}:${taken.rows[0].version}` }));
    // Дело ушло из работы и тут же снова предложено очередью: остановились — слот свободен, а
    // следующее дело предлагается, но не берётся за человека.
    const stopped = await inOrg(orgId, (db) => db.query('select status from tasks where id = $1', [task.id]));
    expect(stopped.rows[0].status).not.toBe('in_progress');
    expect(stopped.rows[0].status).toBe('active');
  });

  it('карточка с обязательным фото и ссылкой показывает «Приложить» и url', async () => {
    const { orgId, ownerId } = await makeOrg();
    const personId = await addPerson(orgId);
    const agentId = await makeAgent(orgId, ownerId);
    const url = 'https://example.com/spec';
    const task = await inOrg(orgId, (db) => createTask(db, {
      ...base, title: 'со ссылкой', assigneeUserId: personId,
      expectedResult: { type: 'photo', required: true }, links: [{ type: 'url', url }],
    }, { kind: 'agent', agentId, userId: ownerId }, MON_10));

    const from = tgUser(nextTgId++);
    await linkTelegram(personId, from!.id);
    await bot.handleUpdate(messageUpdate({ from, text: `/start t_${task.short_id}` }));

    const text = String(lastSent()?.payload.text ?? '');
    expect(text).toContain('Приложить');
    expect(text).toContain(url);
  });

  it('callback с устаревшей версией → «Карточка устарела»', async () => {
    const { orgId, ownerId } = await makeOrg();
    const personId = await addPerson(orgId);
    const agentId = await makeAgent(orgId, ownerId);
    const task = await inOrg(orgId, (db) => createTask(db, { ...base, title: 'т1', assigneeUserId: personId }, { kind: 'agent', agentId, userId: ownerId }, MON_10));
    const from = tgUser(nextTgId++);
    await linkTelegram(personId, from!.id);

    await bot.handleUpdate(callbackUpdate({ from, data: `a:take:${task.short_id}:${task.version + 5}` }));
    const stale = sent.filter((s) => s.method === 'sendMessage').find((s) => s.payload.text === t('ru', 'card.stale'));
    expect(stale).toBeTruthy();
  });

  it('коллега по организации не видит чужую карточку по /start t_<short_id>', async () => {
    const { orgId, ownerId } = await makeOrg();
    const alice = await addPerson(orgId);
    const bob = await addPerson(orgId);
    const agentId = await makeAgent(orgId, ownerId);
    const task = await inOrg(orgId, (db) => createTask(db, { ...base, title: 'секрет Алисы', assigneeUserId: alice }, { kind: 'agent', agentId, userId: ownerId }, MON_10));
    const from = tgUser(nextTgId++);
    await linkTelegram(bob, from!.id);

    await bot.handleUpdate(messageUpdate({ from, text: `/start t_${task.short_id}` }));
    expect(sent.some((c) => String(c.payload.text ?? '').includes('секрет Алисы'))).toBe(false);
  });

  it('«Взял» на пункте очереди меняет «Сейчас»', async () => {
    const { orgId, ownerId } = await makeOrg();
    const personId = await addPerson(orgId);
    const agentId = await makeAgent(orgId, ownerId);
    const act = { kind: 'agent' as const, agentId, userId: ownerId };
    const t1 = await inOrg(orgId, (db) => createTask(db, { ...base, title: 'первая', assigneeUserId: personId }, act, MON_10));
    const t2 = await inOrg(orgId, (db) => createTask(db, { ...base, title: 'вторая', assigneeUserId: personId }, act, MON_10));
    expect(t1.status).toBe('active');
    expect(t2.status).toBe('ready');

    const from = tgUser(nextTgId++);
    await linkTelegram(personId, from!.id);
    await bot.handleUpdate(callbackUpdate({ from, data: `a:take:${t2.short_id}:${t2.version}` }));

    const rows = await inOrg(orgId, (db) => db.query('select title, status from tasks where id = any($1::uuid[]) order by title', [[t1.id, t2.id]]));
    const byTitle = Object.fromEntries(rows.rows.map((r) => [r.title, r.status]));
    expect(byTitle['первая']).toBe('ready');
    expect(byTitle['вторая']).toBe('in_progress');
  });
});

describe('свободный текст', () => {
  it('задачу не создаёт — только подсказка про кнопку приложения (задачи ставит агент)', async () => {
    const personId = await makeUser();
    const from = tgUser(nextTgId++);
    await linkTelegram(personId, from!.id);

    await bot.handleUpdate(messageUpdate({ from, text: 'полить цветы' }));
    expect(lastSent()?.payload.text).toBe(t('ru', 'hint.no_tasks_here'));

    const orgs = await withGlobal((db) => db.query(`select id from orgs where owner_user_id = $1`, [personId]));
    for (const o of orgs.rows) {
      const n = await inOrg(o.id, (db) => db.query('select count(*)::int as n from tasks where assignee_user_id = $1', [personId]));
      expect(n.rows[0].n).toBe(0);
    }
  });
});


describe('доставка уведомлений', () => {
  it('deliverNotification для proposal шлёт 3 кнопки владельцу', async () => {
    const { orgId, ownerId } = await makeOrg();
    const agentId = await makeAgent(orgId, ownerId);
    await linkTelegram(ownerId, nextTgId++);

    const proposal = await inOrg(orgId, (db) => createProposal(db, { agentId, type: 'other', summary: 'Проверь запись' }, MON_10));
    const n = await inOrg(orgId, (db) => db.query(`select id from notifications where kind = 'proposal' and payload->>'proposal_id' = $1`, [proposal.id]));
    const result = await deliverNotification(orgId, n.rows[0].id);
    expect(result).toBe('sent');

    const proposalMsg = lastSent();
    expect(proposalMsg?.payload.text).toBe('<b>Проверь запись</b>');
    const kb = JSON.stringify(proposalMsg?.payload.reply_markup);
    expect(kb).toContain(`pr:accept:${proposal.short_id}`);
    expect(kb).toContain(`pr:reject:${proposal.short_id}`);
    expect(kb).toContain(`pr:change:${proposal.short_id}`);
  });

  it('403 при отправке → blocked_at, следующая доставка — skipped', async () => {
    const { orgId, ownerId } = await makeOrg();
    const personId = await addPerson(orgId);
    const agentId = await makeAgent(orgId, ownerId);
    const chatId = nextTgId++;
    await linkTelegram(personId, chatId);
    blockChatIds.add(chatId);

    const task = await inOrg(orgId, (db) => createTask(db, { ...base, title: 'заблокированному', assigneeUserId: personId }, { kind: 'agent', agentId, userId: ownerId }, MON_10));
    const n = await inOrg(orgId, (db) => db.query(`select id from notifications where kind = 'task_now' and task_id = $1`, [task.id]));
    expect(n.rowCount).toBe(1);

    const first = await deliverNotification(orgId, n.rows[0].id);
    expect(first).toBe('skipped');
    const link = await withGlobal((db) => db.query('select blocked_at from telegram_links where telegram_user_id = $1', [chatId]));
    expect(link.rows[0].blocked_at).not.toBeNull();

    blockChatIds.delete(chatId);
    const sentBefore = sent.length;
    const second = await deliverNotification(orgId, n.rows[0].id);
    expect(second).toBe('skipped');
    expect(sent.length).toBe(sentBefore); // заблокирован — вторую попытку отправки не делаем вовсе
  });

  it('дайджест — одно сообщение на человека по всем его организациям', async () => {
    const { orgId, ownerId } = await makeOrg();
    const personId = await addPerson(orgId);
    const agentId = await makeAgent(orgId, ownerId);
    const from = tgUser(nextTgId++);
    await linkTelegram(personId, from!.id);

    const companyTask = await inOrg(orgId, (db) => createTask(
      db, { ...base, title: 'компания', assigneeUserId: personId }, { kind: 'agent', agentId, userId: ownerId }, MON_10,
    ));
    expect(companyTask.status).toBe('active'); // единственная задача человека — сразу в «Сейчас»

    const personalOrgId = (await withGlobal((db) => db.query(
      `select id from orgs where owner_user_id = $1 and kind = 'personal'`, [personId],
    ))).rows[0].id as string;
    // buildDigest (bot/deliver.ts) фильтрует «личное на сегодня» по реальному времени доставки, не по
    // симулированному `now` тика — дата должна быть сегодняшней по-настоящему, иначе задача не
    // попадёт в дайджест.
    const today = localDate(new Date(), 'Europe/Istanbul');
    await inOrg(personalOrgId, (db) => createTask(
      db, { title: 'личное дело', assigneeUserId: personId, dueDate: today }, { kind: 'user', userId: personId }, MON_10,
    ));

    const workStart = new Date('2026-09-21T06:03:00Z'); // 09:03 Стамбул — начало рабочего дня + 3 мин
    // Тикаем организации этого человека, а не всю базу (runTick): к концу прогона в ней сотни
    // организаций, и один обход упирался в таймаут теста. Обход — в worker.test.ts.
    for (const id of [orgId, personalOrgId]) await tickOrg(id, workStart);

    const inCompanyOrg = await inOrg(orgId, (db) => db.query(`select id from notifications where kind = 'digest' and user_id = $1`, [personId]));
    const inPersonalOrg = await inOrg(personalOrgId, (db) => db.query(`select id from notifications where kind = 'digest' and user_id = $1`, [personId]));
    expect(inCompanyOrg.rowCount).toBe(0);
    expect(inPersonalOrg.rowCount).toBe(1); // канонически — личное пространство, оно есть у каждого

    const result = await deliverNotification(personalOrgId, inPersonalOrg.rows[0].id);
    expect(result).toBe('sent');
    const text = String(lastSent()?.payload.text ?? '');
    expect(text).toContain('компания');
    expect(text).toContain('личное дело');
  });
});

describe('«Написать» на карточке (спека task-comments)', () => {
  it('постановщик-владелец пишет к делу исполнителя: кнопка не тупик', async () => {
    const { orgId, ownerId } = await makeOrg();
    const personId = await addPerson(orgId);
    const task = await inOrg(orgId, (db) => createTask(
      db, { ...base, title: 'встретить поставщика', assigneeUserId: personId },
      { kind: 'user', userId: ownerId }, MON_10));
    const from = tgUser(nextTgId++);
    await linkTelegram(ownerId, from!.id);

    // Владелец открывает карточку своего дела, назначенного другому, и жмёт «Написать».
    await bot.handleUpdate(messageUpdate({ from, text: `/start t_${task.short_id}` }));
    expect(JSON.stringify(lastSent()?.payload.reply_markup)).toContain(`a:cm:${task.short_id}:`);
    await bot.handleUpdate(callbackUpdate({ from, data: `a:cm:${task.short_id}:${task.version}` }));
    // Просьба — отдельным сообщением, карточка остаётся.
    expect(lastSent('sendMessage')?.payload.text).toBe(t('ru', 'comment.ask'));

    await bot.handleUpdate(messageUpdate({ from, text: 'поставщик будет во вторник' }));
    expect(lastSent()?.payload.text).toBe(t('ru', 'comment.sent'));
    const msgs = await inOrg(orgId, (db) => db.query(
      `select kind, text, author_user_id from task_messages where task_id = $1`, [task.id]));
    expect(msgs.rows).toHaveLength(1);
    expect(msgs.rows[0]).toMatchObject({ kind: 'comment', text: 'поставщик будет во вторник', author_user_id: ownerId });
  });

  it('реплика записывается комментарием, пустой текст — подсказка; первая реплика исполнителя начинает дело', async () => {
    const { orgId, ownerId } = await makeOrg();
    const personId = await addPerson(orgId);
    const agentId = await makeAgent(orgId, ownerId);
    const task = await inOrg(orgId, (db) => createTask(
      db, { ...base, title: 'закупка стеллажей', assigneeUserId: personId }, { kind: 'agent', agentId, userId: ownerId }, MON_10));
    const from = tgUser(nextTgId++);
    await linkTelegram(personId, from!.id);

    // Кнопка есть на карточке.
    await bot.handleUpdate(messageUpdate({ from, text: `/start t_${task.short_id}` }));
    expect(JSON.stringify(lastSent()?.payload.reply_markup)).toContain(`a:cm:${task.short_id}:`);

    await bot.handleUpdate(callbackUpdate({ from, data: `a:cm:${task.short_id}:${task.version}` }));
    // Просьба — отдельным сообщением, карточка остаётся.
    expect(lastSent('sendMessage')?.payload.text).toBe(t('ru', 'comment.ask'));

    // Пустой текст — подсказка, реплики нет; диалог остаётся открытым.
    await bot.handleUpdate(messageUpdate({ from, text: '   ' }));
    expect(lastSent()?.payload.text).toBe(t('ru', 'comment.empty'));
    const none = await inOrg(orgId, (db) => db.query(`select 1 from task_messages where task_id = $1`, [task.id]));
    expect(none.rowCount).toBe(0);

    await bot.handleUpdate(messageUpdate({ from, text: 'поставщик перенёс на четверг' }));
    expect(lastSent()?.payload.text).toBe(t('ru', 'comment.sent'));

    const msgs = await inOrg(orgId, (db) => db.query(
      `select kind, text, author_user_id from task_messages where task_id = $1`, [task.id]));
    expect(msgs.rows).toHaveLength(1);
    expect(msgs.rows[0]).toMatchObject({ kind: 'comment', text: 'поставщик перенёс на четверг', author_user_id: personId });

    // Первая реплика исполнителя к неначатому делу начинает его (спека auto-start): это «Взять» без кнопки.
    const after = await inOrg(orgId, (db) => db.query('select status, started_via from tasks where id = $1', [task.id]));
    expect(after.rows[0]).toMatchObject({ status: 'in_progress', started_via: 'comment' });
  });
});

// Бот — журнал. Уведомление под кнопкой не затирается: просьба идёт отдельным
// сообщением, итог дописывается под исходным текстом, «Отмена» возвращает кнопки.
describe('уведомление не затирается кнопкой', () => {
  function noticeUpdate(from: NonNullable<Update['message']>['from'], data: string, messageId: number, text: string): Update {
    return {
      update_id: nextUpdateId++,
      callback_query: {
        id: String(nextUpdateId), from, chat_instance: 'x', data,
        message: {
          message_id: messageId, date: Math.floor(Date.now() / 1000),
          chat: { id: from!.id, type: 'private', first_name: 'Person' },
          text, entities: [{ type: 'bold', offset: 0, length: 6 }],
          reply_markup: { inline_keyboard: [[{ text: 'Ответить', callback_data: data }]] },
        },
      },
    } as unknown as Update;
  }

  async function ownerWithQuestion() {
    const { orgId, ownerId } = await makeOrg();
    const personId = await addPerson(orgId);
    const task = await inOrg(orgId, (db) => createTask(db, { ...base, title: 'проверить прайс', assigneeUserId: personId },
      { kind: 'user', userId: ownerId }, MON_10));
    await inOrg(orgId, (db) => transition(db, task.id, 'question', { kind: 'user', userId: personId }, { now: MON_10, text: 'прайс не тот?' }));
    const from = tgUser(nextTgId++);
    await linkTelegram(ownerId, from!.id);
    return { orgId, task, from };
  }

  it('«Ответить»: вопрос остаётся в чате, после ответа под ним «✓ …», просьба убрана', async () => {
    const { task, from } = await ownerWithQuestion();
    const noticeId = nextMessageId++;
    const notice = 'Вопрос: Мария спрашивает «прайс не тот?»';
    const data = (await import('../src/bot/callbacks.js')).encodeOwnerTask('answer', String(task.short_id));
    await bot.handleUpdate(noticeUpdate(from, data, noticeId, notice));

    expect(sent.some((s) => s.method === 'editMessageText' && s.payload.message_id === noticeId)).toBe(false);
    expect(lastSent('editMessageReplyMarkup')?.payload).toMatchObject({ message_id: noticeId, reply_markup: { inline_keyboard: [] } });
    const ask = lastSent('sendMessage')!;
    expect(ask.payload.text).toBe(t('ru', 'owner_task.answer_ask'));

    await bot.handleUpdate(messageUpdate({ from, text: 'тот, смотри лист 2' }));
    const edit = lastSent('editMessageText')!;
    expect(edit.payload).toMatchObject({ message_id: noticeId, text: `${notice}\n\n✓ ${t('ru', 'owner_task.answer_sent')}` });
    expect(edit.payload.entities).toEqual([{ type: 'bold', offset: 0, length: 6 }]);
    expect(sent.some((s) => s.method === 'deleteMessage')).toBe(true);
  });

  it('«Отмена» под просьбой возвращает уведомлению кнопки', async () => {
    const { task, from } = await ownerWithQuestion();
    const noticeId = nextMessageId++;
    const data = (await import('../src/bot/callbacks.js')).encodeOwnerTask('answer', String(task.short_id));
    await bot.handleUpdate(noticeUpdate(from, data, noticeId, 'Вопрос по делу'));
    const askId = nextMessageId - 1;
    const { UNIVERSAL_CANCEL } = await import('../src/bot/callbacks.js');
    await bot.handleUpdate(callbackUpdate({ from, data: UNIVERSAL_CANCEL, messageId: askId }));
    const restored = [...sent].reverse().find((s) => s.method === 'editMessageReplyMarkup' && s.payload.message_id === noticeId)!;
    expect(JSON.stringify(restored.payload.reply_markup)).toContain(data);
  });
});
