import { withOrg, type Db } from '../db/pool.js';
import { AppError } from './errors.js';
import { emit } from './events.js';
import { assertPersonalAllows, holdsSlot, inPersonalSpace, loadTaskForUpdate, transition, type SlotHolder } from './lifecycle.js';
import { localDate, loadUserSchedule, workingMinutesBetween } from './calendar.js';
import { isPersonalPlace } from './personal-place.js';
import { logger } from '../log.js';
import type { Actor, Task } from './types.js';

// Очередь человека внутри организации: единственный, кто ставит задачу в «Сейчас»
// (спека step-lifecycle-and-queue, «Очередь: выбор следующего»).

export const PEOPLE_DIRECTION = 'people';

export interface Candidate {
  id: string;
  direction: string;                 // author_agent_id или 'people'
  priority: 'normal' | 'urgent';
  due_date: string | null;           // 'YYYY-MM-DD'
  plan_created_at: number;           // для задач без плана — created_at самой задачи
  position: number;
  created_at: number;
}

/** Чистая функция выбора — детерминирована, тестируется без базы. */
export function pickNext(
  candidates: Candidate[],
  opts: { today: string; quotas: Record<string, number>; history: Record<string, number> },
): Candidate | null {
  if (!candidates.length) return null;
  const byInner = (a: Candidate, b: Candidate) =>
    a.plan_created_at - b.plan_created_at || a.position - b.position || a.created_at - b.created_at;

  const urgent = candidates.filter((c) => c.priority === 'urgent').sort((a, b) => a.created_at - b.created_at);
  if (urgent[0]) return urgent[0];

  const due = candidates
    .filter((c) => c.due_date !== null && c.due_date <= opts.today)
    .sort((a, b) => (a.due_date! < b.due_date! ? -1 : a.due_date! > b.due_date! ? 1 : byInner(a, b)));
  if (due[0]) return due[0];

  const directions = [...new Set(candidates.map((c) => c.direction))];
  // Квоты — проценты. Направления без явной квоты делят остаток поровну; если остатка нет —
  // получают по 10, чтобы не голодать вечно (ревью ядра: задачи от людей не должны стоять).
  const explicit = Object.fromEntries(Object.entries(opts.quotas).filter(([, v]) => v > 0));
  const implicit = directions.filter((d) => !(d in explicit));
  const explicitSum = Object.values(explicit).reduce((s, v) => s + v, 0);
  const rest = explicitSum < 100 ? (100 - explicitSum) / Math.max(1, implicit.length) : 10;
  const weight = (d: string): number => (d in explicit ? explicit[d]! : explicitSum === 0 ? 1 : rest);
  const weightTotal = directions.reduce((s, d) => s + weight(d), 0) || 1;
  const share = (d: string): number => weight(d) / weightTotal;
  const histTotal = Object.values(opts.history).reduce((s, v) => s + v, 0);
  const actual = (d: string): number => (histTotal > 0 ? (opts.history[d] ?? 0) / histTotal : 0);

  directions.sort((a, b) => {
    const da = share(a) - actual(a);
    const db = share(b) - actual(b);
    if (Math.abs(da - db) > 1e-9) return db - da;
    if (share(a) !== share(b)) return share(b) - share(a);
    return a < b ? -1 : 1;
  });
  const dir = directions[0]!;
  return candidates.filter((c) => c.direction === dir).sort(byInner)[0] ?? null;
}

async function lockPerson(db: Db, userId: string): Promise<void> {
  // Сериализация на человека целиком, а не на человека внутри организации (спека multi-company):
  // иначе тик компании А и тик компании Б выдают два «Сейчас» одновременно, каждый в своей
  // транзакции и каждый уверенный, что человек свободен.
  await db.query(`select pg_advisory_xact_lock(hashtext('taskano:slot'), hashtext($1))`, [userId]);
}

/** Минуты цикла по направлениям за последние 7 календарных дней (≈ 5 рабочих). */
async function directionHistory(db: Db, userId: string, now: Date): Promise<Record<string, number>> {
  const schedule = await loadUserSchedule(db, userId);
  const r = await db.query(
    `select coalesce(author_agent_id::text, $2) as direction, started_at, submitted_at
       from tasks
      where assignee_user_id = $1 and kind = 'action' and started_at is not null and submitted_at is not null
        and submitted_at > $3::timestamptz - interval '7 days'`,
    [userId, PEOPLE_DIRECTION, now],
  );
  const hist: Record<string, number> = {};
  for (const row of r.rows) {
    const mins = Math.max(1, workingMinutesBetween(schedule, new Date(row.started_at), new Date(row.submitted_at)));
    hist[row.direction] = (hist[row.direction] ?? 0) + mins;
  }
  return hist;
}

/** Если слот свободен — поставить в «Сейчас» следующую задачу; если нечего — автопилот. */
export async function fillSlot(db: Db, userId: string, now: Date = new Date()): Promise<Task | null> {
  await lockPerson(db, userId);
  // Компания, куда человека лишь позвали, «Сейчас» не выдаёт до принятия приглашения:
  // держателем слота её дело не считается (миграция 017), и выданное здесь «Сейчас» стало бы вторым —
  // рядом с делом действующей компании. Её очередь двинется с первым действием человека по её делу.
  const membership = await db.query(
    `select status from memberships where org_id = current_setting('app.org_id')::uuid and user_id = $1`, [userId]);
  if (membership.rowCount && membership.rows[0].status !== 'active') return null;
  // «Сейчас» — одно на человека, а не на компанию (спека multi-company): человек один, и занят он
  // целиком. Через функцию с правами владельца — своя транзакция видит и то, что только что сделала
  // сама, а RLS чужих компаний того же человека отсюда не покажет (миграция 017).
  // Узкий тип, а не `Task`: функция отдаёт ровно то, чем человек занят, — и следующий, кто заглянет
  // здесь в другое поле дела, увидит это в типах, а не получит undefined.
  const holders = (await db.query('select * from person_slot_holders($1)', [userId]))
    .rows as SlotHolder[];
  for (const h of holders) if (await holdsSlot(db, h, now)) return null;

  let candidates = await loadCandidates(db, userId);
  if (!candidates.length) {
    const released = await autopilotRelease(db, userId, now);
    if (released) candidates = await loadCandidates(db, userId);
  }
  if (!candidates.length) {
    await signalIdle(db, userId, now);
    return null;
  }
  const settings = (await db.query('select quotas from queue_settings where user_id = $1', [userId])).rows[0];
  const schedule = await loadUserSchedule(db, userId);
  const pick = pickNext(candidates, {
    today: localDate(now, schedule.tz),
    quotas: (settings?.quotas ?? {}) as Record<string, number>,
    history: await directionHistory(db, userId, now),
  });
  if (!pick) return null;
  return transition(db, pick.id, 'activate', { kind: 'system' }, { now, skipFill: true });
}

/** Кандидаты на «Сейчас». Дела архивного проекта в очередь не идут (спека projects). */
async function loadCandidates(db: Db, userId: string): Promise<Candidate[]> {
  const r = await db.query(
    `select t.id, coalesce(t.author_agent_id::text, $2) as direction, t.priority, to_char(t.due_date, 'YYYY-MM-DD') as due_date,
            t.position, t.created_at, coalesce(p.created_at, t.created_at) as plan_created_at
       from tasks t
       left join plans p on p.id = t.plan_id
       left join agents a on a.id = t.author_agent_id
       left join projects pr on pr.id = t.project_id
      where t.assignee_user_id = $1 and t.kind = 'action' and t.status in ('ready','rework')
        and (p.id is null or p.status in ('active','waiting'))
        and (pr.id is null or pr.status = 'active')`,
    [userId, PEOPLE_DIRECTION],
  );
  return r.rows.map((row) => ({
    id: row.id, direction: row.direction, priority: row.priority, due_date: row.due_date,
    position: row.position, created_at: new Date(row.created_at).getTime(),
    plan_created_at: new Date(row.plan_created_at).getTime(),
  }));
}

/** Автопилот: следующий по порядку draft плана с auto_release_ok (агент пометил, что шаг не зависит от результата). */
async function autopilotRelease(db: Db, userId: string, now: Date): Promise<boolean> {
  const r = await db.query(
    `select t.id from tasks t
       join plans p on p.id = t.plan_id and p.status = 'active'
       join agents a on a.id = p.agent_id and a.status = 'active'
      where t.assignee_user_id = $1 and t.status = 'draft' and t.auto_release_ok
        -- Правило полноты (спека task-context): неполный шаг автопилот не выпускает, он остаётся draft.
        and (not t.requires_context or (btrim(t.why) <> '' and btrim(t.done_criteria) <> ''))
        and t.position = (select min(t2.position) from tasks t2 where t2.plan_id = t.plan_id and t2.status = 'draft')
        and not exists (select 1 from tasks t3 where t3.plan_id = t.plan_id and t3.position < t.position
                          and t3.status in ('ready','active','in_progress','blocked','rework','waiting_external','scheduled'))
      order by p.created_at, t.position
      limit 1`,
    [userId],
  );
  const id = r.rows[0]?.id as string | undefined;
  if (!id) return false;
  await transition(db, id, 'release', { kind: 'system' }, { now, skipFill: true });
  await emit(db, { type: 'autopilot_released', taskId: id, data: { user_id: userId } });
  return true;
}

/** Нечего выдать: сообщить агентам, у которых есть активный план с этим человеком. Раз за период простоя. */
async function signalIdle(db: Db, userId: string, now: Date): Promise<void> {
  const agents = await db.query(
    `select distinct p.agent_id from plans p join tasks t on t.plan_id = p.id
      where p.status = 'active' and t.assignee_user_id = $1`,
    [userId],
  );
  for (const row of agents.rows) {
    const last = await db.query(
      `select max(at) as at from events where agent_id = $1 and type = 'person_idle' and data->>'user_id' = $2`,
      [row.agent_id, userId],
    );
    const lastActivation = await db.query(
      `select max(status_changed_at) as at from tasks where assignee_user_id = $1 and status in ('active','in_progress','submitted','done')`,
      [userId],
    );
    const lastIdle = last.rows[0]?.at ? new Date(last.rows[0].at) : null;
    const lastWork = lastActivation.rows[0]?.at ? new Date(lastActivation.rows[0].at) : null;
    if (lastIdle && (!lastWork || lastIdle >= lastWork)) continue;
    await emit(db, { type: 'person_idle', agentId: row.agent_id, data: { user_id: userId, at: now.toISOString() } });
  }
}

/** Закрыть открытый таймер учёта по делу: работа встала — счёт часов тоже (спека time-tracking).
 *  Учёт человек ведёт сам и может считать иначе, но натикать часы, которых не было, он не должен. */
async function closeRunningTimer(db: Db, userId: string, taskId: string, now: Date): Promise<void> {
  await db.query(
    `update time_entries set ended_at = $2, minutes = greatest(1, round(extract(epoch from ($2::timestamptz - started_at)) / 60))
      where user_id = $1 and task_id = $3 and ended_at is null and source = 'timer'`,
    [userId, now, taskId],
  );
}

/** Снять дело с «Сейчас» и закрыть его таймер: прежний держатель возвращается в очередь. */
async function releaseHolder(db: Db, userId: string, taskId: string, actor: Actor, now: Date): Promise<void> {
  await transition(db, taskId, 'deactivate', actor, { now, skipFill: true });
  await closeRunningTimer(db, userId, taskId, now);
}

/**
 * «Остановить» — пара к «Взял»: дело возвращается в очередь, счёт времени встаёт (спека mini-app).
 * Живёт в ядре, а не в поверхности: то же самое делают и приложение, и бот, а разойдясь, они
 * рассказывали бы о деле разное. Слот наполняет очередь сама — остановились, и следующее дело
 * предлагается, но не берётся за человека.
 */
export async function stopTask(
  db: Db, taskId: string, userId: string, opts: { now?: Date; expectedVersion?: number } = {},
): Promise<Task> {
  const now = opts.now ?? new Date();
  const task = await transition(db, taskId, 'deactivate', { kind: 'user', userId }, { now, expectedVersion: opts.expectedVersion });
  await closeRunningTimer(db, userId, taskId, now);
  return task;
}

/** «Взял» на любом пункте списка: прежний держатель слота возвращается в очередь. */
export async function takeTask(db: Db, taskId: string, actor: Actor, opts: { now?: Date; expectedVersion?: number } = {}): Promise<Task> {
  const now = opts.now ?? new Date();
  // Порядок замков как в fillSlot: сначала человек, потом строка задачи — иначе взаимная блокировка (ревью ядра).
  const owner = await db.query('select assignee_user_id from tasks where id = $1', [taskId]);
  if (!owner.rowCount) throw new AppError('not_found', 'Task not found');
  await lockPerson(db, owner.rows[0].assignee_user_id);
  const task = await loadTaskForUpdate(db, taskId);
  if (actor.kind !== 'system' && actor.userId !== task.assignee_user_id) throw new AppError('forbidden', 'This task belongs to another person');
  // До того, как гасить прежнего держателя: дело другой компании гасится своей транзакцией, и отказ
  // `transition` ниже её уже не откатит — человек потерял бы «Сейчас» ради дела, которое взять нельзя.
  assertPersonalAllows(await inPersonalSpace(db), 'take');
  // Прежнего держателя ищем через функцию слота, а не запросом по `tasks`: слот один на человека
  // поперёк компаний, а RLS этой транзакции чужую компанию не покажет — и человек остался бы с двумя
  // «Сейчас» сразу (спека multi-company).
  const others = (await db.query(
    `select * from person_slot_holders($1) where id <> $2 and status in ('active','in_progress')`,
    [task.assignee_user_id, task.id],
  )).rows as SlotHolder[];
  const myOrgId = (await db.query(`select current_setting('app.org_id')::uuid as id`)).rows[0].id as string;
  for (const o of others) {
    // Дело другой компании гасим её же транзакцией: под служебной ролью RLS не действует, и правка
    // прошла бы мимо границы организаций (тот же приём, что при переносе дела, core/routing.ts).
    if (o.org_id !== myOrgId) {
      // Человек указывается явно: в закрытом проекте дело видно только его участникам, а без
      // `app.actor_user_id` чужая транзакция не показывала дело даже его собственному хозяину —
      // «Взять» во второй компании отвечало «дела не существует».
      //
      // Гонка двух «Взял» в разных компаниях разрешается замком человека (`lockPerson`): он общий для
      // всех компаний, второе «Взял» ждёт, пока первое закоммитится, и видит его дело держателем.
      // Чужая компания гасится отдельной транзакцией, а эта держит замок человека — если строку
      // чужого дела в этот миг держит транзакция, которая сама ждёт замка человека, база этого
      // круга не увидит (одно звено ожидания — в приложении). Поэтому ждём строку недолго: лучше
      // отказ «попробуй ещё раз», чем висящий запрос и занятое соединение.
      await withOrg(o.org_id, async (other) => {
        await other.query(`set local lock_timeout = '5s'`);
        await releaseHolder(other, task.assignee_user_id!, o.id, actor, now);
      }, { actorUserId: task.assignee_user_id! });
      continue;
    }
    await releaseHolder(db, task.assignee_user_id!, o.id, actor, now);
  }
  return transition(db, task.id, 'take', actor, { now, expectedVersion: opts.expectedVersion });
}

/** Чем начато дело без «Взять» (спека auto-start, миграция 035). */
export type AutoStartCause = 'comment' | 'attachment' | 'submit';

/** Статусы «ещё не начато»: `active` тоже — дело стоит в «Сейчас», но «Взять» не нажато. */
const NOT_STARTED_STATUSES: readonly string[] = ['ready', 'active', 'rework'];

/**
 * Начинает ли это действие дело само (спека auto-start): действует сам исполнитель-человек, дело —
 * действие (не ожидание), ещё не начато (`started_at` пуст) и стоит в очереди или в «Сейчас».
 * Личное место проверяет вызывающий: это запрос в базу.
 */
export function startsByAction(task: Pick<Task, 'kind' | 'status' | 'started_at' | 'assignee_user_id'>, actor: Actor): boolean {
  return actor.kind === 'user' && actor.userId === task.assignee_user_id && task.kind === 'action'
    && !task.started_at && NOT_STARTED_STATUSES.includes(task.status);
}

/**
 * Первое действие исполнителя по неначатому делу начинает его (спека auto-start): люди не
 * нажимают «Взять», и время цикла, «Итоги» и учёт времени считали нули, хотя работа шла (NOR-039).
 * Зовётся в транзакции самого действия — до записи реплики или фото.
 *
 * Нет у человека другого дела в «Сейчас» — дело берётся тем же путём, что «Взять»: переходом `take`
 * (начало, взятие, учёт времени). Другое уже в «Сейчас» — статус не меняется: переключать человека с
 * дела, над которым он работает, из-за реплики к очередному вредно; ставится только начало. Сдача
 * сюда не ходит — её начало ставит сам `transition 'submit'`.
 *
 * Автоначало — довесок к действию, и действие из-за него не ждёт и не падает. Замки берутся без
 * ожидания: строка дела (`nowait`), затем замок человека (`try`). Ждать здесь нельзя — у вызывающих
 * два порядка: «Взять» и очередь берут человека, потом строку, а любой `transition` — строку, потом
 * человека (в `fillSlot`). Ожидание в любом из порядков замыкало круг с другим (ревью: реплика
 * исполнителя против отмены агентом). Занято — по делу прямо сейчас идёт другое действие или
 * перестановка в «Сейчас»: дело не начинаем, реплика или фото проходят. Всё — в точке сохранения:
 * любой сбой откатывает только автоначало. Два действия разом: одно берёт дело, второе видит замок
 * или уже начатое дело и ничего не делает. Возвращает дело после начала или null.
 */
export async function autoStart(
  db: Db, taskId: string, actor: Actor, cause: Exclude<AutoStartCause, 'submit'>, now: Date = new Date(),
): Promise<Task | null> {
  if (actor.kind !== 'user') return null;
  // Без замков: у большинства реплик дело уже начато, и стоять в очереди на человеке им незачем.
  const peek = (await db.query('select * from tasks where id = $1', [taskId])).rows[0] as Task | undefined;
  if (!peek || !startsByAction(peek, actor)) return null;
  const personal = await isPersonalPlace(db, {
    projectId: peek.project_id, assigneeUserId: peek.assignee_user_id, authorUserId: peek.author_user_id, authorAgentId: peek.author_agent_id,
  });
  // У личного дела нет очереди и «Взять» — начинать нечего.
  if (personal) return null;

  // Замки дела и человека берутся без ожидания, но взятие внутри ещё пишет таймер, а уникальный индекс
  // «один открытый таймер на человека» ждёт чужую незакоммиченную строку. Ответ на вопрос по другому
  // делу того же человека держит её и ждёт замок человека, который держим мы, — круг, и база обрывала
  // ответ (ревью 23.10, 38 из 80). Короткий предел ожидания меньше deadlock_timeout делает ждущим
  // всегда автоначало: его 55P03 гасится ниже, а чужое действие проходит. Откат точки сохранения
  // возвращает предел сам, после release его надо вернуть руками.
  const prevTimeout = (await db.query(`select current_setting('lock_timeout') as v`)).rows[0].v as string;
  await db.query('savepoint auto_start');
  try {
    await db.query(`select set_config('lock_timeout', '200ms', true)`);
    const started = await startUnderLocks(db, taskId, actor, cause, now);
    await db.query('release savepoint auto_start');
    await db.query(`select set_config('lock_timeout', $1, true)`, [prevTimeout]);
    return started;
  } catch (e) {
    await db.query('rollback to savepoint auto_start');
    // Занятый замок — обычное дело (действие и перестановка разом), прочее — в журнал: действие всё равно проходит.
    if ((e as { code?: string }).code !== LOCK_NOT_AVAILABLE) logger.warn({ err: e, task: taskId }, 'autoStart: дело не начато, действие проходит без начала');
    return null;
  }
}

/** Код Postgres «замок занят» у `for update nowait`. */
const LOCK_NOT_AVAILABLE = '55P03';

async function startUnderLocks(
  db: Db, taskId: string, actor: Extract<Actor, { kind: 'user' }>, cause: Exclude<AutoStartCause, 'submit'>, now: Date,
): Promise<Task | null> {
  const task = (await db.query('select * from tasks where id = $1 for update nowait', [taskId])).rows[0] as Task | undefined;
  // Второе из двух действий разом приходит сюда, когда первое уже закоммитило начало.
  if (!task || !startsByAction(task, actor)) return null;
  const person = await db.query(`select pg_try_advisory_xact_lock(hashtext('taskano:slot'), hashtext($1)) as ok`, [actor.userId]);
  if (!person.rows[0].ok) throw Object.assign(new Error('person slot is busy'), { code: LOCK_NOT_AVAILABLE });

  // «Сейчас» одно на человека поперёк компаний — смотрим через функцию слота, как «Взять».
  const busy = await db.query(
    `select 1 from person_slot_holders($1) where id <> $2 and status in ('active','in_progress') limit 1`,
    [actor.userId, task.id],
  );
  const switched = !busy.rowCount;
  if (switched) {
    // Тот же переход, что у «Взять»; освобождать некого — другого дела в «Сейчас» нет. Отметка `auto`
    // на событии взятия: его породило не решение человека, а реплика или фото (тревога «агенты молчат»).
    await transition(db, task.id, 'take', actor, { now, autoStart: cause });
  } else {
    await db.query('update tasks set started_at = $2 where id = $1 and started_at is null', [task.id, now]);
  }
  await db.query('update tasks set started_via = $2 where id = $1', [task.id, cause]);
  await emit(db, { type: 'task_auto_started', taskId: task.id, actorUserId: actor.userId, data: { cause, switched }, at: now });
  return (await db.query('select * from tasks where id = $1', [task.id])).rows[0] as Task;
}
