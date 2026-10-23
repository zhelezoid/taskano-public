import type { Api, Context } from 'grammy';
import { InlineKeyboard } from 'grammy';
import type { Chat, ChatMemberUpdated } from 'grammy/types';
import { withGlobal, withOrg, withSystem } from '../db/pool.js';
import { logger } from '../log.js';
import { t } from '../i18n/index.js';
import { dialogDb } from '../bot/dialog.js';
import { ensureSecretary } from './dialog-tasks.js';

// Подключение рабочей группы (спека group-intake, «Подключение группы»). Бот добавлен → добавивший
// должен быть owner/admin ровно одной компании (несколько — выбор кнопками в личке, выбор хранится в
// bot_dialogs), иначе бот выходит. Бот видит всю переписку только администратором — проверка при
// подключении и раз в сутки. В группу бот не пишет ничего: все сообщения — в личку.

const PRESENT = new Set(['member', 'administrator', 'restricted']);
const GONE = new Set(['left', 'kicked']);

type GroupChat = Extract<Chat, { type: 'group' | 'supergroup' }>;

interface Linker { userId: string; chatId: number; language: string }

async function linkerByTelegram(telegramUserId: number): Promise<Linker | null> {
  const r = await withGlobal((db) => db.query(
    `select tl.user_id, tl.chat_id, tl.blocked_at, u.language from telegram_links tl join users u on u.id = tl.user_id
      where tl.telegram_user_id = $1 and u.anonymized_at is null`, [telegramUserId]));
  const row = r.rows[0];
  if (!row || row.blocked_at) return null;
  return { userId: row.user_id, chatId: Number(row.chat_id), language: row.language };
}

/** Компании, где человек — активный owner/admin. */
async function manageableOrgs(userId: string): Promise<{ id: string; name: string }[]> {
  const r = await withGlobal((db) => db.query(
    `select o.id, o.name from memberships m join orgs o on o.id = m.org_id
      where m.user_id = $1 and m.status = 'active' and m.role in ('owner','admin') and o.kind = 'company'
      order by o.created_at`, [userId]));
  return r.rows;
}

async function dm(api: Api, chatId: number, text: string, extra?: Parameters<Api['sendMessage']>[2]): Promise<void> {
  try { await api.sendMessage(chatId, text, extra); } catch (e) { logger.info({ err: e, chatId }, 'group link: личное сообщение не доставлено'); }
}

/** Личный ключ выбора организации: не трогает текущий диалог человека с ботом (bot_dialogs по user_key). */
function pickKey(chatId: number): string { return `grp:${Math.abs(chatId)}`; }
export function encodeGroupPick(chatId: number, orgIdx: number): string { return `grp:${Math.abs(chatId)}:${orgIdx}`; }
export function decodeGroupPick(data: string): { chatAbs: string; orgIdx: number } | null {
  const m = /^grp:(\d{1,20}):(\d{1,2})$/.exec(data);
  return m ? { chatAbs: m[1]!, orgIdx: Number(m[2]) } : null;
}

let cachedBotId: number | undefined;
async function botId(api: Api): Promise<number> {
  cachedBotId ??= (await api.getMe()).id;
  return cachedBotId;
}

export async function isBotAdmin(api: Api, chatId: number): Promise<boolean> {
  const m = await api.getChatMember(chatId, await botId(api));
  return m.status === 'administrator' || m.status === 'creator';
}

/** Привязать группу к организации (или вернуть прежнюю строку в active) и сообщить в личку. */
export async function linkGroup(api: Api, orgId: string, chat: GroupChat, linker: Linker, isAdmin: boolean, now = new Date()): Promise<void> {
  const title = chat.title ?? '';
  await withGlobal((db) => db.query(
    `insert into group_links(telegram_chat_id, org_id) values ($1, $2)
     on conflict (telegram_chat_id) do update set org_id = excluded.org_id`, [chat.id, orgId]));
  const owner = await withOrg(orgId, async (db) => {
    await db.query(
      `insert into group_chats(org_id, telegram_chat_id, title, status, bot_is_admin, linked_by_user_id, admin_checked_at)
       values (current_setting('app.org_id')::uuid, $1, $2, 'active', $3, $4, $5)
       on conflict (org_id, telegram_chat_id) do update
         set title = excluded.title, status = 'active', bot_is_admin = excluded.bot_is_admin,
             linked_by_user_id = excluded.linked_by_user_id, admin_checked_at = excluded.admin_checked_at`,
      [chat.id, title, isAdmin, linker.userId, now]);
    // «Секретарь» — автор задач из переписки, если поручение не подошло ни одному направлению (этап 1b).
    await ensureSecretary(db);
    return (await db.query(`select owner_user_id from orgs where id = current_setting('app.org_id')::uuid`)).rows[0].owner_user_id as string;
  });

  const ownerLink = owner === linker.userId ? linker : await withGlobal(async (db) => {
    const r = await db.query(
      `select tl.chat_id, tl.blocked_at, u.language from telegram_links tl join users u on u.id = tl.user_id where tl.user_id = $1`, [owner]);
    const row = r.rows[0];
    return row && !row.blocked_at ? { userId: owner, chatId: Number(row.chat_id), language: row.language as string } : null;
  });
  const recipients = [linker, ...(ownerLink && ownerLink.userId !== linker.userId ? [ownerLink] : [])];
  for (const r of recipients) await dm(api, r.chatId, t(r.language, 'group.connected', { title }));
  if (!isAdmin) await dm(api, linker.chatId, t(linker.language, 'group.make_admin', { title }));
}

async function leaveWithReason(api: Api, chat: GroupChat, telegramUserId: number, lang: string): Promise<void> {
  try { await api.leaveChat(chat.id); } catch (e) { logger.warn({ err: e, chatId: chat.id }, 'group link: не удалось выйти из группы'); }
  // Бот может написать только тому, кто хоть раз открывал с ним личный чат — иначе Telegram откажет.
  await dm(api, telegramUserId, t(lang, 'group.left_not_allowed', { title: chat.title ?? '' }));
}

async function markLeft(chatId: number): Promise<void> {
  const link = await withGlobal((db) => db.query('delete from group_links where telegram_chat_id = $1 returning org_id', [chatId]));
  const orgId = link.rows[0]?.org_id as string | undefined;
  if (orgId) await withOrg(orgId, (db) => db.query(`update group_chats set status = 'left' where telegram_chat_id = $1`, [chatId]));
}

async function setAdminFlag(api: Api, orgId: string, chatId: number, isAdmin: boolean, now: Date): Promise<void> {
  const prev = await withOrg(orgId, (db) => db.query(
    `update group_chats g set bot_is_admin = $2, admin_checked_at = $3
       from (select id, bot_is_admin as was from group_chats where telegram_chat_id = $1) old
      where g.id = old.id returning old.was, g.title, g.linked_by_user_id`, [chatId, isAdmin, now]));
  const row = prev.rows[0];
  if (!row || isAdmin || row.was === false || !row.linked_by_user_id) return;
  // Бота разжаловали — он снова слеп. Напоминаем подключившему.
  const who = await withGlobal((db) => db.query(
    `select tl.chat_id, tl.blocked_at, u.language from telegram_links tl join users u on u.id = tl.user_id where tl.user_id = $1`,
    [row.linked_by_user_id]));
  const l = who.rows[0];
  if (l && !l.blocked_at) await dm(api, Number(l.chat_id), t(l.language, 'group.make_admin', { title: row.title }));
}

/** `my_chat_member`: бота добавили, выгнали, повысили или разжаловали в группе. */
export async function handleMyChatMember(ctx: Context): Promise<void> {
  const upd = ctx.myChatMember as ChatMemberUpdated | undefined;
  if (!upd) return;
  const chat = upd.chat;
  if (chat.type !== 'group' && chat.type !== 'supergroup') return;
  const was = upd.old_chat_member.status;
  const now = upd.new_chat_member.status;
  const isAdmin = now === 'administrator';

  if (GONE.has(now)) { await markLeft(chat.id); return; }
  if (!PRESENT.has(now)) return;

  const existing = await withGlobal((db) => db.query('select org_id from group_links where telegram_chat_id = $1', [chat.id]));
  if (existing.rowCount && !GONE.has(was)) {
    // Уже подключена: сменились только права бота.
    await setAdminFlag(ctx.api, existing.rows[0].org_id as string, chat.id, isAdmin, new Date());
    return;
  }

  const from = upd.from;
  const linker = await linkerByTelegram(from.id);
  const orgs = linker ? await manageableOrgs(linker.userId) : [];
  if (!linker || !orgs.length) {
    await markLeft(chat.id);
    await leaveWithReason(ctx.api, chat, from.id, linker?.language ?? from.language_code ?? 'en');
    return;
  }
  if (orgs.length === 1) {
    await linkGroup(ctx.api, orgs[0]!.id, chat, linker, isAdmin);
    return;
  }
  await dialogDb((db) => db.query(
    `insert into bot_dialogs(user_key, state, data, updated_at) values ($1, 'group_pick', $2, now())
     on conflict (user_key) do update set state = excluded.state, data = excluded.data, updated_at = excluded.updated_at`,
    [pickKey(chat.id), JSON.stringify({
      chat: { id: chat.id, type: chat.type, title: chat.title ?? '' }, telegramUserId: from.id, userId: linker.userId,
      orgIds: orgs.map((o) => o.id), isAdmin,
    })]));
  const kb = new InlineKeyboard();
  orgs.forEach((o, i) => kb.text(o.name, encodeGroupPick(chat.id, i)).row());
  await dm(ctx.api, linker.chatId, t(linker.language, 'group.pick_org', { title: chat.title ?? '' }), { reply_markup: kb });
}

/** Кнопка «К какой организации?» — только тот, кто добавил бота, и только пока он там owner/admin. */
export async function handleGroupPickCallback(ctx: Context, pick: { chatAbs: string; orgIdx: number }): Promise<void> {
  const from = ctx.from;
  if (!from) return;
  const key = `grp:${pick.chatAbs}`;
  const row = (await dialogDb((db) => db.query('select state, data from bot_dialogs where user_key = $1', [key]))).rows[0];
  const data = row?.data as { chat: GroupChat; telegramUserId: number; userId: string; orgIds: string[]; isAdmin: boolean } | undefined;
  const linker = await linkerByTelegram(from.id);
  const lang = linker?.language ?? from.language_code ?? 'en';
  const orgId = data?.orgIds[pick.orgIdx];
  const allowed = linker && data && row.state === 'group_pick' && data.telegramUserId === from.id && data.userId === linker.userId
    && orgId && (await manageableOrgs(linker.userId)).some((o) => o.id === orgId);
  if (!allowed) {
    await ctx.answerCallbackQuery();
    try { await ctx.editMessageText(t(lang, 'group.pick_stale')); } catch { /* сообщение недоступно */ }
    return;
  }
  await dialogDb((db) => db.query('delete from bot_dialogs where user_key = $1', [key]));
  let isAdmin = data.isAdmin;
  try { isAdmin = await isBotAdmin(ctx.api, data.chat.id); } catch { /* бота могли уже выгнать — оставим прежнее */ }
  try { await ctx.editMessageReplyMarkup({ reply_markup: undefined }); } catch { /* не критично */ }
  await linkGroup(ctx.api, orgId, data.chat, linker, isAdmin);
  await ctx.answerCallbackQuery();
}

/** Группа стала супергруппой — новый chat_id, привязка переезжает вместе с историей. */
export async function migrateGroupChat(oldChatId: number, newChatId: number): Promise<void> {
  const { oldOrg, newTaken } = await withGlobal(async (db) => {
    const o = await db.query('select org_id from group_links where telegram_chat_id = $1', [oldChatId]);
    const n = await db.query('select 1 from group_links where telegram_chat_id = $1', [newChatId]);
    return { oldOrg: o.rows[0]?.org_id as string | undefined, newTaken: !!n.rowCount };
  });
  if (!oldOrg) return;
  if (newTaken) {
    // my_chat_member новой супергруппы пришёл раньше и уже привязал её — старая строка больше не нужна.
    await markLeft(oldChatId);
    return;
  }
  await withGlobal((db) => db.query('update group_links set telegram_chat_id = $2 where telegram_chat_id = $1', [oldChatId, newChatId]));
  await withOrg(oldOrg, (db) => db.query('update group_chats set telegram_chat_id = $2 where telegram_chat_id = $1', [oldChatId, newChatId]));
}

/** Раз в сутки: видит ли бот всё ещё переписку (админ ли он). withSystem — только перечень организаций. */
export async function checkGroupAdmins(api: Api | null, now: Date = new Date()): Promise<void> {
  if (!api) return;
  const orgIds = (await withSystem((db) => db.query(`select distinct org_id from group_chats where status <> 'left'`))).rows.map((r) => r.org_id as string);
  for (const orgId of orgIds) {
    const chats = (await withOrg(orgId, (db) => db.query(`select telegram_chat_id::text from group_chats where status <> 'left'`))).rows;
    for (const c of chats) {
      const chatId = Number(c.telegram_chat_id);
      try {
        await setAdminFlag(api, orgId, chatId, await isBotAdmin(api, chatId), now);
      } catch (e) {
        logger.warn({ err: e, chatId }, 'group admin check: getChatMember не удался');
      }
    }
  }
}
