-- Вход через Google на странице подключения к Claude (спека google-login).
--
-- Глобальный слой, как oauth_pending и login_codes: без RLS, доступ только через код сервера.
-- Строка живёт от старта входа до обратного вызова Google (10 минут) и одноразова. Всё, что
-- приходит из браузера назад, хранится хэшем: state, значение cookie tk_g, nonce. В открытом
-- виде — только code_verifier PKCE: его нужно отдать Google при обмене кода.

create table oauth_google_states (
  state_hash    text primary key,
  pending_id    uuid not null references oauth_pending(id) on delete cascade,
  cookie_hash   text not null,
  nonce_hash    text not null,
  code_verifier text not null,
  expires_at    timestamptz not null,
  used_at       timestamptz,
  created_at    timestamptz not null default now()
);
create index on oauth_google_states(pending_id);

-- Сессия входа, вошедшая через Google, принимает согласие только из того же браузера: здесь — хэш
-- его cookie tk_g. Пусто — сессия вошла кодом, согласие как раньше.
alter table oauth_pending add column via_google_cookie_hash text;

-- Аккаунт Google (sub из id_token), которым человек вошёл впервые. Та же почта с другим sub — другой
-- аккаунт Google (адрес в домене Workspace переназначили): через Google такой вход не принимается.
alter table users add column google_sub text;

grant select, insert, update, delete on oauth_google_states to taskano_app;
grant select, insert, update, delete on oauth_google_states to taskano_system;

comment on table oauth_google_states is 'Одноразовое состояние входа через Google: хэши state/cookie/nonce и PKCE verifier, 10 минут (спека google-login)';
