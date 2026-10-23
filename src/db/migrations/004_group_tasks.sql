-- Бот в рабочих группах, этап 1b и ежечасная ревизия — спека group-intake
--: задачи из переписки от агента «Секретарь», суждение модели о каждом сообщении
-- (для unmatched и close_candidates в сводке) и окно «с прошлого ack_briefing» для блока groups.

-- Служебная роль агента: «Секретарь» ставит задачи из диалога, если не подошло ни одно направление.
-- Ищется по роли, а не по имени: имя локализовано и владелец может его сменить.
alter table agents add column system_role text check (system_role in ('secretary'));
create unique index agents_system_role on agents(org_id, system_role) where system_role is not null;

-- Срок не назван в переписке — поставлен следующий рабочий день исполнителя (агент видит и уточняет).
alter table tasks add column due_assumed boolean not null default false;
-- Идемпотентность задач из диалога: одна задача на поручение (origin + исполнитель).
create index on tasks(org_id, origin) where origin is not null;

-- Суждение модели о сообщении при любой уверенности: ревизии нужны пересказ непривязанного,
-- «говорит, что сделано» и «не нужно/отменили». Текст — пересказ людей, untrusted.
alter table group_messages
  add column kind text check (kind in ('evidence','progress','blocker','done_claim','obsolete','other')),
  add column summary text,
  add column confidence real;
create index on group_messages(org_id, analyzed_at);

-- ============================================================ слой организации

-- Окно блока groups в get_briefing: acked_until — граница, подтверждённая ack_briefing;
-- pending_* — что отдала последняя сводка (ack с тем же курсором переносит pending в acked).
create table group_review_state (
  org_id uuid primary key references orgs(id) on delete cascade,
  acked_until timestamptz,
  pending_until timestamptz,
  pending_cursor text,
  updated_at timestamptz not null default now()
);

alter table group_review_state enable row level security;
alter table group_review_state force row level security;
create policy org_isolation on group_review_state
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);

comment on schema public is 'org-layer: agents runners plans tasks task_results task_messages events agent_cursors review_cursors proposals vetoable_changes plan_decisions queue_settings time_entries notifications deliveries invitations agent_notes playbooks idempotency_keys translations ai_usage agent_audit external_links group_chats group_messages media task_attachments group_review_state';
