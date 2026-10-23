-- Проекты — спека projects: дело лежит в проекте, папке по теме.
-- Проект либо открыт (его ведут агенты, видит организация), либо закрыт (виден только хозяину).
-- Этап 1: проекты появляются, личное пространство продолжает работать как раньше.

-- ============================================================ слой организации

-- Backfill идёт под ролью миграций: на tasks висит force row level security, а app.org_id
-- здесь не задан. Отключаем проверку явно — иначе всё держится на том, что роль суперпользователь,
-- и в день, когда это перестанет быть правдой, backfill молча обновит ноль строк.
set local row_security = off;

create table projects (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  name text not null,
  description text not null default '',
  owner_user_id uuid not null references users(id),
  private boolean not null default false,   -- закрытый: дела видны только owner_user_id
  status text not null default 'active' check (status in ('active','archived')),
  created_at timestamptz not null default now(),
  archived_at timestamptz,
  unique (org_id, id)
);
-- Имя открытого проекта уникально в организации: два «Разное» рядом — всегда ошибка, а не замысел.
-- Закрытые в индекс не входят: этап 2 заводит личный проект каждому человеку компании, и одинаковое
-- имя у двух закрытых проектов разных хозяев — норма.
create unique index projects_open_name_ci on projects(org_id, lower(name)) where not private;
create index on projects(org_id, status);

-- Дело всегда в проекте. На этапе 1 колонка ещё nullable: not null ставит этап 2, когда личные
-- организации переедут и не останется дел, заведённых мимо проекта.
alter table tasks add column project_id uuid;
-- Кто видит дело, если проект закрыт; null у открытого. Продублировано из projects намеренно:
-- правило видимости должно быть одним условием политики RLS, без подзапроса к проектам.
alter table tasks add column private_owner_user_id uuid references users(id);
-- Deferrable — как все ключи на tasks после миграции 007: перенос дела между организациями
-- (src/core/routing.ts) меняет org_id и project_id разом под `set constraints all deferred`.
alter table tasks add constraint tasks_project_fk
  foreign key (org_id, project_id) references projects(org_id, id) deferrable initially immediate;
create index on tasks(org_id, project_id);
create index on tasks(private_owner_user_id) where private_owner_user_id is not null;

-- ============================================================ перенос существующих дел

-- По проекту на каждую организацию: «Разное» в компании, «Личное» в личном пространстве. Оба
-- открытые. Личное пространство — отдельная организация, и от агентов его прячет именно это
--: закрывать вдобавок его проект значило бы менять личное на этапе, где оно
-- «продолжает работать как раньше» — служебные задания, дайджест и агент самого владельца перестали
-- бы видеть его дела. Закрытым личное становится на этапе 2, когда переезжает внутрь компании.
-- backfill-projects:begin
insert into projects(org_id, name, owner_user_id, private)
select o.id, case when o.kind = 'personal' then 'Личное' else 'Разное' end, o.owner_user_id, false
  from orgs o
 where not exists (select 1 from projects p where p.org_id = o.id);

update tasks t
   set project_id = p.id,
       private_owner_user_id = case when p.private then p.owner_user_id end
  from projects p
 where p.org_id = t.org_id and t.project_id is null;
-- backfill-projects:end

-- ============================================================ RLS на слое организации

alter table projects enable row level security;
alter table projects force row level security;
create policy org_isolation on projects
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);

-- Правило видимости дела (спека projects, «Правило видимости»): к изоляции организаций добавляется
-- хозяин закрытого дела. `app.actor_user_id` ставит тот же слой, что и `app.org_id` (src/db/pool.ts).
-- Переменной нет → null → закрытое не видно: отказ в безопасную сторону. Агент рутины действует
-- от имени агента, человека в сессии нет — закрытые проекты ему не видны никогда.
drop policy org_isolation on tasks;
create policy project_visibility on tasks
  using (
    org_id = nullif(current_setting('app.org_id', true), '')::uuid
    and (private_owner_user_id is null
         or private_owner_user_id = nullif(current_setting('app.actor_user_id', true), '')::uuid))
  with check (
    org_id = nullif(current_setting('app.org_id', true), '')::uuid
    and (private_owner_user_id is null
         or private_owner_user_id = nullif(current_setting('app.actor_user_id', true), '')::uuid));

-- Для машинной проверки инварианта (тест сравнивает этот список с фактическими таблицами).
comment on schema public is 'org-layer: agents runners plans projects tasks task_results task_messages events agent_cursors review_cursors proposals vetoable_changes plan_decisions queue_settings time_entries notifications deliveries invitations agent_notes playbooks idempotency_keys translations ai_usage agent_audit task_sources group_chats group_messages media task_attachments group_review_state owner_activity_state';
