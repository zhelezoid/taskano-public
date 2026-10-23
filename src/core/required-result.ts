import type { Db } from '../db/pool.js';
import { AppError } from './errors.js';
import type { Task } from './types.js';

// Замок обязательного результата (спека required-result). Правило «Завершить» сдаёт
// всегда осталось у дел без `expected_result.required`; здесь — те, где автор поставил замок явно.
// Правило одно на все пути сдачи (ядро, коннектор, бот, приложение): расходиться им нельзя.

/**
 * Порог текстового результата. «Готово», «сделал», «ok» не проходят, «Позвонил, договорились на 25-е»
 * проходит. Не оценка содержания — только отсев пустых отписок; по существу судит проверяющий.
 */
export const RESULT_MIN_LENGTH = 15;

export interface SubmittedResult { text?: string; number?: number; files?: unknown[] }

/** Дело, у которого сдача закрыта замком. Ожидание результата не просит: его не сдают, оно «наступило». */
export function requiresResult(task: Pick<Task, 'kind' | 'expected_result'>): boolean {
  return task.kind === 'action' && Boolean(task.expected_result?.required);
}

/**
 * Невидимые знаки формата (нулевой ширины, BOM и т.п.): ими можно набрать «текст» из пустоты и пройти
 * порог длины. Перед любой проверкой текста результата их выбрасываем.
 */
const INVISIBLE = /\p{Cf}/gu;
const cleaned = (s: string): string => s.replace(INVISIBLE, '').trim();

/** Текст результата засчитывается: после очистки не короче порога и в нём есть буква или цифра («...............» — нет). */
function textOk(text: string | undefined): boolean {
  const c = cleaned(text ?? '');
  return c.length >= RESULT_MIN_LENGTH && /[\p{L}\p{N}]/u.test(c);
}

/**
 * Число, записанное целиком: «42», «-3,5», «3.14159». Разделитель один. Ровно три цифры после него
 * («1.500», «1,000») — тысячи или дробь? — не угадываем, а просим написать без разделителей тысяч;
 * 1–2 или 4 и больше цифр — десятичная дробь. Слова вокруг числа — уже текст.
 */
const NUMBER_TEXT = /^-?\d+(?:[.,](?:\d{1,2}|\d{4,}))?$/;
/** Число с разделителями (тысяч или несколько сразу): отказ с подсказкой, а не молчаливое «не число». */
const NUMBER_LIKE = /^-?\d+(?:[\s.,'’\u00a0\u202f]\d+)+$/;

type NumberHint = 'number_format';
interface NumberRead { value: number | null; hint?: NumberHint }

function numberOf(result: SubmittedResult): NumberRead {
  if (typeof result.number === 'number' && Number.isFinite(result.number)) return { value: result.number };
  if (result.text === undefined) return { value: null };
  const s = cleaned(result.text);
  if (NUMBER_TEXT.test(s)) {
    // 400 девяток читаются как Infinity: в базу бесконечность не кладём.
    const n = Number(s.replace(',', '.'));
    return Number.isFinite(n) ? { value: n } : { value: null };
  }
  return { value: null, ...(NUMBER_LIKE.test(s) ? { hint: 'number_format' as const } : {}) };
}

/** Есть ли у дела вложение, приложенное исполнителем: фото из бота, приложения или его сообщение в группе. */
async function assigneeAttached(db: Db, task: Task): Promise<boolean> {
  // Автор фото из группы — автор сообщения группы: в самой строке вложения его нет. Чужое фото на
  // деле (постановщик приложил пример) результатом исполнителя не считается.
  const r = await db.query(
    `select 1 from task_attachments a left join group_messages m on m.id = a.message_id
      where a.task_id = $1 and coalesce(a.author_user_id, m.author_user_id) = $2 limit 1`,
    [task.id, task.assignee_user_id],
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * Пускает сдачу или отказывает `result_required`. Возвращает результат, который надо записать: у
 * числового дела число, пришедшее текстом, записывается и числом — читать его будут как число.
 */
export async function assertRequiredResult(db: Db, task: Task, result: SubmittedResult | undefined): Promise<SubmittedResult | undefined> {
  if (!requiresResult(task)) return result;
  const type = task.expected_result!.type;
  const r = result ?? {};
  let ok: boolean;
  let saved = result;
  let hint: NumberHint | undefined;
  if (type === 'text') {
    ok = textOk(r.text);
  } else if (type === 'number') {
    const n = numberOf(r);
    ok = n.value !== null;
    hint = n.hint;
    if (n.value !== null && r.number === undefined) saved = { ...r, number: n.value };
  } else if (type === 'file') {
    // Файл в приложении не загрузить (только фото), поэтому его закрывает и текст: где файл или ссылка.
    ok = (r.files?.length ?? 0) > 0 || textOk(r.text) || await assigneeAttached(db, task);
  } else {
    ok = (r.files?.length ?? 0) > 0 || await assigneeAttached(db, task);
  }
  if (ok) return saved;
  throw new AppError(
    'validation_failed',
    `This task cannot be handed in without a result: ${EXPECTED[type]}${hint ? ` — ${HINTS[hint]}` : ''}`,
    { reason: 'result_required', type, min_length: RESULT_MIN_LENGTH, ...(hint ? { hint } : {}) },
  );
}

const HINTS: Record<NumberHint, string> = {
  number_format: 'write the number without thousands separators (for example 1500 or 3.5)',
};

const EXPECTED: Record<NonNullable<Task['expected_result']>['type'], string> = {
  text: `pass "result" — what was done, at least ${RESULT_MIN_LENGTH} characters`,
  number: 'pass "number" (or "result" with just the number)',
  photo: 'attach a photo to the task in the bot or the app, then hand it in again',
  file: `pass "result" — where the file is or a link (at least ${RESULT_MIN_LENGTH} characters) — or attach a photo to the task in the bot or the app, then hand it in again`,
};
