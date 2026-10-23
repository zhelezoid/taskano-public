-- Повторяющееся объявление (тревога) — спека announcement-alerts.
--
-- Тревогу поднимает внешний сторож по ключу и снимает событием «сдвинулось»; пока открыта, каждый
-- получатель видит её раундами — обычными объявлениями одному человеку (`announcements.alert_id`).
-- «Прочёл» отмечает раунд, тревогу не закрывает.

create table announcement_alerts (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references orgs(id) on delete cascade,
  key                 text not null check (length(key) between 1 and 200),
  author_user_id      uuid not null references users(id),
  author_agent_id     uuid references agents(id),
  text                text not null check (length(text) between 1 and 2000),
  source_language     text,
  per_day             int not null default 2 check (per_day between 1 and 4),
  escalated_per_day   int not null default 4 check (escalated_per_day between 1 and 4),
  escalate_after_days int not null default 2 check (escalate_after_days between 1 and 30),
  opened_at           timestamptz not null default now(),
  resolved_at         timestamptz,
  resolved_reason     text check (resolved_reason is null or length(resolved_reason) <= 500),
  unique (org_id, id),
  check (escalated_per_day >= per_day)
);
-- Открытая тревога с ключом в организации — одна: повторный подъём находит её, а не плодит вторую.
create unique index announcement_alerts_open_key on announcement_alerts(org_id, key) where resolved_at is null;
create index on announcement_alerts(org_id, opened_at desc);

create table announcement_alert_recipients (
  org_id        uuid not null,
  alert_id      uuid not null,
  user_id       uuid not null references users(id),
  rounds        int not null default 0,
  last_round_at timestamptz,
  primary key (alert_id, user_id),
  foreign key (org_id, alert_id) references announcement_alerts(org_id, id) on delete cascade
);
create index on announcement_alert_recipients(org_id);

alter table announcements add column alert_id uuid;
alter table announcements add constraint announcements_alert_fk
  foreign key (org_id, alert_id) references announcement_alerts(org_id, id) on delete cascade;
create index announcements_alert on announcements(alert_id) where alert_id is not null;

alter table announcement_alerts enable row level security;
alter table announcement_alerts force row level security;
create policy org_isolation on announcement_alerts
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);

alter table announcement_alert_recipients enable row level security;
alter table announcement_alert_recipients force row level security;
create policy org_isolation on announcement_alert_recipients
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);

-- Тревогу не удаляют — закрывают (`resolved_at`); получателя не вычёркивают. Отзыв — в ensureRoles.
grant select, insert, update on announcement_alerts to taskano_app;
grant select, insert, update on announcement_alert_recipients to taskano_app;
grant select, insert, update, delete on announcement_alerts to taskano_system;
grant select, insert, update, delete on announcement_alert_recipients to taskano_system;

comment on table announcement_alerts is 'Повторяющиеся объявления по ключу внешнего сторожа; закрываются resolved_at (спека announcement-alerts)';
comment on table announcement_alert_recipients is 'Кому повторяется тревога; rounds/last_round_at — сколько раундов показано';
comment on schema public is 'org-layer: agents runners plans projects project_members tasks task_results task_messages events agent_cursors review_cursors proposals vetoable_changes plan_decisions queue_settings time_entries notifications deliveries invitations agent_notes playbooks idempotency_keys translations ai_usage agent_audit task_sources group_chats group_messages media task_attachments group_review_state owner_activity_state task_views announcements announcement_recipients announcement_alerts announcement_alert_recipients';
