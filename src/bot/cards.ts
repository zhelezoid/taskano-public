import type { Db } from '../db/pool.js';
import type { Task } from '../core/types.js';
import { t } from '../i18n/index.js';
import { translateField } from '../ai/translate.js';
import { clip } from './html.js';

// Текст карточки задачи и списков — спека telegram-bot, «Карточка задачи», «Список».

export interface CardText { text: string; translated: boolean }

const RESULT_LIMIT = 500;

type ResultType = 'text' | 'number' | 'file' | 'photo';

const ATTACH_KEY: Record<ResultType, string> = {
  text: 'card.attach_text', number: 'card.attach_number', file: 'card.attach_file', photo: 'card.attach_photo',
};

/** «Что приложить» — из expected_result, только если результат обязателен. */
function attachLine(lang: string, task: Task): string | null {
  if (!task.expected_result?.required) return null;
  return t(lang, ATTACH_KEY[task.expected_result.type]);
}

/**
 * «Связи» карточки, кроме плана (тот идёт через opts.planLabel — держит порядок карточки не завися
 * от db): предыдущий результат и внешняя ссылка из task.links (свободный список без общей схемы —
 * элементы распознаются по полю type), внешняя ссылка из task.external, контакт — из task.waiting
 * (спека telegram-bot, «Карточка задачи»: «связи (план, предыдущий результат, внешняя ссылка,
 * контакт)»).
 */
function linkLines(lang: string, task: Task): string[] {
  const lines: string[] = [];
  for (const raw of task.links ?? []) {
    if (!raw || typeof raw !== 'object') continue;
    const link = raw as Record<string, unknown>;
    if (link.type === 'previous_result' && typeof link.text === 'string' && link.text) {
      lines.push(t(lang, 'card.link_previous_result', { text: link.text }));
    } else if (typeof link.url === 'string' && link.url) {
      lines.push(t(lang, 'card.link_external', { url: link.url }));
    }
  }
  const external = task.external as Record<string, unknown> | null;
  if (external && typeof external === 'object' && typeof external.url === 'string' && external.url) {
    lines.push(t(lang, 'card.link_external', { url: external.url }));
  }
  if (task.waiting?.contact) lines.push(t(lang, 'card.link_contact', { text: task.waiting.contact }));
  return lines;
}

/** Источник дела в карточке (спека task-context): у внешнего — заголовок и статус из слепка,
 *  чтобы человек без доступа к той системе всё равно понимал суть. */
export interface CardSource { kind: string; title: string; url: string | null; status: string | null; quote: string | null }

export async function loadCardSources(db: Db, taskId: string): Promise<CardSource[]> {
  const r = await db.query(
    `select kind, title, url, snapshot->>'status' as status, quote from task_sources where task_id = $1 order by created_at, id`,
    [taskId],
  );
  return r.rows as CardSource[];
}

/** Блок «Материалы»: названия источников со ссылками, число фото и строка «Основание: …» с цитатой. */
function sourceLines(lang: string, sources: CardSource[], groupPhotos: number): string[] {
  const named = sources.filter((s) => s.title?.trim() || s.url);
  if (!named.length && !groupPhotos) return [];
  const lines = [t(lang, 'card.sources')];
  for (const s of named) lines.push(`— ${[s.title?.trim(), s.status, s.url].filter(Boolean).join(' — ')}`);
  if (groupPhotos) lines.push(t(lang, 'card.group_photos', { count: groupPhotos }));
  const basis = sources.find((s) => s.quote?.trim());
  if (basis) lines.push(t(lang, 'card.source_basis', { text: basis.quote!.trim() }));
  return lines;
}

async function trField(db: Db, task: Task, field: 'title' | 'description' | 'why' | 'done_criteria', text: string, sourceLang: string, targetLang: string): Promise<{ text: string; translated: boolean }> {
  if (!text.trim()) return { text: '', translated: false };
  if (sourceLang === targetLang) return { text, translated: false };
  const r = await translateField(db, { objectType: 'task', objectId: task.id, field, text, sourceLang, targetLang });
  return { text: r.text, translated: r.translated };
}

export async function authorLabel(db: Db, task: Task, lang: string): Promise<string> {
  if (task.author_agent_id) {
    const a = await db.query(
      `select ag.name as agent_name, u.display_name as owner_name from agents ag join users u on u.id = ag.owner_user_id where ag.id = $1`,
      [task.author_agent_id],
    );
    const row = a.rows[0];
    return t(lang, 'card.author_agent', { agent: row?.agent_name ?? '?', owner: row?.owner_name ?? '?' });
  }
  const u = await db.query('select display_name from users where id = $1', [task.author_user_id]);
  return t(lang, 'card.author_person', { name: u.rows[0]?.display_name ?? '?' });
}

/**
 * Строки «Делает» и «Проверяет» (спека task-reviewer): все стороны дела видят друг друга. «Делает» —
 * когда это не сам поставивший: в своём деле «Поставил: Олег · Делает: Олег» ничего не сообщает.
 */
async function peopleLines(db: Db, task: Task, lang: string): Promise<string[]> {
  const ids = [task.assignee_user_id, task.reviewer_user_id].filter((x): x is string => !!x);
  const r = await db.query('select id, display_name from users where id = any($1::uuid[])', [ids]);
  const name = (id: string) => (r.rows.find((u) => u.id === id)?.display_name as string | undefined) ?? '?';
  const lines: string[] = [];
  if (task.author_agent_id || task.author_user_id !== task.assignee_user_id) {
    lines.push(t(lang, 'card.assignee', { name: name(task.assignee_user_id) }));
  }
  if (task.reviewer_user_id) lines.push(t(lang, 'card.reviewer', { name: name(task.reviewer_user_id) }));
  return lines;
}

/**
 * Что сдано (спека task-reviewer): последний результат — текст, число, сколько файлов. Принимающий
 * решает по нему, а постановщик и исполнитель видят, о чём решение. Слова человека не переводим,
 * как и предыдущий результат в связях.
 */
async function resultLine(db: Db, task: Task, lang: string): Promise<string | null> {
  if (!['submitted', 'done'].includes(task.status)) return null;
  const r = await db.query(
    `select text, number, coalesce(jsonb_array_length(files), 0)::int as files from task_results
      where task_id = $1 order by created_at desc limit 1`, [task.id]);
  const row = r.rows[0] as { text: string | null; number: string | number | null; files: number } | undefined;
  if (!row) return null;
  // Длинный текст результата вытолкнул бы карточку за предел Telegram (4096): целиком он — в деле.
  const parts = [row.text?.trim() ? clip(row.text.trim(), RESULT_LIMIT) : null, row.number != null ? String(row.number) : null,
    row.files ? t(lang, 'card.result_files', { count: row.files }) : null].filter(Boolean);
  return parts.length ? t(lang, 'card.result', { text: parts.join(' · ') }) : null;
}

/**
 * Дело переехало между пространствами (спека task-routing) — строка для истории карточки:
 * «Перенесено из личного» / «Перенесено в личное». Направление берётся из события `task_moved`:
 * `orgs` вне слоя организации, поэтому вид пространства виден и после переезда.
 */
export async function movedLineKey(db: Db, taskId: string): Promise<string | null> {
  const r = await db.query(
    `select f.kind as from_kind, o.kind as to_kind
       from events e
       join orgs f on f.id = (e.data->>'from_org')::uuid
       join orgs o on o.id = (e.data->>'to_org')::uuid
      where e.task_id = $1 and e.type = 'task_moved'
      order by e.id desc limit 1`,
    [taskId],
  );
  const row = r.rows[0];
  if (!row) return null;
  if (row.to_kind === 'personal') return 'moved.to_personal';
  return row.from_kind === 'personal' ? 'moved.from_personal' : null;
}

/** Сколько фото у дела: из рабочих групп и прикреплённых людьми (спеки group-intake, task-photos). */
export async function groupPhotoCount(db: Db, taskId: string): Promise<number> {
  const r = await db.query('select count(*)::int as n from task_attachments where task_id = $1', [taskId]);
  return r.rows[0].n as number;
}

/** Текст карточки на языке человека; переводит title/description/why/done_criteria по отдельности. */
export async function renderCardText(
  db: Db, task: Task, lang: string,
  opts: {
    sourceLang: string; companyLabel?: string | null; planLabel?: string | null; projectLabel?: string | null;
    groupPhotos?: number; sources?: CardSource[];
  },
): Promise<CardText> {
  let translatedAny = false;
  const tr = async (field: 'title' | 'description' | 'why' | 'done_criteria', text: string) => {
    const r = await trField(db, task, field, text, opts.sourceLang, lang);
    if (r.translated) translatedAny = true;
    return r.text;
  };
  const title = await tr('title', task.title);
  const description = await tr('description', task.description);
  const why = await tr('why', task.why);
  const doneCriteria = await tr('done_criteria', task.done_criteria);

  const attach = attachLine(lang, task);

  const lines = [title || task.title];
  // Объяснение идёт с подписью: теперь это не «пара слов сверху», а инструкция для того, кто не
  // читал разговор постановщика (спека task-context).
  if (description) lines.push(t(lang, 'card.how', { text: description }));
  if (why) lines.push(t(lang, 'card.why', { text: why }));
  if (doneCriteria) lines.push(t(lang, 'card.done_criteria', { text: doneCriteria }));
  if (attach) lines.push(attach);
  if (task.due_date) lines.push(t(lang, 'card.due', { date: task.due_date }));
  // Компания — только когда их у человека больше одной (спека multi-company): иначе
  // «Разное · B2-001» из двух компаний подписаны одинаково и различить их неоткуда.
  if (opts.companyLabel) lines.push(t(lang, 'card.company', { text: opts.companyLabel }));
  // Проект — папка по теме, в которой лежит дело (спека projects); план — шаги агента к цели.
  if (opts.projectLabel) lines.push(t(lang, 'card.project', { text: opts.projectLabel }));
  if (opts.planLabel) lines.push(t(lang, 'card.plan', { text: opts.planLabel }));
  for (const link of linkLines(lang, task)) lines.push(link);
  for (const line of sourceLines(lang, opts.sources ?? [], opts.groupPhotos ?? 0)) lines.push(line);
  lines.push(t(lang, 'card.author', { text: await authorLabel(db, task, lang) }));
  for (const line of await peopleLines(db, task, lang)) lines.push(line);
  const result = await resultLine(db, task, lang);
  if (result) lines.push(result);
  if (translatedAny) lines.push(t(lang, 'card.translated'));
  return { text: lines.join('\n'), translated: translatedAny };
}

/** Оригинал — без перевода, ровно как записано. */
export function renderOriginalText(lang: string, task: Task): string {
  const attach = attachLine(lang, task);

  const lines = [task.title];
  if (task.description) lines.push(t(lang, 'card.how', { text: task.description }));
  if (task.why) lines.push(t(lang, 'card.why', { text: task.why }));
  if (task.done_criteria) lines.push(t(lang, 'card.done_criteria', { text: task.done_criteria }));
  if (attach) lines.push(attach);
  if (task.due_date) lines.push(t(lang, 'card.due', { date: task.due_date }));
  for (const link of linkLines(lang, task)) lines.push(link);
  return lines.join('\n');
}

export function overdueTitle(lang: string, task: Task, today: string): string {
  const overdue = !!task.due_date && task.due_date < today;
  return overdue ? `${t(lang, 'list.overdue_mark')} — ${task.title}` : task.title;
}
