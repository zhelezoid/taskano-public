import type { Db } from '../db/pool.js';
import { t } from '../i18n/index.js';
import { AppError } from './errors.js';
import { emit } from './events.js';
import { noteManagerChange, requireAuthorOrManager } from './tasks.js';
import type { Actor, Task } from './types.js';
import { actorAgentId, actorUserId } from './types.js';

// Проекты — спека projects. Дело лежит в проекте: папке по теме. Проект либо открыт
// (его ведут агенты, видит организация), либо закрыт — тогда его дела видны только хозяину, и эту
// границу держит RLS (`private_owner_user_id` + `app.actor_user_id`, миграция 008), а не код.

export interface ProjectRow {
  id: string;
  org_id: string;
  name: string;
  /** Ключ проекта: «NOR». Вместе с номером дела — его обозначение (спека projects-stage2). */
  key: string;
  description: string;
  owner_user_id: string;
  private: boolean;
  status: 'active' | 'archived';
  created_at: Date;
  archived_at: Date | null;
}

/** Куда ложится дело, для которого проект не назвали. Имя видно человеку — его можно переименовать. */
/** Имя проекта по умолчанию — на языке организации: у англоязычного клиента не должно появиться
 *  русское слово только потому, что пилот был русским. Личное пространство уходит во втором этапе
 *  проектов, до тех пор его имя совпадает с именем самого пространства. */
function defaultProjectName(kind: 'company' | 'personal', language: string): string {
  return kind === 'company' ? t(language, 'project.default') : t(language, 'personal.header');
}

const UUID = /^[0-9a-f-]{36}$/i;
const OPEN_STATUSES = ['draft', 'scheduled', 'ready', 'active', 'in_progress', 'blocked', 'waiting_external', 'submitted', 'rework', 'waiting'];

/**
 * Человек сессии: тот, кому видны его закрытые проекты. Агент действует от своего имени — человека
 * за ним не видно, иначе агент нашёл бы закрытые проекты владельца по названию.
 * Ровно то же правило, что у `app.actor_user_id` в сессии (src/mcp/context.ts).
 */
export const sessionUser = (actor: Actor): string | null => (actor.kind === 'user' ? actor.userId : null);

/** Уникальное имя открытого проекта (projects_open_name_ci) — человеческая ошибка, не сбой. */
function asAppError(e: unknown): never {
  if ((e as { code?: string }).code === '23505') throw new AppError('conflict', 'A project with this name already exists');
  throw e;
}

/**
 * Проект организации по умолчанию: «Разное» в компании, «Личное» в личном пространстве — самый
 * первый открытый проект. Закрытым он не бывает: в проект по умолчанию складывается всё, для чего
 * проект не назвали, в том числе дела, поставленные агентом другому человеку.
 * `orgId` передаётся явно: перенос дела между организациями идёт под служебной ролью, где
 * `app.org_id` не задан (src/core/routing.ts).
 */
// Кириллица латиницей — для ключа проекта, не для показа людям: ключ читается вслух и ищется
// («RAZ-001»), поэтому достаточно узнаваемых первых букв. Турецкие и вьетнамские буквы — это
// латиница с диакритикой, её снимает нормализация.
const CYRILLIC: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm',
  н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya', і: 'i', ї: 'yi', є: 'ye', ґ: 'g',
};

/** Название латиницей: кириллица по таблице, диакритика снята, «ı» и «đ» — их латинские пары. */
export function transliterate(name: string): string {
  return [...name.toLowerCase()].map((c) => CYRILLIC[c] ?? c).join('')
    .replace(/ı/g, 'i').replace(/đ/g, 'd')
    .normalize('NFD').replace(/\p{M}/gu, '');
}

/**
 * Ключ проекта (спека projects-stage2): 2–5 латинских букв или цифр из названия,
 * уникальные в организации. Порядок: латиница названия проекта, затем латиница названия компании
 * («Northwind» → «NOR»), затем транслитерация (спека multi-company-person: «Разное» → «RAZ») —
 * раньше кириллическое название вырождалось в безликий `B2`, и дела двух компаний подписывались
 * одинаково. Совсем нечего взять — запасной `B<n>`. Ключ выдаётся один раз и дальше не меняется:
 * он уходит в переписку, поэтому уже выданные `B2` остаются как есть.
 */
export async function suggestKey(db: Db, orgId: string, name: string, wanted?: string | null): Promise<string> {
  const clean = (s: string): string => s.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  const asked = wanted ? clean(wanted).slice(0, 5) : '';
  if (wanted && asked.length < 2) throw new AppError('validation_failed', 'A project key is 2 to 5 latin letters or digits');
  // Название проекта латиницы не дало («Разное», «Личное») — берём из названия компании: «Northwind»
  // превращает дела в «NOR-001», что человек и ожидает увидеть. Латиницы нет и там — транслитерация.
  // Совсем нечего взять (иероглифы, одни знаки) — запасной «B».
  const fromName = clean(name).slice(0, 3);
  const orgName = fromName.length >= 2 ? '' : (await db.query('select name from orgs where id = $1', [orgId])).rows[0]?.name as string ?? '';
  const candidates = [fromName, clean(orgName).slice(0, 3), clean(transliterate(name)).slice(0, 3), clean(transliterate(orgName)).slice(0, 3)];
  const base = asked || (candidates.find((c) => c.length >= 2) ?? '');
  const taken = new Set((await db.query('select key from projects where org_id = $1 and key is not null', [orgId]))
    .rows.map((r) => r.key as string));
  if (asked) {
    if (taken.has(asked)) throw new AppError('conflict', `The key "${asked}" is already used by another project`);
    return asked;
  }
  if (base.length >= 2 && !taken.has(base)) return base;
  // Занято или считать не из чего: добавляем номер, пока не найдём свободный.
  const stem = base.length >= 2 ? base : 'B';
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${stem}${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new AppError('conflict', 'No free project key is left — name the project differently');
}

/**
 * Следующий номер дела внутри проекта. Счётчик двигается тем же запросом, который его
 * читает, поэтому две параллельные вставки получают разные номера: строка проекта блокируется.
 */
export async function nextProjectNumber(db: Db, projectId: string): Promise<number> {
  const r = await db.query(
    'update projects set next_number = next_number + 1 where id = $1 returning next_number - 1 as number',
    [projectId],
  );
  if (!r.rowCount) throw new AppError('not_found', 'Project not found');
  return r.rows[0].number as number;
}

/**
 * Состав проекта (спека projects-stage2): кто видит её дела, помимо хозяина. Добавляет
 * хозяин проекта или админ организации — чужую проект в свой состав никто себе не припишет.
 */
export async function addProjectMember(db: Db, projectRef: string, personRef: string, actor: Actor): Promise<{ project: ProjectRow; user_id: string }> {
  const userId = actorUserId(actor);
  if (!userId) throw new AppError('forbidden', 'The system does not change project membership');
  if (actorAgentId(actor)) throw new AppError('forbidden', 'Project membership is a person\'s decision, not an agent\'s');
  const project = await resolveProject(db, projectRef, userId);
  await assertProjectKeeper(db, project, userId);
  const member = await resolvePerson(db, personRef);
  await db.query(
    `insert into project_members(project_id, user_id, org_id, added_by)
     values ($1, $2, current_setting('app.org_id')::uuid, $3)
     on conflict (project_id, user_id) do nothing`, [project.id, member, userId]);
  await emit(db, {
    type: 'board_member_added', actorUserId: userId,
    data: { project_id: project.id, name: project.name, user_id: member },
  });
  return { project, user_id: member };
}

export async function removeProjectMember(db: Db, projectRef: string, personRef: string, actor: Actor): Promise<{ project: ProjectRow; user_id: string }> {
  const userId = actorUserId(actor);
  if (!userId) throw new AppError('forbidden', 'The system does not change project membership');
  const project = await resolveProject(db, projectRef, userId);
  await assertProjectKeeper(db, project, userId);
  const member = await resolvePerson(db, personRef);
  // Проверяющий открытого дела закрытого проекта, выпавший из состава, перестал бы видеть то, что
  // ему придёт на приёмку (спека task-reviewer). Как с закрытием проекта при чужом проверяющем —
  // отказ с перечнем дел: сначала сменить проверяющего.
  if (project.private) {
    const held = (await db.query(
      `select number, short_id::text from tasks where project_id = $1 and reviewer_user_id = $2
          and status not in ('done','declined','cancelled','resolved') order by number`,
      [project.id, member])).rows.map((r) => taskKey(project.key, r.number as number) ?? (r.short_id as string));
    if (held.length) {
      throw new AppError('validation_failed',
        `The person checks open items of this project — name another reviewer first: ${held.join(', ')}`, { tasks: held });
    }
  }
  await db.query('delete from project_members where project_id = $1 and user_id = $2', [project.id, member]);
  await emit(db, {
    type: 'board_member_removed', actorUserId: userId,
    data: { project_id: project.id, name: project.name, user_id: member },
  });
  return { project, user_id: member };
}

/** Состав проекта для выдачи: имена, а не идентификаторы. */
export async function projectMembers(db: Db, projectId: string): Promise<{ user_id: string; name: string }[]> {
  const r = await db.query(
    `select m.user_id, u.display_name as name from project_members m join users u on u.id = m.user_id
      where m.project_id = $1 order by u.display_name`, [projectId]);
  return r.rows as { user_id: string; name: string }[];
}

/** Состав меняет хозяин проекта или админ организации: иначе любой вписал бы себя в чужую проект. */
async function assertProjectKeeper(db: Db, project: ProjectRow, userId: string): Promise<void> {
  // Действующее членство проверяется и у хозяина проекта: выведенный из компании хозяин остаётся
  // записан в `owner_user_id`, и без этой проверки он распоряжался бы составом (ревью диффа).
  const r = await db.query(
    `select role from memberships where org_id = current_setting('app.org_id')::uuid and user_id = $1 and status = 'active'`,
    [userId]);
  const role = r.rows[0]?.role as string | undefined;
  if (!role) throw new AppError('forbidden', 'You are not in this organization');
  if (project.owner_user_id === userId) return;
  if (role !== 'owner' && role !== 'admin') {
    throw new AppError('forbidden', `Board "${project.name}" is kept by its owner — ask them to add people`);
  }
}

/** Человек организации по id или имени: состав собирается из тех, кто в ней действует. */
async function resolvePerson(db: Db, ref: string): Promise<string> {
  const trimmed = ref.trim();
  const r = await db.query(
    `select u.id from memberships m join users u on u.id = m.user_id
      left join user_emails e on e.user_id = u.id
      where m.org_id = current_setting('app.org_id')::uuid and m.status in ('active','invited')
        and (u.id::text = $1 or lower(u.display_name) = lower($1) or lower(e.email::text) = lower($1))
      limit 2`, [trimmed]);
  if (r.rowCount === 1) return r.rows[0].id as string;
  if ((r.rowCount ?? 0) > 1) throw new AppError('validation_failed', `"${ref}" is ambiguous — pass the person id`);
  throw new AppError('not_found', `"${ref}" is not a person of this organization`);
}

/** Обозначение дела для человека: «NOR-001». Без проекта или номера обозначения нет. */
export function taskKey(projectKey: string | null | undefined, number: number | null | undefined): string | null {
  if (!projectKey || !number) return null;
  return `${projectKey}-${String(number).padStart(3, '0')}`;
}

export async function ensureDefaultProject(db: Db, orgId: string): Promise<ProjectRow> {
  const existing = (await db.query(
    `select * from projects where org_id = $1 and not private and status = 'active'
      order by created_at, id limit 1`, [orgId])).rows[0] as ProjectRow | undefined;
  if (existing) return existing;
  const org = (await db.query('select kind, owner_user_id, language from orgs where id = $1', [orgId])).rows[0] as
    { kind: 'company' | 'personal'; owner_user_id: string; language: string } | undefined;
  if (!org) throw new AppError('not_found', 'Organization not found');
  const name = defaultProjectName(org.kind, org.language);
  const r = await db.query(
    `insert into projects(org_id, name, owner_user_id, private, key) values ($1, $2, $3, false, $4) returning *`,
    [orgId, name, org.owner_user_id, await suggestKey(db, orgId, name)],
  ).catch(asAppError);
  return r.rows[0] as ProjectRow;
}

/**
 * Закрытый проект человека в текущей организации (спека projects-stage2). После переезда «личное» —
 * это она: дела лежат в компании, но видны только хозяину. Пока человек не переехал, проекта нет и
 * личное остаётся отдельной организацией — тогда null, и работают прежние правила.
 */
export async function ownBoardId(db: Db, userId: string): Promise<string | null> {
  const r = await db.query(
    `select id from projects
      where org_id = current_setting('app.org_id')::uuid and owner_user_id = $1 and private and status = 'active'
      order by created_at limit 1`, [userId]);
  return (r.rows[0]?.id as string) ?? null;
}

/** Проект по id или имени среди видимых в организации. Закрытый чужой не находится — его нет для
 *  этого человека; проект, в состав которой его добавили, находится. */
export async function resolveProject(db: Db, ref: string, userId: string | null): Promise<ProjectRow> {
  const trimmed = ref.trim();
  const visible = `(private = false or owner_user_id = $2
    or exists (select 1 from project_members m where m.project_id = projects.id and m.user_id = $2))`;
  if (UUID.test(trimmed)) {
    const byId = await db.query(`select * from projects where id = $1 and ${visible}`, [trimmed, userId]);
    if (byId.rowCount) return byId.rows[0] as ProjectRow;
  }
  const byName = await db.query(`select * from projects where lower(name) = lower($1) and ${visible}`, [trimmed, userId]);
  if (byName.rowCount === 1) return byName.rows[0] as ProjectRow;
  if ((byName.rowCount ?? 0) > 1) {
    throw new AppError('validation_failed', `The name "${ref}" is ambiguous — pass the project id`,
      { projects: byName.rows.map((p) => ({ id: p.id, name: p.name })) });
  }
  throw new AppError('not_found', `Project "${ref}" not found`);
}

/**
 * Можно ли положить это дело в этот проект, и кто тогда его видит. У закрытого проекта видимость
 * держится на `private_owner_user_id`: раньше это всегда был хозяин, теперь — хозяин ИЛИ состав
 *, поэтому исполнителем может быть любой участник, а полем остаётся хозяин: правило
 * RLS читает его вместе с составом.
 */
export function privateOwnerFor(project: ProjectRow, assigneeUserId: string, actor: Actor, members: string[] = []): string | null {
  if (project.status !== 'active') throw new AppError('validation_failed', `Project "${project.name}" is archived`);
  if (!project.private) return null;
  const inside = (id: string | null) => id != null && (id === project.owner_user_id || members.includes(id));
  if (actorAgentId(actor) || !inside(actorUserId(actor))) {
    throw new AppError('forbidden', `Project "${project.name}" is private — only the people on it put items into it`);
  }
  if (!inside(assigneeUserId)) {
    throw new AppError('validation_failed', `Project "${project.name}" is private — add the person to it first`);
  }
  return project.owner_user_id;
}

/** Идентификаторы состава — для проверок доступа, где имена не нужны. Состав спрашивается только
 *  у закрытого проекта: у открытой он ни на что не влияет, а запрос идёт на каждое создание дела. */
export async function memberIds(db: Db, project: ProjectRow): Promise<string[]> {
  if (!project.private) return [];
  const r = await db.query('select user_id from project_members where project_id = $1', [project.id]);
  return r.rows.map((x) => x.user_id as string);
}

export async function createProject(
  db: Db, input: { name: string; description?: string | null; private?: boolean; key?: string | null }, actor: Actor,
): Promise<ProjectRow> {
  const name = input.name?.trim();
  if (!name) throw new AppError('validation_failed', 'A project name is required');
  const userId = actorUserId(actor);
  if (!userId) throw new AppError('forbidden', 'The system does not create projects');
  // Закрытый проект заводит только человек и только себе: у агента хозяина закрытого быть не может.
  if (input.private && actorAgentId(actor)) {
    throw new AppError('forbidden', 'A private project is created by a person, not by an agent');
  }
  const orgId = (await db.query(`select current_setting('app.org_id')::uuid as id`)).rows[0].id as string;
  const key = await suggestKey(db, orgId, name, input.key);
  const r = await db.query(
    `insert into projects(org_id, name, description, owner_user_id, private, key)
     values (current_setting('app.org_id')::uuid, $1, $2, $3, $4, $5) returning *`,
    [name, input.description ?? '', userId, input.private ?? false, key],
  ).catch(asAppError);
  const project = r.rows[0] as ProjectRow;
  await emit(db, {
    type: 'project_created', actorUserId: userId, actorAgentId: actorAgentId(actor),
    data: { project_id: project.id, name: project.name, private: project.private },
  });
  return project;
}

export interface ProjectListItem {
  id: string; name: string; description: string; private: boolean; status: string;
  owner_user_id: string; tasks_open: number; created_at: Date; members: string[];
}

/** Свои закрытые, проекты со своим участием и все открытые; архивные — только по явной просьбе.
 *  `userId = null` — смотрит не человек, а агент: закрытых для него нет вовсе.
 *  Состав отдаётся вместе со списком: кто ставит дело в проект, тот должен видеть, кому оно
 *  станет видно. */
export async function listProjects(db: Db, userId: string | null, opts: { includeArchived?: boolean } = {}): Promise<ProjectListItem[]> {
  const r = await db.query(
    `select p.id, p.name, p.description, p.private, p.status, p.owner_user_id, p.created_at,
            (select count(*)::int from tasks t where t.project_id = p.id and t.status = any($3)) as tasks_open,
            coalesce((select array_agg(u.display_name order by u.display_name)
                        from project_members m join users u on u.id = m.user_id
                       where m.project_id = p.id), '{}') as members
       from projects p
      where (p.private = false or p.owner_user_id = $1
             or exists (select 1 from project_members m where m.project_id = p.id and m.user_id = $1))
        and ($2 or p.status = 'active')
      order by p.private, lower(p.name)`,
    [userId, opts.includeArchived ?? false, OPEN_STATUSES],
  );
  return r.rows as ProjectListItem[];
}

export interface ProjectPatch {
  name?: string;
  description?: string;
  private?: boolean;
  status?: 'active' | 'archived';
}

/** Кто правит проект: его хозяин, а открытый — ещё и владелец/админ организации. */
async function requireProjectControl(db: Db, project: ProjectRow, actor: Actor): Promise<string> {
  const userId = actorUserId(actor);
  if (!userId) throw new AppError('forbidden', 'The system does not change projects');
  if (project.private && (actorAgentId(actor) || project.owner_user_id !== userId)) {
    throw new AppError('forbidden', 'A private project is managed by its owner');
  }
  if (project.owner_user_id === userId) return userId;
  const m = await db.query(
    `select role from memberships where org_id = current_setting('app.org_id')::uuid and user_id = $1 and status = 'active'`, [userId]);
  if (['owner', 'admin'].includes(m.rows[0]?.role)) return userId;
  throw new AppError('forbidden', 'Only the owner of the project or an admin of the organization changes it');
}

export async function updateProject(db: Db, ref: string, patch: ProjectPatch, actor: Actor, now: Date = new Date()): Promise<ProjectRow> {
  const userId = actorUserId(actor);
  const project = await resolveProject(db, ref, sessionUser(actor));
  await requireProjectControl(db, project, actor);

  const cols: Record<string, unknown> = {};
  if (patch.name !== undefined) {
    if (!patch.name.trim()) throw new AppError('validation_failed', 'A project name cannot be empty');
    cols.name = patch.name.trim();
  }
  if (patch.description !== undefined) cols.description = patch.description;
  if (patch.status !== undefined && patch.status !== project.status) {
    cols.status = patch.status;
    cols.archived_at = patch.status === 'archived' ? now : null;
  }

  if (patch.private !== undefined && patch.private !== project.private) {
    // Закрыть и открыть проект может только человек: это решение о видимости, а не о содержании.
    if (actorAgentId(actor)) throw new AppError('forbidden', 'Opening or closing a project is a decision of a person, not of an agent');
    if (project.owner_user_id !== userId) throw new AppError('forbidden', 'A project is closed and opened by its owner');
    if (patch.private) {
      // Право видеть дело есть не только у исполнителя: его видят постановщик-человек, тот, кому
      // поручено проверить ожидание, и проверяющий результата (спека task-reviewer). Закрытие отняло
      // бы дело у них молча — поэтому смотрим на всех.
      const foreign = await db.query(
        `select count(*)::int as n from tasks
          where project_id = $1
            and (assignee_user_id <> $2
                 or (author_agent_id is null and author_user_id is not null and author_user_id <> $2)
                 or (waiting->>'check_user_id' is not null and waiting->>'check_user_id' <> $2::text)
                 or (reviewer_user_id is not null and reviewer_user_id <> $2))`,
        [project.id, project.owner_user_id]);
      if (foreign.rows[0].n > 0) {
        throw new AppError('validation_failed',
          'The project holds items other people take part in — a private project holds only your own',
          { foreign_tasks: foreign.rows[0].n });
      }
    }
    cols.private = patch.private;
  }

  const entries = Object.entries(cols).filter(([, v]) => v !== undefined);
  if (!entries.length) return project;
  const sets = entries.map(([k], i) => `${k} = $${i + 2}`);
  const r = await db.query(
    `update projects set ${sets.join(', ')} where id = $1 returning *`, [project.id, ...entries.map(([, v]) => v)],
  ).catch(asAppError);
  const updated = r.rows[0] as ProjectRow;

  if (cols.private !== undefined) {
    // Правило видимости живёт в самом деле — при смене признака проекта его надо переписать делам.
    await db.query(
      'update tasks set private_owner_user_id = $2, version = version + 1, updated_at = $3 where project_id = $1',
      [project.id, updated.private ? updated.owner_user_id : null, now]);
    // Открытие делает дела видимыми агентам — это событие, а не тихая правка (спека, edge cases).
    await emit(db, {
      type: updated.private ? 'project_closed' : 'project_opened', actorUserId: userId,
      data: { project_id: project.id, name: updated.name },
    });
  }
  await emit(db, {
    type: 'project_updated', actorUserId: userId, actorAgentId: actorAgentId(actor),
    data: { project_id: project.id, fields: entries.map(([k]) => k) },
  });
  return updated;
}

/**
 * Сменить проект дела — то, что раньше было переносом между пространствами: внутри одной
 * организации это правка одной строки, история дела остаётся на месте.
 */
export async function setTaskProject(db: Db, taskId: string, ref: string, actor: Actor, now: Date = new Date()): Promise<Task> {
  const task = await requireAuthorOrManager(db, taskId, actor);
  const project = await resolveProject(db, ref, sessionUser(actor));
  if (task.project_id === project.id) return task;
  const members = await memberIds(db, project);
  const privateOwner = privateOwnerFor(project, task.assignee_user_id, actor, members);
  // Проверяющий в закрытом проекте — на правах исполнителя (спека task-reviewer): иначе дело уехало
  // бы от того, кому оно придёт на приёмку.
  const reviewer = task.reviewer_user_id;
  if (project.private && reviewer && reviewer !== project.owner_user_id && !members.includes(reviewer)) {
    throw new AppError('validation_failed', `Project "${project.name}" is private — add the reviewer to it first`);
  }
  // Переезд даёт делу новый номер, а прежнее обозначение остаётся видимым: «NOR-12»,
  // посланное кому-то в переписке, обязано находиться и после переезда.
  const former = await taskFormerKey(db, task);
  const number = await nextProjectNumber(db, project.id);
  const r = await db.query(
    `update tasks set project_id = $2, private_owner_user_id = $3, number = $5,
            former_keys = case when $6::text is null then former_keys else array_append(former_keys, $6) end,
            version = version + 1, updated_at = $4
      where id = $1 returning *`,
    [taskId, project.id, privateOwner, now, number, former],
  );
  await emit(db, {
    type: 'task_updated', taskId, actorUserId: actorUserId(actor), actorAgentId: actorAgentId(actor),
    data: { fields: ['project_id'], project_id: project.id },
  });
  // Дело уехало в другой проект не рукой хозяина — он узнаёт об этом так же, как о любой другой
  // правке чужого дела (спека roles-and-rights).
  await noteManagerChange(db, task, actor);
  return r.rows[0] as Task;
}

/** Обозначение, под которым дело жило до переезда: его и запоминают люди в переписке. */
async function taskFormerKey(db: Db, task: Task): Promise<string | null> {
  if (!task.project_id || !task.number) return null;
  const r = await db.query('select key from projects where id = $1', [task.project_id]);
  return taskKey(r.rows[0]?.key as string | undefined, task.number);
}

/** Название проекта дела — для карточки бота и приложения. */
export async function taskProject(db: Db, projectId: string | null): Promise<ProjectRow | null> {
  if (!projectId) return null;
  const r = await db.query('select * from projects where id = $1', [projectId]);
  return (r.rows[0] as ProjectRow) ?? null;
}
