-- Значения по умолчанию у организации — нейтральные.
--
-- В 001 у `orgs` стояли `language = 'ru'` и `timezone = 'Europe/Istanbul'`: язык и пояс пилотной
-- организации владельца продукта. Для всякого следующего клиента это чужой календарь — его сроки,
-- рабочее окно агентов и граница суток считались бы не в его времени до первой настройки.
--
-- Код (`createCompanyOrg`) колонки задаёт всегда, поэтому дефолт таблицы — страховка; приводим её
-- в согласие с кодом, чтобы вставка мимо ядра не воскресила пилотные значения. Существующие строки
-- не трогаются: `alter column set default` действует только на будущие вставки.

alter table orgs alter column language set default 'en';
alter table orgs alter column timezone set default 'UTC';
alter table orgs alter column agent_window set default
  '{"tz":"UTC","days":[1,2,3,4,5],"start":"09:00","end":"19:00"}'::jsonb;
