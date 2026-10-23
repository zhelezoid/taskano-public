import type { Context } from 'grammy';
import { withGlobal, withOrg, type Db } from '../db/pool.js';
import { t } from '../i18n/index.js';
import { AppError } from '../core/errors.js';
import { userOrgs } from '../core/people.js';
import { applyInvitedMode, workingOrgs, type InvitedMode } from '../core/invitations.js';
import type { Task } from '../core/types.js';

// Поиск сущностей по короткому id среди организаций человека — под withOrg (RLS не обойти иначе).
// Спека telegram-bot: «задача ищется по short_id среди организаций пользователя под withOrg».

export interface LinkedPerson { userId: string; chatId: number; blockedAt: Date | null; language: string; timezone: string; country: string | null }

export async function findByTelegramId(telegramUserId: number): Promise<LinkedPerson | null> {
  return withGlobal(async (db) => {
    const r = await db.query(
      `select tl.user_id, tl.chat_id, tl.blocked_at, u.language, u.timezone, u.country
         from telegram_links tl join users u on u.id = tl.user_id
        where tl.telegram_user_id = $1`,
      [telegramUserId],
    );
    if (!r.rowCount) return null;
    const row = r.rows[0];
    // node-pg возвращает bigint строкой — Telegram API ждёт число.
    return { userId: row.user_id, chatId: Number(row.chat_id), blockedAt: row.blocked_at, language: row.language, timezone: row.timezone, country: row.country };
  });
}

/**
 * Организации, в которые человек вошёл, — единственный список, по которому работает бот (спека
 * multi-company). Приглашение, которое не приняли, сюда не попадает: иначе в боте видны
 * дела чужой компании и по ним можно отвечать, а в приложении та же кнопка отвечает 404.
 * Роль тоже здесь — она нужна, например, для «кто может ставить задачи».
 */
export const orgsOf = (userId: string): ReturnType<typeof userOrgs> =>
  withGlobal((db) => userOrgs(db, userId, { includeInvited: false }));

/**
 * Организации, чьи дела бот показывает: действующие и те, куда человека позвали живым приглашением
 *. Что действие по делу такой компании делает с приглашением — решает само действие
 * (`actInOrg`). Пульт владельца (агенты, лента, предложения) берёт только действующие — `orgsOf`:
 * распоряжаться компанией до входа в неё нечем.
 */
export const taskOrgsOf = (userId: string): ReturnType<typeof workingOrgs> => workingOrgs(userId);

/** `orgStatus: 'invited'` — дело компании, куда человека лишь позвали. Поиск ничего не принимает. */
export interface OrgTask { orgId: string; orgName: string; orgKind: string; orgStatus: string; task: Task }

export async function findTaskByShortId(userId: string, shortId: string): Promise<OrgTask | null> {
  const orgs = await taskOrgsOf(userId);
  for (const o of orgs) {
    // Видеть карточку может только причастный: исполнитель, постановщик, тот, кто проверяет ожидание,
    // и проверяющий результата (спека task-reviewer).
    // Одного членства в организации мало — short_id последовательный, его можно перебрать (ревью безопасности).
    const found = await withOrg(o.id, (db) => db.query(
      `select * from tasks where short_id = $1
          and (assignee_user_id = $2 or author_user_id = $2 or waiting->>'check_user_id' = $2::text or reviewer_user_id = $2)`,
      [shortId, userId],
    ), { actorUserId: userId });
    if (found.rowCount) return { orgId: o.id, orgName: o.name, orgKind: o.kind, orgStatus: o.status, task: found.rows[0] as Task };
  }
  return null;
}

/**
 * Транзакция действия по делу. Для действующей компании — обычный `inOrg`. Для
 * компании, куда позвали: действие работы принимает приглашение в этой же транзакции (упало
 * действие — не принято), отказ отклоняет приглашение, прочее до входа недоступно (`forbidden`).
 */
export function actInOrg<T>(
  found: { orgId: string; orgStatus: string }, userId: string, mode: InvitedMode, fn: (db: Db) => Promise<T>,
): Promise<T> {
  return withOrg(found.orgId, async (db) => {
    await applyInvitedMode(db, { id: found.orgId, status: found.orgStatus }, userId, mode);
    return fn(db);
  }, { actorUserId: userId });
}

/**
 * Отказ правила приглашённого — словами человеку: дело исчезло (приглашение отозвали или оно
 * истекло) или сначала нужно войти, взяв дело. `false` — ошибка не отсюда, её разбирает вызывающий.
 */
export async function replyInvitedRefusal(ctx: Context, lang: string, e: unknown): Promise<boolean> {
  if (!(e instanceof AppError)) return false;
  const details = (e.details ?? {}) as { invitation_gone?: boolean; invite_first?: boolean };
  if (e.code === 'not_found' && details.invitation_gone) { await ctx.reply(t(lang, 'start.task_not_found')); return true; }
  if (e.code === 'forbidden' && details.invite_first) { await ctx.reply(t(lang, 'invite.act_first')); return true; }
  return false;
}

export interface OrgProposal { orgId: string; row: Record<string, unknown> }

export async function findProposalByShortId(userId: string, shortId: string): Promise<OrgProposal | null> {
  const orgs = await orgsOf(userId);
  for (const o of orgs) {
    const found = await withOrg(o.id, (db) => db.query(
      `select p.* from proposals p join agents a on a.id = p.agent_id
        where p.short_id = $1 and (a.owner_user_id = $2 or exists (
          select 1 from memberships m where m.org_id = p.org_id and m.user_id = $2 and m.status = 'active' and m.role in ('owner','admin')))`,
      [shortId, userId],
    ));
    if (found.rowCount) return { orgId: o.id, row: found.rows[0] };
  }
  return null;
}

export interface OrgVetoable { orgId: string; row: Record<string, unknown> }

export async function findVetoableByShortId(userId: string, shortId: string): Promise<OrgVetoable | null> {
  const orgs = await orgsOf(userId);
  for (const o of orgs) {
    const found = await withOrg(o.id, (db) => db.query(
      `select v.* from vetoable_changes v join agents a on a.id = v.agent_id where v.short_id = $1 and a.owner_user_id = $2`,
      [shortId, userId],
    ));
    if (found.rowCount) return { orgId: o.id, row: found.rows[0] };
  }
  return null;
}

/**
 * Транзакция организации от имени человека бота: `actorUserId` открывает ему его закрытые проекты
 * (спека projects). Бот всегда действует за конкретного человека — без него дела закрытого проекта
 * не видны даже их хозяину.
 */
export const inOrg = <T>(orgId: string, userId: string, fn: (db: Db) => Promise<T>): Promise<T> =>
  withOrg(orgId, fn, { actorUserId: userId });

/**
 * Привязать Telegram к человеку через вход по почте (спека telegram-bot, «Вход»). Тот же
 * Telegram-аккаунт у другого человека → отказ без слияния. Смена Telegram — старая привязка
 * этого человека (если была под другим telegram_user_id) снимается.
 */
export async function linkTelegramByLogin(userId: string, telegramUserId: number, chatId: number): Promise<void> {
  await withGlobal(async (db) => {
    const conflict = await db.query('select user_id from telegram_links where telegram_user_id = $1', [telegramUserId]);
    if (conflict.rowCount && conflict.rows[0].user_id !== userId) {
      throw new AppError('conflict', 'This Telegram account is already linked to another person');
    }
    await db.query('delete from telegram_links where user_id = $1 and telegram_user_id <> $2', [userId, telegramUserId]);
    await db.query(
      `insert into telegram_links(telegram_user_id, user_id, chat_id) values ($1, $2, $3)
       on conflict (telegram_user_id) do update set user_id = excluded.user_id, chat_id = excluded.chat_id, blocked_at = null`,
      [telegramUserId, userId, chatId],
    );
  });
}
