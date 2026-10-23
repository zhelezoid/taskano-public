import { withGlobal, withOrg, withPrivacyLifted, withSystem, type Db } from '../db/pool.js';
import { AppError } from './errors.js';
import { randomToken, sha256 } from './crypto.js';
import { addMember, ensureUserByEmail, userOrgs } from './people.js';
import { loadAgent, requireActorRole, requireMember, type Role } from './access.js';
import { emit } from './events.js';
import { notify } from './notify.js';
import { fillSlot } from './queue.js';
import { cancelTask, handReviewOver } from './tasks.js';
import { env } from '../config/env.js';
import { sendEmail } from '../email/send.js';
import { assertPlainName } from './names.js';
import { invitationMail, type InvitationInfo } from '../email/templates/invitation.js';
import { openAppMail } from '../email/templates/open-app.js';
import { loadSeen, presenceOf, presenceView, viewerTimezone, type Presence } from './presence.js';
import type { Actor, Task } from './types.js';
import { actorAgentId, actorUserId } from './types.js';

// Приглашение и вывод людей из организации (спека mcp-and-oauth, группа «Люди»).

export interface InvitePersonInput { email: string; name?: string; role: Role; language?: string }

export interface InviteResult {
  userId: string;
  membershipStatus: 'active' | 'invited';
  invitationId: string | null;
  alreadyMember: boolean;
}

/** Уже активный участник: письма нет, но видно, заходит ли он (спека person-presence). */
export type AlreadyMemberResult = InviteResult & Presence;

const INVITATION_TTL_MS = 30 * 24 * 3600 * 1000;

/**
 * Потолок писем-приглашений (спека open-signup). Компанию теперь заводит кто угодно, а приглашение —
 * письмо с домена taskano.app с названием, которое выбрал владелец компании: без потолка это канал
 * спама и фишинга, и за ним — репутация домена, с которого уходят и коды входа всем клиентам. Свежая
 * компания — самый дешёвый путь для рассыльщика, у неё потолок ниже. Считаются письма: и первое
 * приглашение, и повтор.
 */
export const INVITE_LIMITS = { perDay: 20, youngPerDay: 10, youngTotal: 30, youngDays: 7, untrustedTotal: 30, untrustedProductPerDay: 300 };

/** События, каждое из которых — письмо-приглашение: первое, повтор, напоминание воркера. */
const INVITE_MAIL_EVENTS = ['person_invited', 'invitation_resent', 'invitation_reminded'];

/** Замок писем-приглашений компании до конца транзакции. Повторный захват той же сессией не ждёт. */
async function lockInvitationMail(db: Db): Promise<void> {
  await db.query(`select pg_advisory_xact_lock(hashtext('taskano:invite:' || current_setting('app.org_id')))`);
}

/**
 * Можно ли этой компании (контекст `app.org_id`) отправить ещё одно письмо-приглашение. Замок на
 * компанию берётся до подсчёта и держится до конца транзакции: без него параллельные приглашения
 * читали один и тот же счёт и проходили все (ревью диффа).
 */
export async function invitationBudgetRefusal(db: Db, now: Date): Promise<string | null> {
  await lockInvitationMail(db);
  const r = (await db.query(
    `select o.created_at > $1::timestamptz - make_interval(days => $2) as young, o.trusted,
            (select count(*)::int from events e where e.org_id = o.id and e.type = any($3::text[])
               and e.at > $1::timestamptz - interval '24 hours') as day,
            (select count(*)::int from events e where e.org_id = o.id and e.type = any($3::text[])) as total
       from orgs o where o.id = current_setting('app.org_id')::uuid`,
    [now, INVITE_LIMITS.youngDays, INVITE_MAIL_EVENTS])).rows[0] as { young: boolean; trusted: boolean; day: number; total: number };
  const perDay = r.young ? INVITE_LIMITS.youngPerDay : INVITE_LIMITS.perDay;
  if (r.day >= perDay) return `No more than ${perDay} invitation emails a day from this organization. Try again tomorrow`;
  if (r.young && r.total >= INVITE_LIMITS.youngTotal) {
    return `A new organization can send ${INVITE_LIMITS.youngTotal} invitation emails in its first ${INVITE_LIMITS.youngDays} days. `
      + 'More are possible later, or write to support@taskano.app';
  }
  if (!r.trusted) {
    if (r.total >= INVITE_LIMITS.untrustedTotal) {
      return `An organization created without an invite code can send ${INVITE_LIMITS.untrustedTotal} invitation emails. `
        + 'Write to support@taskano.app to lift the limit';
    }
    // Потолок одной компании не держит рассыльщика с сотней аккаунтов — считаем всех непроверенных.
    const product = await withSystem(async (s) => (await s.query(
      `select count(*)::int as n from events e join orgs o on o.id = e.org_id
        where not o.trusted and e.type = any($2::text[]) and e.at > $1::timestamptz - interval '24 hours'`,
      [now, INVITE_MAIL_EVENTS])).rows[0].n as number);
    if (product >= INVITE_LIMITS.untrustedProductPerDay) {
      return 'Taskano is not sending invitations from new organizations right now. Try again tomorrow or write to support@taskano.app';
    }
  }
  return null;
}

async function assertInvitationBudget(db: Db, now: Date): Promise<void> {
  const refusal = await invitationBudgetRefusal(db, now);
  if (refusal) throw new AppError('limit_exceeded', refusal);
}

export async function invitePerson(db: Db, input: InvitePersonInput, actor: Actor, now: Date = new Date()): Promise<InviteResult | AlreadyMemberResult> {
  const callerUserId = actorUserId(actor);
  if (!callerUserId) throw new AppError('forbidden', 'The system does not invite people');
  if (!input.email?.trim()) throw new AppError('validation_failed', 'email is required');
  // Состав компании меняют владелец и админ (спека roles-and-rights). Приглашение назначает роль —
  // без этой проверки рядовой исполнитель заводил в компанию вторую свою почту владельцем.
  await requireActorRole(db, actor, ['owner', 'admin']);
  // Владельца зовёт только владелец: иначе админ приглашал бы вторую свою почту владельцем и
  // получал права, которых ему не давали, — снять владельца потом нельзя.
  if (input.role === 'owner') await requireActorRole(db, actor, ['owner']);

  const org = (await db.query(`select id, name, language, invite_domains from orgs where id = current_setting('app.org_id')::uuid`)).rows[0];
  const domain = input.email.trim().toLowerCase().split('@')[1] ?? '';
  const allowedDomains: string[] | null = org.invite_domains;
  if (allowedDomains?.length && !allowedDomains.some((d) => d.toLowerCase() === domain)) {
    const agentId = actorAgentId(actor);
    if (agentId) {
      const agent = await loadAgent(db, agentId);
      if (!agent.permissions?.invite_any_domain) {
        throw new AppError('forbidden', `Email is outside the allowed domains of the organization: ${allowedDomains.join(', ')}`);
      }
    } else {
      await requireMember(db, callerUserId, ['owner', 'admin']);
    }
  }

  const personName = input.name === undefined || input.name === null ? undefined : assertPlainName(input.name, 'name', 60);
  const { user } = await ensureUserByEmail(db, input.email, { name: personName, language: input.language });
  const existing = await db.query(
    `select status from memberships where org_id = current_setting('app.org_id')::uuid and user_id = $1`,
    [user.id],
  );
  // Приглашение на почту уже активного участника — членство уже есть, письма не шлём (edge case спеки).
  // Отметки — чтобы «он уже у нас» не звучало как «он работает»: вошёл и пропал — тоже active.
  if (existing.rows[0]?.status === 'active') {
    return { userId: user.id, membershipStatus: 'active', invitationId: null, alreadyMember: true, ...(await presenceOf(db, user.id, await viewerTimezone(db, actor), now)) };
  }

  await assertInvitationBudget(db, now);
  await addMember(db, org.id, user.id, input.role, 'invited');

  const token = randomToken();
  const ins = await db.query(
    `insert into invitations(org_id, email, user_id, role, language, token_hash, invited_by_user_id, invited_by_agent_id)
     values (current_setting('app.org_id')::uuid, $1, $2, $3, $4, $5, $6, $7) returning id`,
    [input.email.trim().toLowerCase(), user.id, input.role, input.language ?? null, sha256(token), callerUserId, actorAgentId(actor)],
  );
  const invitationId = ins.rows[0].id as string;

  const inviterName = await inviterDisplayName(db, callerUserId, org.name);
  // Язык письма — указанный приглашающим, иначе язык компании: турецкой компании незачем
  // звать человека английским письмом (спека translation-and-email).
  const lang = input.language ?? org.language ?? 'en';
  const link = `https://t.me/${env.telegramBotUsername}?start=inv_${token}`;
  await sendEmail(invitationMail(input.email, { inviterName, orgName: org.name, personName: personName ?? null, role: input.role, link }, lang));

  await emit(db, {
    type: 'person_invited', actorUserId: actorUserId(actor), actorAgentId: actorAgentId(actor),
    data: { user_id: user.id, invitation_id: invitationId },
  });
  // Ссылку пригласившему не отдаём: токен в ней — это вход в аккаунт человека с этой почтой.
  // «Да, это я» почту не проверяет, а пригласить может кто угодно (открытая регистрация), и
  // ссылка в ответе давала постороннему привязать свой Telegram к чужому аккаунту — в том числе к
  // почте, которую ещё никто не регистрировал. Токен знает только тот, кто читает эту почту; письмо
  // не дошло — повтор приглашения шлёт новое.
  return { userId: user.id, membershipStatus: 'invited', invitationId, alreadyMember: false };
}

/** Что сделал повтор приглашения (спека person-presence, таблица «Повторное приглашение»). */
export type ResendOutcome = 'invitation_resent' | 'app_nudge_sent' | 'already_using_app' | 'app_nudge_recent';

/**
 * Отметки (`Presence`) — только про того, кто уже в компании. Непринявший приглашение ещё не её
 * человек: его отметки — это его жизнь в других компаниях, а пригласить можно любой адрес.
 */
export interface ResendResult extends Partial<Presence> {
  result: ResendOutcome;
  /** Что ушло человеку: агент пересказывает владельцу ровно это. */
  sent: ('email' | 'telegram')[];
  invitationId?: string;
}

/** Не чаще раза в сутки напоминаем одному человеку про приложение: вторая просьба владельца — не повод для второго письма. */
const APP_NUDGE_INTERVAL_HOURS = 24;

/**
 * Повторить приглашение — по тому, на каком шаге человек застрял (спека person-presence):
 *
 * - приглашение не принято — новая ссылка (прежняя перестаёт работать) и новое письмо: первое не дошло;
 * - вошёл, но в приложение не заходил — письмо «откройте приложение» и сообщение бота с кнопкой в него;
 * - в приложение заходил — ничего: помогать тут нечем, а ответ говорит, когда он был;
 * - напоминание уходило меньше суток назад — ничего: второе письмо подряд не помогает, а раздражает.
 *
 * Раньше повтор знал только первый случай, и тому, кто принял приглашение и пропал, ответом было
 * «No pending invitation». Только владелец/админ организации или агент от их имени.
 */
export async function resendInvitation(db: Db, email: string, actor: Actor, now: Date = new Date()): Promise<ResendResult> {
  const callerUserId = actorUserId(actor);
  if (!callerUserId) throw new AppError('forbidden', 'The system does not invite people');
  // Роль спрашиваем и у вызова от имени агента: иначе агент рядового рассылает приглашения заново,
  // а ссылка из письма — это вход в компанию.
  await requireActorRole(db, actor, ['owner', 'admin']);
  const r = await db.query(
    `select id, email, language, role from invitations
      where org_id = current_setting('app.org_id')::uuid and lower(email) = lower($1) and status = 'pending'
      order by created_at desc limit 1 for update`,
    [email.trim()],
  );
  const inv = r.rows[0] as { id: string; email: string; language: string | null; role: InvitationInfo['role'] } | undefined;
  const org = (await db.query(`select name, language from orgs where id = current_setting('app.org_id')::uuid`)).rows[0] as { name: string; language: string };
  if (!inv) return nudgeActiveMember(db, email, actor, callerUserId, org, now);

  await assertInvitationBudget(db, now);
  const token = randomToken();
  // Срок приглашения считается заново: человек получает письмо только сейчас.
  await db.query('update invitations set token_hash = $2, created_at = now(), reminded_at = null, escalated_at = null where id = $1', [inv.id, sha256(token)]);
  const link = `https://t.me/${env.telegramBotUsername}?start=inv_${token}`;
  const inviterName = await inviterDisplayName(db, callerUserId, org.name);
  await sendEmail(invitationMail(inv.email, { inviterName, orgName: org.name, role: inv.role, link }, inv.language ?? org.language ?? 'en'));
  await emit(db, { type: 'invitation_resent', actorUserId: actorUserId(actor), actorAgentId: actorAgentId(actor), data: { invitation_id: inv.id } });
  // Новая ссылка — только в письме, как и первая (см. `invitePerson`).
  return { result: 'invitation_resent', sent: ['email'], invitationId: inv.id };
}

/** Повтор для того, кто уже вошёл: приглашать некуда, помогает только дорога в приложение. */
async function nudgeActiveMember(
  db: Db, email: string, actor: Actor, callerUserId: string, org: { name: string; language: string }, now: Date,
): Promise<ResendResult> {
  const person = (await db.query(
    `select u.id, u.language, e.email::text as email, tl.chat_id, tl.blocked_at
       from user_emails e join users u on u.id = e.user_id
       join memberships m on m.user_id = u.id and m.org_id = current_setting('app.org_id')::uuid and m.status = 'active'
       left join telegram_links tl on tl.user_id = u.id
      where lower(e.email::text) = lower($1)`,
    [email.trim()],
  )).rows[0] as { id: string; language: string; email: string; chat_id: string | null; blocked_at: Date | null } | undefined;
  // Не в компании, выведен или приглашение истекло — тот же ответ, что и раньше: повторять нечего.
  if (!person) throw new AppError('not_found', `No pending invitation and no active member for ${email}`);

  // Решает сырая отметка, а в ответ идут слова в поясе того, кто просил.
  const seen = await loadSeen(db, person.id);
  const presence = presenceView(seen.bot, seen.app, await viewerTimezone(db, actor), now);
  if (seen.app) return { result: 'already_using_app', sent: [], ...presence };

  // Замок — до проверки «уже напоминали»: иначе две просьбы подряд обе видят «не напоминали» и шлют
  // два письма. Бюджет ниже берёт тот же замок, повторный захват той же транзакцией не ждёт.
  await lockInvitationMail(db);
  const recent = await db.query(
    `select 1 from events
      where type = 'invitation_resent' and data->>'kind' = 'app' and data->>'user_id' = $1
        and at > $2::timestamptz - make_interval(hours => $3)
      limit 1`,
    [person.id, now, APP_NUDGE_INTERVAL_HOURS],
  );
  if (recent.rowCount) return { result: 'app_nudge_recent', sent: [], ...presence };

  // Под тем же потолком, что приглашения: это тоже письмо с нашего домена по просьбе владельца компании.
  await assertInvitationBudget(db, now);
  const requesterName = await inviterDisplayName(db, callerUserId, org.name);
  // Заблокировавшему бота сообщение не дойдёт — не ставим его в очередь, чтобы ответ не обещал лишнего.
  const telegram = Boolean(person.chat_id && !person.blocked_at);
  const sent: ResendResult['sent'] = telegram ? ['email', 'telegram'] : ['email'];
  // Всё, что пишется в базу, — до письма, а письмо последним. Письмо из транзакции не отзовёшь:
  // упади запись после отправки, откат стёр бы событие, и следующая просьба не увидела бы ни
  // суточного лимита, ни расхода бюджета — письма уходили бы снова и снова. Упадёт сама отправка —
  // откатится и событие, и сообщение в бота: ничего не ушло, ничего и не записано.
  if (telegram) await notify(db, { userId: person.id, kind: 'open_app', level: 'work', payload: { by: requesterName } });
  // Событие — и строка бюджета писем (INVITE_MAIL_EVENTS), и метка для суточной проверки выше.
  await emit(db, {
    type: 'invitation_resent', actorUserId: actorUserId(actor), actorAgentId: actorAgentId(actor),
    data: { kind: 'app', user_id: person.id, sent },
  });
  await sendEmail(openAppMail(person.email, { requesterName, orgName: org.name, botUsername: env.telegramBotUsername }, person.language ?? org.language ?? 'en'));
  return { result: 'app_nudge_sent', sent, ...presence };
}

/** Имя, которое никто не задавал, — часть почты до «@» («jdoe1984»); в письме тогда название организации. */
async function inviterDisplayName(db: Db, userId: string, orgName: string): Promise<string> {
  const row = (await db.query(
    `select u.display_name, e.email from users u left join user_emails e on e.user_id = u.id and e.is_primary where u.id = $1`,
    [userId],
  )).rows[0] as { display_name?: string; email?: string } | undefined;
  const unnamed = !row?.display_name || row.display_name === row.email?.split('@')[0];
  return unnamed ? orgName : row!.display_name!;
}

export interface AcceptResult { userId: string; orgId: string }

/**
 * Ядро принятия приглашения — одно на оба пути: переход по ссылке из письма и первое
 * действие по делу компании, куда человек уже позван, но ссылку не открывал (он работает в другой
 * компании и связан с Telegram). Последствия одни и те же: членство `active` с `joined_at`,
 * приглашение `accepted`, событие `invitation_accepted` и, по умолчанию, `fillSlot`.
 *
 * Вызывается внутри `withOrg(orgId)`. Принимается только живое приглашение этого человека в эту
 * организацию: `pending`, не старше 30 дней, членство не снято. Отозванное, истёкшее, чужое — `false`,
 * и вызывающий отвечает «не найдено». Кто этот человек — решает вызывающий: бот и приложение знают
 * его только по привязке Telegram (`telegram_links`), ссылка — по токену из письма.
 *
 * Принимаются все висящие приглашения человека в эту организацию сразу: повторное приглашение
 * заводит новую строку, и оставшаяся `pending` продолжала бы слать напоминания уже вошедшему.
 * `fillSlot: false` — для действия по делу: действие само двигает слот, а очередь, наполненная
 * раньше него, выдала бы человеку «Сейчас» по другому делу за мгновение до «Взял».
 */
export async function acceptPendingInvitation(
  db: Db, orgId: string, userId: string, now: Date = new Date(),
  opts: { invitationId?: string; fillSlot?: boolean } = {},
): Promise<boolean> {
  const pending = (await db.query(
    `select id from invitations
      where org_id = $1 and user_id = $2 and status = 'pending' and created_at > $3
      order by (id = $4) desc, created_at desc
      for update`,
    [orgId, userId, new Date(now.getTime() - INVITATION_TTL_MS), opts.invitationId ?? null],
  )).rows as { id: string }[];
  if (!pending.length) return false;
  if (opts.invitationId && pending[0]!.id !== opts.invitationId) return false;
  // Снятое членство — это вывод из компании: приглашение, оставшееся после него висеть, уже не зовёт.
  const membership = await db.query(
    `select status from memberships where org_id = $1 and user_id = $2 for update`, [orgId, userId]);
  const status = membership.rows[0]?.status as string | undefined;
  if (status !== 'invited' && status !== 'active') return false;

  await db.query(`update memberships set status = 'active', joined_at = $3 where org_id = $1 and user_id = $2`, [orgId, userId, now]);
  await db.query(
    `update invitations set status = 'accepted', accepted_at = $3 where org_id = $1 and user_id = $2 and status = 'pending'`,
    [orgId, userId, now],
  );
  await emit(db, { type: 'invitation_accepted', actorUserId: userId, data: { invitation_id: pending[0]!.id } });
  // Задачи могли накопиться до входа человека — теперь можно занять слот.
  if (opts.fillSlot !== false) await fillSlot(db, userId, now);
  return true;
}

/**
 * Организации, где человек работает, и те, куда его позвали живым приглашением: их дела
 * он видит, а первое действие по такому делу принимает приглашение. Приглашение отозванное, истёкшее
 * или снятое выводом в список не попадает — дела такой компании не видны нигде.
 *
 * `invitations` — слой организации, поэтому живость проверяется системным соединением, и только
 * перечислением id организаций: ни одного поля приглашения наружу не уходит. У человека без
 * приглашений запрос один, как и раньше.
 */
export async function workingOrgs(userId: string, now: Date = new Date()): Promise<WorkingOrg[]> {
  const orgs = await withGlobal((db) => userOrgs(db, userId, { includeInvited: true }));
  if (!orgs.some((o) => o.status === 'invited')) return orgs;
  const live = await withSystem(async (db) => new Set((await db.query(
    `select distinct org_id from invitations where user_id = $1 and status = 'pending' and created_at > $2`,
    [userId, new Date(now.getTime() - INVITATION_TTL_MS)],
  )).rows.map((r) => r.org_id as string)));
  return orgs.filter((o) => o.status === 'active' || live.has(o.id));
}

export type WorkingOrg = Awaited<ReturnType<typeof userOrgs>>[number];

/**
 * Что делает действие по делу компании, куда человека лишь позвали:
 *
 * - `work` — действие работы (взять, сдать, отправленный вопрос, реплика, срок): принимает приглашение
 *   в той же транзакции, что и само действие — упало действие, приглашение не принято;
 * - `decline` — «Отказаться» не вход: дело отклоняется, приглашение — `declined`, членство остаётся;
 * - `other` — прочее (таймер, «не сегодня», «жду ответа»…) до входа недоступно.
 */
export type InvitedMode = 'work' | 'decline' | 'other';

/**
 * Применить правило приглашённого внутри транзакции действия (`withOrg(orgId)`). Для действующей
 * компании — ничего. Приглашение отозвали или оно истекло между показом и нажатием — `not_found`:
 * дела для человека больше нет.
 */
export async function applyInvitedMode(
  db: Db, org: { id: string; status: string }, userId: string, mode: InvitedMode, now: Date = new Date(),
): Promise<void> {
  if (org.status !== 'invited') return;
  if (mode === 'other') {
    throw new AppError('forbidden', 'You are invited to this company but have not joined yet — take the task to start', { invite_first: true });
  }
  if (mode === 'work') {
    if (!(await acceptPendingInvitation(db, org.id, userId, now, { fillSlot: false }))) {
      throw new AppError('not_found', 'Task not found', { invitation_gone: true });
    }
    return;
  }
  const declined = await db.query(
    `update invitations set status = 'declined' where org_id = $1 and user_id = $2 and status = 'pending' and created_at > $3 returning id`,
    [org.id, userId, new Date(now.getTime() - INVITATION_TTL_MS)]);
  if (!declined.rowCount) throw new AppError('not_found', 'Task not found', { invitation_gone: true });
  // Пригласившему — событием в ленте компании: причина отказа уходит с самим делом (`task_declined`).
  await emit(db, { type: 'invitation_declined', actorUserId: userId, data: { invitation_id: declined.rows[0].id } });
}

/**
 * Принятие приглашения из бота: токен → (org_id, invitation), проверка не старше 30 дней,
 * членство → active, привязка Telegram. `invitations` — слой организации, поэтому org_id ищем
 * через `withSystem` (перечисление, без чтения содержимого), правки — уже под `withOrg`.
 */
export async function acceptInvitation(token: string, telegramUserId: number, chatId: number, now: Date = new Date()): Promise<AcceptResult> {
  const tokenHash = sha256(token);
  const found = await withSystem((db) => db.query(
    `select org_id, id from invitations where token_hash = $1 and status = 'pending' and created_at > $2`,
    [tokenHash, new Date(now.getTime() - INVITATION_TTL_MS)],
  ));
  const hit = found.rows[0];
  if (!hit) throw new AppError('not_found', 'Invitation not found or expired');
  const orgId = hit.org_id as string;

  return withOrg(orgId, async (db) => {
    const inv = (await db.query('select * from invitations where id = $1 for update', [hit.id])).rows[0];
    if (!inv || inv.status !== 'pending') throw new AppError('conflict', 'Invitation already used');

    const linked = await db.query('select user_id from telegram_links where telegram_user_id = $1', [telegramUserId]);
    if (linked.rowCount && linked.rows[0].user_id !== inv.user_id) {
      throw new AppError('conflict', 'This Telegram account is already linked to another person');
    }

    if (!(await acceptPendingInvitation(db, orgId, inv.user_id as string, now, { invitationId: inv.id as string }))) {
      throw new AppError('not_found', 'Invitation not found or expired');
    }
    if (linked.rowCount) {
      await db.query('update telegram_links set chat_id = $2, blocked_at = null where telegram_user_id = $1', [telegramUserId, chatId]);
    } else {
      await db.query('insert into telegram_links(telegram_user_id, user_id, chat_id) values ($1, $2, $3)', [telegramUserId, inv.user_id, chatId]);
    }
    return { userId: inv.user_id as string, orgId };
  });
}

export interface OffboardResult { cancelledTasks: number }

export async function offboardPerson(db: Db, userId: string, actor: Actor, now: Date = new Date()): Promise<OffboardResult> {
  const callerUserId = actorUserId(actor);
  if (!callerUserId) throw new AppError('forbidden', 'The system does not remove people from the organization');
  await requireMember(db, callerUserId, ['owner', 'admin']);
  const target = await requireMember(db, userId);
  if (target.role === 'owner') throw new AppError('forbidden', 'The organization owner cannot be removed');
  // Себя не выводят: действие необратимо и отнимает доступ у того, кто его совершил, — а отменить
  // его будет уже некому (ревью диффа).
  if (userId === callerUserId) throw new AppError('forbidden', 'You cannot remove yourself from the organization');

  await db.query(
    `update time_entries set ended_at = $2, minutes = greatest(1, round(extract(epoch from ($2::timestamptz - started_at)) / 60))
      where user_id = $1 and ended_at is null and source = 'timer'`,
    [userId, now],
  );

  const open = await db.query(
    `select id, author_user_id, author_agent_id, title from tasks
      where assignee_user_id = $1 and status not in ('draft','done','declined','cancelled','resolved')`,
    [userId],
  );
  for (const t of open.rows) {
    await cancelTask(db, t.id, { kind: 'system' }, 'Человек выведен из организации', now);
    if (t.author_agent_id) {
      await emit(db, { type: 'person_offboarded', agentId: t.author_agent_id, taskId: t.id, data: { user_id: userId, title: t.title } });
    } else if (t.author_user_id && t.author_user_id !== userId) {
      await notify(db, { userId: t.author_user_id, kind: 'person_offboarded', level: 'decision', taskId: t.id });
    }
  }

  // Ушёл проверяющий — приёмка возвращается автору (спека task-reviewer): иначе сданное ждало бы
  // решения того, кого в компании больше нет. Дела закрытых проектов админ может не видеть, поэтому
  // снимаем поверх приватности. Сданное автор получает на приёмку, остальное — как правку не своей рукой.
  await withPrivacyLifted(db, async () => {
    const reviewed = (await db.query(
      `update tasks set reviewer_user_id = null, version = version + 1, updated_at = $2
        where reviewer_user_id = $1 and status not in ('done','declined','cancelled','resolved') returning *`,
      [userId, now])).rows as Task[];
    for (const t of reviewed) {
      await emit(db, { type: 'task_updated', taskId: t.id, actorUserId: callerUserId, data: { fields: ['reviewer_user_id'] } });
      if (t.status === 'submitted') await handReviewOver(db, t, { from: userId, to: null, by: callerUserId }, now);
      else if (!t.author_agent_id && t.author_user_id !== callerUserId) {
        await notify(db, { userId: t.author_user_id, kind: 'task_changed_by_manager', level: 'work', taskId: t.id });
      }
    }
  });

  // Закрытые проекты ушедшего админ не видит, а сам он после вывода не увидит организацию — значит
  // его дела остались бы висеть невидимыми навсегда. Убираем их вместе с ним (спека projects).
  //
  // Но проект ушедшего могла быть общей на нескольких: тогда её дела нужны тем, кто
  // остался, и стирать их вместе с хозяином — потеря чужой работы. Поэтому сначала снимаем ушедшего
  // из всех составов, а потом убираем только то, что после этого не видит никто.
  const wiped = await withPrivacyLifted(db, async () => {
    await db.query('delete from project_members where user_id = $1', [userId]);
    const orphan = `private_owner_user_id = $1
      and not exists (select 1 from project_members m where m.project_id = tasks.project_id)`;
    await db.query(`update proposals set task_id = null where task_id in (select id from tasks where ${orphan})`, [userId]);
    await db.query(`update group_messages set task_id = null where task_id in (select id from tasks where ${orphan})`, [userId]);
    const r = await db.query(`delete from tasks where ${orphan}`, [userId]);
    await db.query(
      `delete from projects where private and owner_user_id = $1
        and not exists (select 1 from project_members m where m.project_id = projects.id)`, [userId]);
    return r.rowCount ?? 0;
  });

  // Профиль стирается вместе с выводом (спека person-profile): иначе он всплывёт
  // при повторном приглашении того же человека — чужими словами годичной давности (ревью диффа).
  // Висящее приглашение после вывода больше не зовёт: иначе по нему человек вернулся бы действием по делу.
  await db.query(
    `update invitations set status = 'revoked' where org_id = current_setting('app.org_id')::uuid and user_id = $1 and status = 'pending'`,
    [userId]);
  await db.query(
    `update memberships set status = 'removed', removed_at = $2, about = null
      where org_id = current_setting('app.org_id')::uuid and user_id = $1`, [userId, now]);
  await emit(db, { type: 'membership_removed', actorUserId: callerUserId, data: { user_id: userId, private_items_removed: wiped } });
  return { cancelledTasks: open.rowCount ?? 0 };
}
