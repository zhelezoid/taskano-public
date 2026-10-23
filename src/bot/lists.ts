import type { Context } from 'grammy';
import { InlineKeyboard } from 'grammy';
import { localDate, loadUserSchedule } from '../core/calendar.js';
import type { Task } from '../core/types.js';
import { t } from '../i18n/index.js';
import { transition } from '../core/lifecycle.js';
import { nextCheckAfter, setCheckDate } from '../core/tasks.js';
import { actInOrg, findByTelegramId, findTaskByShortId, inOrg, orgsOf, replyInvitedRefusal, taskOrgsOf } from './lookup.js';
import { editToConfirm, sendCard } from './card-view.js';
import { personalItemKeyboard, waitingItemKeyboard } from './keyboards.js';
import { overdueTitle } from './cards.js';
import { encodeShow, type WaitAction } from './callbacks.js';
import { askTakeLater } from './take-prompt.js';

// «Сейчас» / «Список» / «Ожидания» / «Личное» — спека telegram-bot.

async function personLang(telegramUserId: number): Promise<{ userId: string; lang: string } | null> {
  const p = await findByTelegramId(telegramUserId);
  return p ? { userId: p.userId, lang: p.language } : null;
}

function rowLine(lang: string, task: Task, today: string): string {
  return `${overdueTitle(lang, task, today)}${task.due_date ? ` — ${task.due_date}` : ''}`;
}

function rowButtonLabel(lang: string, task: Task, today: string): string {
  const label = overdueTitle(lang, task, today);
  return label.length > 60 ? `${label.slice(0, 57)}…` : label;
}

function buildListKeyboard(lang: string, groups: Task[][], today: string): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const group of groups) for (const task of group) kb.text(rowButtonLabel(lang, task, today), encodeShow(task.short_id)).row();
  return kb;
}

export async function handleNowCommand(ctx: Context): Promise<void> {
  const from = ctx.from;
  if (!from) return;
  const person = await personLang(from.id);
  if (!person) { await ctx.reply(t(from.language_code ?? 'en', 'start.unknown')); return; }
  const orgs = await taskOrgsOf(person.userId);
  let any = false;
  for (const org of orgs) {
    await inOrg(org.id, person.userId, async (db) => {
      const r = await db.query(
        `select * from tasks where assignee_user_id = $1 and kind = 'action' and status in ('active','in_progress') order by status_changed_at desc limit 1`,
        [person.userId],
      );
      if (r.rowCount) {
        any = true;
        const task = r.rows[0] as Task;
        await sendCard(ctx, db, task, person.lang, { sourceLang: task.source_language ?? 'ru', personal: org.kind === 'personal', viewerUserId: person.userId });
        // Дело в «Сейчас», а «Взять» не нажато — через минуту спросить (спека auto-start).
        await askTakeLater(db, task, person.userId);
      }
    });
  }
  if (!any) await ctx.reply(t(person.lang, 'list.empty'));
}

export async function handleListCommand(ctx: Context): Promise<void> {
  const from = ctx.from;
  if (!from) return;
  const person = await personLang(from.id);
  if (!person) { await ctx.reply(t(from.language_code ?? 'en', 'start.unknown')); return; }
  const orgs = await taskOrgsOf(person.userId);
  let any = false;
  for (const org of orgs) {
    if (org.kind === 'personal') continue;
    await inOrg(org.id, person.userId, async (db) => {
      const schedule = await loadUserSchedule(db, person.userId);
      const today = localDate(new Date(), schedule.tz);
      const r = await db.query(
        `select * from tasks where assignee_user_id = $1 and kind = 'action' and status in
           ('active','in_progress','ready','rework','waiting_external','submitted','blocked')
         order by status_changed_at`,
        [person.userId],
      );
      const rows = r.rows as Task[];
      if (!rows.length) return;
      any = true;
      const now = rows.filter((x) => x.status === 'active' || x.status === 'in_progress');
      const queue = rows.filter((x) => ['ready', 'rework', 'blocked'].includes(x.status));
      const waiting = rows.filter((x) => x.status === 'waiting_external');
      const submitted = rows.filter((x) => x.status === 'submitted');
      const lines = [t(person.lang, 'list.header', { org: org.name })];
      for (const [label, group] of [
        [t(person.lang, 'list.now'), now], [t(person.lang, 'list.queue'), queue],
        [t(person.lang, 'list.waiting_external'), waiting], [t(person.lang, 'list.submitted'), submitted],
      ] as const) {
        if (!group.length) continue;
        lines.push(`\n${label}:`);
        for (const task of group) lines.push(rowLine(person.lang, task, today));
      }
      await ctx.reply(lines.join('\n'), { reply_markup: buildListKeyboard(person.lang, [now, queue, waiting, submitted], today) });
    });
  }
  if (!any) await ctx.reply(t(person.lang, 'list.empty'));
}

export async function handleWaitingCommand(ctx: Context): Promise<void> {
  const from = ctx.from;
  if (!from) return;
  const person = await personLang(from.id);
  if (!person) { await ctx.reply(t(from.language_code ?? 'en', 'start.unknown')); return; }
  const orgs = await taskOrgsOf(person.userId);
  let any = false;
  for (const org of orgs) {
    await inOrg(org.id, person.userId, async (db) => {
      const r = await db.query(
        `select * from tasks where kind = 'waiting' and status = 'waiting' and (waiting->>'check_user_id') = $1 order by (waiting->>'next_check_at')`,
        [person.userId],
      );
      for (const row of r.rows as Task[]) {
        any = true;
        const since = new Date(row.created_at).toISOString().slice(0, 10);
        await ctx.reply(t(person.lang, 'waiting.item', { title: row.title, since }), { reply_markup: waitingItemKeyboard(person.lang, row.short_id) });
      }
    });
  }
  if (!any) await ctx.reply(t(person.lang, 'waiting.empty'));
}

export async function handleWaitAction(ctx: Context, action: WaitAction, shortId: string): Promise<void> {
  const from = ctx.from;
  if (!from) return;
  const person = await personLang(from.id);
  if (!person) { await ctx.answerCallbackQuery(); return; }
  const found = await findTaskByShortId(person.userId, shortId);
  if (!found) { await ctx.answerCallbackQuery(); return; }
  const { task } = found;
  if (task.waiting?.check_user_id !== person.userId) { await ctx.answerCallbackQuery(); return; }
  const actor = { kind: 'user' as const, userId: person.userId };

  // Отметки ожидания — не вход в компанию: до принятия приглашения недоступны.
  try {
    await actInOrg(found, person.userId, 'other', async (db) => {
    switch (action) {
      case 'nochange': {
        const expected = task.waiting?.expected_at ? new Date(task.waiting.expected_at) : null;
        await setCheckDate(db, task.id, nextCheckAfter(new Date(), expected), actor);
        await editToConfirm(ctx, undefined, undefined, t(person.lang, 'waiting.no_change_done'));
        break;
      }
      case 'arrived': {
        await transition(db, task.id, 'resolve_waiting', actor);
        await editToConfirm(ctx, undefined, undefined, t(person.lang, 'waiting.arrived_done'));
        break;
      }
      case 'push1':
      case 'push3':
      case 'push1w': {
        const ms = { push1: 86400000, push3: 3 * 86400000, push1w: 7 * 86400000 }[action];
        const at = new Date(Date.now() + ms);
        await setCheckDate(db, task.id, at, actor);
        await editToConfirm(ctx, undefined, undefined, t(person.lang, 'waiting.postponed', { date: at.toISOString().slice(0, 10) }));
        break;
      }
      case 'stop': {
        await transition(db, task.id, 'cancel', actor);
        await editToConfirm(ctx, undefined, undefined, t(person.lang, 'waiting.stopped'));
        break;
      }
      default:
        break;
    }
    });
  } catch (e) {
    if (!(await replyInvitedRefusal(ctx, person.lang, e))) throw e;
  }
  await ctx.answerCallbackQuery();
}

export async function handlePersonalCommand(ctx: Context): Promise<void> {
  const from = ctx.from;
  if (!from) return;
  const person = await personLang(from.id);
  if (!person) { await ctx.reply(t(from.language_code ?? 'en', 'start.unknown')); return; }
  const orgs = await orgsOf(person.userId);
  const personalOrg = orgs.find((o) => o.kind === 'personal');
  if (!personalOrg) { await ctx.reply(t(person.lang, 'personal.empty')); return; }
  await inOrg(personalOrg.id, person.userId, async (db) => {
    const r = await db.query(
      `select * from tasks where assignee_user_id = $1 and kind = 'action' and status = 'ready' order by due_date nulls last, created_at`,
      [person.userId],
    );
    if (!r.rowCount) { await ctx.reply(t(person.lang, 'personal.empty')); return; }
    for (const row of r.rows as Task[]) {
      const line = `${row.title}${row.due_date ? ` — ${t(person.lang, 'personal.due', { date: row.due_date })}` : ''}`;
      await ctx.reply(line, { reply_markup: personalItemKeyboard(person.lang, row.short_id, row.version) });
    }
  });
}

/** Показать карточку задачи по её short_id — используется и кнопкой строки списка, и deep link'ом `/start t_<id>`. */
async function renderTaskCard(ctx: Context, telegramUserId: number, shortId: string): Promise<boolean> {
  const person = await personLang(telegramUserId);
  if (!person) return false;
  const found = await findTaskByShortId(person.userId, shortId);
  if (!found) { await ctx.reply(t(person.lang, 'start.task_not_found')); return false; }
  await inOrg(found.orgId, person.userId, async (db) => {
    await sendCard(ctx, db, found.task, person.lang, {
      sourceLang: found.task.source_language ?? 'ru', personal: found.orgKind === 'personal', viewerUserId: person.userId,
    });
    // Открыл своё неначатое дело — через минуту «Берёшь сейчас?», если сам не взял (спека auto-start).
    await askTakeLater(db, found.task, person.userId);
  });
  return true;
}

export async function handleShowCallback(ctx: Context, shortId: string): Promise<void> {
  const from = ctx.from;
  if (from) await renderTaskCard(ctx, from.id, shortId);
  await ctx.answerCallbackQuery();
}

export async function handleTaskDeepLink(ctx: Context, shortId: string): Promise<void> {
  const from = ctx.from;
  if (!from) return;
  await renderTaskCard(ctx, from.id, shortId);
}
