import type { Db } from '../db/pool.js';
import { AppError } from './errors.js';
import { assertPlainName } from './names.js';
import { env } from '../config/env.js';
import { logger } from '../log.js';
import { sendEmail } from '../email/send.js';
import { welcomeOwnerMail } from '../email/templates/welcome-owner.js';
import { SKILL_REPO } from '../config/product.js';
import { emit } from './events.js';
import type { Actor } from './types.js';
import { actorAgentId, actorUserId } from './types.js';
import type { Role } from './access.js';

// Глобальный слой: люди, почты, организации, членства. Вызывается внутри withGlobal или withOrg
// (таблицы без RLS видны в обоих).

export interface UserRow {
  id: string; display_name: string; language: string; timezone: string; country: string | null;
  consent_at: Date | null; anonymized_at: Date | null;
}

const COUNTRY_TZ: Record<string, string> = { TR: 'Europe/Istanbul', VN: 'Asia/Ho_Chi_Minh', RU: 'Europe/Moscow' };
const LANG_COUNTRY: Record<string, string> = { tr: 'TR', vi: 'VN', ru: 'RU' };

export function guessCountry(language: string | null | undefined): string | null {
  return language ? LANG_COUNTRY[language] ?? null : null;
}
export function guessTimezone(country: string | null | undefined, fallback = 'Europe/Istanbul'): string {
  return (country && COUNTRY_TZ[country]) || fallback;
}

/**
 * Имя часового пояса IANA. Проверять обязательно на входе: неизвестное имя роняет `Intl` уже внутри
 * расчёта календаря (`src/core/calendar.ts`), то есть не в месте ошибки, а в тике организации —
 * и вся автоматика компании встаёт из-за одной опечатки в настройке.
 */
export function assertTimezone(tz: string): string {
  // Только полное имя зоны «Регион/Город» (или ровно UTC). Голая проверка через Intl слишком добра:
  // она принимает трёхбуквенные алиасы ICU и разрешает их не туда, о чём никто не узнает — «IST»
  // это Индия, а не Израиль, «EST» — Панама. Списком `Intl.supportedValuesOf` фильтровать нельзя:
  // в нём нет ни `UTC`, ни `Asia/Ho_Chi_Minh` — половина живых зон отвалилась бы как неизвестные.
  const wellFormed = tz === 'UTC' || /^[A-Za-z]+(?:\/[A-Za-z0-9_+-]+){1,2}$/.test(tz);
  if (wellFormed) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
      return tz;
    } catch { /* ниже — общая ошибка */ }
  }
  throw new AppError('validation_failed', `Unknown time zone "${tz}". Use a full IANA name, for example Asia/Ho_Chi_Minh or America/Sao_Paulo`);
}

export async function findUserByEmail(db: Db, email: string): Promise<UserRow | null> {
  const r = await db.query('select u.* from users u join user_emails e on e.user_id = u.id where e.email = $1', [email.trim()]);
  return (r.rows[0] as UserRow) ?? null;
}

/** Пускать ли почту внутрь (решение владельца 20.10.2026): Taskano — внутренний инструмент,
 *  сам себя посторонний не регистрирует. Входит тот, кто состоит в компании или приглашён в неё;
 *  остальным вход закрыт — и коннектору, и боту. Приглашение по-прежнему открывает дверь. */
export async function mayEnter(db: Db, email: string): Promise<boolean> {
  if (!env.internalOnly) return true;
  const r = await db.query(
    `select 1 from user_emails e join memberships m on m.user_id = e.user_id join orgs o on o.id = m.org_id
      where e.email = $1 and o.kind = 'company' and m.status in ('active', 'invited') limit 1`, [email.trim().toLowerCase()]);
  return (r.rowCount ?? 0) > 0;
}

/** Найти или создать человека по почте. Одна почта = один человек. */
export async function ensureUserByEmail(
  db: Db, email: string, opts: { name?: string; language?: string; country?: string | null; verified?: boolean } = {},
): Promise<{ user: UserRow; created: boolean }> {
  const normalized = email.trim().toLowerCase();
  // Длина проверяется раньше формата: почта в 40 000 знаков проходит regex и падает уже на пределе
  // индекса в базе — наружу уходил голый 500 вместо понятного отказа (ревью диффа). 254 — предел RFC.
  if (normalized.length > 254) throw new AppError('validation_failed', 'Invalid email: too long');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) throw new AppError('validation_failed', `Invalid email: ${email}`);
  const existing = await findUserByEmail(db, normalized);
  if (existing) {
    if (opts.verified) await db.query('update user_emails set verified_at = coalesce(verified_at, now()) where email = $1', [normalized]);
    return { user: existing, created: false };
  }
  const language = opts.language ?? 'en';
  const country = opts.country ?? guessCountry(language);
  const u = await db.query(
    `insert into users(display_name, language, country, timezone) values ($1, $2, $3, $4) returning *`,
    [opts.name ?? normalized.split('@')[0], language, country, guessTimezone(country)],
  );
  const user = u.rows[0] as UserRow;
  // Захват почты под savepoint. Гонка здесь реальная: приглашение и вход по той же почте могут
  // прийти одновременно, и тогда вторая вставка падала сырой ошибкой уникальности. `on conflict
  // do nothing` не годится — он ЖДЁТ чужую незакоммиченную вставку, то есть один прогон блокирует
  // другой; savepoint же трогает только тот путь, где конфликт действительно случился.
  await db.query('savepoint claim_email');
  try {
    await db.query(
      `insert into user_emails(email, user_id, verified_at, is_primary) values ($1, $2, $3, true)`,
      [normalized, user.id, opts.verified ? new Date() : null],
    );
    await db.query('release savepoint claim_email');
  } catch (e) {
    if ((e as { code?: string }).code !== '23505') throw e;
    await db.query('rollback to savepoint claim_email');
    // Победил параллельный вызов. Свою заготовку убираем — иначе останется человек без почты,
    // невидимый любому входу.
    await db.query('delete from users where id = $1', [user.id]);
    const winner = await findUserByEmail(db, normalized);
    if (!winner) throw e;
    if (opts.verified) await db.query('update user_emails set verified_at = coalesce(verified_at, now()) where email = $1', [normalized]);
    return { user: winner, created: false };
  }
  await ensurePersonalOrg(db, user.id);
  return { user, created: true };
}

/** Личное пространство — одно на человека. */
export async function ensurePersonalOrg(db: Db, userId: string): Promise<string> {
  const r = await db.query(`select id from orgs where owner_user_id = $1 and kind = 'personal'`, [userId]);
  if (r.rowCount) return r.rows[0].id;
  const o = await db.query(
    `insert into orgs(kind, name, owner_user_id) values ('personal', 'Личное', $1)
     on conflict (owner_user_id) where kind = 'personal' do nothing returning id`,
    [userId],
  );
  const orgId = o.rows[0]?.id ?? (await db.query(`select id from orgs where owner_user_id = $1 and kind = 'personal'`, [userId])).rows[0].id;
  await db.query(
    `insert into memberships(org_id, user_id, role, status, joined_at) values ($1, $2, 'owner', 'active', now()) on conflict do nothing`,
    [orgId, userId],
  );
  return orgId;
}

export async function createCompanyOrg(db: Db, ownerUserId: string, name: string, opts: { language?: string; timezone?: string } = {}): Promise<string> {
  name = assertPlainName(name ?? '', 'Organization name', 80);
  const count = await db.query(`select count(*)::int as n from orgs where owner_user_id = $1 and kind = 'company'`, [ownerUserId]);
  if (count.rows[0].n >= 3) throw new AppError('limit_exceeded', 'No more than three organizations per person');
  // Нейтральные значения по умолчанию. Дефолт продукта не вправе быть языком и поясом пилотной
  // организации: клиент, создавший компанию сам по инвайт-коду, иначе тихо стартует на чужом
  // календаре, и до первого `update_org_settings` его сроки считаются не в его сутках.
  const tz = opts.timezone ?? 'UTC';
  const o = await db.query(
    `insert into orgs(kind, name, owner_user_id, language, timezone, agent_window)
     values ('company', $1, $2, $3, $4, jsonb_build_object('tz', $4::text, 'days', '[1,2,3,4,5]'::jsonb, 'start', '09:00', 'end', '19:00'))
     returning id`,
    [name.trim(), ownerUserId, opts.language ?? 'en', tz],
  );
  const orgId = o.rows[0].id as string;
  await db.query(`insert into memberships(org_id, user_id, role, status, joined_at) values ($1, $2, 'owner', 'active', now())`, [orgId, ownerUserId]);
  return orgId;
}

/**
 * Подписать клиента пилота без инвайт-кода: человек, его личное пространство и компания, где он
 * владелец. Зовёт только админка продукта (`src/admin/cli.ts`): компанию за другого человека через MCP
 * не завести — свою через MCP заводят `create_org` (спека open-signup). Идемпотентно по паре «почта + название компании»: повтор команды
 * возвращает ту же организацию, а не вторую такую же.
 *
 * Почта помечается подтверждённой: за неё ручается оператор. Войти это не позволяет — вход всё
 * равно идёт кодом, отправленным на эту почту.
 */
export async function provisionClient(
  db: Db, email: string, companyName: string, opts: { language?: string; timezone?: string; name?: string } = {},
): Promise<{ userId: string; orgId: string; created: boolean }> {
  if (!companyName?.trim()) throw new AppError('validation_failed', 'Organization name is required');
  // Ни язык, ни часовой пояс за клиента не угадываются: оператор их не знает, а дефолты продукта
  // (ru / Europe/Istanbul) — это пилотная организация, а не новый клиент. Нейтральные en/UTC видны
  // сразу и как «не настроено»: setup.md обязывает агента клиента спросить и поставить своё.
  const language = opts.language ?? 'en';
  const timezone = assertTimezone(opts.timezone ?? 'UTC');
  // Одинаковые вызовы выстраиваются в очередь: иначе два параллельных запуска команды завели бы
  // человеку две одинаковые компании — уникальности по названию в схеме нет.
  await db.query('select pg_advisory_xact_lock(hashtext($1))', [`provision:${email.trim().toLowerCase()}:${companyName.trim().toLowerCase()}`]);
  const { user } = await ensureUserByEmail(db, email, { name: opts.name, language, verified: true });
  const existing = await db.query(
    `select id from orgs where owner_user_id = $1 and kind = 'company' and lower(name) = lower($2)`,
    [user.id, companyName.trim()],
  );
  if (existing.rowCount) return { userId: user.id, orgId: existing.rows[0].id, created: false };
  const orgId = await createCompanyOrg(db, user.id, companyName, { language, timezone });
  // Компания без письма — это компания, о которой владелец не знает, что с ней делать: первый
  // клиент пилота так и просидел, разговаривая с Клодом без коннектора (спека pilot-deploy).
  // Письмо не блокирует подписание: почта упала — компания всё равно заведена, письмо шлётся
  // повторно той же командой.
  try {
    await sendEmail(welcomeOwnerMail(email.trim().toLowerCase(), companyName.trim(), language, {
      site: env.publicUrl,
      connector: `${env.publicUrl}/mcp`,
      skill: SKILL_REPO,
    }));
  } catch (e) {
    logger.error({ err: e, orgId }, 'подписание клиента: приветственное письмо не ушло');
  }
  return { userId: user.id, orgId, created: true };
}

export async function addMember(db: Db, orgId: string, userId: string, role: Role, status: 'active' | 'invited' = 'active'): Promise<void> {
  await db.query(
    `insert into memberships(org_id, user_id, role, status, joined_at) values ($1, $2, $3, $4, case when $4 = 'active' then now() end)
     on conflict (org_id, user_id) do update set
       role = case when memberships.status = 'removed' then excluded.role else memberships.role end,
       status = case when memberships.status = 'removed' then excluded.status else memberships.status end,
       removed_at = null`,
    [orgId, userId, role, status],
  );
}

/** Профиль человека: до 2000 знаков (спека person-profile). */
export const ABOUT_LIMIT = 2000;

/**
 * Записать профиль человека в этой компании: правит владелец, админ — и сам человек
 * про себя. Агент профиль читает, но не пишет: это слова людей о людях, а не вывод модели.
 */
export async function setPersonAbout(db: Db, personId: string, about: string | null, actor: Actor): Promise<{ user_id: string; about: string | null }> {
  const userId = actorUserId(actor);
  if (!userId) throw new AppError('forbidden', 'The system does not write people profiles');
  if (actorAgentId(actor)) throw new AppError('forbidden', 'A profile is written by people, not by an agent');
  const text = about?.trim() ? about.trim() : null;
  if (text && text.length > ABOUT_LIMIT) {
    throw new AppError('validation_failed', `A profile is a paragraph, not a dossier: up to ${ABOUT_LIMIT} characters`);
  }
  if (personId !== userId) {
    const r = await db.query(
      `select role from memberships where org_id = current_setting('app.org_id')::uuid and user_id = $1 and status = 'active'`,
      [userId]);
    const role = r.rows[0]?.role as string | undefined;
    if (role !== 'owner' && role !== 'admin') {
      throw new AppError('forbidden', 'Only the person themselves, the owner or an admin writes this profile');
    }
  }
  const upd = await db.query(
    `update memberships set about = $2
      where org_id = current_setting('app.org_id')::uuid and user_id = $1 and status <> 'removed'
      returning user_id, about`, [personId, text]);
  if (!upd.rowCount) throw new AppError('not_found', 'This person is not in the organization');
  await emit(db, { type: 'person_profile_set', actorUserId: userId, data: { user_id: personId, filled: text !== null } });
  return upd.rows[0] as { user_id: string; about: string | null };
}

/** Человек организации по id, почте или имени — для полей assignee/person/owner инструментов MCP. */
export async function resolvePersonRef(db: Db, ref: string): Promise<string> {
  const trimmed = ref.trim();
  if (/^[0-9a-f-]{36}$/i.test(trimmed)) {
    const byId = await db.query(
      `select user_id from memberships where org_id = current_setting('app.org_id')::uuid and user_id = $1 and status <> 'removed'`,
      [trimmed],
    );
    if (byId.rowCount) return byId.rows[0].user_id;
  }
  const byEmail = await db.query(
    `select m.user_id from memberships m join user_emails e on e.user_id = m.user_id
      where m.org_id = current_setting('app.org_id')::uuid and m.status <> 'removed' and e.email = $1`,
    [trimmed.toLowerCase()],
  );
  if (byEmail.rowCount) return byEmail.rows[0].user_id;
  const byName = await db.query(
    `select m.user_id from memberships m join users u on u.id = m.user_id
      where m.org_id = current_setting('app.org_id')::uuid and m.status <> 'removed' and lower(u.display_name) = lower($1)`,
    [trimmed],
  );
  if (byName.rowCount === 1) return byName.rows[0].user_id;
  if (byName.rowCount) throw new AppError('not_found', `Person "${ref}" is ambiguous in the organization`, { ambiguous: byName.rowCount });
  // Часть имени: владелец говорит «Ахмет», а в карточке «Ahmet Özkan». Без этого поиск по имени
  // находил только полное имя слово в слово, и агент делал вывод «на нём задач нет» (29.09, Ахмет).
  // Совпадение — начало любого слова имени; берём, только если такой человек один, иначе называем
  // кандидатов, а не угадываем.
  const byPart = await db.query(
    `select m.user_id, u.display_name from memberships m join users u on u.id = m.user_id
      where m.org_id = current_setting('app.org_id')::uuid and m.status <> 'removed' and u.anonymized_at is null
        and (lower(u.display_name) like lower($1) || '%' or lower(u.display_name) like '% ' || lower($1) || '%')
      order by u.display_name limit 6`,
    [trimmed.replace(/[\\%_]/g, (c) => `\\${c}`)],
  );
  if (byPart.rowCount === 1) return byPart.rows[0].user_id;
  if (byPart.rowCount) {
    throw new AppError('not_found', `Person "${ref}" is ambiguous in the organization: ${byPart.rows.map((r) => r.display_name).join(', ')}`,
      { ambiguous: byPart.rowCount });
  }
  throw new AppError('not_found', `Person "${ref}" not found in the organization`);
}

/**
 * Организации человека. По умолчанию — вместе с приглашениями, их ждёт экран «меня позвали».
 * Поверхности, которые показывают работу (бот и его списки), зовут с `includeInvited: false`:
 * приглашение, которое не приняли, — ещё не работа (спека multi-company).
 */
export async function userOrgs(
  db: Db, userId: string, opts: { includeInvited?: boolean } = {},
): Promise<{ id: string; name: string; kind: string; role: Role; status: string }[]> {
  // По умолчанию — только компании, где человек действительно работает. Приглашение, которое он ещё
  // не принял, — не работа: её дела он не видит и отвечать по ним не может, а появившись в списке,
  // компания обещала бы обратное (спека multi-company). Приглашённые — по явной просьбе.
  const statuses = opts.includeInvited ? ['active', 'invited'] : ['active'];
  const r = await db.query(
    `select o.id, o.name, o.kind, m.role, m.status from memberships m join orgs o on o.id = m.org_id
      where m.user_id = $1 and m.status = any($2) order by o.kind, o.created_at`,
    [userId, statuses],
  );
  return r.rows;
}

/**
 * Название текущей компании — если называть её есть смысл (спека multi-company).
 * Смысл появляется, когда действующих компаний у человека больше одной: «Сейчас: подготовить
 * отчёт» из двух разных компаний различить неоткуда, а проект по умолчанию в обеих зовётся
 * одинаково. У человека с одной компанией — null: лишнее слово в каждом сообщении раздражает
 * больше, чем помогает. Личное пространство компанией не считается.
 *
 * Свойство человека, а не организации: один и тот же текст одному приходит с названием, другому —
 * без. `memberships` и `orgs` живут вне слоя организации, поэтому видны из любой транзакции.
 */
export async function companyNameIfMany(db: Db, userId: string): Promise<string | null> {
  // Компания, куда человека лишь позвали, тоже в счёт — но только своя, текущая: её дела
  // он видит рядом с делами действующей компании, и путаница ровно та же. Чужие приглашения не
  // считаем: живо ли приглашение, отсюда не видно, а залежавшееся ставило бы название всем подряд.
  const r = await db.query(
    `with companies as (
       select o.id, o.name from memberships m join orgs o on o.id = m.org_id
        where m.user_id = $1 and o.kind = 'company'
          and (m.status = 'active' or (m.status = 'invited' and o.id = nullif(current_setting('app.org_id', true), '')::uuid))
     )
     select name from companies
      where id = nullif(current_setting('app.org_id', true), '')::uuid
        and (select count(*) from companies) > 1`,
    [userId],
  );
  return (r.rows[0]?.name as string | undefined) ?? null;
}
