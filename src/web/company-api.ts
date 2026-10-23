import type { Router } from 'express';
import { withGlobal, withOrg, type Db } from '../db/pool.js';
import { AppError } from '../core/errors.js';
import { setPersonAbout, userOrgs } from '../core/people.js';
import { orgStats, PERIODS, type Period } from '../core/stats.js';
import { LOAD_STATUSES } from '../core/types.js';
import { projectMembers } from '../core/projects.js';
import { presenceView } from '../core/presence.js';
import { handleError } from './http-errors.js';

// Раздел «Компания» (спека miniapp-company): люди, проекты и их состав, агенты — глазами, а не только
// разговором. Правила не переписываются: каждое действие идёт в то же ядро, что и инструменты MCP.
//
// Отдельный файл, а не продолжение miniapp-api: там список дел исполнителя, здесь управление
// компанией — разные читатели и разная граница доступа.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Компания, которой человек управляет. Роль приходит с сервера, приложение её не угадывает: скрыть
 * кнопку мало — ручка сама держит границу. Рядовой исполнитель получает «не найдено»,
 * а не «нельзя»: ему про этот раздел знать незачем.
 */
async function managedOrg(userId: string, orgId?: string): Promise<{ id: string; name: string; role: string }> {
  const orgs = (await withGlobal((db) => userOrgs(db, userId)))
    .filter((o) => o.kind === 'company' && o.status === 'active' && (o.role === 'owner' || o.role === 'admin'));
  const org = orgId ? orgs.find((o) => o.id === orgId) : orgs[0];
  if (!org) throw new AppError('not_found', 'Company not found');
  return { id: org.id, name: org.name, role: org.role };
}

/** Компания, в которой человек состоит — с любой ролью. Для своей же строки профиля. */
async function myOrg(userId: string, orgId?: string): Promise<{ id: string; name: string; role: string }> {
  const orgs = (await withGlobal((db) => userOrgs(db, userId)))
    .filter((o) => o.kind === 'company' && o.status === 'active');
  const org = orgId ? orgs.find((o) => o.id === orgId) : orgs[0];
  if (!org) throw new AppError('not_found', 'Company not found');
  return { id: org.id, name: org.name, role: org.role };
}

/** Люди компании: кто вошёл в бота, когда заходил (спека person-presence), сколько дел в работе, какая роль. */
async function people(db: Db, viewerId: string): Promise<unknown[]> {
  const r = await db.query(
    `select u.id, u.display_name as name, e.email::text as email, u.language, m.role, m.status, m.about, m.joined_at,
            (u.id = $1) as me,
            -- Приглашённый ещё не в компании: есть ли у него Telegram и когда он заходил — это его
            -- жизнь в других компаниях, а пригласить можно любой адрес (спека person-presence).
            (m.status = 'active' and tl.user_id is not null and tl.blocked_at is null) as in_telegram,
            case when m.status = 'active' then u.last_seen_bot_at end as last_seen_bot_at,
            case when m.status = 'active' then u.last_seen_app_at end as last_seen_app_at,
            -- Без ручного фильтра приватности: запрос и так идёт под правилом видимости смотрящего
            -- (RLS), а лишнее условие прятало от владельца его собственные дела на закрытой проекте —
            -- он видел у себя ноль при трёх десятках дел.
            (select count(*)::int from tasks t
              where t.assignee_user_id = u.id and t.status = any($2)) as open
       from memberships m join users u on u.id = m.user_id
       left join user_emails e on e.user_id = u.id and e.is_primary
       left join telegram_links tl on tl.user_id = u.id
      where m.org_id = current_setting('app.org_id')::uuid and m.status <> 'removed' and u.anonymized_at is null
      order by u.display_name`, [viewerId, LOAD_STATUSES]);
  // Отметки — словами в поясе смотрящего, как и в ответах агенту: точное время наружу не уходит.
  // `seen_tracked_since` с `joined_at` отличают «ещё не заходил» от «не заходил с тех пор, как
  // отметки начали писать».
  const tz = (await db.query('select timezone from users where id = $1', [viewerId])).rows[0]?.timezone ?? 'UTC';
  return r.rows.map(({ last_seen_bot_at: bot, last_seen_app_at: app, ...p }) => ({ ...p, ...presenceView(bot, app, tz) }));
}

/** Проекты компании с составом: видно, кто попадёт к делам закрытого проекта. */
async function projects(db: Db, userId: string): Promise<unknown[]> {
  const r = await db.query(
    `select p.id, p.key, p.name, p.private, p.status,
            (select count(*)::int from tasks t where t.project_id = p.id and t.status = any($2)) as open
       from projects p
      where p.status = 'active' and (p.private = false or p.owner_user_id = $1
            or exists (select 1 from project_members m where m.project_id = p.id and m.user_id = $1))
      order by p.private, lower(p.name)`, [userId, LOAD_STATUSES]);
  const out = [];
  for (const b of r.rows) out.push({ ...b, members: await projectMembers(db, b.id as string) });
  return out;
}

/** Агенты компании: чьё направление и не на паузе ли оно. */
async function agents(db: Db): Promise<unknown[]> {
  const r = await db.query(
    `select a.id, a.name, a.status, u.display_name as owner
       from agents a left join users u on u.id = a.owner_user_id
      where a.org_id = current_setting('app.org_id')::uuid order by a.name`);
  return r.rows;
}

export function companyRoutes(router: Router): void {
  // Итоги (спека stats-page): сколько сделано за период, кем и на какой проекте. Владелец и админ
  // видят всю компанию, остальные — только себя: чужая выработка не их дело.
  router.get('/stats', async (req, res) => {
    try {
      const { userId, language } = req.miniappUser!;
      const period = String(req.query.period ?? 'today') as Period;
      if (!PERIODS.includes(period)) throw new AppError('validation_failed', `Unknown period: ${period}`);
      const orgs = (await withGlobal((db) => userOrgs(db, userId)))
        .filter((o) => o.kind === 'company' && o.status === 'active');
      const org = req.query.org ? orgs.find((o) => o.id === req.query.org) : orgs[0];
      if (!org) throw new AppError('not_found', 'Company not found');
      const tz = (await withGlobal((db) => db.query('select timezone from orgs where id = $1', [org.id])))
        .rows[0]?.timezone as string ?? 'UTC';
      const stats = await withOrg(org.id, (db) => orgStats(db, {
        period, tz, lang: language, viewerId: userId, wholeOrg: org.role === 'owner' || org.role === 'admin',
      }), { actorUserId: userId });
      res.json({ org_id: org.id, org_name: org.name, whole_org: org.role === 'owner' || org.role === 'admin', ...stats });
    } catch (e) {
      handleError(res, e);
    }
  });

  // Всё о компании одним запросом: раздел открывается целиком, а не тремя вкладками по очереди.
  router.get('/company', async (req, res) => {
    try {
      const { userId } = req.miniappUser!;
      const org = await managedOrg(userId, typeof req.query.org === 'string' ? req.query.org : undefined);
      const data = await withOrg(org.id, async (db) => ({
        people: await people(db, userId), projects: await projects(db, userId), agents: await agents(db),
      }), { actorUserId: userId });
      res.json({ org_id: org.id, org_name: org.name, role: org.role, ...data });
    } catch (e) {
      handleError(res, e);
    }
  });

  router.post('/company/people/:id/about', async (req, res) => {
    try {
      const { userId } = req.miniappUser!;
      if (!UUID_RE.test(req.params.id!)) throw new AppError('not_found', 'Person not found');
      // Единственная ручка раздела, куда ходит рядовой исполнитель: о себе он вправе сказать, даже
      // если агента у него нет вовсе. Про чужой профиль правило прежнее — владелец и
      // админ; его держит ядро (`setPersonAbout`), здесь только пускаем человека к своей строке.
      const org = req.params.id === userId ? await myOrg(userId, req.body?.org) : await managedOrg(userId, req.body?.org);
      // Не приводим чужой JSON к строке молча: объект превратился бы в «[object Object]» и лёг
      // в профиль как текст о человеке (ревью диффа). MCP-путь такое отклоняет — здесь тоже.
      const raw = req.body?.about;
      if (raw != null && typeof raw !== 'string') throw new AppError('validation_failed', 'about must be text or null');
      const about = raw == null ? null : raw;
      const r = await withOrg(org.id, (db) => setPersonAbout(db, req.params.id!, about, { kind: 'user', userId }),
        { actorUserId: userId });
      res.json({ ok: true, about: r.about });
    } catch (e) {
      handleError(res, e);
    }
  });

}
