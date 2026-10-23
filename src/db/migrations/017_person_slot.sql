-- «Сейчас» — одно на человека, а не на компанию (спека multi-company).
--
-- Человек в трёх компаниях получал три дела «Сейчас» одновременно: слот считался внутри
-- организации, и каждая компания была уверена, что человек занят именно её делом. Продукт при этом
-- обещает обратное — одно дело сейчас.
--
-- Узнать это из транзакции одной организации нельзя: RLS чужих дел не покажет. Системное соединение
-- не годится — оно живёт в своей транзакции и не видит того, что делает текущая (дело, только что
-- активированное здесь же, для него ещё не существует). Поэтому узкая функция с правами владельца:
-- выполняется в той же транзакции, видит всё, но отдаёт только то, чем занят человек, — ни
-- заголовков, ни компаний, ни чего-либо ещё о чужой работе.

create or replace function person_slot_holders(p_user uuid)
returns table (id uuid, org_id uuid, status text, blocked_at timestamptz, assignee_user_id uuid)
language sql
stable
security definer
set search_path = public
as $$
  select t.id, t.org_id, t.status, t.blocked_at, t.assignee_user_id
    from tasks t
    join orgs o on o.id = t.org_id
    -- Только компании, где человек действительно работает: дело от компании, куда его лишь позвали
    -- (или откуда вывели), он не видит и не может двинуть — а слот бы держало, и человек остался бы
    -- вообще без «Сейчас». Личное пространство очереди не имеет вовсе (спека task-routing).
    join memberships m on m.org_id = t.org_id and m.user_id = p_user and m.status = 'active'
   where t.assignee_user_id = p_user
     and o.kind = 'company'
     and t.kind = 'action'
     and t.status in ('active', 'in_progress', 'blocked')
$$;

comment on function person_slot_holders(uuid) is
  'Чем человек занят прямо сейчас во всех его компаниях — для слота «Сейчас» (спека multi-company)';

revoke all on function person_slot_holders(uuid) from public;
grant execute on function person_slot_holders(uuid) to taskano_app;
grant execute on function person_slot_holders(uuid) to taskano_system;

-- Дела, которые уже лежат в личном пространстве со статусом очереди: до общего слота они держали
-- только свою личную организацию и никому не мешали, теперь держали бы человека во всех компаниях.
-- Ни один список их не показывает — вернуть в 'ready' надо разово, здесь.
update tasks t set status = 'ready', blocked_at = null
  from orgs o
 where o.id = t.org_id and o.kind = 'personal'
   and t.kind = 'action' and t.status in ('active', 'in_progress', 'blocked');
