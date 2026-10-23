-- Объявления людям с подтверждением прочтения — спека announcements.
--
-- Объявление — не задача: его не делают и не сдают, его читают и подтверждают. Подтверждение —
-- свидетельство «человек прочёл в это время», поэтому ставится один раз и задним числом не
-- меняется: триггер держит это на уровне базы, а не только в коде.

create table announcements (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references orgs(id) on delete cascade,
  author_user_id  uuid not null references users(id),
  author_agent_id uuid references agents(id),
  text            text not null check (length(text) between 1 and 2000),
  source_language text,
  to_all          boolean not null default false,
  created_at      timestamptz not null default now(),
  unique (org_id, id)
);
create index on announcements(org_id, created_at desc);

create table announcement_recipients (
  org_id           uuid not null references orgs(id) on delete cascade,
  announcement_id  uuid not null,
  user_id          uuid not null references users(id),
  confirmed_at     timestamptz,
  confirmed_via    text check (confirmed_via in ('bot', 'app')),
  reminded_count   int not null default 0,
  last_reminded_at timestamptz,
  primary key (announcement_id, user_id),
  foreign key (org_id, announcement_id) references announcements(org_id, id) on delete cascade,
  check ((confirmed_at is null) = (confirmed_via is null))
);
create index on announcement_recipients(org_id);
create index announcement_recipients_open on announcement_recipients(user_id) where confirmed_at is null;

-- Подтверждение неизменно: поставленное время не переписать, чужим не сделать и получателя не
-- вычеркнуть. Вставка приходит неподтверждённой — подтверждение задним числом не записать. Удаление
-- всей организации (каскад от orgs) идёт мимо — тогда исчезает и само объявление.
create function announcement_recipients_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    new.confirmed_at := null;
    new.confirmed_via := null;
    return new;
  end if;
  if tg_op = 'DELETE' then
    if exists (select 1 from orgs where id = old.org_id) then
      raise exception 'announcement recipient cannot be removed';
    end if;
    return old;
  end if;
  if new.org_id is distinct from old.org_id or new.announcement_id is distinct from old.announcement_id
     or new.user_id is distinct from old.user_id then
    raise exception 'announcement recipient cannot be reassigned';
  end if;
  if old.confirmed_at is not null
     and (new.confirmed_at is distinct from old.confirmed_at or new.confirmed_via is distinct from old.confirmed_via) then
    raise exception 'announcement confirmation cannot be changed';
  end if;
  return new;
end $$;
create trigger announcement_recipients_guard
  before insert or update or delete on announcement_recipients
  for each row execute function announcement_recipients_guard();

alter table announcements enable row level security;
alter table announcements force row level security;
create policy org_isolation on announcements
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);

alter table announcement_recipients enable row level security;
alter table announcement_recipients force row level security;
create policy org_isolation on announcement_recipients
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);

-- Объявление не правят и не удаляют (спека: «ошибся — новое»).
grant select, insert on announcements to taskano_app;
grant select, insert on announcement_recipients to taskano_app;
grant update (confirmed_at, confirmed_via, reminded_count, last_reminded_at) on announcement_recipients to taskano_app;
grant select, insert, update, delete on announcements to taskano_system;
grant select, insert, update, delete on announcement_recipients to taskano_system;

comment on table announcements is 'Объявления людям; не правятся и не отзываются (спека announcements)';
comment on table announcement_recipients is 'Кому объявлено и когда подтвердил; confirmed_at ставится один раз (триггер)';
comment on schema public is 'org-layer: agents runners plans projects project_members tasks task_results task_messages events agent_cursors review_cursors proposals vetoable_changes plan_decisions queue_settings time_entries notifications deliveries invitations agent_notes playbooks idempotency_keys translations ai_usage agent_audit task_sources group_chats group_messages media task_attachments group_review_state owner_activity_state task_views announcements announcement_recipients';
