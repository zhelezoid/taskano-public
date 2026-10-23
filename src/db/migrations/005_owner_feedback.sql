-- Обратная связь агентам о том, что владелец сделал сам — спека owner-feedback
--. Личное дело попадает агентам только с пометкой «рабочее».

-- Пометка «рабочее»: организация, агентам которой видно это личное дело.
-- Политику RLS на tasks НЕ трогаем: «видно, если org_id = текущая» остаётся единственным правилом
-- изоляции для всех запросов (правки, джойны, бот, Mini App). Помеченные дела читает одна узкая
-- выборка блока owner_activity под withSystem строго по shared_org_id (src/runtime/owner-activity.ts).
alter table tasks add column shared_org_id uuid references orgs(id) on delete set null;
create index on tasks(shared_org_id) where shared_org_id is not null;

-- «Заполнено — значит личное дело владельца и его же компания»: check не умеет смотреть в другие
-- таблицы, поэтому условие держит триггер (приложение проверяет то же самое и отвечает понятной ошибкой).
create function tasks_shared_org_check() returns trigger language plpgsql as $$
declare space_kind text; space_owner uuid; target_kind text;
begin
  if new.shared_org_id is null then return new; end if;
  select kind, owner_user_id into space_kind, space_owner from orgs where id = new.org_id;
  if space_kind is distinct from 'personal' then
    raise exception 'shared_org_id: only a task of a personal space can be marked';
  end if;
  select kind into target_kind from orgs where id = new.shared_org_id;
  if target_kind is distinct from 'company' then
    raise exception 'shared_org_id: only a company can be named';
  end if;
  if not exists (
    select 1 from memberships m
     where m.org_id = new.shared_org_id and m.user_id = space_owner and m.status = 'active'
  ) then
    raise exception 'shared_org_id: the owner of the personal space is not a member of that organization';
  end if;
  return new;
end $$;

create trigger tasks_shared_org_check before insert or update of shared_org_id on tasks
  for each row execute function tasks_shared_org_check();

-- ============================================================ слой организации

-- Окно блока owner_activity в get_briefing — как у групп: acked_until подтверждён ack_briefing,
-- pending_* отдала последняя сводка (ack с тем же курсором переносит pending в acked).
create table owner_activity_state (
  org_id uuid primary key references orgs(id) on delete cascade,
  acked_until timestamptz,
  pending_until timestamptz,
  pending_cursor text,
  updated_at timestamptz not null default now()
);

alter table owner_activity_state enable row level security;
alter table owner_activity_state force row level security;
create policy org_isolation on owner_activity_state
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);

comment on schema public is 'org-layer: agents runners plans tasks task_results task_messages events agent_cursors review_cursors proposals vetoable_changes plan_decisions queue_settings time_entries notifications deliveries invitations agent_notes playbooks idempotency_keys translations ai_usage agent_audit external_links group_chats group_messages media task_attachments group_review_state owner_activity_state';
