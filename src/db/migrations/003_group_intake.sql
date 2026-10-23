-- Бот в рабочих группах Telegram, этап 1 — спека group-intake.
-- Глобальный указатель chat_id → организация (как invitations ищутся по токену) и четыре таблицы
-- слоя организации (org_id + FORCE RLS, составные FK (org_id, id) — как в 001).

-- ============================================================ глобальный слой

-- Только маршрутизация апдейта из группы: какой организации отдать сообщение. Содержимого нет.
-- Строка живёт, пока бот в группе; выгнали бота — строка удаляется (group_chats.status = left).
create table group_links (
  telegram_chat_id bigint primary key,
  org_id uuid not null references orgs(id) on delete cascade,
  created_at timestamptz not null default now()
);
create index on group_links(org_id);

-- ============================================================ слой организации

-- Уникальность chat_id — внутри организации: глобально её держит group_links (одна активная
-- привязка), а строка прежней организации остаётся ей (status = left) при переносе группы в другую.
create table group_chats (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  telegram_chat_id bigint not null,
  title text not null default '',
  status text not null default 'active' check (status in ('active','paused','left')),
  bot_is_admin boolean not null default false,
  linked_by_user_id uuid references users(id),
  admin_checked_at timestamptz,
  created_at timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, telegram_chat_id)
);

create table group_messages (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  group_id uuid not null,
  telegram_message_id bigint not null,
  author_user_id uuid not null references users(id),
  text text not null default '',
  reply_to bigint,
  thread_id bigint,
  media_group_id text,
  photo_file_id text,                  -- ссылка на скачивание; файл забирает фоновый разбор, не webhook
  photo_file_unique_id text,           -- дедупликация до скачивания
  media_id uuid,                       -- скачанное и очищенное изображение
  task_id uuid,                        -- к какой задаче привязано (привязанное не удаляется через 30 дней)
  sent_at timestamptz not null,
  edited_at timestamptz,
  analyzed_at timestamptz,
  analysis_status text not null default 'pending' check (analysis_status in ('pending','done','failed','skipped')),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, group_id, telegram_message_id),
  foreign key (org_id, group_id) references group_chats(org_id, id) on delete cascade,
  foreign key (org_id, task_id) references tasks(org_id, id) on delete set null (task_id)
);
create index on group_messages(group_id, analyzed_at);
create index on group_messages(org_id, expires_at);

create table media (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  sha256 text not null,
  file_unique_id text,
  path text not null,                  -- относительно MEDIA_DIR: <org_id>/<sha256>.jpg
  width int,
  height int,
  bytes int,
  analysis jsonb,                      -- {description, text_on_image} от модели — текст людей, untrusted
  source_message_id uuid,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,     -- удаляется после этого, только если не привязано к задаче
  unique (org_id, id),
  unique (org_id, sha256),
  foreign key (org_id, source_message_id) references group_messages(org_id, id) on delete set null (source_message_id)
);
create index on media(org_id, file_unique_id);

alter table group_messages
  add foreign key (org_id, media_id) references media(org_id, id) on delete set null (media_id);

create table task_attachments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  task_id uuid not null,
  media_id uuid not null,
  message_id uuid,
  source text not null default 'group' check (source in ('group')),
  summary text not null default '',
  confidence real,
  created_at timestamptz not null default now(),
  unique (org_id, id),
  unique (task_id, media_id),
  foreign key (org_id, task_id) references tasks(org_id, id) on delete cascade,
  foreign key (org_id, media_id) references media(org_id, id) on delete cascade,
  foreign key (org_id, message_id) references group_messages(org_id, id) on delete set null (message_id)
);
create index on task_attachments(task_id);

-- ============================================================ RLS на слое организации

do $$
declare t text;
begin
  foreach t in array array['group_chats','group_messages','media','task_attachments'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format(
      'create policy org_isolation on %I using (org_id = nullif(current_setting(''app.org_id'', true), '''')::uuid) '
      || 'with check (org_id = nullif(current_setting(''app.org_id'', true), '''')::uuid)', t);
  end loop;
end $$;

comment on schema public is 'org-layer: agents runners plans tasks task_results task_messages events agent_cursors review_cursors proposals vetoable_changes plan_decisions queue_settings time_entries notifications deliveries invitations agent_notes playbooks idempotency_keys translations ai_usage agent_audit external_links group_chats group_messages media task_attachments';
