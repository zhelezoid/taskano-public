-- Фоновые задания видят закрытые проекты своей организации.
--
-- Миграция 008 закрыла дела закрытого проекта ото всех, у кого в сессии нет их хозяина. Под это
-- правило попал и воркер: `tickOrg` идёт под `withOrg` без действующего лица, поэтому дело в
-- закрытом проекте компании переставало активироваться по сроку, не получало напоминаний и не
-- попадало в «Сейчас» — молча.
--
-- Сделать воркер системным (BYPASSRLS) нельзя: вместе с приватностью отключится и граница
-- организаций, и запрос вроде «все scheduled» вернёт чужие дела. Поэтому добавляем узкое
-- послабление: признак сессии `app.background`, который ставит только `withOrgBackground`
-- (см. src/db/pool.ts). Граница организаций при этом остаётся в силе — снимается ровно приватность.

drop policy project_visibility on tasks;

create policy project_visibility on tasks
  using (
    org_id = nullif(current_setting('app.org_id', true), '')::uuid
    and (private_owner_user_id is null
         or private_owner_user_id = nullif(current_setting('app.actor_user_id', true), '')::uuid
         or current_setting('app.background', true) = '1'))
  with check (
    org_id = nullif(current_setting('app.org_id', true), '')::uuid
    and (private_owner_user_id is null
         or private_owner_user_id = nullif(current_setting('app.actor_user_id', true), '')::uuid
         or current_setting('app.background', true) = '1'));
