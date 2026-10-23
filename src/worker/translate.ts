import { withOrgBackground } from '../db/pool.js';
import { countLlmCalls } from '../ai/llm.js';
import { warmTranslations, type TranslateFieldInput } from '../ai/translate.js';
import type { TranslateTaskPayload } from '../ai/translate-queue.js';
import type { Task } from '../core/types.js';
import { logger } from '../log.js';

// Фоновый перевод дела (спека translation-prefetch): поля и реплики на языки исполнителя, автора-
// человека и проверяющего — в тот же кэш `translations`, что читает карточка. К моменту, когда
// человек откроет дело, перевод уже лежит, и карточка не ждёт модель.

/** Сколько реплик показывает карточка (loadNotes): дальше этого переводить незачем. */
export const CARD_NOTES_LIMIT = 30;

/** Какие записи по делу показывает карточка. Одно условие для loadNotes и для задачи — иначе
 *  задача переводит не то, что откроет человек. Таблица запроса — под алиасом `m`. */
export const CARD_NOTES_SQL = `(m.kind in ('comment', 'owner_instruction', 'question', 'unclear', 'answer', 'rework_reason')
             or (m.kind = 'due_request' and m.text <> ''))`;

const TASK_FIELDS = ['title', 'why', 'done_criteria', 'description'] as const;

function isPayload(p: unknown): p is TranslateTaskPayload {
  const o = p as Record<string, unknown> | null;
  return !!o && typeof o.orgId === 'string' && typeof o.taskId === 'string';
}

export async function runTranslateJob(payload: unknown): Promise<void> {
  if (!isPayload(payload)) { logger.warn({ payload }, 'translate_task: некорректный payload'); return; }
  const { orgId, taskId } = payload;
  const started = Date.now();
  // Что переводить — короткой транзакцией; сам перевод — вне её (warmTranslations): ожидание модели
  // в транзакции держало блокировки кэша, и открытая в это время карточка ждала задачу.
  const plan = await withOrgBackground(orgId, async (db) => {
    const task = (await db.query('select * from tasks where id = $1', [taskId])).rows[0] as Task | undefined;
    if (!task) return null;
    // Агент-автор языка читающего не имеет; его хозяин — author_user_id — есть, и он тоже читает дело.
    const readers = [task.assignee_user_id, task.author_user_id, task.reviewer_user_id].filter((id): id is string => !!id);
    const langs = [...new Set((await db.query('select language from users where id = any($1::uuid[])', [readers]))
      .rows.map((r) => r.language as string))];
    const messages = (await db.query(
      `select m.id, m.text, m.source_language from task_messages m
        where m.task_id = $1 and ${CARD_NOTES_SQL}
        order by m.created_at desc, m.id desc limit $2`,
      [taskId, CARD_NOTES_LIMIT],
    )).rows as { id: string; text: string; source_language: string | null }[];
    return { task, langs, messages };
  });
  if (!plan) return;
  const { task, langs, messages } = plan;
  const source = task.source_language ?? 'ru';
  const inputs: TranslateFieldInput[] = [];
  for (const lang of langs) {
    for (const field of TASK_FIELDS) {
      const text = task[field];
      if (text?.trim()) inputs.push({ objectType: 'task', objectId: task.id, field, text, sourceLang: source, targetLang: lang });
    }
    // Язык реплики не распознан (короткое «ок») — переводить не из чего; карточка так же.
    for (const m of messages) {
      if (m.text.trim() && m.source_language) {
        inputs.push({ objectType: 'task_message', objectId: m.id, field: 'text', text: m.text, sourceLang: m.source_language, targetLang: lang });
      }
    }
  }
  const run = await countLlmCalls(() => warmTranslations(orgId, inputs, { background: true }));
  if (run.calls) logger.info({ task: taskId, langs, llm: run.calls, ms: Date.now() - started }, 'translate_task: перевод подготовлен');
  // Модель не ответила — бросаем: graphile повторит задачу (maxAttempts), и повтор переведёт только
  // недостающее — готовое уже в кэше.
  if (run.result.failed) throw new Error(`translate_task: не переведено ${run.result.failed}`);
}
