import express, { type NextFunction, type Request, type Response, type Router } from 'express';
import { setActor, withGlobal, withOrg } from '../db/pool.js';
import { AppError } from '../core/errors.js';
import { dropHiddenProjectEvents, readEvents, ZERO_CURSOR } from '../core/events.js';
import { verifyReadToken } from '../core/read-tokens.js';
import { eventDataForAgent, involvedSql, involvementFilter, resolveOrg, untrusted } from '../mcp/context.js';
import { taskLink } from '../runtime/attention.js';
import { taskKey } from '../core/projects.js';
import { translatedTitle } from '../bot/notif-text.js';
import { handleError } from './http-errors.js';
import { clientKey, rateLimit } from './rate-limit.js';

// Чтение для программ человека по токену `tkr_…` (спека read-tokens). Только GET: токен — это
// человек, читающий свою ленту, и ничего больше. Вход отдельный от /mcp и Mini App — ни один из них
// этот токен не принимает, и этот вход не принимает их учётных данных.

declare global {
  namespace Express {
    interface Request {
      reader?: { tokenId: string; userId: string };
    }
  }
}

// Числа ограничены длиной: огромное значение прошло бы регулярку и уронило приведение к xid8 в 500.
const CURSOR_RE = /^\d{1,19}:\d{1,19}$/;
/** Формат токена — до похода в базу: мусор отсекается без запроса (ревью 08.10). */
const TOKEN_RE = /^tkr_[A-Za-z0-9_-]{43}$/;
const MAX_LIMIT = 200;
/**
 * Сколько новых переводов названий за один запрос: остальное — из кэша или оригиналом. Первое
 * чтение с начала ленты иначе ждало бы модель по разу на каждое дело; в обычном опросе раз в
 * 3 минуты дел мало, а названия почти всегда уже переведены для уведомлений бота.
 */
const MAX_NEW_TITLE_TRANSLATIONS = 20;

/** Токен из заголовка `Authorization: Bearer …`; сам токен дальше этой функции и проверки не идёт. */
function bearer(req: Request): string | null {
  const h = req.header('authorization');
  const m = h ? /^Bearer\s+(\S+)$/i.exec(h) : null;
  return m ? m[1]! : null;
}

export function readRoutes(): Router {
  const router = express.Router();

  // Запись отказана до любой проверки: на этом входе её нет вовсе, а не «нет прав».
  router.use((req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') { next(); return; }
    res.status(405).set('Allow', 'GET').json({ code: 'method_not_allowed' });
  });
  // Лента — личное чтение: ни Cloudflare, ни прокси не должны отдать её другому (ревью 08.10).
  router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  // Общий потолок по адресу — до хэша и похода в базу. Высокий: за одним адресом может сидеть
  // несколько программ одной компании.
  router.use(rateLimit({ windowMs: 60_000, max: 600, key: clientKey }));

  // Неудачные попытки считаются отдельно по адресу: подбор токена упирается в 429, а владелец с
  // настоящим токеном за тем же адресом продолжает работать — его запросы сюда не попадают.
  const failures = rateLimit({ windowMs: 60_000, max: 30, key: clientKey });
  const failedRecently = new Map<string, { n: number; until: number }>();
  router.use(async (req: Request, res: Response, next: NextFunction) => {
    const raw = bearer(req);
    // Адрес, уже упёршийся в предел неудач, в базу больше не ходит до конца окна.
    const key = clientKey(req);
    const f = failedRecently.get(key);
    if (f && f.until > Date.now() && f.n >= 30) { res.status(429).json({ code: 'rate_limited' }); return; }
    const reader = raw && TOKEN_RE.test(raw) ? await verifyReadToken(raw) : null;
    if (!reader) {
      const cur = f && f.until > Date.now() ? f : { n: 0, until: Date.now() + 60_000 };
      cur.n += 1;
      failedRecently.set(key, cur);
      if (failedRecently.size > 10_000) for (const [k, v] of failedRecently) if (v.until <= Date.now()) failedRecently.delete(k);
    }
    if (!reader) {
      failures(req, res, () => { res.status(401).set('WWW-Authenticate', 'Bearer').json({ code: 'unauthorized' }); });
      return;
    }
    req.reader = reader;
    next();
  });

  // Программа ходит раз в три минуты по каждой компании; шестьдесят в минуту на токен — с запасом.
  router.use(rateLimit({ windowMs: 60_000, max: 60, key: (req) => `t:${req.reader!.tokenId}` }));

  router.get('/orgs', async (req, res) => {
    const { userId } = req.reader!;
    const orgs = (await withGlobal((db) => db.query(
      `select o.id, o.name, o.kind, m.role from memberships m join orgs o on o.id = m.org_id
        where m.user_id = $1 and m.status = 'active' order by o.kind, o.created_at`, [userId]))).rows;
    res.json({ orgs });
  });

  router.get('/changes', async (req, res) => {
    try {
      const { userId } = req.reader!;
      const orgRef = typeof req.query.org === 'string' && req.query.org.trim() ? req.query.org.trim() : null;
      const cursorRaw = typeof req.query.cursor === 'string' && req.query.cursor ? req.query.cursor : ZERO_CURSOR;
      // Испорченный курсор — ошибка программы, а не просьба «с начала»: молча отдали бы всю ленту заново.
      if (!CURSOR_RE.test(cursorRaw)) throw new AppError('validation_failed', 'cursor must be the value returned by a previous call');
      let limit = MAX_LIMIT;
      if (req.query.limit !== undefined) {
        limit = Number(req.query.limit);
        if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new AppError('validation_failed', `limit must be a whole number from 1 to ${MAX_LIMIT}`);
      }
      let orgId: string;
      try {
        orgId = await resolveOrg(userId, orgRef);
      } catch (e) {
        // Компании нет среди действующих членств — человек в ней не состоит (или уже выведен).
        if (orgRef && e instanceof AppError && e.code === 'not_found') throw new AppError('forbidden', 'You are not a member of this organization');
        throw e;
      }
      const out = await withOrg(orgId, async (db) => {
        const m = await db.query(`select 1 from memberships where org_id = $1 and user_id = $2 and status = 'active'`, [orgId, userId]);
        if (!m.rowCount) throw new AppError('forbidden', 'You are not a member of this organization');
        // Дела видны ровно как самому человеку: его закрытые доски — да, чужие — нет (RLS дел).
        await setActor(db, userId);
        const r = await readEvents(db, cursorRaw, { limit });
        const ids = [...new Set(r.events.map((e) => e.task_id).filter((x): x is string => !!x))];
        // Участник и гость — только причастные дела, как у get_changes_since.
        const only = await involvementFilter({ db, userId, agent: null });
        const visible = new Map<string, { short_id: string; project_id: string | null; project_name: string | null; key: string | null; title: string }>();
        if (ids.length) {
          // Проект — тем же запросом и под тем же правилом: дело чужой закрытой доски сюда не попадёт,
          // а с ним и имя её проекта.
          const rows = (await db.query(
            `select t.id, t.short_id::text, t.project_id, p.name as project_name, p.key as project_key, t.number,
                    t.title, t.source_language
               from tasks t left join projects p on p.id = t.project_id
              where t.id = any($1::uuid[])${only ? ` and ${involvedSql('t', '$2')}` : ''}`,
            only ? [ids, only.userId] : [ids])).rows as {
              id: string; short_id: string; project_id: string | null; project_name: string | null;
              project_key: string | null; number: number | null; title: string; source_language: string | null;
            }[];
          // Название — на языке владельца токена, как в его уведомлениях бота: оригинал на чужом языке
          // человеку ни к чему. Тот же кэш перевода, что у карточки и уведомлений.
          const lang = (await db.query('select language from users where id = $1', [userId])).rows[0]?.language ?? 'en';
          let fresh = 0;
          for (const row of rows) {
            // Считаем каждое название на чужом языке: из кэша оно или от модели, заранее не видно.
            const foreign = (row.source_language ?? 'ru') !== lang && row.title.trim() !== '';
            const title = await translatedTitle(db, row, lang, { cacheOnly: foreign && fresh >= MAX_NEW_TITLE_TRANSLATIONS });
            if (foreign) fresh += 1;
            visible.set(row.id, {
              short_id: row.short_id, project_id: row.project_id, project_name: row.project_name,
              key: taskKey(row.project_key, row.number), title,
            });
          }
        }
        // Событие дела, которого человек не видит, выбрасывается; курсор при этом идёт по всему
        // прочитанному — пропущенное не вернётся следующим чтением. Событие без дела участнику не
        // отдаётся вовсе, как в get_changes_since: причастности к нему нет.
        // Событие без дела про закрытую доску называет её имя — такие только тем, кому она видна.
        const shown = await dropHiddenProjectEvents(db, r.events.filter((e) => (e.task_id ? visible.has(e.task_id) : !only)));
        // Кто действовал — чтобы программа не будила человека на его же действия. Действовал агент —
        // человека нет: событие от агента стоит показать и его хозяину.
        const actorUser = (e: (typeof shown)[number]): string | null => (e.actor_agent_id ? null : e.actor_user_id);
        const userIds = [...new Set(shown.map(actorUser).filter((x): x is string => !!x))];
        const agentIds = [...new Set(shown.map((e) => e.actor_agent_id).filter((x): x is string => !!x))];
        const names = new Map<string, string>();
        if (userIds.length) {
          for (const row of (await db.query(`select id, display_name as name from users where id = any($1::uuid[])`, [userIds])).rows) names.set(row.id, row.name);
        }
        if (agentIds.length) {
          for (const row of (await db.query(`select id, name from agents where id = any($1::uuid[])`, [agentIds])).rows) names.set(row.id, row.name);
        }
        const events = shown.map((e) => {
          const task = e.task_id ? visible.get(e.task_id)! : null;
          const who = actorUser(e);
          const actorId = e.actor_agent_id ?? who;
          return {
            id: e.id, at: e.at, type: e.type, task_id: e.task_id,
            actor_user_id: who, actor_agent_id: e.actor_agent_id,
            // Имена людей и агентов — их собственные слова, как в сводке: под untrusted.
            actor_name: actorId && names.has(actorId) ? untrusted(names.get(actorId)!) : null,
            is_me: who === userId,
            project_id: task?.project_id ?? null,
            project_name: task?.project_name != null ? untrusted(task.project_name) : null,
            // Обозначение дела для человека («NOR-024»), а не технический номер из ссылки; без проекта — null.
            task_key: task?.key ?? null,
            task_title: task ? untrusted(task.title) : null,
            data: eventDataForAgent(e.data),
            link: task ? taskLink(task.short_id) : null,
          };
        });
        return { events, cursor: r.cursor, has_more: r.hasMore };
      });
      res.json(out);
    } catch (e) {
      handleError(res, e);
    }
  });

  router.use((_req, res) => { res.status(404).json({ code: 'not_found' }); });
  return router;
}
