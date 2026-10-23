-- Закрытая доска не называет себя тем, кому она закрыта (ревью диффа).
--
-- У `tasks` правило видимости стоит в самой базе (миграции 008, 009, 013), а у `projects` была
-- только граница организаций. Дела чужой закрытой доски не выдавались — а её имя выдавалось: любой
-- участник компании, открыв «Итоги», видел строку «Секретный проект» с нулём дел. Имя закрытой
-- доски — это и есть то, что от неё скрывают: «Переговоры о продаже» говорит достаточно.
--
-- Условие дословно повторяет правило для дел: доска не закрыта ИЛИ я её хозяин ИЛИ я в составе ИЛИ
-- это фоновая сессия. Фоновое послабление обязательно: воркер обходит доски без действующего лица,
-- и без него таймеры и напоминания по закрытым доскам молча встали бы (та же плата, что в 009).

-- `as restrictive`: обычные политики складываются через ИЛИ, и рядом с `org_isolation` эта ничего
-- бы не закрыла — «своя организация» разрешала бы всё. Ограничивающая политика применяется через И.
create policy project_privacy on projects as restrictive
  using (
    private = false
    or owner_user_id = nullif(current_setting('app.actor_user_id', true), '')::uuid
    or current_setting('app.background', true) = '1'
    or exists (
      select 1 from project_members m
       where m.project_id = projects.id
         and m.user_id = nullif(current_setting('app.actor_user_id', true), '')::uuid))
  with check (
    private = false
    or owner_user_id = nullif(current_setting('app.actor_user_id', true), '')::uuid
    or current_setting('app.background', true) = '1'
    or exists (
      select 1 from project_members m
       where m.project_id = projects.id
         and m.user_id = nullif(current_setting('app.actor_user_id', true), '')::uuid));

comment on table projects is 'Доски компании; закрытую видят хозяин и состав — правило в политике project_privacy';
