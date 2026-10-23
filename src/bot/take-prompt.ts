import type { Db } from '../db/pool.js';
import { localDate, localParts, loadUserSchedule, nextWorkingStart, zonedToUtc, type Schedule } from '../core/calendar.js';
import { notify } from '../core/notify.js';
import { isPersonalPlace } from '../core/personal-place.js';
import type { Task } from '../core/types.js';
import type { TakeLaterCode } from './callbacks.js';

// «Берёшь сейчас?» (спека auto-start, часть 2): человек открыл в боте неначатое дело и не начал —
// через минуту один вопрос с «Взять» и «Позже». Здесь — когда спрашивать и на какое время звать
// «позже»; кнопки — keyboards.ts, нажатия — task-actions.ts, пропуск при доставке — notif-text.ts.

/** Через сколько после показа карточки спросить: за минуту человек успевает нажать «Взять» сам. */
export const TAKE_PROMPT_DELAY_MS = 60_000;

/** Статусы, в которых дело можно взять и оно ещё не в работе. */
export const TAKE_ASK_STATUSES: readonly string[] = ['ready', 'active', 'rework'];

/**
 * Бот показал карточку — поставить вопрос через минуту, если смотрит исполнитель, дело есть смысл
 * брать и человек не работает над другим. Не чаще раза на дело в день: ключ — по локальной дате исполнителя, пятое открытие за день
 * второго вопроса не даёт. Зовётся в транзакции организации дела.
 */
export async function askTakeLater(db: Db, task: Task, viewerUserId: string, now: Date = new Date()): Promise<void> {
  if (task.assignee_user_id !== viewerUserId || task.kind !== 'action' || !TAKE_ASK_STATUSES.includes(task.status)) return;
  // У личного дела нет очереди и «Взять» — спрашивать не о чем.
  const personal = await isPersonalPlace(db, {
    projectId: task.project_id, assigneeUserId: task.assignee_user_id, authorUserId: task.author_user_id, authorAgentId: task.author_agent_id,
  });
  if (personal) return;
  if (await workingOnAnother(db, viewerUserId, task.id)) return;
  const { tz } = await loadUserSchedule(db, viewerUserId);
  await notify(db, {
    userId: viewerUserId, kind: 'take_prompt', level: 'work', taskId: task.id, createdAt: now,
    deliverAfter: new Date(now.getTime() + TAKE_PROMPT_DELAY_MS),
    dedupeKey: `take_prompt:${task.id}:${localDate(now, tz)}`,
  });
}

/**
 * Стоит ли ещё звать браться (вопрос и напоминание при доставке): дело на том же человеке, его
 * можно взять, его не начали с тех пор, как уведомление поставлено, и человек не взял другое. Начатое раньше и потом
 * остановленное — снова в очереди, и позвать к нему честно.
 */
export async function takeStillOpen(db: Db, taskId: string, recipientUserId: string, createdAt: Date): Promise<boolean> {
  const r = await db.query('select status, kind, assignee_user_id, started_at from tasks where id = $1', [taskId]);
  const row = r.rows[0] as Pick<Task, 'status' | 'kind' | 'assignee_user_id' | 'started_at'> | undefined;
  if (!row || row.kind !== 'action' || row.assignee_user_id !== recipientUserId || !TAKE_ASK_STATUSES.includes(row.status)) return false;
  if (row.started_at && new Date(row.started_at) >= new Date(createdAt)) return false;
  return !(await workingOnAnother(db, recipientUserId, taskId));
}

/**
 * Человек уже работает над другим делом (взял его, любая компания): не дёргаем его вопросом «берёшь
 * это?» — решение главной сессии к спеке auto-start. «Сейчас», которое очередь только предложила
 * (`active`), работой не считается. Через функцию слота: RLS чужих компаний отсюда не покажет.
 */
async function workingOnAnother(db: Db, userId: string, taskId: string): Promise<boolean> {
  const r = await db.query(`select 1 from person_slot_holders($1) where id <> $2 and status = 'in_progress' limit 1`, [userId, taskId]);
  return (r.rowCount ?? 0) > 0;
}

export interface LaterChoice { code: TakeLaterCode; at: Date }

/** Когда позвать по варианту «Позже» от момента `from`: в рабочем окне человека, вне его — с начала следующего. */
export function laterAt(s: Schedule, code: TakeLaterCode, from: Date): Date {
  if (code === 'tm') {
    const p = localParts(from, s.tz);
    return nextWorkingStart(s, zonedToUtc(p.year, p.month, p.day + 1, 0, 0, s.tz));
  }
  return nextWorkingStart(s, new Date(from.getTime() + (code === 'h1' ? 1 : 3) * 60 * 60_000));
}

/**
 * Варианты «Позже» от момента `from` в рабочем графике человека: через час, через три и утро
 * следующего рабочего дня. Время вне рабочего окна переносится на начало следующего — кнопка
 * показывает итоговое. Совпавшие схлопываются: «Завтра утром» остаётся, оно понятнее «к 09:00».
 */
export function laterChoices(s: Schedule, from: Date): LaterChoice[] {
  const [h1, h3, tm] = (['h1', 'h3', 'tm'] as const).map((code) => laterAt(s, code, from)) as [Date, Date, Date];
  const out: LaterChoice[] = [];
  if (h1.getTime() !== tm.getTime()) out.push({ code: 'h1', at: h1 });
  if (h3.getTime() !== tm.getTime() && h3.getTime() !== h1.getTime()) out.push({ code: 'h3', at: h3 });
  out.push({ code: 'tm', at: tm });
  return out;
}

/** Время «HH:MM» в поясе человека — так оно на кнопке и в «Хорошо, напомню в …». */
export function clockTime(at: Date, tz: string): string {
  const p = localParts(at, tz);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}
