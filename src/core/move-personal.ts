import type { Db } from '../db/pool.js';
import { ensureDefaultProject, nextProjectNumber, suggestKey, taskKey, type ProjectRow } from './projects.js';
import { fillSlot } from './queue.js';
import type { Task } from './types.js';
import { access, copyFile, mkdir, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { logger } from '../log.js';
import { dirname } from 'node:path';
import { mediaPath } from '../groups/media.js';

// Переезд личных дел в закрытые проекты компании (спека projects-stage2).
//
// Личные организации после переезда остаются — пустыми: ошибка тогда обратима сменой
// одного поля, а не восстановлением из бэкапа. Человек без компании остаётся как был: ему некуда.

export interface MoveCandidate {
  user_id: string;
  name: string;
  personal_org_id: string;
  company_id: string | null;
  tasks: number;
}

export interface MoveResult {
  name: string;
  board: string | null;
  key: string | null;
  moved: number;
  shared: number;
  left: number;
  skipped?: 'no_company';
}

/** Кому есть что перевозить: дела в личном пространстве плюс компания, куда их везти. */
export async function movePlan(db: Db): Promise<MoveCandidate[]> {
  const r = await db.query(`
    select
      u.id as user_id,
      coalesce(nullif(u.display_name, ''), split_part(e.email::text, '@', 1)) as name,
      p.id as personal_org_id,
      (select count(*)::int from tasks t where t.org_id = p.id and t.assignee_user_id = u.id) as tasks,
      (select o.id from memberships m join orgs o on o.id = m.org_id
        where m.user_id = u.id and m.status = 'active' and o.kind = 'company'
        order by m.joined_at nulls last, o.created_at limit 1) as company_id
    from users u
    join orgs p on p.owner_user_id = u.id and p.kind = 'personal'
    left join user_emails e on e.user_id = u.id and e.is_primary
    where u.anonymized_at is null
    order by u.display_name`);
  return (r.rows as MoveCandidate[]).filter((row) => row.tasks > 0);
}

/** Закрытый проект человека в его компании. Названа его именем: «Личное» соседу ничего не говорит. */
export async function ensureOwnBoard(db: Db, companyId: string, userId: string, personName: string): Promise<ProjectRow> {
  const existing = await db.query(
    `select * from projects where org_id = $1 and owner_user_id = $2 and private and status = 'active'
      order by created_at limit 1`, [companyId, userId]);
  if (existing.rowCount) return existing.rows[0] as ProjectRow;
  const name = personName?.trim() || 'My project';
  const key = await suggestKey(db, companyId, name);
  const r = await db.query(
    `insert into projects(org_id, name, owner_user_id, private, key)
     values ($1, $2, $3, true, $4) returning *`, [companyId, name, userId, key]);
  return r.rows[0] as ProjectRow;
}

/** История дела переезжает вместе с ним: без неё на новом месте останется голая карточка. */
// `task_views` — отметки «открывал карточку» (спека unread-and-deeplink): без них дело на новом месте
// загорелось бы новым, а отложенный внешний ключ уронил бы весь переезд на commit.
const HISTORY_TABLES = ['events', 'task_messages', 'task_results', 'task_sources', 'task_attachments',
  'notifications', 'time_entries', 'task_views'];

/**
 * Фото дела (спека task-photos) переезжают копией: файл лежит под каталогом старого пространства, а
 * его запись media может быть общей с другим делом (дедупликация по sha256). Копия файла в каталоге
 * новой организации и своя запись media там; старая запись истечёт и уберётся очисткой как обычно —
 * вместе со своим файлом, который новой записи уже не нужен.
 */
async function moveMedia(db: Db, taskId: string, orgId: string): Promise<void> {
  const rows = (await db.query(
    `select a.id as attachment_id, m.* from task_attachments a join media m on m.id = a.media_id where a.task_id = $1`,
    [taskId])).rows;
  for (const m of rows) {
    const rel = `${orgId}/${m.sha256}.jpg`;
    const dest = mediaPath(rel);
    // Тот же sha в компании уже есть — файл тот же байт в байт, перезаписывать нечего: копия поверх
    // была бы неатомарной, и чужое дело прочло бы недописанный JPEG (ревью 07.10).
    const exists = await access(dest).then(() => true, () => false);
    if (!exists) {
      await mkdir(dirname(dest), { recursive: true });
      const tmp = `${dest}.${randomUUID()}.tmp`;
      try {
        await copyFile(mediaPath(m.path), tmp);
        await rename(tmp, dest);
      } catch (e) {
        // Файла нет на диске — переезд дела не валим: запись переедет, картинка просто не откроется.
        logger.warn({ err: e, task: taskId, media: m.id }, 'move-personal: файл фото не скопирован');
      }
    }
    const inserted = await db.query(
      `insert into media(org_id, sha256, file_unique_id, path, width, height, bytes, analysis, created_at, expires_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       on conflict (org_id, sha256) do nothing returning id`,
      [orgId, m.sha256, m.file_unique_id, rel, m.width, m.height, m.bytes, m.analysis, m.created_at, m.expires_at]);
    const mediaId = inserted.rowCount
      ? inserted.rows[0].id as string
      : (await db.query('select id from media where org_id = $1 and sha256 = $2', [orgId, m.sha256])).rows[0].id as string;
    // Организация и файл меняются одной строкой: внешний ключ (org_id, media_id) не отложенный.
    await db.query('update task_attachments set org_id = $3, media_id = $2, message_id = null where id = $1', [m.attachment_id, mediaId, orgId]);
  }
}

async function moveOne(db: Db, task: Task, orgId: string, project: ProjectRow, isPrivate: boolean): Promise<void> {
  const fromKey = (await db.query('select key from projects where id = $1', [task.project_id])).rows[0]?.key as string | undefined;
  const former = taskKey(fromKey, task.number);
  const number = await nextProjectNumber(db, project.id);
  // Отложенные внешние ключи: дело и его история меняют org_id в одной транзакции (миграция 007).
  await db.query('set constraints all deferred');
  await moveMedia(db, task.id, orgId);
  for (const table of HISTORY_TABLES) {
    await db.query(`update ${table} set org_id = $2 where task_id = $1`, [task.id, orgId]);
  }
  await db.query(
    `update translations set org_id = $2 where object_type = 'task' and object_id = $1`, [task.id, orgId]);
  await db.query(
    `update tasks
        set org_id = $2, project_id = $3, private_owner_user_id = $4, number = $5, shared_org_id = null,
            former_keys = case when $6::text is null then former_keys else array_append(former_keys, $6) end,
            version = version + 1, updated_at = now()
      where id = $1`,
    [task.id, orgId, project.id, isPrivate ? task.assignee_user_id : null, number, former]);
}

/**
 * Перевезти дела одного человека. Дело с пометкой «рабочее» уезжает в ту компанию, с которой им
 * поделились, в её открытую проект: пометка ровно об этом и говорила.
 */
export async function movePerson(db: Db, person: MoveCandidate): Promise<MoveResult> {
  if (!person.company_id) {
    return { name: person.name, board: null, key: null, moved: 0, shared: 0, left: person.tasks, skipped: 'no_company' };
  }
  const tasks = (await db.query(
    `select * from tasks where org_id = $1 and assignee_user_id = $2 order by created_at, id`,
    [person.personal_org_id, person.user_id])).rows as Task[];
  const board = await ensureOwnBoard(db, person.company_id, person.user_id, person.name);
  let moved = 0;
  let shared = 0;
  for (const task of tasks) {
    if (task.shared_org_id) {
      const open = await ensureDefaultProject(db, task.shared_org_id);
      await moveOne(db, task, task.shared_org_id, open, false);
      shared += 1;
    } else {
      await moveOne(db, task, person.company_id, board, true);
      moved += 1;
    }
  }
  // Очередь пересчитывается после переезда: иначе у человека есть дела, но «Сейчас» пустует —
  // слот остался в покинутой организации. `app.org_id` нужен самому `fillSlot`.
  await db.query(`select set_config('app.org_id', $1, true)`, [person.company_id]);
  await fillSlot(db, person.user_id);

  const left = (await db.query('select count(*)::int as n from tasks where org_id = $1', [person.personal_org_id])).rows[0].n as number;
  return { name: person.name, board: board.name, key: board.key, moved, shared, left };
}
