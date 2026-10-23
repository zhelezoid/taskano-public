-- Открытая регистрация (спека open-signup): компания, заведённая без инвайт-кода, — непроверенная.
-- Потолок бюджета AI держит владелец продукта, а не владелец компании: иначе посторонний ставил себе
-- любой бюджет и тратил деньги продукта. Существующие компании — проверенные, их потолок — 20 $.
alter table orgs add column trusted boolean not null default true;
alter table orgs add column ai_budget_cap_usd numeric(10,2) not null default 20;
