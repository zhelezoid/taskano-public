import { withSystem } from '../db/pool.js';

// Разовая проверка после закрытия захвата аккаунта через ссылку-приглашение (аудит безопасности).
// Ссылка с токеном раньше уходила в ответ приглашающему, а «Да, это я» почту не проверяет: кто угодно
// заводил компанию, звал чужую почту и привязывал свой Telegram к чужому аккаунту. Здесь — привязки,
// которые могли так появиться: Telegram привязан принятием приглашения компании без инвайт-кода
// (`trusted = false`), и либо человек с этой почтой существовал до приглашения, либо после привязки
// с этой почтой пришёл кто-то ещё (см. `kind`). Только чтение: что с ними делать, решает владелец
// продукта по каждой строке.

export interface SuspectInviteLink {
  /**
   * `existed_before` — человек с этой почтой был в Taskano до приглашения: Telegram мог привязать тот,
   * кто позвал чужой аккаунт. `registered_after` — человек заведён самим приглашением, но потом с этой
   * почтой пришёл кто-то ещё (своя компания, другие членства, вход по коду почты): Telegram мог
   * привязать тот, кто позвал почту до её владельца, а владелец пришёл позже («почта до регистрации»).
   */
  kind: 'existed_before' | 'registered_after';
  telegram_user_id: string;
  user_id: string;
  email: string;
  linked_at: Date;
  org_id: string;
  org_name: string;
  invitation_id: string;
  invited_at: Date;
  accepted_at: Date;
  user_created_at: Date;
  /** Других компаний у человека, кроме пригласившей: у жертвы захвата они обычно есть. */
  other_memberships: number;
  /** Что появилось у человека после привязки (только для `registered_after`). */
  later: { companies_owned: number; memberships_joined: number; email_code_logins: number } | null;
}

/**
 * Привязка «создана принятием», если она появилась в той же транзакции, что и принятие: время
 * привязки — часы базы, время принятия — часы приложения, поэтому сравниваем с запасом.
 * «Существовал до приглашения» — человек заведён раньше первого письма-приглашения: новый человек
 * заводится той же транзакцией, что и приглашение, и время у них одно.
 */
const LINKS_BY_ACCEPTANCE = `
  select tl.telegram_user_id::text, tl.user_id, i.email::text as email, tl.linked_at,
         i.org_id, o.name as org_name, i.id as invitation_id, coalesce(invited.at, i.created_at) as invited_at,
         i.accepted_at, u.created_at as user_created_at,
         (select count(*)::int from memberships m
           where m.user_id = tl.user_id and m.org_id <> i.org_id and m.status <> 'removed') as other_memberships
    from invitations i
    join orgs o on o.id = i.org_id and not o.trusted
    join users u on u.id = i.user_id
    join telegram_links tl on tl.user_id = i.user_id
    left join lateral (
      select min(e.at) as at from events e
       where e.org_id = i.org_id and e.type = 'person_invited' and e.data->>'invitation_id' = i.id::text
    ) invited on true
   where i.status = 'accepted' and i.accepted_at is not null
     and tl.linked_at between i.accepted_at - interval '1 minute' and i.accepted_at + interval '1 minute'`;

export async function auditInviteLinks(): Promise<SuspectInviteLink[]> {
  // Системное соединение: приглашения и события — слой организаций, а смотреть нужно по всем сразу.
  return withSystem(async (db) => {
    const before = (await db.query(
      `select 'existed_before' as kind, x.*, null::jsonb as later from (${LINKS_BY_ACCEPTANCE}) x
        where x.user_created_at < x.invited_at
        order by x.linked_at desc`,
    )).rows as SuspectInviteLink[];
    // Личное пространство не в счёт: оно заводится само, признаком другого человека не служит.
    const after = (await db.query(
      `select 'registered_after' as kind, x.*, jsonb_build_object(
                'companies_owned', l.companies_owned, 'memberships_joined', l.memberships_joined,
                'email_code_logins', l.email_code_logins) as later
         from (${LINKS_BY_ACCEPTANCE}) x
         cross join lateral (
           select (select count(*)::int from orgs o2
                    where o2.owner_user_id = x.user_id and o2.kind = 'company' and o2.created_at > x.linked_at) as companies_owned,
                  (select count(*)::int from memberships m join orgs o3 on o3.id = m.org_id and o3.kind = 'company'
                    where m.user_id = x.user_id and m.org_id <> x.org_id and m.joined_at > x.linked_at) as memberships_joined,
                  (select count(*)::int from login_codes lc join user_emails e on e.email = lc.email
                    where e.user_id = x.user_id and lc.consumed_at > x.linked_at) as email_code_logins
         ) l
        where x.user_created_at >= x.invited_at
          and l.companies_owned + l.memberships_joined + l.email_code_logins > 0
        order by x.linked_at desc`,
    )).rows as SuspectInviteLink[];
    return [...before, ...after];
  });
}
