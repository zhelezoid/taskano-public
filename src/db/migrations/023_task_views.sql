-- Когда человек последний раз открывал карточку дела в Mini App (спека unread-and-deeplink).
--
-- Без отметки приложение не отличало дело с новой репликой от прочих: владелец открывал каждое дело
-- сотрудника, чтобы найти, где ему ответили. Отметка — по человеку и делу, в организации дела: один
-- человек в нескольких компаниях — строки в каждой, изоляция та же, что у самого дела.

create table task_views (
  user_id   uuid not null references users(id),
  task_id   uuid not null,
  org_id    uuid not null references orgs(id) on delete cascade,
  viewed_at timestamptz not null default now(),
  primary key (user_id, task_id),
  -- Организация отметки и организация дела — одно и то же. Отложенная проверка — как у остальных
  -- ссылок на дело (миграция 007): перенос дела между организациями двигает и отметки
  -- (src/core/routing.ts), а забытая таблица всплывает ошибкой на commit.
  foreign key (org_id, task_id) references tasks(org_id, id) on delete cascade deferrable initially immediate
);
create index on task_views(org_id);
create index on task_views(task_id);

alter table task_views enable row level security;
alter table task_views force row level security;
create policy org_isolation on task_views
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);

grant select, insert, update, delete on task_views to taskano_app;
grant select, insert, update, delete on task_views to taskano_system;

comment on table task_views is 'Когда человек последний раз открывал карточку дела; viewed_at только растёт (спека unread-and-deeplink)';
comment on schema public is 'org-layer: agents runners plans projects project_members tasks task_results task_messages events agent_cursors review_cursors proposals vetoable_changes plan_decisions queue_settings time_entries notifications deliveries invitations agent_notes playbooks idempotency_keys translations ai_usage agent_audit task_sources group_chats group_messages media task_attachments group_review_state owner_activity_state task_views';
