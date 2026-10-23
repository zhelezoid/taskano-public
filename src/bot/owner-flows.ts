import type { Context } from 'grammy';
import { AppError } from '../core/errors.js';
import { answerQuestion, transition } from '../core/lifecycle.js';
import { requireReviewer } from '../core/tasks.js';
import { decideProposal, rollbackVetoable } from '../core/proposals.js';
import { t } from '../i18n/index.js';
import { dialogDb, saveDialog, userKey } from './dialog.js';
import { findByTelegramId, findProposalByShortId, findTaskByShortId, findVetoableByShortId, inOrg, orgsOf } from './lookup.js';
import { notificationLine, type NotifRow } from './notif-text.js';
import { agentKeyboard, cancelOnlyKeyboard } from './keyboards.js';
import { askSeparately, editToConfirm } from './card-view.js';
import type { AgentAction, OwnerTaskAction, ProposalDecision } from './callbacks.js';

// Постановщик-человек (приёмка/вопросы) и пульт владельца — спека telegram-bot.

function cardCtx(ctx: Context): { chatId: number; messageId: number } | null {
  const chatId = ctx.chat?.id ?? ctx.msg?.chat.id;
  const messageId = ctx.msgId;
  return chatId && messageId ? { chatId, messageId } : null;
}

export async function handleOwnerTaskCallback(ctx: Context, action: OwnerTaskAction, shortId: string): Promise<void> {
  const from = ctx.from;
  if (!from) return;
  const person = await findByTelegramId(from.id);
  if (!person) { await ctx.answerCallbackQuery(); return; }
  const found = await findTaskByShortId(person.userId, shortId);
  if (!found) { await ctx.answerCallbackQuery(); await ctx.reply(t(person.language, 'start.task_not_found')); return; }
  const { orgId, task } = found;
  // Принять и вернуть — тот, кто принимает: проверяющий, если назван, иначе автор (спека task-reviewer).
  // Отвечает на вопрос по-прежнему автор: спрашивают того, кто поставил.
  const judge = action === 'answer' ? task.author_user_id : (task.reviewer_user_id ?? task.author_user_id);
  if (judge !== person.userId) { await ctx.answerCallbackQuery(); await ctx.reply(t(person.language, 'error.not_your_task')); return; }
  const actor = { kind: 'user' as const, userId: person.userId };
  const pos = cardCtx(ctx);

  if (action === 'accept') {
    // Право — ещё раз в той же транзакции, что и приём: проверяющего могли сменить после поиска дела.
    try {
      await inOrg(orgId, person.userId, async (db) => {
        await requireReviewer(db, task.id, actor);
        return transition(db, task.id, 'accept', actor);
      });
    } catch (e) {
      if (!(e instanceof AppError) || e.code !== 'forbidden') throw e;
      await ctx.answerCallbackQuery();
      await ctx.reply(t(person.language, 'error.not_your_task'));
      return;
    }
    await editToConfirm(ctx, pos?.chatId, pos?.messageId, t(person.language, 'owner_task.accepted'));
    await ctx.answerCallbackQuery();
    return;
  }
  if (action === 'rework') {
    const ask = await askSeparately(ctx, t(person.language, 'owner_task.rework_ask'), cancelOnlyKeyboard(person.language));
    await dialogDb((db) => saveDialog(db, userKey(from.id), { state: 'await_owner_rework', data: { shortId, orgId, ...pos, ...ask } }));
    await ctx.answerCallbackQuery();
    return;
  }
  // 'answer' — ответ на вопрос/«непонятно» по своей задаче.
  const ask = await askSeparately(ctx, t(person.language, 'owner_task.answer_ask'), cancelOnlyKeyboard(person.language));
  await dialogDb((db) => saveDialog(db, userKey(from.id), { state: 'await_owner_answer', data: { shortId, orgId, ...pos, ...ask } }));
  await ctx.answerCallbackQuery();
}

export async function handleOwnerReworkText(ctx: Context, dialogData: Record<string, unknown>, text: string): Promise<void> {
  const from = ctx.from!;
  const person = await findByTelegramId(from.id);
  if (!person) return;
  const found = await findTaskByShortId(person.userId, dialogData.shortId as string);
  await dialogDb((db) => saveDialog(db, userKey(from.id), { state: 'idle', data: {} }));
  if (!found) return;
  // Пока человек писал причину, проверяющего могли сменить: право проверяем на момент возврата.
  const actor = { kind: 'user' as const, userId: person.userId };
  try {
    await inOrg(found.orgId, person.userId, async (db) => {
      await requireReviewer(db, found.task.id, actor);
      return transition(db, found.task.id, 'rework', actor, { text });
    });
  } catch (e) {
    if (!(e instanceof AppError) || e.code !== 'forbidden') throw e;
    await ctx.reply(t(person.language, 'error.not_your_task'));
    return;
  }
  await editToConfirm(ctx, dialogData.chatId as number | undefined, dialogData.messageId as number | undefined, t(person.language, 'owner_task.reworked'), dialogData);
}

export async function handleOwnerAnswerText(ctx: Context, dialogData: Record<string, unknown>, text: string): Promise<void> {
  const from = ctx.from!;
  const person = await findByTelegramId(from.id);
  if (!person) return;
  const found = await findTaskByShortId(person.userId, dialogData.shortId as string);
  await dialogDb((db) => saveDialog(db, userKey(from.id), { state: 'idle', data: {} }));
  if (!found) return;
  // Не `transition('answer')`: вопрос по делу из очереди статуса не меняет, и переход из `ready`
  // недопустим — ответ на него закрывает вопрос, не трогая статус (core/lifecycle, answerQuestion).
  await inOrg(found.orgId, person.userId, (db) => answerQuestion(db, found.task.id, { kind: 'user', userId: person.userId }, text));
  await editToConfirm(ctx, dialogData.chatId as number | undefined, dialogData.messageId as number | undefined, t(person.language, 'owner_task.answer_sent'), dialogData);
}

/** «Понятно»/«Ещё вопрос» на ответ постановщика — приходит исполнителю новым сообщением. */
export async function handleAnswerAckCallback(ctx: Context, action: 'understood' | 'more', shortId: string, version: number): Promise<void> {
  const from = ctx.from;
  if (!from) return;
  const person = await findByTelegramId(from.id);
  if (!person) { await ctx.answerCallbackQuery(); return; }
  if (action === 'understood') {
    await editToConfirm(ctx, undefined, undefined, t(person.language, 'answer.understood'));
    await ctx.answerCallbackQuery();
    return;
  }
  const { handleTaskCallback } = await import('./task-actions.js');
  await handleTaskCallback(ctx, { action: 'q', shortId, version });
}

// ---------------------------------------------------------------- пульт владельца

export async function handleFeedCommand(ctx: Context): Promise<void> {
  const from = ctx.from;
  if (!from) return;
  const person = await findByTelegramId(from.id);
  if (!person) { await ctx.reply(t(from.language_code ?? 'en', 'start.unknown')); return; }
  const all = await orgsOf(person.userId);
  const orgs = all.filter((o) => o.role === 'owner');
  // Компанию называем, когда их у человека больше одной (спека multi-company-person, п.9): ленты двух
  // компаний приходят подряд и иначе неотличимы.
  const named = all.filter((o) => o.kind === 'company').length > 1;
  let any = false;
  for (const org of orgs) {
    await inOrg(org.id, person.userId, async (db) => {
      const r = await db.query(
        `select id, kind, level, task_id, payload, created_at from notifications
          where user_id = $1 and level = 'feed' and created_at > now() - interval '24 hours' order by created_at desc`,
        [person.userId],
      );
      if (!r.rowCount) return;
      any = true;
      const lines = [named && org.kind === 'company' ? t(person.language, 'feed.header_company', { org: org.name }) : t(person.language, 'feed.header')];
      for (const row of r.rows as NotifRow[]) {
        // Строкой простого текста: отдельное сообщение уведомления — разметка, а /feed — список.
        const text = await notificationLine(db, person.language, row, person.userId);
        if (!text) continue;
        const time = new Date(row.created_at).toISOString().slice(11, 16);
        lines.push(t(person.language, 'feed.line', { time, text }));
      }
      await ctx.reply(lines.join('\n'));
    });
  }
  if (!any) await ctx.reply(t(person.language, 'feed.empty'));
}

export async function handleAgentsCommand(ctx: Context): Promise<void> {
  const from = ctx.from;
  if (!from) return;
  const person = await findByTelegramId(from.id);
  if (!person) { await ctx.reply(t(from.language_code ?? 'en', 'start.unknown')); return; }
  const orgs = await orgsOf(person.userId);
  // Одноимённые агенты двух компаний («Операционный») без метки неразличимы (спека multi-company-person, п.9).
  const named = orgs.filter((o) => o.kind === 'company').length > 1;
  let any = false;
  for (const org of orgs) {
    await inOrg(org.id, person.userId, async (db) => {
      const r = await db.query(
        `select id, name, status from agents where owner_user_id = $1 or $2 in ('owner','admin') order by name`,
        [person.userId, org.role],
      );
      for (const row of r.rows as { id: string; name: string; status: 'active' | 'paused' }[]) {
        any = true;
        const status = t(person.language, row.status === 'paused' ? 'agents.status_paused' : 'agents.status_active');
        const line = named && org.kind === 'company'
          ? t(person.language, 'agents.line_company', { name: row.name, status, org: org.name })
          : t(person.language, 'agents.line', { name: row.name, status });
        await ctx.reply(line, { reply_markup: agentKeyboard(person.language, row.id, row.status) });
      }
    });
  }
  if (!any) await ctx.reply(t(person.language, 'agents.empty'));
}

export async function handleAgentCallback(ctx: Context, action: AgentAction, agentId: string): Promise<void> {
  const from = ctx.from;
  if (!from) return;
  const person = await findByTelegramId(from.id);
  if (!person) { await ctx.answerCallbackQuery(); return; }
  const orgs = await orgsOf(person.userId);
  for (const org of orgs) {
    const updated = await inOrg(org.id, person.userId, async (db) => {
      const a = await db.query('select owner_user_id from agents where id = $1', [agentId]);
      if (!a.rowCount) return null;
      if (a.rows[0].owner_user_id !== person.userId && !['owner', 'admin'].includes(org.role)) return null;
      const status = action === 'pause' ? 'paused' : 'active';
      const r = await db.query('update agents set status = $2 where id = $1 returning name', [agentId, status]);
      return r.rows[0]?.name as string | undefined;
    });
    if (updated !== null && updated !== undefined) {
      await ctx.editMessageText(t(person.language, action === 'pause' ? 'agents.paused' : 'agents.resumed', { name: updated }));
      await ctx.answerCallbackQuery();
      return;
    }
  }
  await ctx.answerCallbackQuery();
}

export async function handleProposalCallback(ctx: Context, decision: ProposalDecision, shortId: string): Promise<void> {
  const from = ctx.from;
  if (!from) return;
  const person = await findByTelegramId(from.id);
  if (!person) { await ctx.answerCallbackQuery(); return; }
  const found = await findProposalByShortId(person.userId, shortId);
  if (!found) { await ctx.answerCallbackQuery(); return; }
  if (decision === 'change') {
    const ask = await askSeparately(ctx, t(person.language, 'proposal.change_ask'), cancelOnlyKeyboard(person.language));
    await dialogDb((db) => saveDialog(db, userKey(from.id), { state: 'await_proposal_change', data: { shortId, orgId: found.orgId, ...cardCtx(ctx), ...ask } }));
    await ctx.answerCallbackQuery();
    return;
  }
  try {
    await inOrg(found.orgId, person.userId, (db) => decideProposal(db, found.row.id as string, decision, person.userId));
  } catch (e) {
    if (!(e instanceof AppError)) throw e;
  }
  await editToConfirm(ctx, cardCtx(ctx)?.chatId, cardCtx(ctx)?.messageId, t(person.language, decision === 'accept' ? 'proposal.decided' : 'proposal.rejected'));
  await ctx.answerCallbackQuery();
}

export async function handleProposalChangeText(ctx: Context, dialogData: Record<string, unknown>, text: string): Promise<void> {
  const from = ctx.from!;
  const person = await findByTelegramId(from.id);
  if (!person) return;
  const found = await findProposalByShortId(person.userId, dialogData.shortId as string);
  await dialogDb((db) => saveDialog(db, userKey(from.id), { state: 'idle', data: {} }));
  if (!found) return;
  await inOrg(found.orgId, person.userId, (db) => decideProposal(db, found.row.id as string, 'change', person.userId, { text }));
  await editToConfirm(ctx, dialogData.chatId as number | undefined, dialogData.messageId as number | undefined, t(person.language, 'proposal.changed'), dialogData);
}

export async function handleVetoableCallback(ctx: Context, shortId: string): Promise<void> {
  const from = ctx.from;
  if (!from) return;
  const person = await findByTelegramId(from.id);
  if (!person) { await ctx.answerCallbackQuery(); return; }
  const found = await findVetoableByShortId(person.userId, shortId);
  if (!found) { await ctx.answerCallbackQuery(); return; }
  try {
    await inOrg(found.orgId, person.userId, (db) => rollbackVetoable(db, found.row.id as string, person.userId));
    await editToConfirm(ctx, undefined, undefined, t(person.language, 'vetoable.rolled_back'));
  } catch (e) {
    if (e instanceof AppError && e.code === 'conflict') await ctx.reply(t(person.language, 'vetoable.too_late'));
    else throw e;
  }
  await ctx.answerCallbackQuery();
}
