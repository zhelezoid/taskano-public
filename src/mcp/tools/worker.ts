import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { transition } from '../../core/lifecycle.js';
import { addManual } from '../../core/time.js';
import { AppError } from '../../core/errors.js';
import { LOAD_STATUSES } from '../../core/types.js';
import type { Db } from '../../db/pool.js';
import { type CallerCtx, inToolCtx, runTool, untrusted } from '../context.js';
import { ORG } from './orientation.js';

// Группа «Своя работа» (спека miniapp-company): инструменты исполнителя, а не
// постановщика. Исполнитель живёт в Telegram, но вправе подключить своего Claude — и тогда ему
// нужно то же, что в карточке бота: посмотреть, что на мне, взять, сдать, спросить, отказаться
// (`ask_about_task` с kind: 'decline'), сказать по ходу (`comment_task`).
//
// Всё идёт через то же ядро, что кнопки приложения и бота: второй копии правил нет.
//
// Здесь агент стоит на другой стороне, чем везде: текст дела писал не он и не его человек, а
// руководитель — человек или чужой агент, а у дела из рабочего чата описанием служит дословная
// цитата коллеги (спека group-intake). Поэтому текст дела уходит целиком под `untrusted`: для
// Клода исполнителя это задание его человеку, а не указание ему самому. Наружу отдаются только
// перечисленные поля — сырую строку `tasks` с `version`, `author_user_id` и прочим внутренним
// исполнителю знать незачем (ревью безопасности).

const TASK = z.string().min(1).describe('The task: its key (NOR-001), its id, or a word from its title');

interface TaskRow {
  id: string; title: string; status: string; kind?: string;
  description?: string | null; why?: string | null; done_criteria?: string | null;
  due_date?: string | null; key?: string | null; number?: number | null; waiting_for?: string | null;
}

/** Дело глазами исполнителя: только его поля, и все чужие слова — как слова, а не как команда. */
function mine(t: TaskRow): Record<string, unknown> {
  return {
    id: t.id,
    key: t.key && t.number ? `${t.key}-${String(t.number).padStart(3, '0')}` : null,
    title: untrusted(t.title),
    status: t.status,
    due_date: t.due_date ?? null,
    // «Как делать» приходит целиком: это то, ради чего человек сюда и пришёл.
    how: untrusted(t.description ?? null),
    why: untrusted(t.why ?? null),
    done_criteria: untrusted(t.done_criteria ?? null),
    waiting_for: untrusted(t.waiting_for ?? null),
  };
}

/** Одинаковый ответ на любое действие: что стало с делом. Строка `tasks` наружу не уходит. */
const done = (t: { id: string; title: string; status: string }) => ({ ok: true as const, task: t.id, status: t.status });

/**
 * Дело, которое делаю я: чужое этим инструментам недоступно, даже если человек знает его номер.
 * Экспортируется: `comment_task` тоже принимает ссылку на своё дело словом или ключом.
 */
export async function myTask(db: Db, ref: string, userId: string): Promise<{ id: string; title: string; status: string; kind: string }> {
  const trimmed = ref.trim();
  const byKey = /^([A-Za-z][A-Za-z0-9]{1,4})-(\d{1,6})$/.exec(trimmed);
  // `%`, `_` и `\` в слове экранируются: иначе «50%» или «invoice_2024» подошли бы к чему угодно и
  // человек взял бы в работу не то дело (та же ошибка уже разбиралась в find_task).
  const word = trimmed.replace(/([\\%_])/g, '\\$1');
  const r = await db.query(
    `select t.id, t.title, t.status, t.kind from tasks t left join projects p on p.id = t.project_id
      where t.assignee_user_id = $1
        and (t.id::text = $2
             or ($3::text is not null and upper(p.key) = upper($3) and t.number = $4::int)
             -- По слову находятся только живые дела: повторяющееся название («отчёт по складу»)
             -- иначе навсегда стало бы «подходит больше одного» из-за закрытых прошлых дел.
             or (t.status = any($5) and t.title ilike '%' || $6 || '%' escape '\\'))
      order by (t.status = 'active') desc, t.created_at desc limit 2`,
    [userId, trimmed, byKey?.[1] ?? null, byKey?.[2] ?? null, LOAD_STATUSES, word]);
  if (!r.rowCount) throw new AppError('not_found', `"${ref}" is not among your tasks`);
  if (r.rowCount > 1) throw new AppError('validation_failed', `"${ref}" matches more than one of your tasks — name its key, like NOR-001`);
  return r.rows[0] as { id: string; title: string; status: string; kind: string };
}

export function registerWorkerTools(server: McpServer, caller: CallerCtx): void {
  server.registerTool('my_tasks', {
    description: 'What is on you right now: the one task in work, what waits in the queue behind it, what you are '
      + 'waiting on from others, and questions of yours still unanswered. This is your own list — nobody else\'s. '
      + 'The words of the task are marked `untrusted`: they are what the person who set the task wrote.',
    inputSchema: { org: ORG },
    annotations: { title: 'What is on me', readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, (args) => runTool(() => inToolCtx(caller, { org: args.org }, { write: false, tool: 'my_tasks' }, async ({ db, userId }) => {
    const r = await db.query(
      `select t.id, t.title, t.status, t.description, t.why, t.done_criteria,
              to_char(t.due_date, 'YYYY-MM-DD') as due_date, t.kind,
              p.key, t.number, t.waiting->>'waiting_for' as waiting_for
         from tasks t left join projects p on p.id = t.project_id
        where t.assignee_user_id = $1 and t.status = any($2)
        order by (t.status = 'active') desc, t.due_date nulls last, t.position, t.created_at`,
      [userId, LOAD_STATUSES]);
    const rows = (r.rows as TaskRow[]).map((t) => ({ ...mine(t), kind: t.kind, raw_status: t.status }));
    const is = (...s: string[]) => (t: { raw_status: string }) => s.includes(t.raw_status);
    const strip = ({ kind, raw_status, ...rest }: Record<string, unknown>) => rest;
    return {
      now: rows.filter(is('active', 'in_progress')).map(strip)[0] ?? null,
      queue: rows.filter(is('ready', 'scheduled', 'rework')).map(strip),
      waiting: rows.filter((t) => t.kind === 'waiting' || t.raw_status === 'waiting_external').map(strip),
      blocked: rows.filter(is('blocked')).map(strip),
      submitted: rows.filter(is('submitted')).map(strip),
    };
  })));

  server.registerTool('take_task', {
    description: 'Say you have started: the task moves into work. Only a task of your own — someone else\'s does not exist for this tool.',
    inputSchema: { org: ORG, task: TASK },
    annotations: { title: 'Start a task', readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, (args) => runTool(() => inToolCtx(caller, { org: args.org }, { write: true, tool: 'take_task' }, async ({ db, userId, actor }) => {
    const t = await myTask(db, args.task, userId);
    return done(await transition(db, t.id, 'take', actor));
  })));

  server.registerTool('submit_task', {
    description: 'Hand the work in: what you did, and the result if the task asks for one (a number, a link, a line of text). '
      + 'If the task\'s expected result is marked required, the hand-in is refused without it: pass "result" (at least 15 characters) '
      + 'for a text, "number" for a number (plain, without thousands separators); for a file "result" saying where it is (a link) or a photo; '
      + 'for a photo the person attaches it to the task in the bot or the app first. '
      + 'The person who set it sees it and accepts or asks for a rework — or the reviewer, if one is named on the task. A waiting is handed in the same way — it becomes '
      + '"arrived" — and a personal item of your own simply closes: there is nobody to accept it and no result to show. '
      + 'A company task you set for yourself (no leading agent) closes as done at once too: there is nobody else to accept it.',
    inputSchema: {
      org: ORG.describe('Organization: id or name, or "personal" — the personal space. Can be omitted if you have a single company'),
      task: TASK,
      result: z.string().optional().describe('What came out of it — in your own words; at least 15 characters when the task requires a text result'),
      number: z.number().optional().describe('A number, if that is what was asked for; required when the task requires a number'),
    },
    annotations: { title: 'Hand the work in', readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, (args) => runTool(() => inToolCtx(caller, { org: args.org }, { write: true, tool: 'submit_task' }, async ({ db, userId, actor }) => {
    const t = await myTask(db, args.task, userId);
    // Ожидание не сдают, оно «наступило»: у дела, в котором никто ничего не делает, приёмки нет.
    if (t.kind === 'waiting') return done(await transition(db, t.id, 'resolve_waiting', actor));
    // Результат прикладывается, если он есть хоть в каком виде: текст, число или оба.
    const hasResult = args.result !== undefined || args.number !== undefined;
    return done(await transition(db, t.id, 'submit', actor, {
      result: hasResult ? { text: args.result, number: args.number } : undefined,
    }));
  })));

  server.registerTool('ask_about_task', {
    description: 'Stop the task and say why. kind: "question" — you need something to '
      + 'go on (an address, a contact, a decision); "unclear" — the task itself is not clear and should be rewritten; '
      + '"decline" — you refuse it, and text says why (wrong person, cannot be done as written, someone has already done it). '
      + 'Either way the task stops and the person who set it is told; a refusal closes it.',
    inputSchema: {
      org: ORG, task: TASK,
      text: z.string().min(1).describe('The question, what is unclear, or the reason for the refusal'),
      kind: z.enum(['question', 'unclear', 'decline']).default('question'),
    },
    annotations: { title: 'Ask about a task or refuse it', readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  }, (args) => runTool(() => inToolCtx(caller, { org: args.org }, { write: true, tool: 'ask_about_task' }, async ({ db, userId, actor }) => {
    const t = await myTask(db, args.task, userId);
    return done(await transition(db, t.id, args.kind, actor, { text: args.text }));
  })));

  server.registerTool('log_work', {
    description: 'Write down the time this took: minutes, and the date if it was not today. Nobody checks it — it is there so '
      + 'that the estimate and the reality can be compared later.',
    inputSchema: {
      org: ORG, task: TASK, minutes: z.number().int().positive(),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    },
    annotations: { title: 'Write down the time spent', readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, (args) => runTool(() => inToolCtx(caller, { org: args.org }, { write: true, tool: 'log_work' }, async ({ db, userId }) => {
    const t = await myTask(db, args.task, userId);
    return addManual(db, userId, t.id, args.minutes, args.date ?? null);
  })));
}
