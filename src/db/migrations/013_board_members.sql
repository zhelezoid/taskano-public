-- Состав доски: дела видят те, кого в неё добавили (спека projects-stage2).
--
-- До этого у доски было два состояния: общая (видит вся организация) и закрытая (видит только
-- хозяин). Середины не было, а нужна именно она — доска на троих из десяти сотрудников.
--
-- Правило видимости остаётся ОДНИМ условием политики: к «я хозяин» добавляется «я в составе».
-- Подзапрос к составу — цена, которую платим за правило; индекс (user_id, project_id) делает его
-- поиском по одной строке.

create table project_members (
  project_id uuid not null references projects(id) on delete cascade,
  user_id    uuid not null references users(id),
  org_id     uuid not null references orgs(id),
  added_by   uuid references users(id),
  added_at   timestamptz not null default now(),
  primary key (project_id, user_id),
  -- Организация строки и организация доски — одно и то же (тот же приём, что у tasks_project_fk в
  -- миграции 008): правило видимости доверяет `org_id` этой строки, и рассинхрон обошёл бы его.
  foreign key (org_id, project_id) references projects(org_id, id)
);
create index on project_members(user_id, project_id);
create index on project_members(org_id);

alter table project_members enable row level security;
alter table project_members force row level security;
create policy org_isolation on project_members
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);

-- ============================================================ правило видимости

drop policy project_visibility on tasks;
create policy project_visibility on tasks
  using (
    org_id = nullif(current_setting('app.org_id', true), '')::uuid
    and (private_owner_user_id is null
         or private_owner_user_id = nullif(current_setting('app.actor_user_id', true), '')::uuid
         or current_setting('app.background', true) = '1'
         or exists (
           select 1 from project_members m
            where m.project_id = tasks.project_id
              and m.user_id = nullif(current_setting('app.actor_user_id', true), '')::uuid)))
  with check (
    org_id = nullif(current_setting('app.org_id', true), '')::uuid
    and (private_owner_user_id is null
         or private_owner_user_id = nullif(current_setting('app.actor_user_id', true), '')::uuid
         or current_setting('app.background', true) = '1'
         or exists (
           select 1 from project_members m
            where m.project_id = tasks.project_id
              and m.user_id = nullif(current_setting('app.actor_user_id', true), '')::uuid)));

-- Послабление фоновой сессии (миграция 009) остаётся дословно: воркер снимает приватность целиком,
-- иначе дела закрытых досок молча перестают активироваться по сроку. Состав добавляется рядом с ним,
-- а не вместо него.

grant select, insert, update, delete on project_members to taskano_app;
grant select, insert, update, delete on project_members to taskano_system;

comment on table project_members is 'Состав доски: кто её видит, помимо хозяина (спека projects-stage2)';
comment on schema public is 'org-layer: agents runners plans projects project_members tasks task_results task_messages events agent_cursors review_cursors proposals vetoable_changes plan_decisions queue_settings time_entries notifications deliveries invitations agent_notes playbooks idempotency_keys translations ai_usage agent_audit task_sources group_chats group_messages media task_attachments group_review_state owner_activity_state';
