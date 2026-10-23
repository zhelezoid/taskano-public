-- Срок называет исполнитель — спека self-set-due.
--
-- Просьба назвать срок — реплика по делу (`due_request`): у неё есть автор, время и `answered_at`,
-- то есть ровно то, что нужно для эскалации «попросили тогда-то, ответа нет». Отдельная таблица
-- повторила бы task_messages целиком.

alter table task_messages drop constraint task_messages_kind_check;
alter table task_messages add constraint task_messages_kind_check check (kind in (
  'comment','question','unclear','answer','decline_reason','owner_instruction','rework_reason','due_request'));

-- Таймер просьб перебирает только открытые: их единицы, а реплик по делам — тысячи.
create index task_messages_open_due_requests on task_messages(org_id, created_at)
  where kind = 'due_request' and answered_at is null;

-- Срок из обсуждения в чате ставится только там, где группе это разрешили: по
-- умолчанию выключено — договорённость в чате становится обязательством лишь с согласия владельца.
alter table group_chats add column due_from_chat boolean not null default false;

-- Один объект внешней системы — источник нескольких дел: сообщение чата, где названы
-- сроки двум делам, — основание у обоих. Прежний ключ (org_id, system, external_id) переносил строку
-- источника с одного дела на другое при повторе того же объекта. Новый ключ мягче старого: данные,
-- которые проходили прежнюю уникальность, проходят и эту.
drop index task_sources_external;
create unique index task_sources_external on task_sources(org_id, task_id, system, external_id)
  where system is not null and external_id is not null;
create index task_sources_by_external on task_sources(org_id, system, external_id)
  where system is not null and external_id is not null;
