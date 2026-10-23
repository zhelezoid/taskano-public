import { withOrg, withSystem, type Db } from '../db/pool.js';
import { AppError } from './errors.js';
import { emit } from './events.js';
import { loadUserSchedule } from './calendar.js';
import { fillSlot } from './queue.js';
import { stopTaskTimer } from './time.js';
import { ensureDefaultProject, nextProjectNumber, taskKey } from './projects.js';
import type { Actor, Task } from './types.js';

// Перенос дела между личным пространством человека и его компанией — спека task-routing.
// Критерий «чьё это дело, а не кто его делает» смысловой, его держит агент в разговоре; сервер
// только исполняет явный перенос и проверяет, что он допустим.
//
// Изоляция. Перенос — единственное действие, которому нужны две организации сразу, поэтому он идёт
// под withSystem (BYPASSRLS). Политику RLS на tasks мы НЕ ослабляем: «видно, если org_id = текущая»
// остаётся единственным правилом для всех остальных запросов — та же линия, что в решении 69
// (src/runtime/owner-activity.ts). Чужое сюда не попадёт: и дело, и организация-получатель ищутся
// строго среди действующих членств самого человека.

const UUID = /^[0-9a-f-]{36}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Закрытое дело не переносится: история закрытых остаётся на месте. */
const CLOSED_STATUSES = ['done', 'declined', 'cancelled', 'resolved'];

/** Статусы, которыми дело занимает слот «Сейчас» (core/lifecycle, `holdsSlot`). */
const SLOT_STATUSES = ['active', 'in_progress', 'blocked'];

export interface MovePatch {
  why?: string | null;
  doneCriteria?: string | null;
  dueDate?: string | null;
}

/**
 * Перенести открытое дело в другую организацию того же человека (или в его личное пространство).
 * Возвращает дело уже на новом месте; повтор переноса туда же — успех без второго события.
 */
export async function moveTaskToOrg(
  actor: Actor, taskId: string, toOrgId: string, patch: MovePatch = {}, now: Date = new Date(),
): Promise<Task> {
  // Переносит только сам человек: из личного агент читал бы то, что ему закрыто, а в личное —
  // уводил бы работу из-под надзора (спека owner-feedback).
  if (actor.kind !== 'user') throw new AppError('forbidden', 'Only the person themselves moves an item between their spaces');
  if (!UUID.test(taskId)) throw new AppError('not_found', 'Task not found');
  const { task, fromOrgId } = await withSystem(async (db) => {
    await db.query('begin');
    try {
      const result = await move(db, actor.userId, taskId, toOrgId, patch, now);
      await db.query('commit');
      return result;
    } catch (e) {
      await db.query('rollback').catch(() => {});
      throw e;
    }
  });

  // Слот «Сейчас» в прежней организации мог освободиться — наполняем его отдельной транзакцией
  // под withOrg. Внутри переноса этого делать нельзя: под служебной ролью RLS не действует, и
  // fillSlot увидел бы задачи человека во всех его организациях сразу.
  if (task.org_id !== fromOrgId) await withOrg(fromOrgId, (db) => fillSlot(db, actor.userId, now));
  return task;
}

async function move(
  db: Db, userId: string, taskId: string, toOrgId: string, patch: MovePatch, now: Date,
): Promise<{ task: Task; fromOrgId: string }> {
  const t = (await db.query(
    `select t.* from tasks t
       join memberships m on m.org_id = t.org_id and m.user_id = $2 and m.status = 'active'
      where t.id = $1 for update of t`,
    [taskId, userId],
  )).rows[0] as Task | undefined;
  if (!t) throw new AppError('not_found', 'Task not found');
  // Дело в работе у другого человека — это уже не дело владельца, переносить его нельзя.
  if (t.assignee_user_id !== userId) throw new AppError('conflict', 'The item is being done by another person');
  if (CLOSED_STATUSES.includes(t.status)) throw new AppError('conflict', 'A closed item stays where it was closed');
  // Идемпотентность: дело уже там, куда просят, — успех без изменений и без второго события.
  if (t.org_id === toOrgId) return { task: t, fromOrgId: t.org_id };

  const to = (await db.query(
    `select o.kind, o.owner_user_id from orgs o join memberships m on m.org_id = o.id and m.user_id = $2 and m.status = 'active'
      where o.id = $1`, [toOrgId, userId],
  )).rows[0] as { kind: 'company' | 'personal'; owner_user_id: string } | undefined;
  if (!to) throw new AppError('not_found', 'Organization not found among yours');
  const from = (await db.query('select kind from orgs where id = $1', [t.org_id])).rows[0] as { kind: 'company' | 'personal' };

  // Одна сторона переноса — всегда личное пространство самого человека. Иначе дело со всей историей
  // (реплики людей, результаты, источники) уехало бы из компании A в компанию B: человек может
  // работать на двух работодателей, и это был бы вынос данных одного к другому.
  if (from.kind !== 'personal' && to.kind !== 'personal') {
    throw new AppError('conflict', 'An item moves between your personal space and a company, not between two companies');
  }
  if (to.kind === 'personal' && to.owner_user_id !== userId) throw new AppError('not_found', 'Organization not found among yours');

  // План и агент-автор живут в своей организации (внешние ключи tasks → plans/agents): шаг чужого
  // плана не выдёргивается, делом агента он распоряжается сам.
  if (t.plan_id) throw new AppError('conflict', 'A step of a plan is not pulled out of it');
  if (t.author_agent_id) throw new AppError('conflict', 'An item set by an agent is not moved — the agent leads it where it stands');
  // Унести дело компании в личное может только тот, кто его и завёл: иначе участник в одиночку
  // выносил бы постановку начальника туда, куда организации хода нет, и без следа.
  if (from.kind === 'company' && to.kind === 'personal' && t.author_user_id !== userId) {
    throw new AppError('conflict', 'This item was set by someone else — ask them to move it, or close it here');
  }
  // Фото дела (из рабочего чата и присланные людьми, спека task-photos) лежат в хранилище своей
  // организации: дело с вложениями не переносим, а говорим почему.
  const attached = await db.query('select 1 from task_attachments where task_id = $1 limit 1', [taskId]);
  if (attached.rowCount) throw new AppError('conflict', 'The item carries photos — they stay with this organization; move it without them by setting a new one there');
  // Ссылка на объект внешней системы уникальна в организации в пределах одного дела
  // (task_sources_external, миграция 024): один тикет — основание нескольких дел, так
  // что тот же тикет у другого дела на новом месте переносу не мешает. Столкнуться может только
  // строка этого же дела — если бы она там уже была, перенос упал бы сырой ошибкой базы, поэтому
  // проверка остаётся и говорит человеческими словами.
  const clash = await db.query(
    `select s.system, s.external_id from task_sources s
      where s.task_id = $1 and s.system is not null and s.external_id is not null
        and exists (select 1 from task_sources o
                     where o.org_id = $2 and o.task_id = s.task_id and o.system = s.system and o.external_id = s.external_id)
      limit 1`,
    [taskId, toOrgId]);
  if (clash.rowCount) {
    const { system, external_id: externalId } = clash.rows[0] as { system: string; external_id: string };
    throw new AppError('conflict', `${system} ${externalId} is already linked to another item there — unlink it first`,
      { system, external_id: externalId });
  }

  const company = to.kind === 'company';
  // В личном нет ни очереди, ни «Сейчас» (спека telegram-bot, «Личное»), поэтому дело, уехавшее
  // туда в работе, не показывалось ни в одном списке личного, но держало слот человека и висело в
  // «Сейчас» (спека multi-company). Возвращаем его в очередь так же, как «deactivate» в
  // core/lifecycle: status → ready. Слот после переноса наполнит fillSlot в прежней организации.
  const leavesQueue = !company && SLOT_STATUSES.includes(t.status);
  const why = (patch.why ?? t.why).trim();
  const doneCriteria = (patch.doneCriteria ?? t.done_criteria).trim();
  const dueDate = patch.dueDate === undefined ? t.due_date : patch.dueDate;
  if (dueDate && !DATE.test(dueDate)) throw new AppError('validation_failed', 'due_date — format YYYY-MM-DD');
  if (company) {
    // Карточка идёт в общую работу — к ней применяется правило полноты (спека task-context):
    // перенос и есть тот момент, когда дело получает контекст. У ожидания вместо критерия и срока
    // — то, чего ждут, и дата проверки; они уже записаны в самом ожидании.
    const missing: string[] = [];
    if (!why) missing.push('why');
    if (t.kind === 'action' && !doneCriteria) missing.push('done_criteria');
    if (t.kind === 'action' && !dueDate) missing.push('due_date');
    if (missing.length) throw new AppError('validation_failed', `Missing required fields: ${missing.join(', ')}`, { missing });
  }
  const dueTz = dueDate ? (await loadUserSchedule(db, t.assignee_user_id)).tz : null;

  // Дело всегда лежит в проекте организации, в которой оно находится (спека projects): на новом
  // месте это проект по умолчанию — «Разное» в компании, закрытое «Личное» в личном пространстве.
  const project = await ensureDefaultProject(db, toOrgId);

  // Дело переезжает на другую проект, значит получает её номер, а прежнее обозначение остаётся
  // видимым (спека projects-stage2): «NOR-12» из чужой переписки должно находиться.
  const fromKey = (await db.query('select key from projects where id = $1', [t.project_id])).rows[0]?.key as string | undefined;
  const formerKey = taskKey(fromKey, t.number);
  const number = await nextProjectNumber(db, project.id);

  // Дело в работе уходит из «Сейчас» — отрезок работы кончился так же, как при выходе из
  // in_progress в core/lifecycle: таймер закрывается, отрезок от taken_at прибавляется к общему
  // времени. Иначе таймер оставался открытым при деле в очереди (и держал единственный открытый
  // таймер человека), а время подхода пропадало из worked_seconds. Дело, которое и на новом месте
  // остаётся в работе, свой таймер везёт с собой (time_entries переезжают ниже) — счёт не рвётся.
  let workedSeconds = t.worked_seconds ?? 0;
  if (leavesQueue && t.status === 'in_progress') {
    await stopTaskTimer(db, t.assignee_user_id, t.id, now);
    if (t.taken_at) workedSeconds += Math.max(0, Math.round((now.getTime() - new Date(t.taken_at).getTime()) / 1000));
  }

  // Отсюда и до commit проверки внешних ключей на tasks отложены (миграция 007): дело и его
  // история меняют org_id вместе, а порядок операторов внутри транзакции перестаёт иметь значение.
  await db.query('set constraints all deferred');

  // История дела переезжает вместе с ним: без неё на новом месте останется голая карточка.
  await db.query('update events set org_id = $2 where task_id = $1', [taskId, toOrgId]);
  await db.query('update task_messages set org_id = $2 where task_id = $1', [taskId, toOrgId]);
  await db.query('update task_results set org_id = $2 where task_id = $1', [taskId, toOrgId]);
  await db.query('update task_sources set org_id = $2 where task_id = $1', [taskId, toOrgId]);
  await db.query('update time_entries set org_id = $2 where task_id = $1', [taskId, toOrgId]);
  // Отметки «открывал карточку» (спека unread-and-deeplink): без них дело на новом месте загорелось бы
  // новым у всех, кто его уже читал.
  await db.query('update task_views set org_id = $2 where task_id = $1', [taskId, toOrgId]);
  // Уведомления переезжают только СВОИ. Чужое недоставленное (начальнику — «не подтвердил», тому,
  // кто проверяет ожидание) нельзя тащить в другое пространство: доставщик прочитал бы текст дела
  // уже на новом месте и отправил человеку, который туда не входит. Гасим их в источнике —
  // уведомление о деле, которого в организации больше нет, всё равно бессмысленно.
  await db.query(
    'update notifications set delivered_at = coalesce(delivered_at, $3) where task_id = $1 and user_id <> $2',
    [taskId, userId, now]);
  // Доставки привязаны к уведомлению, а не к делу, — их org_id двигается вместе с уведомлениями.
  await db.query(
    `update deliveries set org_id = $2 where notification_id in (select id from notifications where task_id = $1 and user_id = $3)`,
    [taskId, toOrgId, userId]);
  await db.query('update notifications set org_id = $2 where task_id = $1 and user_id = $3', [taskId, toOrgId, userId]);
  // Кэш переводов полей дела: без переноса организация-получатель заплатит за тот же перевод заново.
  await db.query(`update translations set org_id = $2 where object_type = 'task' and object_id = $1`, [taskId, toOrgId]);

  // Кэш идемпотентности хранит снимок тела дела и вернул бы на повтор ссылку на уехавшее дело.
  await db.query(
    `delete from idempotency_keys where response->>'id' = $1 or response->'task'->>'id' = $1`, [taskId]);

  // Строки, которые приросли к прежней организации: сообщение принадлежит рабочему чату, предложение
  // — агенту. Дело уходит, связь рвётся — но сами строки остаются на месте целыми.
  await db.query('update group_messages set task_id = null where task_id = $1', [taskId]);
  await db.query('update proposals set task_id = null where task_id = $1', [taskId]);

  // Пометка «рабочее» снимается: в компании дело теперь и так видно, а в личном ей неоткуда взяться.
  // `category`, «важно» — поля личного разбора, в компании их нет. Проверяющий тоже
  // снимается (спека task-reviewer): одна сторона переноса всегда личное, а там принимать некому —
  // иначе своё дело, сданное в личном, ждало бы человека из компании, которой туда хода нет.
  await db.query(
    `update tasks
        set org_id = $2, shared_org_id = null, reviewer_user_id = null, why = $3, done_criteria = $4, due_date = $5, due_tz = $6,
            category = case when $7 then null else category end,
            priority = case when $7 then 'normal' else priority end,
            requires_context = case when $7 then true else requires_context end,
            status = case when $13 then 'ready' else status end,
            status_changed_at = case when $13 then $8 else status_changed_at end,
            blocked_at = case when $13 then null else blocked_at end,
            worked_seconds = $14,
            project_id = $9, private_owner_user_id = $10, number = $11,
            former_keys = case when $12::text is null then former_keys else array_append(former_keys, $12) end,
            version = version + 1, updated_at = $8
      where id = $1`,
    [taskId, toOrgId, why, doneCriteria, dueDate, dueTz, company, now, project.id, project.private ? project.owner_user_id : null,
      number, formerKey, leavesQueue, workedSeconds],
  );

  // Событие пишется уже в организации-получателе: её агенты видят, откуда пришло дело. app.org_id
  // под system-ролью ни на что не влияет, кроме этой записи, и живёт до конца транзакции.
  await db.query(`select set_config('app.org_id', $1, true)`, [toOrgId]);
  await emit(db, { type: 'task_moved', taskId, actorUserId: userId, data: { from_org: t.org_id, to_org: toOrgId } });

  return {
    task: (await db.query('select * from tasks where id = $1', [taskId])).rows[0] as Task,
    fromOrgId: t.org_id,
  };
}
