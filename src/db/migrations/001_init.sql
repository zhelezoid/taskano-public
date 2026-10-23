-- Taskano: начальная схема. спека — core-data-model.
-- Два слоя: глобальный (identity, без RLS) и слой организации (org_id + FORCE ROW LEVEL SECURITY).

create extension if not exists citext;
create extension if not exists pgcrypto;

-- ============================================================ глобальный слой

create table users (
  id uuid primary key default gen_random_uuid(),
  display_name text not null default '',
  language text not null default 'en',
  timezone text not null default 'UTC',
  country text,
  work_days int[] not null default '{1,2,3,4,5}',
  work_start time not null default '09:00',
  work_end time not null default '18:00',
  quiet_start time not null default '21:00',
  quiet_end time not null default '08:00',
  consent_at timestamptz,
  anonymized_at timestamptz,
  created_at timestamptz not null default now()
);

create table user_emails (
  email citext primary key,
  user_id uuid not null references users(id) on delete cascade,
  verified_at timestamptz,
  is_primary boolean not null default false
);
create index on user_emails(user_id);

create table telegram_links (
  telegram_user_id bigint primary key,
  user_id uuid not null unique references users(id) on delete cascade,
  chat_id bigint not null,
  blocked_at timestamptz,
  linked_at timestamptz not null default now()
);

create table login_codes (
  id uuid primary key default gen_random_uuid(),
  email citext not null,
  purpose text not null,              -- oauth | bot
  pending_id uuid,                    -- страница входа OAuth, для которой выпущен код (иначе код можно ввести в чужой сессии)
  code_hash text not null,
  expires_at timestamptz not null,
  attempts int not null default 0,
  consumed_at timestamptz,
  sent_at timestamptz not null default now()
);
create index on login_codes(email, sent_at desc);

create table oauth_clients (
  client_id text primary key,
  client_secret_hash text,
  metadata jsonb not null,
  created_at timestamptz not null default now()
);

create table oauth_codes (
  code_hash text primary key,
  client_id text not null references oauth_clients(client_id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  code_challenge text not null,
  redirect_uri text not null,
  scopes text[] not null default '{}',
  resource text,
  expires_at timestamptz not null,
  used_at timestamptz
);

create table oauth_tokens (
  token_hash text primary key,
  kind text not null check (kind in ('access','refresh')),
  family uuid not null,               -- цепочка ротации refresh: повтор старого = отзыв всей цепочки
  client_id text not null references oauth_clients(client_id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  scopes text[] not null default '{}',
  resource text,
  expires_at timestamptz not null,
  rotated_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index on oauth_tokens(family);

-- Одноразовые состояния страницы входа OAuth (между шагами «почта» и «код»).
create table oauth_pending (
  id uuid primary key default gen_random_uuid(),
  client_id text not null,
  params jsonb not null,
  email citext,
  user_id uuid,
  expires_at timestamptz not null
);

create table bots (
  id text primary key,
  username text not null,
  token_env text not null,
  org_id uuid
);

create table product_invite_codes (
  code_hash text primary key,
  note text,
  created_by text not null,
  used_by_org uuid,
  used_at timestamptz,
  expires_at timestamptz
);

create table orgs (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('company','personal')),
  name text not null,
  owner_user_id uuid not null references users(id),
  language text not null default 'ru',
  timezone text not null default 'Europe/Istanbul',
  agent_window jsonb not null default '{"tz":"Europe/Istanbul","days":[1,2,3,4,5],"start":"09:00","end":"19:00"}',
  glossary text[] not null default '{}',
  invite_domains text[],
  ai_budget_usd_month numeric(10,2) not null default 20,
  translation_paused_at timestamptz,
  settings jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create unique index orgs_one_personal on orgs(owner_user_id) where kind = 'personal';

create table memberships (
  org_id uuid not null references orgs(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  role text not null check (role in ('owner','admin','member','guest')),
  status text not null default 'active' check (status in ('active','invited','removed')),
  mode text not null default 'lead' check (mode in ('lead','self')),
  joined_at timestamptz,
  removed_at timestamptz,
  primary key (org_id, user_id)
);
create index on memberships(user_id);

create table holidays (
  country text not null,
  date date not null,
  name text not null,
  primary key (country, date)
);

create table admin_audit (
  id bigserial primary key,
  actor text not null,
  action text not null,
  payload jsonb,
  at timestamptz not null default now()
);

create table bot_dialogs (
  user_key text primary key,           -- 'tg:<telegram_user_id>' — до привязки пользователя его ещё нет
  state text not null,
  data jsonb not null default '{}',
  updated_at timestamptz not null default now()
);

create table runner_links (
  token_hash text primary key,
  org_id uuid not null references orgs(id) on delete cascade,
  created_by uuid not null references users(id),
  expires_at timestamptz not null,
  used_at timestamptz
);

-- ============================================================ слой организации

create table agents (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  name text not null,
  description text not null default '',
  owner_user_id uuid not null references users(id),
  status text not null default 'active' check (status in ('active','paused')),
  permissions jsonb not null default '{}',
  created_at timestamptz not null default now(),
  unique (org_id, id)
);
create unique index agents_name_ci on agents(org_id, lower(name));

create table runners (
  org_id uuid primary key references orgs(id) on delete cascade,
  fire_url text not null,
  fire_token_enc text not null,
  status text not null default 'ok' check (status in ('ok','broken')),
  last_fired_at timestamptz,
  last_fire_error text,
  last_briefing_at timestamptz,
  pending_since timestamptz,           -- есть блокирующие события, ещё не отправленные в /fire
  pending_summary jsonb not null default '{}',
  updated_at timestamptz not null default now()
);

create table plans (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  agent_id uuid not null,
  goal text not null,
  status text not null default 'active'
    check (status in ('active','waiting','paused','done','failed','stopped')),
  created_at timestamptz not null default now(),
  closed_at timestamptz,
  unique (org_id, id),
  foreign key (org_id, agent_id) references agents(org_id, id)
);
create index on plans(org_id, agent_id, status);

create table tasks (
  id uuid primary key default gen_random_uuid(),
  short_id bigserial unique,           -- короткий номер для callback_data Telegram (≤ 64 байт)
  org_id uuid not null references orgs(id) on delete cascade,
  plan_id uuid,
  position int not null default 0,
  kind text not null default 'action' check (kind in ('action','waiting')),
  title text not null,
  description text not null default '',
  why text not null default '',
  done_criteria text not null default '',
  expected_result jsonb,               -- {type: text|number|file|photo, required: bool}
  origin text,
  links jsonb not null default '[]',
  rationale text,
  assignee_user_id uuid not null references users(id),
  author_agent_id uuid,
  author_user_id uuid not null references users(id),
  status text not null,
  due_date date,
  due_tz text,
  activate_at timestamptz,
  priority text not null default 'normal' check (priority in ('normal','urgent')),
  estimate_minutes int,
  auto_release_ok boolean not null default false,
  source_language text,
  external jsonb,
  waiting jsonb,                       -- {waiting_for, expected_at, next_check_at, check_user_id, on_arrival, contact, checks_done}
  started_at timestamptz,              -- «Взял» (для времени цикла)
  submitted_at timestamptz,
  blocked_at timestamptz,
  status_changed_at timestamptz not null default now(),
  acked_at timestamptz,                -- любое нажатие по «Сейчас»
  reminded_count int not null default 0,
  last_reminded_at timestamptz,
  snoozed_until timestamptz,           -- «Не сегодня»
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1,
  unique (org_id, id),
  foreign key (org_id, plan_id) references plans(org_id, id),
  foreign key (org_id, author_agent_id) references agents(org_id, id),
  constraint tasks_status_check check (status in (
    'draft','scheduled','ready','active','in_progress','blocked','waiting_external',
    'submitted','rework','done','declined','cancelled',
    'waiting','resolved'))
);
create index on tasks(org_id, assignee_user_id, status);
create index on tasks(org_id, plan_id, position);
create index on tasks(status, activate_at) where status = 'scheduled';

create table task_results (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  task_id uuid not null,
  user_id uuid not null references users(id),
  text text,
  number numeric,
  files jsonb not null default '[]',   -- [{telegram_file_id, kind, name}]
  created_at timestamptz not null default now(),
  foreign key (org_id, task_id) references tasks(org_id, id) on delete cascade
);

create table task_messages (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  task_id uuid not null,
  author_user_id uuid references users(id),
  author_agent_id uuid,
  kind text not null check (kind in ('comment','question','unclear','answer','decline_reason','owner_instruction','rework_reason')),
  text text not null,
  source_language text,
  answered_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (org_id, task_id) references tasks(org_id, id) on delete cascade,
  foreign key (org_id, author_agent_id) references agents(org_id, id)
);
create index on task_messages(org_id, task_id, created_at);

create table events (
  id bigserial primary key,
  org_id uuid not null references orgs(id) on delete cascade,
  xid xid8 not null default pg_current_xact_id(),
  at timestamptz not null default now(),
  actor_user_id uuid,
  actor_agent_id uuid,
  agent_id uuid,                        -- какому агенту событие адресовано (null — никому из агентов)
  task_id uuid,
  plan_id uuid,
  type text not null,
  data jsonb not null default '{}'
);
create index events_cursor on events(org_id, xid, id);

create table agent_cursors (
  org_id uuid not null references orgs(id) on delete cascade,
  agent_id uuid not null,
  cursor text not null default '0:0',
  primary key (org_id, agent_id),
  foreign key (org_id, agent_id) references agents(org_id, id) on delete cascade
);

create table review_cursors (
  org_id uuid not null references orgs(id) on delete cascade,
  agent_id uuid not null,
  user_id uuid not null references users(id),
  reviewed_at timestamptz not null,
  primary key (org_id, agent_id, user_id),
  foreign key (org_id, agent_id) references agents(org_id, id) on delete cascade
);

create table proposals (
  id uuid primary key default gen_random_uuid(),
  short_id bigserial unique,
  org_id uuid not null references orgs(id) on delete cascade,
  agent_id uuid not null,
  plan_id uuid,
  task_id uuid,
  type text not null,
  summary text not null,
  payload jsonb not null default '{}',
  rationale text,
  status text not null default 'pending' check (status in ('pending','accepted','rejected','expired','changed')),
  default_action text not null default 'reject',
  expires_at timestamptz,
  decided_by uuid references users(id),
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (org_id, agent_id) references agents(org_id, id),
  foreign key (org_id, plan_id) references plans(org_id, id),
  foreign key (org_id, task_id) references tasks(org_id, id)
);

create table vetoable_changes (
  id uuid primary key default gen_random_uuid(),
  short_id bigserial unique,
  org_id uuid not null references orgs(id) on delete cascade,
  agent_id uuid not null,
  kind text not null,
  summary text not null,
  before jsonb not null,
  after jsonb not null,
  rollback_until timestamptz not null,
  rolled_back_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (org_id, agent_id) references agents(org_id, id)
);

create table plan_decisions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  plan_id uuid not null,
  agent_id uuid not null,
  at timestamptz not null default now(),
  trigger_event_id bigint,
  decision text not null,
  rejected_options text,
  foreign key (org_id, plan_id) references plans(org_id, id) on delete cascade,
  foreign key (org_id, agent_id) references agents(org_id, id)
);

create table queue_settings (
  org_id uuid not null references orgs(id) on delete cascade,
  user_id uuid not null references users(id),
  quotas jsonb not null default '{}',
  weights jsonb not null default '{}',
  daily_step_limit int not null default 20,
  primary key (org_id, user_id)
);

create table time_entries (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  task_id uuid,
  user_id uuid not null references users(id),
  started_at timestamptz not null,
  ended_at timestamptz,
  minutes int,
  source text not null check (source in ('timer','manual')),
  created_at timestamptz not null default now(),
  foreign key (org_id, task_id) references tasks(org_id, id) on delete set null (task_id)
);
create index on time_entries(org_id, user_id, started_at);
create unique index time_entries_one_open on time_entries(user_id) where ended_at is null and source = 'timer';

create table notifications (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  user_id uuid not null references users(id),
  kind text not null,
  level text not null check (level in ('feed','glance','decision','work')),
  task_id uuid,
  payload jsonb not null default '{}',
  dedupe_key text,
  deliver_after timestamptz not null default now(),
  delivered_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index notifications_dedupe on notifications(org_id, dedupe_key) where dedupe_key is not null;
create index on notifications(delivered_at, deliver_after) where delivered_at is null;

create table deliveries (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  notification_id uuid references notifications(id) on delete cascade,
  channel text not null check (channel in ('telegram','email','web')),
  status text not null,
  external_id text,
  error text,
  at timestamptz not null default now()
);

create table invitations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  email citext not null,
  user_id uuid not null references users(id),
  role text not null,
  language text,
  token_hash text not null unique,
  invited_by_user_id uuid references users(id),
  invited_by_agent_id uuid,
  status text not null default 'pending' check (status in ('pending','accepted','expired','revoked')),
  reminded_at timestamptz,
  escalated_at timestamptz,
  accepted_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (org_id, invited_by_agent_id) references agents(org_id, id)
);

create table agent_notes (
  org_id uuid not null references orgs(id) on delete cascade,
  agent_id uuid not null,
  key text not null,
  value text not null,
  updated_at timestamptz not null default now(),
  primary key (org_id, agent_id, key),
  foreign key (org_id, agent_id) references agents(org_id, id) on delete cascade
);

create table playbooks (
  org_id uuid primary key references orgs(id) on delete cascade,
  text text not null,
  updated_at timestamptz not null default now()
);

create table idempotency_keys (
  org_id uuid not null references orgs(id) on delete cascade,
  actor text not null,
  key text not null,
  request_hash text not null,
  response jsonb not null,
  created_at timestamptz not null default now(),
  primary key (org_id, actor, key)
);

create table translations (
  org_id uuid not null references orgs(id) on delete cascade,
  object_type text not null,
  object_id uuid not null,
  field text not null,
  lang text not null,
  source_hash text not null,
  text text not null,
  suspect boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (org_id, object_type, object_id, field, lang, source_hash)
);

create table ai_usage (
  id bigserial primary key,
  org_id uuid not null references orgs(id) on delete cascade,
  fn text not null,
  model text not null,
  input_tokens int not null,
  output_tokens int not null,
  usd numeric(12,6) not null,
  at timestamptz not null default now()
);
create index on ai_usage(org_id, at);

create table agent_audit (
  id bigserial primary key,
  org_id uuid not null references orgs(id) on delete cascade,
  agent_id uuid,
  user_id uuid references users(id),
  tool text not null,
  args_summary jsonb,
  result text not null,
  at timestamptz not null default now(),
  foreign key (org_id, agent_id) references agents(org_id, id)
);

create table external_links (
  org_id uuid not null references orgs(id) on delete cascade,
  task_id uuid not null,
  system text not null,
  external_id text not null,
  url text,
  direction text not null default 'link',
  synced_at timestamptz,
  primary key (org_id, system, external_id),
  foreign key (org_id, task_id) references tasks(org_id, id) on delete cascade
);

-- ============================================================ RLS на слое организации

do $$
declare t text;
begin
  foreach t in array array[
    'agents','runners','plans','tasks','task_results','task_messages','events','agent_cursors',
    'review_cursors','proposals','vetoable_changes','plan_decisions','queue_settings','time_entries',
    'notifications','deliveries','invitations','agent_notes','playbooks','idempotency_keys',
    'translations','ai_usage','agent_audit','external_links'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format(
      'create policy org_isolation on %I using (org_id = nullif(current_setting(''app.org_id'', true), '''')::uuid) '
      || 'with check (org_id = nullif(current_setting(''app.org_id'', true), '''')::uuid)', t);
  end loop;
end $$;

-- Для машинной проверки инварианта (тест сравнивает этот список с фактическими таблицами).
comment on schema public is 'org-layer: agents runners plans tasks task_results task_messages events agent_cursors review_cursors proposals vetoable_changes plan_decisions queue_settings time_entries notifications deliveries invitations agent_notes playbooks idempotency_keys translations ai_usage agent_audit external_links';

-- Фиксированные праздники; переходящие (Байрам, Тет) — через set_holidays.
insert into holidays(country, date, name)
select c, make_date(y, m, d), n
from (values
  ('TR', 1, 1, 'Yılbaşı'), ('TR', 4, 23, 'Ulusal Egemenlik ve Çocuk Bayramı'), ('TR', 5, 1, 'Emek ve Dayanışma Günü'),
  ('TR', 5, 19, 'Atatürk''ü Anma, Gençlik ve Spor Bayramı'), ('TR', 7, 15, 'Demokrasi ve Millî Birlik Günü'),
  ('TR', 8, 30, 'Zafer Bayramı'), ('TR', 10, 29, 'Cumhuriyet Bayramı'),
  ('VN', 1, 1, 'Tết Dương lịch'), ('VN', 4, 30, 'Ngày Giải phóng miền Nam'), ('VN', 5, 1, 'Quốc tế Lao động'),
  ('VN', 9, 2, 'Quốc khánh'),
  ('RU', 1, 1, 'Новый год'), ('RU', 1, 2, 'Новогодние каникулы'), ('RU', 1, 7, 'Рождество'),
  ('RU', 2, 23, 'День защитника Отечества'), ('RU', 3, 8, 'Международный женский день'),
  ('RU', 5, 1, 'Праздник Весны и Труда'), ('RU', 5, 9, 'День Победы'), ('RU', 6, 12, 'День России'),
  ('RU', 11, 4, 'День народного единства')
) as h(c, m, d, n)
cross join (values (2026), (2027)) as yrs(y)
on conflict do nothing;
