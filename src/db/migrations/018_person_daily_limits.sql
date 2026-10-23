-- Суточные лимиты — на человека, а не на компанию (спека multi-company).
--
-- И три напоминания в день, и дневная квота шагов считались внутри организации: человек в двух
-- компаниях получал 3 + 3 напоминания и две полные квоты шагов, хотя внимание у него одно.
--
-- Считать это из транзакции одной организации нельзя (RLS чужого не покажет), а системное
-- соединение живёт в своей транзакции и не видит того, что текущая только что записала — четвёртое
-- напоминание за минуту после третьего оказалось бы первым. Поэтому, как и со слотом (миграция
-- 017), узкие функции с правами владельца: выполняются в той же транзакции, но отдают только
-- число — ни текстов, ни заголовков, ни названий чужих компаний.

-- Границу суток принимаем моментом времени, а не датой: `created_at::date` считал бы день по
-- поясу сессии базы (UTC), и у человека восточнее Гринвича первые часы его дня попадали бы во
-- вчера — лимит «три в день» пропускал бы четвёртое напоминание.
create or replace function person_reminders_since(p_user uuid, p_since timestamptz)
returns int
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::int from notifications n
   where n.user_id = p_user and n.kind = 'reminder' and n.created_at >= p_since
$$;

comment on function person_reminders_since(uuid, timestamptz) is
  'Сколько напоминаний человек получил с начала своего дня во всех его компаниях (спека multi-company)';

create or replace function person_agent_steps_since(p_user uuid, p_since timestamptz)
returns int
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::int from tasks t
   where t.assignee_user_id = p_user and t.author_agent_id is not null and t.created_at >= p_since
$$;

-- Порог квоты — тоже на человека. Считать шаги во всех компаниях и сверять их с порогом одной
-- значило бы: компания, где лимит не трогали (20 по умолчанию), обесценивает двойку, выставленную
-- соседней. Берём наименьший из действующих: квота защищает внимание человека, и строже тот, кто
-- ближе знает его нагрузку.
create or replace function person_daily_step_limit(p_user uuid)
returns int
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(min(q.daily_step_limit), 20)::int
    from queue_settings q
    join memberships m on m.org_id = q.org_id and m.user_id = q.user_id and m.status = 'active'
   where q.user_id = p_user
$$;

comment on function person_daily_step_limit(uuid) is
  'Наименьшая суточная квота шагов среди действующих компаний человека (спека multi-company)';

revoke all on function person_daily_step_limit(uuid) from public;
grant execute on function person_daily_step_limit(uuid) to taskano_app;
grant execute on function person_daily_step_limit(uuid) to taskano_system;

comment on function person_agent_steps_since(uuid, timestamptz) is
  'Сколько шагов агенты выдали человеку с начала его дня — во всех его компаниях (спека multi-company)';

revoke all on function person_reminders_since(uuid, timestamptz) from public;
revoke all on function person_agent_steps_since(uuid, timestamptz) from public;
grant execute on function person_reminders_since(uuid, timestamptz) to taskano_app;
grant execute on function person_reminders_since(uuid, timestamptz) to taskano_system;
grant execute on function person_agent_steps_since(uuid, timestamptz) to taskano_app;
grant execute on function person_agent_steps_since(uuid, timestamptz) to taskano_system;
