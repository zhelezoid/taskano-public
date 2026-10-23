-- Токен только на чтение для программ человека (спека read-tokens).
--
-- Глобальный слой, как oauth_tokens: без RLS и без org_id — токен принадлежит человеку, а не
-- компании; что он видит в компании, решает уже withOrg + действующее лицо. Сам токен не хранится —
-- только sha256 hex: утечка базы не даёт читать чужую ленту. Отзыв — отметка, а не удаление: по ней
-- видно, когда токен перестал действовать.

create table read_tokens (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users(id) on delete cascade,
  label        text not null,
  token_hash   text not null unique,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);
-- Список и предел «не больше 5 действующих» считаются по человеку.
create index on read_tokens(user_id) where revoked_at is null;

grant select, insert, update, delete on read_tokens to taskano_app;
grant select, insert, update, delete on read_tokens to taskano_system;

comment on table read_tokens is 'Постоянный токен только на чтение (GET /api/read): хэш sha256, отзыв отметкой (спека read-tokens)';
