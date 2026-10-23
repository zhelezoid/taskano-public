import { setActor, type Db } from '../db/pool.js';
import { ZERO_CURSOR, type EventRow } from '../core/events.js';
import { eventDataForAgent, proposalForAgent, taskForAgent, untrusted } from '../mcp/context.js';
import { cursorGreater, toBig } from './fire.js';
import { drainAgentEvents } from './drain-events.js';
import { ackGroupsReview, groupsBriefing, type GroupsBlock } from '../groups/revision.js';
import { ackOwnerActivity, ownerActivityBriefing, ownerActivityHasContent, type OwnerActivityBlock } from './owner-activity.js';
import { attentionBlock, taskLink, type AttentionBlock } from './attention.js';
import { NOT_SEEN_HOURS, presenceView, type Presence } from '../core/presence.js';

// Сводка для исполнителя агента: один вызов на всю организацию (спека agent-runtime, `get_briefing`).

// Имена — ровно те, что пишут emit()/transition() (EVENT_TYPE в core/lifecycle.ts); skill leading.md ссылается на них.
const AGENT_EVENT_TYPES = new Set([
  'task_submitted', 'task_accepted', 'auto_accepted', 'question', 'unclear', 'declined', 'cancelled', 'postponed',
  'not_acknowledged', 'person_idle', 'person_switched', 'waiting_external', 'external_back', 'waiting_resolved',
  'external_overdue', 'proposal_decided', 'vetoed', 'step_limit', 'autopilot_released', 'channel_dead',
  'invitation_accepted', 'invitation_stalled', 'person_offboarded', 'membership_removed',
  'group_evidence', 'group_blocker', 'attachment_moved', 'comment',
  // Дело, закрытое по ошибке и возвращённое человеком (спека completed-list): без этого агент считает
  // его сделанным и строит дальнейший план по картине, которой уже нет.
  'task_reopened',
  // Срок назвал сам исполнитель и просьба назвать срок осталась без ответа (спека self-set-due):
  // первое меняет план, второе — повод решать, что делать с молчанием.
  'due_set', 'due_request_ignored',
]);

/** Сколько неотвеченных реплик показываем за одну сводку (спека task-comments). */
const COMMENTS_LIMIT = 30;

/** Действия агента, которые считаются ответом на реплику (спека task-comments, «Агент видит»):
 *  `comment_task`, `update_task`, `release_step`, `review_result`. */
const COMMENT_ANSWER_EVENTS = ['comment', 'task_updated', 'task_released', 'task_accepted', 'task_rework'];

/** Закрытая задача: реплика к ней приходит один раз событием и в блок не попадает (edge case спеки). */
const CLOSED_STATUSES = ['done', 'cancelled', 'declined', 'resolved'];

interface BriefingAgent {
  id: string;
  name: string;
  paused: boolean;
  notes: Record<string, string>;
  events: { type: string; task_id: string | null; plan_id: string | null; at: string; data: unknown }[];
  // title задачи из переписки группы — под untrusted (спека group-intake).
  submitted: { id: string; link: string; title: string | ReturnType<typeof untrusted>; assignee_user_id: string }[];
  blocked: { id: string; link: string; title: string | ReturnType<typeof untrusted>; assignee_user_id: string; question: ReturnType<typeof untrusted> }[];
  people_without_ready: { user_id: string; name: string }[];
  proposals: { id: string; type: string; summary: string | ReturnType<typeof untrusted>; status: string }[];
  /** Реплики людей к делам этого агента, на которые он ещё не ответил (спека task-comments). */
  comments: BriefingComment[];
}

interface BriefingComment {
  task: string;
  short_id: string;
  title: ReturnType<typeof untrusted>;
  author: ReturnType<typeof untrusted>;
  kind: 'comment' | 'owner_instruction';
  text: ReturnType<typeof untrusted>;
  at: string;
  answered: false;
}

export interface Briefing {
  now: string;
  org: { name: string; window: unknown; language: string };
  nothing_to_do: boolean;
  cursor: string;
  agents: BriefingAgent[];
  /** Ежечасная ревизия рабочих групп (спека group-intake); null — групп нет. */
  groups: GroupsBlock | null;
  /** Что владелец сделал сам с прошлого ack_briefing (спека owner-feedback). */
  owner_activity: OwnerActivityBlock;
  /** Люди с делами в работе, которые больше NOT_SEEN_HOURS не заходили ни в бота, ни в приложение (спека person-presence). */
  people_not_seen: PersonNotSeen[];
  /**
   * Дела, которые поставил сам тот, кто читает сводку (без агента): сданные ему на проверку и
   * вставшие с вопросом. Раньше сводка видела только дела агентов, и владелец, раздающий работу сам,
   * не узнавал из неё ни о сданном, ни о вопросах (найдено на проверке каталога ChatGPT, 02.10).
   * Отвечать на них — review_result / answer_question. Рутину это не будит: агенту здесь делать нечего.
   */
  awaiting_you: { submitted: BriefingAgent['submitted']; blocked: BriefingAgent['blocked'] };
  playbook: string;
  setup_check?: true;
  /** Только по запросу (`attention: true`): проверка владельца дважды в день (спека owner-attention). */
  attention?: AttentionBlock;
}

interface PersonNotSeen extends Presence {
  user_id: string;
  /** Имя человек задаёт сам — как автор и заголовок в той же сводке, только под untrusted. */
  name: ReturnType<typeof untrusted>;
  tasks_in_work: number;
}

/** Статусы «дело в работе у человека»: ему есть что делать, и тишина от него — уже сигнал. */
const IN_WORK_STATUSES = ['active', 'in_progress', 'rework', 'blocked'];

/**
 * Кто не заходит, хотя работа на нём (спека person-presence). Случай, ради которого это есть: человек
 * принял приглашение, нажал «Готово» и пропал на неделю, а агент считал его «активным участником» —
 * по статусу членства. `greatest` пропускает null: хватает захода по любому каналу. Отметок нет вовсе
 * — человек здесь тоже, но с `seen_tracked_since`: до этой даты их не писали, и «никогда не заходил»
 * о том времени сказать нельзя.
 */
async function loadPeopleNotSeen(db: Db, now: Date, tz: string): Promise<PersonNotSeen[]> {
  const r = await db.query(
    `select u.id as user_id, u.display_name as name, u.last_seen_bot_at, u.last_seen_app_at,
            (select count(*)::int from tasks t where t.assignee_user_id = u.id and t.status = any($1)) as tasks_in_work
       from memberships m join users u on u.id = m.user_id
      where m.org_id = current_setting('app.org_id')::uuid and m.status = 'active' and u.anonymized_at is null
        -- Владельца не считаем: он работает через claude.ai, и сводка, которую он же читает, не должна
        -- говорить ему, что он сам «давно не заходил» в бота.
        and m.role <> 'owner'
        and exists (select 1 from tasks t where t.assignee_user_id = u.id and t.status = any($1))
        and (greatest(u.last_seen_bot_at, u.last_seen_app_at) is null
             or greatest(u.last_seen_bot_at, u.last_seen_app_at) < $2::timestamptz - make_interval(hours => $3))
      order by u.display_name`,
    [IN_WORK_STATUSES, now, NOT_SEEN_HOURS],
  );
  return r.rows.map((row) => ({
    user_id: row.user_id, name: untrusted(row.name), ...presenceView(row.last_seen_bot_at, row.last_seen_app_at, tz, now),
    tasks_in_work: row.tasks_in_work,
  }));
}

function maxCursor(a: string, b: string): string {
  return cursorGreater(toBig(b), toBig(a)) ? b : a;
}

async function loadNotes(db: Db, agentId: string): Promise<Record<string, string>> {
  const r = await db.query(`select key, value from agent_notes where agent_id = $1`, [agentId]);
  return Object.fromEntries(r.rows.map((row) => [row.key, row.value]));
}

async function loadSubmitted(db: Db, agentId: string): Promise<BriefingAgent['submitted']> {
  const r = await db.query(
    // Сданное с проверяющим ждёт его, а не агента (спека task-reviewer): принять его агент не вправе.
    `select id, short_id, title, assignee_user_id, origin from tasks
      where author_agent_id = $1 and status = 'submitted' and reviewer_user_id is null order by submitted_at`,
    [agentId],
  );
  return r.rows.map((row) => { const t = taskForAgent(row); return { id: t.id, link: taskLink(row.short_id), title: t.title, assignee_user_id: t.assignee_user_id }; });
}

async function loadBlocked(db: Db, agentId: string): Promise<BriefingAgent['blocked']> {
  const r = await db.query(
    `select t.id, t.short_id, t.title, t.assignee_user_id, t.origin,
            (select tm.text from task_messages tm where tm.task_id = t.id and tm.kind in ('question','unclear') and tm.answered_at is null
              order by tm.created_at desc limit 1) as question
       from tasks t where t.author_agent_id = $1 and t.status = 'blocked' order by t.blocked_at`,
    [agentId],
  );
  return r.rows.map((row) => ({ id: row.id, link: taskLink(row.short_id), title: taskForAgent(row).title, assignee_user_id: row.assignee_user_id, question: untrusted(row.question) }));
}

async function loadPeopleWithoutReady(db: Db, agentId: string): Promise<BriefingAgent['people_without_ready']> {
  const r = await db.query(
    `select distinct t.assignee_user_id as user_id, u.display_name as name
       from tasks t
       join plans p on p.id = t.plan_id
       join users u on u.id = t.assignee_user_id
      where p.agent_id = $1 and p.status = 'active'
        and not exists (
          select 1 from tasks t2 where t2.author_agent_id = $1 and t2.assignee_user_id = t.assignee_user_id
            and t2.status in ('ready','active','in_progress','blocked')
        )`,
    [agentId],
  );
  return r.rows;
}

/**
 * Неотвеченные реплики людей к открытым делам агента: старые первыми, не больше COMMENTS_LIMIT.
 * «Отвечена» — если после неё агент написал по задаче или изменил её (COMMENT_ANSWER_EVENTS).
 */
async function loadComments(db: Db, agentId: string): Promise<BriefingComment[]> {
  const r = await db.query(
    `select m.task_id, t.short_id, t.title, m.kind, m.text, m.created_at,
            case when coalesce(ms.status, 'removed') = 'removed' then 'former employee' else u.display_name end as author
       from task_messages m
       join tasks t on t.id = m.task_id
       join users u on u.id = m.author_user_id
       left join memberships ms on ms.org_id = t.org_id and ms.user_id = m.author_user_id
      where t.author_agent_id = $1 and m.author_user_id is not null
        and m.kind in ('comment','owner_instruction')
        -- Окно: сводка — про сегодняшнюю работу. Без него на первом запуске всплыли бы все реплики
        -- за всю жизнь организации и вытеснили бы из блока свежие (лимит COMMENTS_LIMIT строк).
        and m.created_at > now() - interval '7 days'
        and not (t.status = any($3))
        and not exists (
          select 1 from events e
           where e.task_id = m.task_id and e.actor_agent_id is not null
             and e.type = any($2) and e.at > m.created_at)
      order by m.created_at limit ${COMMENTS_LIMIT}`,
    [agentId, COMMENT_ANSWER_EVENTS, CLOSED_STATUSES],
  );
  return r.rows.map((row) => ({
    // Заголовок и текст — слова людей: только под untrusted (инвариант «текст людей — недоверенный ввод»).
    task: row.task_id, short_id: String(row.short_id), title: untrusted(row.title),
    author: untrusted(row.author || 'former employee'), kind: row.kind, text: untrusted(row.text),
    at: new Date(row.created_at).toISOString(), answered: false as const,
  }));
}

async function loadDecidedProposals(db: Db, agentId: string, events: EventRow[]): Promise<BriefingAgent['proposals']> {
  const ids = events.filter((e) => e.type === 'proposal_decided').map((e) => e.data.proposal_id as string).filter(Boolean);
  if (!ids.length) return [];
  const r = await db.query(`select id, type, summary, status from proposals where agent_id = $1 and id = any($2::uuid[])`, [agentId, ids]);
  return r.rows.map(proposalForAgent);
}

/** Всё для одного запуска routine (спека, «get_briefing(org)»). Только чтение + сдвиг last_briefing_at. */
/**
 * Сданное, которое принимает `userId` (он проверяющий, а без проверяющего — автор-человек), и вопросы
 * по делам, которые он поставил сам (без агента): спрашивают того, кто поставил. Действующее лицо снято, так
 * что закрытые доски и закрытые проекты отбираются явно: от имени агента (`withPrivate: false`) их
 * не показываем — агенту чужие закрытые дела не видны (спека projects).
 */
async function loadAwaitingYou(db: Db, userId: string, withPrivate: boolean): Promise<Briefing['awaiting_you']> {
  const visible = withPrivate ? '' : 'and t.private_owner_user_id is null and not coalesce(p.private, false)';
  const r = await db.query(
    `select t.id, t.short_id, t.title, t.assignee_user_id, t.origin, t.status,
            (select tm.text from task_messages tm where tm.task_id = t.id and tm.kind in ('question','unclear') and tm.answered_at is null
              order by tm.created_at desc limit 1) as question
       from tasks t left join projects p on p.id = t.project_id
      where true ${visible}
        and ((t.status = 'submitted'
              and coalesce(t.reviewer_user_id, case when t.author_agent_id is null then t.author_user_id end) = $1)
          or (t.author_user_id = $1 and t.author_agent_id is null and t.status <> 'submitted'
              and (t.status = 'blocked'
                   -- Вопрос по делу из очереди статус не меняет (оно остаётся ready), но ответа ждёт так же
                   --: иначе вопрос Марии по NOR-032 в сводку не попадал вовсе.
                   or (t.status not in ('done', 'cancelled', 'declined') and exists (
                     select 1 from task_messages q where q.task_id = t.id and q.kind in ('question','unclear') and q.answered_at is null)))))
      order by coalesce(t.submitted_at, t.blocked_at, t.updated_at)`,
    [userId],
  );
  const submitted: BriefingAgent['submitted'] = [];
  const blocked: BriefingAgent['blocked'] = [];
  for (const row of r.rows) {
    const title = taskForAgent(row).title;
    const link = taskLink(row.short_id);
    if (row.status === 'submitted') submitted.push({ id: row.id, link, title, assignee_user_id: row.assignee_user_id });
    else blocked.push({ id: row.id, link, title, assignee_user_id: row.assignee_user_id, question: untrusted(row.question) });
  }
  return { submitted, blocked };
}

export async function getBriefing(
  db: Db, now: Date,
  opts: { setupCheck?: boolean; attention?: boolean; viewerTz?: string; viewer?: { userId: string; withPrivate: boolean } } = {},
): Promise<Briefing> {
  // Сводка — агентская по смыслу, кто бы её ни позвал. Снимаем действующее лицо: иначе она читала
  // бы дела с правами человека и вынесла агенту содержимое его закрытых проектов (спека projects).
  await setActor(db, null);
  const org = (await db.query(`select id, name, owner_user_id, agent_window, language from orgs where id = current_setting('app.org_id')::uuid`)).rows[0];
  const agentRows = (await db.query(`select id, name, status from agents where org_id = current_setting('app.org_id')::uuid order by name`)).rows;
  const playbookRow = (await db.query(`select text from playbooks where org_id = current_setting('app.org_id')::uuid`)).rows[0];

  let cursor = ZERO_CURSOR;
  let hasContent = false;
  const agents: BriefingAgent[] = [];
  for (const a of agentRows) {
    const cursorRow = (await db.query(`select cursor from agent_cursors where org_id = current_setting('app.org_id')::uuid and agent_id = $1`, [a.id])).rows[0];
    const startCursor = cursorRow?.cursor ?? ZERO_CURSOR;
    const { events, cursor: nextCursor } = await drainAgentEvents(db, startCursor, a.id);
    cursor = maxCursor(cursor, nextCursor);

    // Своя реплика — не событие для себя: `comment` пишут и люди, и сам агент (`comment_task`).
    const relevant = events.filter((e) => AGENT_EVENT_TYPES.has(e.type) && !(e.type === 'comment' && e.actor_agent_id));
    const submitted = await loadSubmitted(db, a.id);
    const blocked = await loadBlocked(db, a.id);
    const peopleWithoutReady = await loadPeopleWithoutReady(db, a.id);
    const proposals = await loadDecidedProposals(db, a.id, events);
    const comments = await loadComments(db, a.id);
    const notes = await loadNotes(db, a.id);
    // Реплика к делу агента на паузе рутину не будит: ответить он не может (`agent_paused` на любую
    // запись), а строка висела бы вечно. Всё остальное — вопросы, сдача, предложения — будит как
    // раньше: вопрос человека нельзя похоронить молча только потому, что направление на паузе.
    const otherEvents = relevant.filter((e) => e.type !== 'comment');
    const anyComment = comments.length > 0 || otherEvents.length < relevant.length;
    const commentWakes = anyComment && a.status !== 'paused';
    if (otherEvents.length || submitted.length || blocked.length || peopleWithoutReady.length
      || proposals.length || commentWakes) hasContent = true;

    agents.push({
      id: a.id, name: a.name, paused: a.status === 'paused', notes,
      events: relevant.map((e) => ({ type: e.type, task_id: e.task_id, plan_id: e.plan_id, at: new Date(e.at).toISOString(), data: eventDataForAgent(e.data) })),
      submitted, blocked, people_without_ready: peopleWithoutReady, proposals, comments,
    });
  }

  const groups = await groupsBriefing(db, now, cursor);
  // Новое из групп — повод для запуска; close_candidates — состояние, само по себе запуск не требует.
  if (groups && (groups.attached.length || groups.created.length || groups.unmatched.length)) hasContent = true;

  const ownerActivity = await ownerActivityBriefing(db, org.id, org.owner_user_id, now, cursor);
  if (ownerActivityHasContent(ownerActivity)) hasContent = true;
  // Состояние, а не новость: само по себе запуск не требует — иначе один пропавший человек будил бы
  // рутину каждый час, пока не объявится.
  // «Вчера» — в поясе того, кто читает сводку; без него (фоновый вызов) — UTC.
  const peopleNotSeen = await loadPeopleNotSeen(db, now, opts.viewerTz ?? 'UTC');
  const awaitingYou = opts.viewer
    ? await loadAwaitingYou(db, opts.viewer.userId, opts.viewer.withPrivate)
    : { submitted: [], blocked: [] };

  await db.query(
    `update runners set last_briefing_at = $1, updated_at = $1 where org_id = current_setting('app.org_id')::uuid`,
    [now],
  );

  return {
    now: now.toISOString(),
    org: { name: org.name, window: org.agent_window, language: org.language },
    nothing_to_do: !hasContent,
    cursor,
    agents,
    groups,
    owner_activity: ownerActivity,
    people_not_seen: peopleNotSeen,
    awaiting_you: awaitingYou,
    playbook: playbookRow?.text ?? '',
    ...(opts.setupCheck ? { setup_check: true as const } : {}),
    ...(opts.attention ? { attention: await attentionBlock(db, now, org.agent_window) } : {}),
  };
}

/** Сдвигает курсор всех агентов организации до `cursor`, только вперёд (спека, «Edge cases»). */
export async function ackBriefing(db: Db, cursor: string): Promise<void> {
  await setActor(db, null);
  const target = toBig(cursor);
  const agentRows = (await db.query(`select id from agents where org_id = current_setting('app.org_id')::uuid`)).rows as { id: string }[];
  for (const a of agentRows) {
    const cur = (await db.query(
      `select cursor from agent_cursors where org_id = current_setting('app.org_id')::uuid and agent_id = $1 for update`, [a.id],
    )).rows[0];
    if (!cur) {
      await db.query(
        `insert into agent_cursors(org_id, agent_id, cursor) values (current_setting('app.org_id')::uuid, $1, $2)`, [a.id, cursor],
      );
      continue;
    }
    if (cursorGreater(target, toBig(cur.cursor))) {
      await db.query(`update agent_cursors set cursor = $2 where org_id = current_setting('app.org_id')::uuid and agent_id = $1`, [a.id, cursor]);
    }
  }
  await ackGroupsReview(db, cursor);
  await ackOwnerActivity(db, cursor);
}
