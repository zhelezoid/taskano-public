import type { Db } from '../db/pool.js';
import { emit } from '../core/events.js';
import { notify } from '../core/notify.js';
import { transition } from '../core/lifecycle.js';
import { isWorkingTime, loadUserSchedule, localDate, workdayEndOf, workingMinutesBetween, zonedToUtc, type Schedule } from '../core/calendar.js';
import type { Task } from '../core/types.js';

// Таймеры шага и ожиданий по расписанию получателя (спека step-lifecycle-and-queue, «Таймеры»).
// Идемпотентность — через `notifications.dedupe_key` (повторный insert ничего не делает) и через
// проверку «уже было такое событие» там, где нужен именно `events` (эскалации без dedupe-ключа).

const ACK_MINUTES = 2 * 60;
const NOT_ACKNOWLEDGED_MINUTES = 4 * 60;
const QUESTION_MINUTES = 4 * 60;
const AUTO_ACCEPT_MINUTES = 24 * 60;
// Молчание проверяющего меряем той же единицей, что автоприёмку у дела без проверяющего: сутки — напоминание ему, двое — постановщику.
const REVIEW_REMINDER_MINUTES = AUTO_ACCEPT_MINUTES;
const REVIEW_OVERDUE_MINUTES = 2 * AUTO_ACCEPT_MINUTES;
const STUCK_DAYS = 2;
const DAILY_REMINDER_LIMIT = 3;
// Таймер сам не идёт дольше нужного: вопрос «ещё работаешь?» — после 2,5 ч без признаков
// жизни, остановка — после 3 ч без них или в конце рабочего дня человека, что раньше.
const TIMER_CHECK_IDLE_MINUTES = 150;
const TIMER_IDLE_STOP_MINUTES = 3 * 60;

async function agentOwner(db: Db, agentId: string): Promise<string> {
  const r = await db.query('select owner_user_id from agents where id = $1', [agentId]);
  return r.rows[0].owner_user_id as string;
}

function isSnoozed(t: Task, now: Date): boolean {
  return !!t.snoozed_until && new Date(t.snoozed_until) > now;
}

/**
 * Напоминание с общим суточным лимитом на человека (спека: «3 в день; сверх — одно сводное»).
 * Дедупликация по стадии (`stage:taskId`) не даёт напомнить о том же дважды; счётчик за день —
 * по количеству уже отправленных `reminder` этому человеку сегодня (его локальная дата).
 */
async function sendReminder(db: Db, userId: string, taskId: string, stage: string, now: Date, schedule: Schedule): Promise<void> {
  // Начало дня человека в его поясе — в момент времени: считать календарным днём базы значит
  // считать чужой день, и у человека восточнее Гринвича лимит съезжал бы на несколько часов.
  const today = localDate(now, schedule.tz);
  const [y, m, d] = today.split('-').map(Number) as [number, number, number];
  const dayStart = zonedToUtc(y, m, d, 0, 0, schedule.tz);
  // Сравниваем с `now` теста, а не с реальным временем сервера: notify() пишет created_at = own now(),
  // что не совпадёт с симулированным `now` в тестах — поэтому здесь отдельный insert с явным created_at.
  //
  // Счёт — по человеку, а не по компании (спека multi-company): внутри организации он
  // давал человеку в двух компаниях шесть напоминаний в день вместо трёх. Через функцию с правами
  // владельца (миграция 018): она видит и то, что записала эта же транзакция минуту назад, а чужие
  // компании отдаёт одним числом — ни заголовков, ни названий.
  const sentToday = await db.query('select person_reminders_since($1, $2) as n', [userId, dayStart]);
  // Счётчик и `last_reminded_at` растут только когда напоминание реально поставлено — не на
  // каждый тик таймера. Дедуп по `dedupe_key` (стадия) и по попаданию в сводку (task_ids) означает,
  // что повторные тики того же дня почти всегда бьют в `do nothing`/пустой `where`: `rowCount`
  // после insert — единственный правдивый признак «поставлено», а не «попытались».
  if (sentToday.rows[0].n < DAILY_REMINDER_LIMIT) {
    const inserted = await db.query(
      `insert into notifications(org_id, user_id, kind, level, task_id, payload, dedupe_key, deliver_after, created_at)
       values (current_setting('app.org_id')::uuid, $1, 'reminder', 'work', $2, $3, $4, $5, $5)
       on conflict (org_id, dedupe_key) where dedupe_key is not null do nothing`,
      [userId, taskId, { stage }, `reminder:${stage}:${taskId}`, now],
    );
    if (inserted.rowCount) await db.query(`update tasks set reminded_count = reminded_count + 1, last_reminded_at = $2 where id = $1`, [taskId, now]);
    return;
  }
  // Склейка сверх лимита: один reminder_digest в день, накапливает id задач. Ключ остаётся в
  // пределах организации: список задач читается при доставке под её RLS, и дело чужой компании в
  // нём превратилось бы в пустое место. Компания у такой склейки названа.
  const digested = await db.query(
    `insert into notifications(org_id, user_id, kind, level, payload, dedupe_key, deliver_after)
     values (current_setting('app.org_id')::uuid, $1, 'reminder_digest', 'work', jsonb_build_object('task_ids', jsonb_build_array($2::text)), $3, now())
     on conflict (org_id, dedupe_key) where dedupe_key is not null
     do update set payload = jsonb_set(notifications.payload, '{task_ids}', (coalesce(notifications.payload->'task_ids', '[]'::jsonb)) || to_jsonb($2::text))
       where not (coalesce(notifications.payload->'task_ids', '[]'::jsonb) ? $2::text)`,
    [userId, taskId, `reminder_digest:${userId}:${today}`],
  );
  // `on conflict ... do update ... where <ложно>` не трогает строку вовсе — `rowCount` = 0 и для
  // «уже был в сводке», ровно как нам нужно (та же гарантия для свежей вставки и для реального update).
  if (digested.rowCount) await db.query(`update tasks set reminded_count = reminded_count + 1, last_reminded_at = $2 where id = $1`, [taskId, now]);
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(a) - Date.parse(b)) / 86400000);
}

/** «Нет нажатия на Сейчас» → напоминание, затем эскалация постановщику (2 р.ч. + 2 р.ч.). */
async function ackTimers(db: Db, now: Date): Promise<void> {
  const rows = (await db.query(
    `select * from tasks where kind = 'action' and status = 'active'`,
  )).rows as Task[];
  for (const t of rows) {
    if (isSnoozed(t, now)) continue;
    const schedule = await loadUserSchedule(db, t.assignee_user_id);
    const minutes = workingMinutesBetween(schedule, new Date(t.status_changed_at), now);
    if (minutes >= ACK_MINUTES && isWorkingTime(schedule, now)) await sendReminder(db, t.assignee_user_id, t.id, 'ack', now, schedule);
    if (minutes >= NOT_ACKNOWLEDGED_MINUTES) {
      const already = await db.query(`select 1 from events where type = 'not_acknowledged' and task_id = $1`, [t.id]);
      if (already.rowCount) continue;
      await emit(db, { type: 'not_acknowledged', taskId: t.id, data: {} });
      if (!t.author_agent_id) {
        await notify(db, { userId: t.author_user_id, kind: 'not_acknowledged', level: 'work', taskId: t.id, dedupeKey: `not_ack:${t.id}` });
      }
    }
  }
}

/**
 * Вопрос/«Непонятно» без ответа 4 р.ч. — «Решение» владельцу агента, для автора-человека — напоминание.
 *
 * Ключ — сама реплика без ответа, а не статус дела (как у просьбы назвать срок ниже): вопрос по делу
 * из очереди (`ready`/`rework`) статуса не меняет, и таймер, смотревший только на `blocked`, такой
 * вопрос не видел никогда (аудит архитектуры, CRIT). Отсчёт — от реплики; у `blocked` это то же
 * время, что `blocked_at`. На дело — последний открытый вопрос: несколько неотвеченных подряд — одна
 * эскалация, а не по одной на каждый. Дедуп — по id реплики: второй вопрос по тому же делу после
 * ответа на первый эскалируется заново (ключ по делу этого не давал).
 */
async function questionTimers(db: Db, now: Date): Promise<void> {
  const rows = (await db.query(
    `select distinct on (m.task_id) m.id, m.task_id, m.created_at, t.author_agent_id, t.author_user_id
       from task_messages m join tasks t on t.id = m.task_id
      where m.kind in ('question','unclear') and m.answered_at is null and m.created_at <= $1
        and t.kind = 'action' and t.status in ('ready','active','in_progress','blocked','rework')
        -- Вне blocked ответом до сих пор служила реплика другой стороны: так коннектор отвечал на
        -- вопрос по делу из очереди (комментарием), так отвечают из приложения, где кнопки
        -- «Ответить» нет. У blocked — только настоящий ответ: он же снимает блокировку.
        and (t.status = 'blocked' or not exists (
          select 1 from task_messages r
           where r.task_id = m.task_id and r.created_at > m.created_at
             and r.kind in ('answer','comment','owner_instruction')
             and r.author_user_id is distinct from m.author_user_id
             -- Отвечает тот, кому вопрос адресован: автор дела (у дела агента — его хозяин) или сам
             -- агент. Реплика стороннего участника вопрос не закрывает (ревью, HIGH).
             and (r.kind = 'answer' or r.author_user_id = t.author_user_id
                  or (t.author_agent_id is not null and r.author_agent_id = t.author_agent_id))))
      order by m.task_id, m.created_at desc`,
    [now],
  )).rows as { id: string; task_id: string; created_at: Date; author_agent_id: string | null; author_user_id: string }[];
  for (const m of rows) {
    const recipient = m.author_agent_id ? await agentOwner(db, m.author_agent_id) : m.author_user_id;
    const schedule = await loadUserSchedule(db, recipient);
    const minutes = workingMinutesBetween(schedule, new Date(m.created_at), now);
    if (minutes < QUESTION_MINUTES || !isWorkingTime(schedule, now)) continue;
    // До выкатки ключ был по делу (`question_unanswered:<дело>`): вопрос, по которому эскалация уже
    // ушла под старым ключом, второй раз не эскалируем.
    const old = await db.query(
      `select 1 from notifications where task_id = $1 and dedupe_key = any($2::text[]) and created_at >= $3 limit 1`,
      [m.task_id, [`question_unanswered:${m.task_id}`, `question_reminder:${m.task_id}`], m.created_at],
    );
    if (old.rowCount) continue;
    if (m.author_agent_id) {
      await notify(db, { userId: recipient, kind: 'question_unanswered', level: 'decision', taskId: m.task_id, dedupeKey: `question_unanswered:${m.id}` });
    } else {
      await notify(db, { userId: recipient, kind: 'task_question', level: 'work', taskId: m.task_id, dedupeKey: `question_reminder:${m.id}` });
    }
  }
}

/**
 * Просьба назвать срок без ответа (спека self-set-due): 1 рабочий день исполнителя —
 * одно напоминание ему, 2 — одно сообщение просившему. Это и есть эскалация: факт, дата просьбы,
 * молчание. Отсчёт — от просьбы, адресат — нынешний исполнитель: дело могли переназначить.
 * Один раз на просьбу — ключ дедупликации по её id.
 */
async function dueRequestTimers(db: Db, now: Date): Promise<void> {
  const rows = (await db.query(
    `select m.id, m.task_id, m.created_at, m.author_user_id, m.author_agent_id, t.assignee_user_id,
            t.author_user_id as task_author_user_id, t.author_agent_id as task_author_agent_id
       from task_messages m join tasks t on t.id = m.task_id
      where m.kind = 'due_request' and m.answered_at is null and m.created_at <= $1
        and t.kind = 'action' and t.status <> all($2::text[])`,
    [now, ['done', 'cancelled', 'declined', 'resolved', 'waiting_external']],
  )).rows as {
    id: string; task_id: string; created_at: Date; author_user_id: string | null; author_agent_id: string | null; assignee_user_id: string;
    task_author_user_id: string; task_author_agent_id: string | null;
  }[];
  for (const m of rows) {
    const schedule = await loadUserSchedule(db, m.assignee_user_id);
    const day = workingDayMinutes(schedule);
    if (day <= 0) continue;
    const minutes = workingMinutesBetween(schedule, new Date(m.created_at), now);
    if (minutes >= day && isWorkingTime(schedule, now)) {
      await notify(db, {
        userId: m.assignee_user_id, kind: 'due_request_reminder', level: 'work', taskId: m.task_id,
        payload: { request_id: m.id }, dedupeKey: `due_request_reminder:${m.id}`,
      });
    }
    if (minutes < 2 * day) continue;
    if (m.author_agent_id) {
      // Агент узнаёт из сводки, его владелец — строкой «Решение»: молчание человека — повод решать.
      const already = await db.query(`select 1 from events where type = 'due_request_ignored' and task_id = $1 and data->>'request_id' = $2`, [m.task_id, m.id]);
      if (!already.rowCount) {
        await emit(db, { type: 'due_request_ignored', taskId: m.task_id, agentId: m.author_agent_id, data: { request_id: m.id, requested_at: new Date(m.created_at).toISOString() } });
      }
      await notify(db, {
        userId: await agentOwner(db, m.author_agent_id), kind: 'due_request_ignored', level: 'decision', taskId: m.task_id,
        payload: { request_id: m.id }, dedupeKey: `due_request_ignored:${m.id}`,
      });
    } else {
      // Просивший мог уйти из компании или потерять право распоряжаться делом — тогда о молчании
      // узнаёт тот, кто за дело отвечает: автор, у дела агента — его владелец (как у вопроса без ответа).
      const still = m.author_user_id && (await db.query(
        `select 1 from memberships where org_id = current_setting('app.org_id')::uuid and user_id = $1 and status = 'active'
            and ($1 = $2 or role in ('owner','admin'))`,
        [m.author_user_id, m.task_author_user_id])).rowCount;
      const recipient = still ? m.author_user_id!
        : m.task_author_agent_id ? await agentOwner(db, m.task_author_agent_id) : m.task_author_user_id;
      await notify(db, {
        userId: recipient, kind: 'due_request_ignored', level: 'work', taskId: m.task_id,
        payload: { request_id: m.id }, dedupeKey: `due_request_ignored:${m.id}`,
      });
    }
  }
}

/**
 * `submitted` от автора-человека без приёмки 24 р.ч. → auto_accept. Дело с проверяющим само не
 * принимается: его назначили, чтобы сданное кто-то посмотрел (спека task-reviewer, развилка 2).
 */
async function autoAcceptTimers(db: Db, now: Date): Promise<void> {
  const rows = (await db.query(
    `select * from tasks where kind = 'action' and status = 'submitted' and author_agent_id is null and reviewer_user_id is null`,
  )).rows as Task[];
  for (const t of rows) {
    if (!t.submitted_at) continue;
    const schedule = await loadUserSchedule(db, t.author_user_id);
    if (workingMinutesBetween(schedule, new Date(t.submitted_at), now) >= AUTO_ACCEPT_MINUTES) {
      await transition(db, t.id, 'auto_accept', { kind: 'system' }, { now });
    }
  }
}

/**
 * Дело с проверяющим не принимается само (выше), но и не должно повиснуть: молчание проверяющего
 * 24 его рабочих часа — напоминание ему, 48 — сообщение постановщику. Часы — по расписанию
 * проверяющего: сдали в пятницу вечером — суббота и воскресенье не считаются.
 *
 * Отсчёт — от `review_since`: позднейшее из сдачи и последней передачи проверки другому (событие
 * `task_updated` с `reviewer_user_id`). `submitted_at` ради этого не трогаем: по нему очередь считает
 * время работы исполнителя. Ключи несут проверяющего и момент отсчёта, поэтому каждая сдача и каждый
 * новый проверяющий получают свои сообщения, а повторный тик — нет.
 *
 * Постановщик — `author_user_id`: у дела агента это его хозяин. Ушёл из компании — сообщение
 * владельцу организации, как у просьбы назвать срок.
 *
 * Выборка по настенным часам отсекает свежее: рабочих минут не больше календарных, так что до суток
 * ждать нечего. Уже получившее сообщение «просрочено» дальше не считаем — оно своё отработало.
 */
async function reviewSilenceTimers(db: Db, now: Date): Promise<void> {
  const rows = (await db.query(
    `select * from (
       select t.*, greatest(t.submitted_at, coalesce((
                select max(e.at) from events e
                 where e.task_id = t.id and e.type = 'task_updated' and e.data->'fields' ? 'reviewer_user_id'
              ), t.submitted_at)) as review_since
         from tasks t
        where t.kind = 'action' and t.status = 'submitted' and t.reviewer_user_id is not null and t.submitted_at is not null
     ) x
      where review_since <= $1::timestamptz - interval '24 hours'`,
    [now],
  )).rows as (Task & { review_since: Date })[];
  if (!rows.length) return;
  const keyOf = (kind: string, t: Task & { review_since: Date }) => `${kind}:${t.id}:${t.reviewer_user_id}:${new Date(t.review_since).toISOString()}`;
  const done = new Set((await db.query(
    `select dedupe_key from notifications where dedupe_key = any($1::text[])`,
    [rows.map((t) => keyOf('review_overdue', t))],
  )).rows.map((r) => r.dedupe_key as string));
  for (const t of rows) {
    if (done.has(keyOf('review_overdue', t))) continue;
    const reviewerId = t.reviewer_user_id!;
    const schedule = await loadUserSchedule(db, reviewerId);
    const minutes = workingMinutesBetween(schedule, new Date(t.review_since), now);
    if (minutes >= REVIEW_REMINDER_MINUTES) {
      await notify(db, {
        userId: reviewerId, kind: 'review_reminder', level: 'work', taskId: t.id,
        payload: { hours: Math.floor(REVIEW_REMINDER_MINUTES / 60) }, dedupeKey: keyOf('review_rem', t),
      });
    }
    if (minutes >= REVIEW_OVERDUE_MINUTES) {
      const stillHere = (await db.query(
        `select 1 from memberships where org_id = current_setting('app.org_id')::uuid and user_id = $1 and status = 'active'`,
        [t.author_user_id])).rowCount;
      const recipient = stillHere ? t.author_user_id : await orgOwner(db);
      if (!recipient) continue;
      await notify(db, {
        userId: recipient, kind: 'review_overdue', level: 'decision', taskId: t.id,
        payload: { reviewer_id: reviewerId, hours: Math.floor(minutes / 60) }, dedupeKey: keyOf('review_overdue', t),
      });
    }
  }
}

async function orgOwner(db: Db): Promise<string | null> {
  const r = await db.query(
    `select user_id from memberships where org_id = current_setting('app.org_id')::uuid and role = 'owner' and status = 'active'
      order by joined_at nulls last, user_id limit 1`);
  return r.rows[0]?.user_id ?? null;
}

/** Затухание просрочки +1/+3/+7 календарных дней; за день до срока — due_tomorrow. Дальше не напоминать. */
async function dueDateTimers(db: Db, now: Date): Promise<void> {
  const rows = (await db.query(
    `select * from tasks where kind = 'action' and due_date is not null
       and status in ('ready','active','in_progress','blocked','rework')
      order by created_at`,
  )).rows as Task[];
  for (const t of rows) {
    if (isSnoozed(t, now)) continue;
    const schedule = await loadUserSchedule(db, t.assignee_user_id);
    if (!isWorkingTime(schedule, now)) continue;
    const today = localDate(now, schedule.tz);
    const overdue = daysBetween(today, t.due_date!);
    let stage: string | null = null;
    if (overdue === -1) stage = 'due_tomorrow';
    else if (overdue === 1) stage = 'overdue_1';
    else if (overdue === 3) stage = 'overdue_3';
    else if (overdue === 7) stage = 'overdue_7';
    if (stage) await sendReminder(db, t.assignee_user_id, t.id, stage, now, schedule);
  }
}

/** `in_progress` дольше 2 рабочих дней без событий → «Взгляд» владельцу агента; время цикла ×2 оценки → estimate_diverged. */
async function stuckAndEstimateTimers(db: Db, now: Date): Promise<void> {
  const rows = (await db.query(
    `select * from tasks where kind = 'action' and status = 'in_progress' and author_agent_id is not null`,
  )).rows as Task[];
  for (const t of rows) {
    const schedule = await loadUserSchedule(db, t.assignee_user_id);
    const owner = await agentOwner(db, t.author_agent_id!);
    // «Сейчас» у человека одно на все компании: если он занят делом другой компании,
    // здесь он не застрял — он работает там. Через функцию слота: RLS этой транзакции чужого не
    // покажет, а функция отдаёт только id, компанию и статус.
    const busyElsewhere = await db.query(
      `select 1 from person_slot_holders($1) where org_id <> $2 and status in ('active','in_progress') limit 1`,
      [t.assignee_user_id, t.org_id]);
    const sinceChange = workingMinutesBetween(schedule, new Date(t.status_changed_at), now);
    const dayMinutes = workingDayMinutes(schedule);
    if (sinceChange >= STUCK_DAYS * dayMinutes && !busyElsewhere.rowCount) {
      // Событие самой смены статуса движением не считается. Оно пишется той же транзакцией, но
      // временем базы, а `status_changed_at` — временем вызывающего: событие выходит на десятки
      // миллисекунд новее, и голое `at > status_changed_at` видело «движение» всегда. Проверка
      // молчала на бою и не падала в тестах, пока часы стояли удачно (поймано прогоном днём —
      // утром те же тесты были зелёными).
      const moved = await db.query(
        `select 1 from events where task_id = $1 and at > $2::timestamptz + interval '1 second' limit 1`,
        [t.id, t.status_changed_at]);
      if (!moved.rowCount) {
        // Сколько рабочих дней шаг стоит без движения — в текст уведомления (спека telegram-bot,
        // «Ахмет застрял на возврате Acmeshop, 2 дня»).
        const days = dayMinutes > 0 ? Math.floor(sinceChange / dayMinutes) : STUCK_DAYS;
        await notify(db, { userId: owner, kind: 'person_stuck', level: 'glance', taskId: t.id, payload: { days }, dedupeKey: `person_stuck:${t.id}` });
      }
    }
    if (t.started_at && t.estimate_minutes) {
      const cycle = workingMinutesBetween(schedule, new Date(t.started_at), now);
      if (cycle >= 2 * t.estimate_minutes) {
        // Действия у этого сообщения нет — только лента: «Лента за вчера» в дайджесте (спека bot-messages).
        await notify(db, { userId: owner, kind: 'estimate_diverged', level: 'feed', taskId: t.id, dedupeKey: `estimate_diverged:${t.id}` });
      }
    }
  }
}

/** Длина рабочего дня в минутах (work_end − work_start), для «2 рабочих дня» в таймере person_stuck. */
function workingDayMinutes(s: Schedule): number {
  const [sh, sm] = s.start.split(':').map(Number) as [number, number];
  const [eh, em] = s.end.split(':').map(Number) as [number, number];
  return (eh * 60 + em) - (sh * 60 + sm);
}

/** Ожидания: время проверки настало → уведомление ответственному; срок ожидания прошёл → external_overdue. */
async function waitingTimers(db: Db, now: Date): Promise<void> {
  const checks = (await db.query(
    `select * from tasks where kind = 'waiting' and status = 'waiting' and (waiting->>'next_check_at')::timestamptz <= $1`, [now],
  )).rows as Task[];
  for (const t of checks) {
    const w = t.waiting!;
    // Одно сообщение на дату проверки (спека bot-messages): ключ по дню слал те же ожидания каждое
    // утро. Не отметили — ожидание остаётся в дайджесте («На проверку сегодня»); перенесли проверку —
    // новая дата, новый ключ, снова одно сообщение.
    await notify(db, { userId: w.check_user_id, kind: 'waiting_check', level: 'work', taskId: t.id, dedupeKey: `waiting_check:${t.id}:${w.next_check_at}` });
  }

  const overdue = (await db.query(
    `select * from tasks where status in ('waiting', 'waiting_external') and waiting is not null
       and waiting->>'expected_at' is not null and (waiting->>'expected_at')::timestamptz <= $1`,
    [now],
  )).rows as Task[];
  for (const t of overdue) {
    const already = await db.query(`select 1 from events where type = 'external_overdue' and task_id = $1`, [t.id]);
    if (already.rowCount) continue;
    await emit(db, { type: 'external_overdue', taskId: t.id, data: {} });
    const recipient = t.author_agent_id ? await agentOwner(db, t.author_agent_id) : t.author_user_id;
    await notify(db, { userId: recipient, kind: 'external_overdue', level: 'glance', taskId: t.id, dedupeKey: `external_overdue:${t.id}` });
  }
}

/**
 * Таймер не тикает без человека (спека time-tracking). «Признак жизни» — старт таймера и
 * отметки человека в боте и приложении (`last_seen_*`, спека person-presence). Через 2,5 ч без них —
 * один вопрос «ещё работаешь?» (нажатие любой кнопки — тоже отметка); через 3 ч — таймер закрывается
 * на отметке «последний признак + 3 ч». Таймер, начатый в рабочие часы, закрывается не позже конца
 * рабочего дня этого же дня. Начатый вне рабочих часов (переработка) — только по бездействию.
 * Остановленный так таймер — с уведомлением: сколько записано и почему.
 */
async function timeEntryTimers(db: Db, now: Date): Promise<void> {
  const rows = (await db.query(
    `select e.id, e.user_id, e.task_id, e.started_at, t.title,
            greatest(e.started_at, coalesce(u.last_seen_bot_at, e.started_at), coalesce(u.last_seen_app_at, e.started_at)) as active_at
       from time_entries e join tasks t on t.id = e.task_id join users u on u.id = e.user_id
      where e.source = 'timer' and e.ended_at is null`,
  )).rows as { id: string; user_id: string; task_id: string; started_at: Date; title: string; active_at: Date }[];
  for (const e of rows) {
    const started = new Date(e.started_at);
    const activeAt = new Date(e.active_at);
    const schedule = await loadUserSchedule(db, e.user_id);
    const dayEnd = workdayEndOf(schedule, started);
    const idleEnd = new Date(activeAt.getTime() + TIMER_IDLE_STOP_MINUTES * 60000);
    const byDayEnd = dayEnd && started < dayEnd && dayEnd <= idleEnd;
    const stopAt = byDayEnd ? dayEnd : idleEnd;
    if (now >= stopAt) {
      const minutes = Math.max(1, Math.round((stopAt.getTime() - started.getTime()) / 60000));
      const closed = await db.query(
        `update time_entries set ended_at = $2, minutes = $3 where id = $1 and ended_at is null`, [e.id, stopAt, minutes]);
      if (!closed.rowCount) continue;
      // Без события: автоостановка — не действие человека, и «застрял ли он» (person_stuck) иначе
      // принимало бы её за движение по делу. Человеку — уведомление ниже.
      await notify(db, {
        userId: e.user_id, kind: 'timer_autostopped', level: 'glance', taskId: e.task_id,
        payload: { title: e.title, minutes, reason: byDayEnd ? 'day_end' : 'idle' }, dedupeKey: `timer_autostopped:${e.id}`,
      });
      continue;
    }
    if (now.getTime() - activeAt.getTime() >= TIMER_CHECK_IDLE_MINUTES * 60000) {
      await notify(db, {
        userId: e.user_id, kind: 'timer_check', level: 'work', taskId: e.task_id,
        payload: { title: e.title, time_entry_id: e.id }, dedupeKey: `timer_check:${e.id}`,
      });
    }
  }
}

export async function runTaskTimers(db: Db, now: Date): Promise<void> {
  await ackTimers(db, now);
  await questionTimers(db, now);
  await dueRequestTimers(db, now);
  await autoAcceptTimers(db, now);
  await reviewSilenceTimers(db, now);
  await dueDateTimers(db, now);
  await stuckAndEstimateTimers(db, now);
  await waitingTimers(db, now);
  await timeEntryTimers(db, now);
}
