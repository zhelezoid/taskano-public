import type { Db } from '../db/pool.js';
import { enqueueTaskTranslation } from '../ai/translate-queue.js';
import { AppError } from './errors.js';
import { emit } from './events.js';
import { notify } from './notify.js';
import { messageLanguage } from './message-language.js';
import { isPersonalPlace } from './personal-place.js';
import { fillSlot, startsByAction } from './queue.js';
import { assertRequiredResult } from './required-result.js';
import { ensureTaskTimer, stopTaskTimer } from './time.js';
import { answerDueRequests } from './due.js';
import type { Actor, Task, TaskStatus } from './types.js';
import { actorAgentId, actorUserId } from './types.js';
import { addWorkingMinutes, loadUserSchedule, nextWorkingStart, zonedToUtc } from './calendar.js';

// Единственное место смены статуса задачи (спека step-lifecycle-and-queue).

export type Action =
  | 'release' | 'schedule_activate' | 'activate' | 'take' | 'submit' | 'accept' | 'rework'
  | 'question' | 'unclear' | 'answer' | 'wait_external' | 'external_back' | 'decline' | 'cancel'
  | 'postpone' | 'deactivate' | 'resolve_waiting' | 'auto_accept' | 'reopen' | 'close';

const OPEN: TaskStatus[] = ['draft', 'scheduled', 'ready', 'active', 'in_progress', 'blocked', 'waiting_external', 'submitted', 'rework'];

const RULES: Record<Action, { from: TaskStatus[]; to: TaskStatus | null }> = {
  release: { from: ['draft'], to: 'ready' },
  schedule_activate: { from: ['scheduled'], to: 'ready' },
  activate: { from: ['ready', 'rework'], to: 'active' },   // rework возвращается в «Сейчас» через очередь
  take: { from: ['active', 'ready', 'rework'], to: 'in_progress' },
  submit: { from: ['ready', 'active', 'in_progress', 'rework'], to: 'submitted' },
  accept: { from: ['submitted'], to: 'done' },
  auto_accept: { from: ['submitted'], to: 'done' },
  rework: { from: ['submitted'], to: 'rework' },
  question: { from: ['active', 'in_progress', 'rework', 'ready'], to: 'blocked' },
  unclear: { from: ['active', 'in_progress', 'rework', 'ready'], to: 'blocked' },
  answer: { from: ['blocked'], to: null },            // → in_progress или ready (решает слот)
  wait_external: { from: ['active', 'in_progress', 'rework'], to: 'waiting_external' },
  external_back: { from: ['waiting_external'], to: 'ready' },
  decline: { from: OPEN.filter((s) => s !== 'draft'), to: 'declined' },
  cancel: { from: [...OPEN, 'waiting'], to: 'cancelled' },
  postpone: { from: ['ready', 'active', 'in_progress', 'rework', 'scheduled'], to: 'scheduled' },
  deactivate: { from: ['active', 'in_progress'], to: 'ready' },
  resolve_waiting: { from: ['waiting'], to: 'resolved' },
  // Закрыл по ошибке — вернул (спека completed-list). Возвращается в `ready`, а не в тот статус, что был
  // до закрытия: слот «Сейчас» распределяет очередь, а не история. Отменённые дела сюда не относятся —
  // отмена это решение, а не промах пальцем.
  reopen: { from: ['done'], to: 'ready' },
  // Закрыть без сдачи: работа сделана, а кнопку исполнитель не нажал — постановщик
  // закрывает дело сам, с доказательством. Из сданного — обычная приёмка, отсюда не ходят.
  close: { from: ['scheduled', 'ready', 'active', 'in_progress', 'blocked', 'waiting_external', 'rework'], to: 'done' },
};

const EVENT_TYPE: Record<Action, string> = {
  release: 'task_released', schedule_activate: 'task_ready', activate: 'task_activated', take: 'task_taken',
  submit: 'task_submitted', accept: 'task_accepted', auto_accept: 'auto_accepted', rework: 'task_rework',
  question: 'question', unclear: 'unclear', answer: 'answered', wait_external: 'waiting_external',
  external_back: 'external_back', decline: 'declined', cancel: 'cancelled', postpone: 'postponed',
  deactivate: 'person_switched', resolve_waiting: 'waiting_resolved', reopen: 'task_reopened',
  // Закрытое без сдачи — сделано так же, как принятое: «Итоги» и сводка агента считают по приёмке.
  close: 'task_accepted',
};

export interface TransitionExtra {
  text?: string;                                   // вопрос, причина, ответ
  result?: { text?: string; number?: number; files?: unknown[] };
  postponeTo?: string;                              // 'YYYY-MM-DD' локальная дата исполнителя
  waitingFor?: string;
  checkAt?: Date;
  expectedVersion?: number;
  now?: Date;
  skipFill?: boolean;                               // вызывающий сам управляет слотом (queue)
  /** Взятие без кнопки — первым действием исполнителя (спека auto-start): в событие `task_taken` как `auto`. */
  autoStart?: 'comment' | 'attachment';
}

export async function loadTaskForUpdate(db: Db, taskId: string): Promise<Task> {
  const r = await db.query('select * from tasks where id = $1 for update', [taskId]);
  if (!r.rowCount) throw new AppError('not_found', 'Task not found');
  return r.rows[0] as Task;
}

/** То, чем человек занят: ровно поля, по которым видно, держит ли дело слот «Сейчас». */
export type SlotHolder = Pick<Task, 'id' | 'org_id' | 'status' | 'blocked_at' | 'assignee_user_id'>;

/** Держит ли задача слот «Сейчас» (спека: active/in_progress, либо blocked ≤ 1 рабочего часа). */
export async function holdsSlot(db: Db, task: SlotHolder, now: Date): Promise<boolean> {
  if (task.status === 'active' || task.status === 'in_progress') return true;
  if (task.status !== 'blocked' || !task.blocked_at) return false;
  const schedule = await loadUserSchedule(db, task.assignee_user_id);
  return addWorkingMinutes(schedule, new Date(task.blocked_at), 60) > now;
}

/**
 * Правило полноты (спека task-context): шаг не выпускают, пока карточка не отвечает на три вопроса —
 * что сделать, зачем и как понять, что готово. Человек, получивший шаг, исходного разговора не видел.
 * Дела, заведённые до миграции 006, правилом не связаны (`requires_context = false`) — задним числом
 * старые карточки не переписываем.
 */
export function assertStepContext(task: Task): void {
  if (!task.requires_context) return;
  const missing: string[] = [];
  if (!task.why?.trim()) missing.push('why');
  if (!task.done_criteria?.trim()) missing.push('done_criteria');
  if (!missing.length) return;
  throw new AppError(
    'validation_failed',
    `The step cannot be released — empty: ${missing.join(', ')}. The person who gets it has not seen the conversation `
    + 'it came from: the card must answer three questions — what to do, why, and how to tell it is done. Fill them in with update_task.',
    { missing },
  );
}

/**
 * Разрешён ли переход из этого статуса. Единственный способ узнать это снаружи ядра: список
 * допустимых действий у карточки (спека miniapp-task-actions) обязан приходить
 * отсюда, иначе таблица переходов размножается по вёрстке и расходится с сервером.
 */
export function canTransition(status: TaskStatus, action: Action): boolean {
  return RULES[action].from.includes(status);
}

/**
 * Переходы, которых нет в личном пространстве: «Взять», вопрос и «Непонятно» — разговор с ведущим
 * агентом, а личное дело человек ведёт сам; отказ уводит дело в `declined`, откуда его не вернуть
 * (`reopen` только из `done`), — своё дело не отклоняют, а удаляют или откладывают. Правило живёт
 * здесь, а не в вёрстке: бот держался на наборе кнопок, приложение — на своей проверке в ручке,
 * а коннектор и старая карточка проходили мимо обоих.
 *
 * Только старое личное пространство (`kind='personal'`), а не всё личное по `isPersonalPlace`: своё
 * дело на своей закрытой доске в компании берут в работу, и слот «Сейчас» у него общий с работой
 * (спека multi-company).
 */
const NOT_FOR_PERSONAL: readonly Action[] = ['take', 'question', 'unclear', 'decline'];

export function assertPersonalAllows(personalSpace: boolean, action: Action): void {
  if (personalSpace && NOT_FOR_PERSONAL.includes(action)) {
    throw new AppError('validation_failed', `"${action}" is for work led by an agent — a personal item is yours to do, postpone or delete`);
  }
}

/** Идёт ли транзакция в старом личном пространстве человека. */
export async function inPersonalSpace(db: Db): Promise<boolean> {
  const r = await db.query(`select kind from orgs where id = current_setting('app.org_id')::uuid`);
  return r.rows[0]?.kind === 'personal';
}

/** Действие исполнителя над делом — кнопка карточки в боте и в приложении. */
export type PersonAction = 'take' | 'stop' | 'done' | 'postpone' | 'question' | 'unclear' | 'wait' | 'decline';

/** Порядок — тот же, что в вёрстке карточек. */
const PERSON_ACTIONS: readonly PersonAction[] = ['take', 'stop', 'done', 'postpone', 'question', 'unclear', 'wait', 'decline'];

function personActionCore(task: Pick<Task, 'kind'>, action: PersonAction): Action {
  switch (action) {
    // «Остановить» — `deactivate`: дело возвращается в очередь, слот освобождается.
    case 'stop': return 'deactivate';
    // Ожидание закрывается как ожидание, всё остальное «Завершить» сдаёт.
    case 'done': return task.kind === 'waiting' ? 'resolve_waiting' : 'submit';
    case 'wait': return 'wait_external';
    default: return action;
  }
}

/**
 * Кнопки исполнителя для дела в этом статусе (спека miniapp-task-actions) — общие для
 * бота и приложения. Таблицу переходов поверхности не копируют: копия в боте однажды уже разошлась
 * с ядром, и кнопка вела в отказ. Поверхность может только сузить набор (свою вёрстку, свои не-цели),
 * но не расширить.
 */
export function personActions(task: Pick<Task, 'status' | 'kind'>, personalSpace: boolean): PersonAction[] {
  return PERSON_ACTIONS.filter((action) => {
    // «Остановить» — пара к «Взять», и предлагается только взятому делу. Ядро разрешает `deactivate`
    // и у `active`, но дело, которое очередь лишь предложила, человек не брал — останавливать нечего.
    if (action === 'stop' && task.status !== 'in_progress') return false;
    const core = personActionCore(task, action);
    if (personalSpace && NOT_FOR_PERSONAL.includes(core)) return false;
    return canTransition(task.status, core);
  });
}

/** Дело, которое человек поставил сам себе и которое не ведёт агент. */
function selfAuthored(task: Task): boolean {
  return !task.author_agent_id && !!task.author_user_id && task.author_user_id === task.assignee_user_id;
}

export async function transition(db: Db, taskId: string, action: Action, actor: Actor, extra: TransitionExtra = {}): Promise<Task> {
  const now = extra.now ?? new Date();
  const task = await loadTaskForUpdate(db, taskId);
  if (extra.expectedVersion !== undefined && extra.expectedVersion !== task.version) {
    throw new AppError('stale_version', 'The card is out of date', { version: task.version });
  }
  const rule = RULES[action];
  if (!rule.from.includes(task.status)) {
    throw new AppError('invalid_transition', `"${action}" is not allowed from status ${task.status}`, { status: task.status });
  }

  const personal = await isPersonalPlace(db, {
    projectId: task.project_id, assigneeUserId: task.assignee_user_id,
    authorUserId: task.author_user_id, authorAgentId: task.author_agent_id,
  });
  // Личное пространство — частный случай личного: второй запрос только тогда, когда он что-то решает.
  if (personal && NOT_FOR_PERSONAL.includes(action)) assertPersonalAllows(await inPersonalSpace(db), action);
  let to: TaskStatus = rule.to ?? task.status;
  const sets: string[] = [];
  const params: unknown[] = [];
  const set = (col: string, val: unknown) => { params.push(val); sets.push(`${col} = $${params.length}`); };

  switch (action) {
    // Возврат дела из завершённых (спека completed-list). Вывод человека из организации закрытые дела
    // не трогает — расчёт на то, что завершённое останется завершённым. Вернуть такое дело значит
    // повесить его на того, кого в организации больше нет: оно не видно ни ему, ни автору, ни админу,
    // и пропадает молча. Поэтому проверяем членство исполнителя.
    case 'reopen': {
      const m = await db.query(
        `select 1 from memberships where org_id = current_setting('app.org_id')::uuid and user_id = $1 and status = 'active'`,
        [task.assignee_user_id],
      );
      if (!m.rowCount) {
        throw new AppError('conflict', 'The person this task was assigned to has left the organization — reassign it instead of reopening');
      }
      break;
    }
    // Выпуск шага — точка, где карточка уходит человеку: здесь и проверяем полноту. Отложенный выпуск
    // (scheduled → ready) проверяем тоже: между постановкой и сроком поля могли опустошить.
    case 'release':
    case 'schedule_activate':
      if (!personal) assertStepContext(task);
      break;
    case 'submit': {
      // «Завершить» сдаёт всегда, где бы его ни нажали: затребованный результат — просьба,
      // а не замок. Замок отправлял человека из приложения в бот «прислать результат», он не понимал,
      // жал «Остановить», и дело неделю не сдавалось (Мария, 30.09–06.10). Исключение — дело, где автор
      // поставил `required` явно: замок вернулся (спека required-result), но результат человек
      // прикладывает там же, где нажал «Завершить», а не в другом месте. Нет результата у обычного дела —
      // проверяющий видит это при приёмке и спрашивает.
      const result = await assertRequiredResult(db, task, extra.result);
      if (result) {
        await db.query(
          `insert into task_results(org_id, task_id, user_id, text, number, files)
           values (current_setting('app.org_id')::uuid, $1, $2, $3, $4, $5)`,
          [task.id, actorUserId(actor) ?? task.assignee_user_id, result.text ?? null, result.number ?? null, JSON.stringify(result.files ?? [])],
        );
      }
      // Своё дело (поставил себе сам, без ведущего агента) принимать некому: сдал — значит сделано
      // (спека skill-roles). Иначе оно навсегда оставалось «сдано» и не попадало в «Итоги».
      // С проверяющим принимать есть кому, даже когда дело своё (спека task-reviewer).
      if (!task.reviewer_user_id && (personal || selfAuthored(task))) to = 'done';
      set('submitted_at', now);
      // Сдали, не нажав «Взять», — дело всё-таки было начато (спека auto-start): иначе время цикла и
      // «Итоги» считают ноль. В работу перед сдачей не переводим и учёт не запускаем — отрезок был бы
      // нулевым. Событие — раньше сдачи: сначала начато, потом сдано.
      if (!personal && startsByAction(task, actor)) {
        set('started_at', now);
        set('started_via', 'submit');
        await emit(db, { type: 'task_auto_started', taskId: task.id, actorUserId: actorUserId(actor), data: { cause: 'submit', switched: false }, at: now });
      }
      break;
    }
    case 'take':
      // `started_at` — первое взятие: по нему считается время цикла дела. `taken_at` — последнее:
      // от него идёт таймер в приложении, и после остановки счёт начинается заново (миграция 019).
      if (!task.started_at) set('started_at', now);
      set('taken_at', now);
      set('acked_at', now);
      break;
    case 'question':
    case 'unclear':
      // Вопрос по задаче из очереди (не «Сейчас») слот не занимает: иначе у человека два «Сейчас» (ревью ядра).
      if (task.status === 'ready' || task.status === 'rework') {
        to = task.status;
      } else {
        set('blocked_at', now);
      }
      set('acked_at', now);
      await addMessage(db, task.id, actor, action, extra.text ?? '', now);
      break;
    case 'answer': {
      await addMessage(db, task.id, actor, 'answer', extra.text ?? '', now);
      await db.query(`update task_messages set answered_at = $2 where task_id = $1 and kind in ('question','unclear') and answered_at is null`, [task.id, now]);
      to = (await holdsSlot(db, task, now)) ? 'in_progress' : 'ready';
      set('blocked_at', null);
      break;
    }
    case 'rework':
      await addMessage(db, task.id, actor, 'rework_reason', extra.text ?? '', now);
      break;
    case 'close':
      if (!extra.text?.trim()) throw new AppError('validation_failed', 'Say what shows the work is done — the person reads it with the closed task');
      await addMessage(db, task.id, actor, 'close_reason', extra.text, now);
      break;
    case 'decline':
      if (!extra.text?.trim()) throw new AppError('validation_failed', 'A reason for declining is required');
      await addMessage(db, task.id, actor, 'decline_reason', extra.text, now);
      break;
    case 'wait_external': {
      if (!extra.waitingFor?.trim() || !extra.checkAt) throw new AppError('validation_failed', 'Required: who we are waiting for and when to check');
      set('waiting', { waiting_for: extra.waitingFor, expected_at: null, next_check_at: extra.checkAt.toISOString(), check_user_id: task.assignee_user_id, on_arrival: null, contact: null });
      set('acked_at', now);
      break;
    }
    case 'postpone': {
      if (!extra.postponeTo || !/^\d{4}-\d{2}-\d{2}$/.test(extra.postponeTo)) throw new AppError('validation_failed', 'A new date is required');
      const schedule = await loadUserSchedule(db, task.assignee_user_id);
      const [y, m, d] = extra.postponeTo.split('-').map(Number) as [number, number, number];
      const [sh, sm] = schedule.start.split(':').map(Number) as [number, number];
      const activateAt = nextWorkingStart(schedule, zonedToUtc(y, m, d, sh, sm, schedule.tz));
      set('due_date', extra.postponeTo);
      set('due_tz', schedule.tz);
      set('activate_at', activateAt);
      set('acked_at', now);
      set('reminded_count', 0);
      if (activateAt <= now) to = 'ready';
      // Перенос исполнителем называет новый срок — это ответ на просьбу назвать срок (спека
      // self-set-due): в боте другого способа поставить дату у человека нет.
      if (actorUserId(actor) === task.assignee_user_id && actor.kind === 'user') await answerDueRequests(db, task.id, now);
      break;
    }
    case 'external_back':
      set('waiting', null);
      break;
    default:
      break;
  }

  // Дело уходит из работы — отрезок закончился, прибавляем его к общему времени (миграция 020).
  // Без этого таймер после каждой остановки начинал считать с нуля, и время первых подходов
  // пропадало с экрана, хотя человек его потратил.
  if (task.status === 'in_progress' && to !== 'in_progress' && task.taken_at) {
    const seconds = Math.max(0, Math.round((now.getTime() - new Date(task.taken_at).getTime()) / 1000));
    set('worked_seconds', (task.worked_seconds ?? 0) + seconds);
  }

  // Учёт времени ведёт сама смена статуса, а не кнопка: «Взять» и «Остановить» есть в боте, в
  // приложении и в коннекторе, и отчёты (`time_report`, «Итоги») считали нули, пока учёт пополнял
  // лишь таймер «Старт» бота (спека time-tracking, «Взять» ведёт учёт времени).
  if (task.assignee_user_id && task.status !== 'in_progress' && to === 'in_progress') {
    await ensureTaskTimer(db, task.assignee_user_id, task.id, now);
  } else if (task.assignee_user_id && task.status === 'in_progress' && to !== 'in_progress') {
    await stopTaskTimer(db, task.assignee_user_id, task.id, now);
  }

  set('status', to);
  set('status_changed_at', now);
  set('updated_at', now);
  params.push(task.id);
  const updated = (await db.query(
    `update tasks set ${sets.join(', ')}, version = version + 1 where id = $${params.length} returning *`,
    params,
  )).rows[0] as Task;

  await emit(db, {
    // Личное дело закрывается сдачей, приёмки у него нет — но «сделано» считается по событию
    // приёмки (spec stats-page). Без этой поправки закрытое личное дело навсегда оставалось бы
    // в «Итогах» сданным и не сделанным: события приёмки для него не будет уже никогда.
    type: action === 'submit' && to === 'done' ? EVENT_TYPE.accept : EVENT_TYPE[action],
    taskId: task.id,
    actorUserId: actorUserId(actor),
    actorAgentId: actorAgentId(actor),
    data: { from: task.status, to, ...(action === 'submit' && to === 'done' && !personal ? { self: true } : {}), ...(action === 'close' ? { closed_by_author: true } : {}), ...(extra.text ? { text: extra.text } : {}), ...(extra.postponeTo ? { postpone_to: extra.postponeTo } : {}), ...(action === 'take' && extra.autoStart ? { auto: extra.autoStart } : {}) },
    // Тем же временем, что и сама смена статуса: иначе событие о переходе оказывается новее её
    // на десятки миллисекунд, и «с тех пор ничего не двигалось» никогда не выполняется.
    at: now,
  });
  await sideEffects(db, action, task, updated, actor, now);

  // Слот мог освободиться или появиться кандидат — пусть очередь решит.
  if (!personal && updated.kind === 'action' && !extra.skipFill) await fillSlot(db, updated.assignee_user_id, now);
  return (await db.query('select * from tasks where id = $1', [task.id])).rows[0] as Task;
}

/** Есть ли у дела вопрос/«Непонятно» без ответа. */
export async function hasOpenQuestion(db: Db, taskId: string): Promise<boolean> {
  const r = await db.query(
    `select 1 from task_messages where task_id = $1 and kind in ('question','unclear') and answered_at is null limit 1`, [taskId]);
  return (r.rowCount ?? 0) > 0;
}

/**
 * Ответ на вопрос/«Непонятно» — из бота («Ответить») и из коннектора (`answer_question`). Вопрос по
 * делу из очереди (`ready`/`rework`) статуса не меняет (см. `question` выше), поэтому и ответ на него
 * статуса не меняет: переход `answer` остаётся только для `blocked`. Иначе такой вопрос нечем было
 * закрыть — бот падал на недопустимом переходе, коннектор писал комментарий, — и `answered_at` не
 * ставился никогда, а таймер вопроса без ответа (worker/timers.ts) эскалировал бы отвеченное.
 */
export async function answerQuestion(db: Db, taskId: string, actor: Actor, text: string, now: Date = new Date()): Promise<Task> {
  const task = await loadTaskForUpdate(db, taskId);
  if (task.status === 'blocked') return transition(db, taskId, 'answer', actor, { text, now });
  if (!(await hasOpenQuestion(db, taskId))) {
    throw new AppError('invalid_transition', `There is no open question on this task (status ${task.status})`, { status: task.status });
  }
  await addMessage(db, task.id, actor, 'answer', text, now);
  await db.query(`update task_messages set answered_at = $2 where task_id = $1 and kind in ('question','unclear') and answered_at is null`, [task.id, now]);
  await emit(db, {
    type: EVENT_TYPE.answer, taskId: task.id, actorUserId: actorUserId(actor), actorAgentId: actorAgentId(actor),
    data: { from: task.status, to: task.status, text }, at: now,
  });
  await sideEffects(db, 'answer', task, task, actor, now);
  return task;
}

/**
 * Реплика по делу. Время — то же, что у самого перехода: окна «что произошло с прошлого раза»
 * считаются по переданному времени, и реплика, записанная временем базы, из окна выпадает.
 */
async function addMessage(db: Db, taskId: string, actor: Actor, kind: string, text: string, at?: Date): Promise<void> {
  // Язык запоминаем при записи: получатель может читать на другом, и переводить задним числом было
  // бы уже нечего — распознать язык по переведённому тексту нельзя (спека translation-and-email).
  await db.query(
    `insert into task_messages(org_id, task_id, author_user_id, author_agent_id, kind, text, source_language, created_at)
     values (current_setting('app.org_id')::uuid, $1, $2, $3, $4, $5, $6, coalesce($7, now()))`,
    [taskId, actor.kind === 'user' ? actor.userId : null, actorAgentId(actor), kind, text,
      await messageLanguage(db, text, actor.kind === 'user' ? actor.userId : null), at ?? null],
  );
  // Перевод реплики для остальных участников дела готовится фоном (спека translation-prefetch) — для
  // видов, которые показывает карточка; причины закрытия и отказа она не показывает.
  if (!['close_reason', 'decline_reason'].includes(kind)) await enqueueTaskTranslation(db, taskId);
}

const NOW_REPEAT_HOURS = 12;
// События, после которых возврат дела в «Сейчас» новостью не становится: его гоняет по слоту сам
// человек («Остановить», «Взял» другое дело) и очередь. Всё прочее — доработка, ответ, перенос,
// правка дела — меняет дело, и о возврате снова стоит сказать.
// Автоначало (спека auto-start) — то же «Взял», только без кнопки.
const SLOT_SHUFFLE_EVENTS = ['task_activated', 'task_taken', 'task_auto_started', 'person_switched', 'comment', 'timer_started', 'timer_stopped', 'time_manual_added'];

/**
 * Сказать ли «Сейчас: …» ещё раз (спека bot-messages, «Дубли»). 22.09 одно дело пришло пять раз за
 * час: человек нажимал «Остановить» или брал другое дело, дело уходило в очередь, и следующий тик
 * ставило его обратно первым — каждый раз с новой версией и, значит, новым ключом `now:id:version`.
 * О деле, которое человек сам только что отложил, он знает. Предел — одно `task_now` на дело человеку
 * за 12 часов, если с прошлого раза дело не менялось ничем, кроме перестановок в слоте.
 */
async function shouldAnnounceNow(db: Db, task: Task, now: Date): Promise<boolean> {
  const last = await db.query(
    `select created_at from notifications
      where user_id = $1 and task_id = $2 and kind = 'task_now'
        and created_at > $3::timestamptz - make_interval(hours => $4) and created_at <= $3::timestamptz
      order by created_at desc limit 1`,
    [task.assignee_user_id, task.id, now, NOW_REPEAT_HOURS],
  );
  if (!last.rowCount) return true;
  const changed = await db.query(
    `select 1 from events where task_id = $1 and at > $2 and at <= $3 and type <> all($4::text[]) limit 1`,
    [task.id, last.rows[0].created_at, now, SLOT_SHUFFLE_EVENTS],
  );
  return (changed.rowCount ?? 0) > 0;
}

/** Кому и что сообщить. Задача от агента — агент узнаёт из ленты; задача от человека — человеку. */
async function sideEffects(db: Db, action: Action, before: Task, task: Task, actor: Actor, now: Date): Promise<void> {
  const humanAuthor = !task.author_agent_id;
  const byAssignee = actorUserId(actor) === task.assignee_user_id;
  switch (action) {
    case 'activate':
      if (await shouldAnnounceNow(db, task, now)) {
        // Время — то же, что у перехода: по нему следующий раз считается окно в 12 часов.
        await notify(db, {
          userId: task.assignee_user_id, kind: 'task_now', level: 'work', taskId: task.id, dedupeKey: `now:${task.id}:${task.version}`, createdAt: now,
        });
      }
      break;
    case 'submit':
      // С проверяющим сданное идёт ему, а постановщику — только итог (спека task-reviewer).
      if (task.reviewer_user_id) {
        if (task.status === 'submitted') await notify(db, { userId: task.reviewer_user_id, kind: 'task_submitted', level: 'work', taskId: task.id });
      } else if (humanAuthor && task.status === 'submitted' && task.author_user_id !== task.assignee_user_id) {
        await notify(db, { userId: task.author_user_id, kind: 'task_submitted', level: 'work', taskId: task.id });
      }
      break;
    case 'question':
    case 'unclear':
      // И по делу от агента тоже: `author_user_id` там — хозяин агента, то есть человек, который
      // и отвечает. Раньше уведомление слали только при авторе-человеке, а основной путь продукта —
      // дело через коннектор: исполнитель задавал вопрос, и первым о нём узнавал хозяин через
      // четыре рабочих часа эскалацией «вопрос без ответа». Таймер остаётся эскалацией.
      if (task.author_user_id !== task.assignee_user_id) {
        await notify(db, { userId: task.author_user_id, kind: action === 'question' ? 'task_question' : 'task_unclear', level: 'work', taskId: task.id });
      }
      break;
    case 'answer':
      if (!byAssignee) await notify(db, { userId: task.assignee_user_id, kind: 'task_answer', level: 'work', taskId: task.id });
      break;
    case 'rework':
      await notify(db, { userId: task.assignee_user_id, kind: 'task_rework', level: 'work', taskId: task.id });
      if (task.reviewer_user_id && task.author_user_id !== task.assignee_user_id) {
        await notify(db, { userId: task.author_user_id, kind: 'task_returned', level: 'feed', taskId: task.id });
      }
      break;
    case 'decline':
      // Отказ — уровень «Решение» владельцу агента или автору-человеку (спека telegram-bot).
      await notify(db, { userId: task.author_user_id, kind: 'task_declined', level: 'decision', taskId: task.id });
      break;
    case 'cancel':
      if (!['draft', 'scheduled'].includes(before.status) && !byAssignee) {
        await notify(db, { userId: task.assignee_user_id, kind: 'task_cancelled', level: 'work', taskId: task.id });
      }
      break;
    case 'accept':
    case 'auto_accept':
      await notify(db, { userId: task.author_user_id, kind: 'task_done', level: 'feed', taskId: task.id });
      // Принял не тот, кто ставил, — исполнитель должен знать итог (спека task-reviewer).
      if (task.reviewer_user_id && task.author_user_id !== task.assignee_user_id) {
        await notify(db, { userId: task.assignee_user_id, kind: 'task_done', level: 'feed', taskId: task.id });
      }
      break;
    case 'close':
      // Исполнитель не нажимал «Завершить» — дело закрыли за него, и он должен знать, по чему.
      if (!byAssignee) await notify(db, { userId: task.assignee_user_id, kind: 'task_closed', level: 'work', taskId: task.id });
      // Закрыл проверяющий — постановщику итог, как при приёмке (спека task-reviewer).
      if (task.reviewer_user_id && actorUserId(actor) === task.reviewer_user_id) {
        await notify(db, { userId: task.author_user_id, kind: 'task_done', level: 'feed', taskId: task.id });
      }
      break;
    case 'reopen':
      // Симметрично «закрыл»: тот, кто поставил дело, должен знать, что сделанное снова в работе.
      // Агент узнаёт о том же событием `task_reopened` в своей сводке.
      if (humanAuthor && task.author_user_id !== task.assignee_user_id && actorUserId(actor) !== task.author_user_id) {
        await notify(db, { userId: task.author_user_id, kind: 'task_reopened', level: 'work', taskId: task.id });
      }
      break;
    default:
      break;
  }
}
