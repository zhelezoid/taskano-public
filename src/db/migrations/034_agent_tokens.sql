-- Постоянный токен агента для серверных программ (спека agent-tokens).
--
-- Глобальный слой, как read_tokens и oauth_tokens: токен проверяется до того, как известна
-- организация, поэтому без RLS. Организация и агент — в самой строке, и обвязка /mcp закрепляет
-- вызов за ними. Сам токен не хранится — только sha256 hex. Отзыв — отметка, а не удаление.

create table agent_tokens (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references orgs(id) on delete cascade,
  agent_id          uuid not null,
  issued_by_user_id uuid not null references users(id),
  -- Хозяин агента на момент выпуска: токен действует от его имени, и смена хозяина его гасит.
  agent_owner_user_id uuid not null references users(id),
  label             text not null check (char_length(label) between 1 and 100),
  token_hash        text not null unique,
  created_at        timestamptz not null default now(),
  expires_at        timestamptz not null,
  last_used_at      timestamptz,
  revoked_at        timestamptz,
  -- Удалили агента — его токены уходят вместе с ним.
  foreign key (org_id, agent_id) references agents(org_id, id) on delete cascade,
  check (expires_at > created_at)
);
-- Предел «3 действующих на агента» и список в приложении.
create index on agent_tokens(org_id, agent_id) where revoked_at is null;
-- Предел «20 выпусков в сутки» на организацию.
create index on agent_tokens(org_id, created_at);

grant select, insert, update on agent_tokens to taskano_app;
grant select, insert, update, delete on agent_tokens to taskano_system;

comment on table agent_tokens is 'Постоянный токен агента (POST /mcp, шесть инструментов от имени одного агента): хэш sha256, срок, отзыв отметкой (спека agent-tokens)';

-- Погасший токен гаснет навсегда (ревью безопасности 22.10). Проверка на каждом запросе одна
-- оставляла его живым в базе: вышедшего человека вернули в компанию — и токен его сервера снова
-- принимается, хотя владелец считал его мёртвым. Поэтому каждое событие, после которого токен не
-- должен действовать, ставит ему `revoked_at` — триггером, чтобы не зависеть от того, каким путём
-- кода человека вывели, понизили или удалили. Функции трогают только agent_tokens (без RLS), агентов
-- не читают: хозяин агента записан в самом токене.
create function agent_tokens_revoke_on_membership() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  -- Человек больше не действующий член: гаснут токены, которые он выпустил, и токены его агентов.
  if old.status = 'active' and (tg_op = 'DELETE' or new.status <> 'active') then
    update agent_tokens set revoked_at = now()
     where org_id = old.org_id and revoked_at is null
       and (issued_by_user_id = old.user_id or agent_owner_user_id = old.user_id);
  -- Перестал быть владельцем: гаснут выпущенные им — выпускать и держать их может только owner.
  elsif old.role = 'owner' and new.role <> 'owner' then
    update agent_tokens set revoked_at = now()
     where org_id = old.org_id and revoked_at is null and issued_by_user_id = old.user_id;
  end if;
  return null;
end $$;
create trigger agent_tokens_revoke_on_membership after update of status, role or delete on memberships
  for each row execute function agent_tokens_revoke_on_membership();

create function agent_tokens_revoke_on_user() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  update agent_tokens set revoked_at = now()
   where revoked_at is null and (issued_by_user_id = new.id or agent_owner_user_id = new.id);
  return null;
end $$;
create trigger agent_tokens_revoke_on_user after update of anonymized_at on users
  for each row when (old.anonymized_at is null and new.anonymized_at is not null)
  execute function agent_tokens_revoke_on_user();

create function agent_tokens_revoke_on_agent() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  update agent_tokens set revoked_at = now() where agent_id = old.id and revoked_at is null;
  return null;
end $$;
create trigger agent_tokens_revoke_on_agent after update of owner_user_id on agents
  for each row when (old.owner_user_id is distinct from new.owner_user_id)
  execute function agent_tokens_revoke_on_agent();

-- Каким токеном сделано действие агента: по нему видно, что натворил утёкший токен.
-- null — действие через коннектор (OAuth человека).
alter table agent_audit add column agent_token_id uuid references agent_tokens(id) on delete set null;
create index on agent_audit(agent_token_id) where agent_token_id is not null;
