import type { Db } from '../db/pool.js';
import { env } from '../config/env.js';
import { windowSchedule, workingMinutesBetween } from '../core/calendar.js';
import { taskForAgent, untrusted } from '../mcp/context.js';

// Блок «внимание» сводки (спека owner-attention): владелец дважды в день хочет знать
// две вещи — где человек написал по делу и остался без ответа, и где дела пересекаются по смыслу.
// Первое считает сервер (время и рабочие часы модель путает), второе — модель по списку дел,
// который сервер ей отдаёт. Это состояние, а не новость: курсора у блока нет, рутину он не будит.

/** Сколько рабочих минут реплика или сданное ждёт, прежде чем попасть в блок. */
export const ATTENTION_WAIT_MINUTES = 60;
/** Описание дела в списке для сверки — суть, а не всё дело: пересечение видно по началу. */
const DESCRIPTION_CHARS = 300;
const LIST_LIMIT = 50;

const CLOSED = ['done', 'cancelled', 'declined', 'resolved'];
/** Чем человек пишет по делу и чего ждёт ответа. Ответ автора (`answer`) и причины возврата — не сюда. */
const ASKING_KINDS = ['comment', 'question', 'unclear'];
/** Что после реплики считается откликом: другой человек или агент написал, изменил дело, принял или вернул. */
const REPLY_EVENTS = ['comment', 'task_updated', 'task_accepted', 'task_rework', 'task_released', 'due_set'];

/** Ссылка на дело в боте. С ключом доски (`t_356_NOR-033`) человек узнаёт в ней дело, которое видит в
 *  приложении; открывает его по-прежнему номер до `_`, поэтому после переезда на другую доску
 *  старая ссылка ведёт туда же. */
export const taskLink = (shortId: string | number, key?: string | null): string =>
  `https://t.me/${env.telegramBotUsername}?start=t_${shortId}${key ? `_${key}` : ''}`;

type Text = ReturnType<typeof untrusted>;

export interface AttentionBlock {
  /** Человек написал по открытому делу, а отклика нет дольше ATTENTION_WAIT_MINUTES рабочих минут. */
  unanswered: {
    task: string; short_id: string; link: string; title: Text | string; status: string;
    set_by: Text; assignee: Text; writer: Text; kind: string; text: Text; at: string; waiting_working_minutes: number;
  }[];
  /** Сдано и не принято дольше ATTENTION_WAIT_MINUTES рабочих минут. */
  waiting_review: {
    task: string; short_id: string; link: string; title: Text | string;
    set_by: Text; assignee: Text; submitted_at: string; waiting_working_minutes: number;
    /** Кто принимает, если не автор (спека task-reviewer): с вопросом «почему не принято» идут к нему. */
    reviewer: Text | null;
  }[];
  /** Открытые дела каждого — для сверки пересечений по смыслу. */
  people: {
    user_id: string; name: Text;
    tasks: { task: string; short_id: string; link: string; title: Text | string; description: Text | string | null;
      status: string; due_date: string | null; project: Text; set_by: Text }[];
  }[];
}

/** Закрытое не показываем: блок — часть сводки, а её читает рутина агентов (спека projects).
 *  Без действующего лица закрытые доски скрывает и RLS; условие держим явно, как в awaiting_you. */
const VISIBLE = 't.private_owner_user_id is null and not coalesce(p.private, false)';

export async function attentionBlock(db: Db, now: Date, window: { tz: string; days: number[]; start: string; end: string }): Promise<AttentionBlock> {
  const schedule = windowSchedule(window);
  const waited = (from: Date | string): number => workingMinutesBetween(schedule, new Date(from), now);
  const name = (v: string | null): Text => untrusted(v ?? 'former employee');

  // Последняя реплика человека по каждому делу, после которой никто другой не откликнулся.
  const asked = (await db.query(
    `select distinct on (t.id) t.id, t.short_id, t.title, t.origin, t.status, m.kind, m.text, m.created_at,
            coalesce(sa.name, su.display_name) as set_by, au.display_name as assignee, wu.display_name as writer
       from task_messages m
       join tasks t on t.id = m.task_id
       left join projects p on p.id = t.project_id
       left join users su on su.id = t.author_user_id
       left join agents sa on sa.id = t.author_agent_id
       left join users au on au.id = t.assignee_user_id
       join users wu on wu.id = m.author_user_id
      where ${VISIBLE} and not (t.status = any($1))
        and m.kind = any($2) and m.answered_at is null
        -- Ждёт ответа тот, кто делает, а не тот, кто поставил: реплики постановщика
        -- исполнителю — чаще уточнения, и в отчёте владельцу они были бы шумом.
        and m.author_user_id is distinct from t.author_user_id
        -- Сданное ждёт приёмки, а не ответа: оно в waiting_review, второй раз его не показываем.
        and t.status <> 'submitted'
        and not exists (select 1 from task_messages r where r.task_id = t.id and r.created_at > m.created_at
                          and (r.author_user_id is distinct from m.author_user_id or r.author_agent_id is not null))
        and not exists (select 1 from events e where e.task_id = t.id and e.at > m.created_at and e.type = any($3)
                          and (e.actor_user_id is distinct from m.author_user_id or e.actor_agent_id is not null))
      order by t.id, m.created_at desc`,
    [CLOSED, ASKING_KINDS, REPLY_EVENTS],
  )).rows;
  const unanswered = asked
    .map((r) => ({
      task: r.id, short_id: String(r.short_id), link: taskLink(r.short_id), title: taskForAgent(r).title, status: r.status,
      set_by: name(r.set_by), assignee: name(r.assignee), writer: name(r.writer), kind: r.kind, text: untrusted(r.text)!,
      at: new Date(r.created_at).toISOString(), waiting_working_minutes: waited(r.created_at),
    }))
    .filter((r) => r.waiting_working_minutes >= ATTENTION_WAIT_MINUTES)
    .sort((a, b) => a.at.localeCompare(b.at))
    .slice(0, LIST_LIMIT);

  const submitted = (await db.query(
    `select t.id, t.short_id, t.title, t.origin, t.submitted_at,
            coalesce(sa.name, su.display_name) as set_by, au.display_name as assignee, t.reviewer_user_id, ru.display_name as reviewer
       from tasks t
       left join projects p on p.id = t.project_id
       left join users su on su.id = t.author_user_id
       left join agents sa on sa.id = t.author_agent_id
       left join users au on au.id = t.assignee_user_id
       left join users ru on ru.id = t.reviewer_user_id
      where ${VISIBLE} and t.status = 'submitted' and t.submitted_at is not null
      order by t.submitted_at`,
  )).rows;
  const waitingReview = submitted
    .map((r) => ({
      task: r.id, short_id: String(r.short_id), link: taskLink(r.short_id), title: taskForAgent(r).title,
      set_by: name(r.set_by), assignee: name(r.assignee),
      submitted_at: new Date(r.submitted_at).toISOString(), waiting_working_minutes: waited(r.submitted_at),
      reviewer: r.reviewer_user_id ? name(r.reviewer) : null,
    }))
    .filter((r) => r.waiting_working_minutes >= ATTENTION_WAIT_MINUTES)
    .slice(0, LIST_LIMIT);

  const open = (await db.query(
    `select t.id, t.short_id, t.title, t.description, t.origin, t.status, to_char(t.due_date, 'YYYY-MM-DD') as due_date,
            t.assignee_user_id, au.display_name as assignee, p.name as project,
            coalesce(sa.name, su.display_name) as set_by
       from tasks t
       join memberships ms on ms.org_id = t.org_id and ms.user_id = t.assignee_user_id and ms.status = 'active'
       join users au on au.id = t.assignee_user_id
       left join projects p on p.id = t.project_id
       left join users su on su.id = t.author_user_id
       left join agents sa on sa.id = t.author_agent_id
      where ${VISIBLE} and not (t.status = any($1))
      order by au.display_name, t.due_date nulls last, t.created_at`,
    [CLOSED],
  )).rows;
  const byPerson = new Map<string, AttentionBlock['people'][number]>();
  for (const r of open) {
    let person = byPerson.get(r.assignee_user_id);
    if (!person) {
      person = { user_id: r.assignee_user_id, name: name(r.assignee), tasks: [] };
      byPerson.set(r.assignee_user_id, person);
    }
    const short = r.description == null ? null : String(r.description).slice(0, DESCRIPTION_CHARS);
    const marked = taskForAgent({ title: r.title, description: short, origin: r.origin });
    const description = marked.description as Text | string | null;
    person.tasks.push({
      task: r.id, short_id: String(r.short_id), link: taskLink(r.short_id), title: marked.title, description,
      status: r.status, due_date: r.due_date, project: untrusted(r.project), set_by: name(r.set_by),
    });
  }


  return { unanswered, waiting_review: waitingReview, people: [...byPerson.values()] };
}
