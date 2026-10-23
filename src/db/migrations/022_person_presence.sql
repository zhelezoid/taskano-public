-- Когда человек последний раз заходил в бота и в Mini App (спека person-presence).
--
-- Taskano хранил только действия: просмотр бота или приложения следа не оставлял, и на вопрос «а он
-- вообще открывал приложение?» ответить было нечем — «active» в списке людей говорит о членстве, не
-- о жизни. Отметка у человека, а не у членства: бот и приложение одни на все его компании.
--
-- До этой миграции отметок не было ни у кого: null значит «не видели с даты выкатки»
-- (SEEN_TRACKED_SINCE в src/core/presence.ts), а не «не заходил никогда».
alter table users add column last_seen_bot_at timestamptz;
alter table users add column last_seen_app_at timestamptz;

comment on column users.last_seen_bot_at is
  'Последнее обновление от человека в личном чате бота; пишется не чаще раза в 5 минут (спека person-presence)';
comment on column users.last_seen_app_at is
  'Последний авторизованный запрос Mini App; пишется не чаще раза в 5 минут (спека person-presence)';
