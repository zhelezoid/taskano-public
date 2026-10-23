-- Досье задачи — спека task-context: дело несёт весь свой контекст.
-- `external_links` (голый адрес без заголовка и статуса) заменяется общей таблицей источников:
-- разговор, рабочий чат, внешний трекер, другое дело — со слепком того, что агент там прочитал.

-- ============================================================ слой организации

create table task_sources (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  task_id uuid not null,
  kind text not null check (kind in ('chat','group','external','task')),
  title text not null default '',
  url text,
  system text,                         -- внешняя система: linear, crm, mail
  external_id text,                    -- идентификатор объекта в ней; для kind = 'task' — id дела Taskano
  quote text,                          -- цитата-основание, слова людей (untrusted), ≤ 500 знаков
  snapshot jsonb,                      -- что агент прочитал снаружи: {status, summary, updated_at}
  captured_at timestamptz,             -- когда сняли слепок (в выдаче агенту — возраст слепка)
  captured_by_agent_id uuid,
  captured_by_user_id uuid references users(id),
  created_at timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, task_id) references tasks(org_id, id) on delete cascade,
  foreign key (org_id, captured_by_agent_id) references agents(org_id, id)
);
-- Объект внешней системы принадлежит одному делу организации (по нему же ищет find_by_external).
create unique index task_sources_external on task_sources(org_id, system, external_id)
  where system is not null and external_id is not null;
-- Один и тот же адрес не заводит второй источник у того же дела (идемпотентность add_source).
create unique index task_sources_url on task_sources(org_id, task_id, url) where url is not null;
create index on task_sources(org_id, task_id, created_at);

-- Правило полноты (release_step и перевод шага в ready требуют why и done_criteria) действует
-- только на дела, заведённые с этой миграции. Дата в коде для этого ненадёжна: прод применяет
-- миграцию не в тот день, когда её написали, и задачи, созданные в промежутке, внезапно перестали
-- бы выпускаться. Поэтому признак ставится самой базой: существующим строкам — false, новым —
-- значение по умолчанию true.
alter table tasks add column requires_context boolean not null default true;
update tasks set requires_context = false;

-- ============================================================ перенос существующих связей

-- backfill-external:begin
insert into task_sources(org_id, task_id, kind, title, url, system, external_id, captured_at, created_at)
select l.org_id, l.task_id, 'external', btrim(l.system || ' ' || l.external_id), l.url, l.system, l.external_id,
       l.synced_at, coalesce(l.synced_at, now())
  from external_links l
 where not exists (
   select 1 from task_sources s where s.org_id = l.org_id and s.system = l.system and s.external_id = l.external_id);
-- backfill-external:end

-- Дело из рабочего чата уже несёт основание: origin = 'group:<group_id>:<message_id>', rationale —
-- слова людей группы. Блок идемпотентен (повторный запуск ничего не добавляет) — его же гоняет тест.
-- backfill-group:begin
insert into task_sources(org_id, task_id, kind, title, quote, created_at)
select t.org_id, t.id, 'group',
       coalesce(nullif(g.title, ''), 'Telegram'),
       case when length(t.rationale) > 500 then left(t.rationale, 499) || '…' else t.rationale end,
       t.created_at
  from tasks t
  left join group_chats g on g.org_id = t.org_id and g.id::text = split_part(t.origin, ':', 2)
 where t.origin like 'group:%' and btrim(coalesce(t.rationale, '')) <> ''
   and not exists (select 1 from task_sources s where s.task_id = t.id and s.kind = 'group');
-- backfill-group:end

drop table external_links;

-- ============================================================ RLS на слое организации

alter table task_sources enable row level security;
alter table task_sources force row level security;
create policy org_isolation on task_sources
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);

-- Для машинной проверки инварианта (тест сравнивает этот список с фактическими таблицами).
comment on schema public is 'org-layer: agents runners plans tasks task_results task_messages events agent_cursors review_cursors proposals vetoable_changes plan_decisions queue_settings time_entries notifications deliveries invitations agent_notes playbooks idempotency_keys translations ai_usage agent_audit task_sources group_chats group_messages media task_attachments group_review_state owner_activity_state';
