import express, { type Express, type Request, type Response, Router } from 'express';
import { withGlobal, withOrg } from '../db/pool.js';
import { sha256, encrypt } from '../core/crypto.js';
import { fireRunner } from '../runtime/fire.js';
import { logger } from '../log.js';
import { langFromRequest } from './accept-language.js';
import type { Lang } from '../i18n/index.js';

// Страница подключения исполнителя агента: одноразовая ссылка `/runner/:token` (спека agent-runtime,
// «Настройка»). Токен `/fire` уходит только сюда, шифруется сразу — в чат claude.ai не попадает.
// Язык — по `Accept-Language`, как на странице входа OAuth: организации бывают не только русские.

const TEXT: Record<Lang, Record<string, string>> = {
  ru: {
    title: 'Подключение исполнителя',
    intro: 'Вставьте адрес API-триггера routine и токен из claude.ai/code/routines — Taskano подключит исполнителя агентов этой организации.',
    url: 'URL API-триггера', token: 'Токен', connect: 'Подключить',
    dead_link: 'Ссылка недействительна или уже использована. Запросите новую через connect_runner.',
    bad_input: 'Проверьте адрес (https://api.anthropic.com/…) и токен.',
    save_failed: 'Не получилось сохранить — попробуйте ещё раз.',
    bad_token: 'Токен не подошёл (401/403). Проверьте API-триггер в claude.ai/code/routines и подключите заново.',
    done: 'Исполнитель подключён. Routine ответит на ближайший плановый запуск или на первое блокирующее событие.',
  },
  tr: {
    title: 'Yürütücüyü bağlama',
    intro: 'claude.ai/code/routines adresindeki routine API tetikleyici adresini ve token\'ı yapıştırın — Taskano bu organizasyonun ajan yürütücüsünü bağlayacak.',
    url: 'API tetikleyici adresi', token: 'Token', connect: 'Bağla',
    dead_link: 'Bağlantı geçersiz ya da zaten kullanılmış. connect_runner ile yenisini isteyin.',
    bad_input: 'Adresi (https://api.anthropic.com/…) ve token\'ı kontrol edin.',
    save_failed: 'Kaydedilemedi — lütfen tekrar deneyin.',
    bad_token: 'Token kabul edilmedi (401/403). claude.ai/code/routines üzerindeki API tetikleyicisini kontrol edip yeniden bağlayın.',
    done: 'Yürütücü bağlandı. Routine, ilk planlı çalıştırmada veya ilk engelleyici olayda yanıt verecek.',
  },
  vi: {
    title: 'Kết nối trình thực thi',
    intro: 'Dán địa chỉ API trigger của routine và token từ claude.ai/code/routines — Taskano sẽ kết nối trình thực thi tác nhân cho tổ chức này.',
    url: 'Địa chỉ API trigger', token: 'Token', connect: 'Kết nối',
    dead_link: 'Liên kết không hợp lệ hoặc đã được dùng. Hãy yêu cầu liên kết mới qua connect_runner.',
    bad_input: 'Hãy kiểm tra địa chỉ (https://api.anthropic.com/…) và token.',
    save_failed: 'Không lưu được — hãy thử lại.',
    bad_token: 'Token bị từ chối (401/403). Hãy kiểm tra API trigger trong claude.ai/code/routines rồi kết nối lại.',
    done: 'Đã kết nối trình thực thi. Routine sẽ phản hồi ở lần chạy theo lịch gần nhất hoặc ở sự kiện chặn đầu tiên.',
  },
  en: {
    title: 'Connect the runner',
    intro: 'Paste the routine API trigger URL and the token from claude.ai/code/routines — Taskano will connect the agent runner of this organization.',
    url: 'API trigger URL', token: 'Token', connect: 'Connect',
    dead_link: 'The link is invalid or already used. Request a new one via connect_runner.',
    bad_input: 'Check the URL (https://api.anthropic.com/…) and the token.',
    save_failed: 'Could not save — please try again.',
    bad_token: 'The token was rejected (401/403). Check the API trigger in claude.ai/code/routines and connect again.',
    done: 'The runner is connected. The routine will answer on the next scheduled run or on the first blocking event.',
  },
};

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function page(res: Response, l: Lang, body: string, status = 200): void {
  const title = esc(TEXT[l].title!);
  res.status(status).type('html').set('Cache-Control', 'no-store').send(`<!doctype html><html lang="${l}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} — Taskano</title>
<style>body{font-family:system-ui,sans-serif;background:#f6f6f4;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:16px}
main{background:#fff;border-radius:12px;padding:28px;max-width:440px;width:100%;box-shadow:0 1px 3px rgba(0,0,0,.08)}
h1{font-size:20px;margin:0 0 16px}label{display:block;font-size:14px;color:#555;margin:12px 0 6px}
input{width:100%;box-sizing:border-box;font-size:15px;padding:10px 12px;border:1px solid #ccc;border-radius:8px;font-family:monospace}
button{margin-top:16px;width:100%;font-size:16px;padding:11px;border:0;border-radius:8px;background:#1f5eff;color:#fff;cursor:pointer}
.err{color:#b00020;font-size:14px;margin-top:10px}.muted{color:#666;font-size:14px}p{line-height:1.5}</style></head>
<body><main><h1>${title}</h1>${body}</main></body></html>`);
}

interface RunnerLink { org_id: string; used_at: string | null }

async function loadLink(token: string): Promise<RunnerLink | null> {
  if (!token) return null;
  return withGlobal(async (db) => {
    const r = await db.query(
      `select org_id, used_at from runner_links where token_hash = $1 and expires_at > now()`, [sha256(token)],
    );
    return (r.rows[0] as RunnerLink) ?? null;
  });
}

function form(token: string, l: Lang, err = ''): string {
  const t = TEXT[l];
  return `<p>${t.intro}</p>
<form method="post" action="/runner/${encodeURIComponent(token)}">
<label for="u">${t.url}</label><input id="u" name="fire_url" type="url" placeholder="https://api.anthropic.com/…" required autofocus>
<label for="t">${t.token}</label><input id="t" name="fire_token" type="text" required>
${err ? `<div class="err">${esc(err)}</div>` : ''}<button>${t.connect}</button></form>`;
}

/** Только https и хост api.anthropic.com — защита от SSRF (спека agent-runtime, «Технические детали»). */
function validFireUrl(raw: string): URL | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.hostname !== 'api.anthropic.com') return null;
    return url;
  } catch {
    return null;
  }
}

export function runnerRoutes(app: Express): void {
  const r = Router();
  r.use(express.urlencoded({ extended: false, limit: '4kb' }));

  r.get('/runner/:token', async (req: Request, res: Response) => {
    const l = langFromRequest(req);
    const token = String(req.params.token ?? '');
    const link = await loadLink(token);
    if (!link || link.used_at) return page(res, l, `<p class="err">${TEXT[l].dead_link}</p>`, 410);
    page(res, l, form(token, l));
  });

  r.post('/runner/:token', async (req: Request, res: Response) => {
    const l = langFromRequest(req);
    const token = String(req.params.token ?? '');
    const link = await loadLink(token);
    if (!link || link.used_at) return page(res, l, `<p class="err">${TEXT[l].dead_link}</p>`, 410);

    const fireUrl = String(req.body.fire_url ?? '').trim();
    const fireToken = String(req.body.fire_token ?? '').trim();
    const url = validFireUrl(fireUrl);
    if (!url || !fireToken) return page(res, l, form(token, l, TEXT[l].bad_input), 400);

    // Ссылка одноразовая: забираем её одним атомарным update — два одновременных POST иначе проходили
    // оба (проверка и отметка шли раздельно; аудит 07.10). Не вышло сохранить — ссылку возвращаем.
    const claimed = await withGlobal((db) => db.query(
      `update runner_links set used_at = now() where token_hash = $1 and used_at is null and expires_at > now() returning org_id`,
      [sha256(token)]));
    if (!claimed.rowCount) return page(res, l, `<p class="err">${TEXT[l].dead_link}</p>`, 410);

    try {
      await withOrg(link.org_id, (db) => db.query(
        `insert into runners(org_id, fire_url, fire_token_enc, status, last_fire_error, updated_at)
         values ($1, $2, $3, 'ok', null, now())
         on conflict (org_id) do update set fire_url = excluded.fire_url, fire_token_enc = excluded.fire_token_enc,
           status = 'ok', last_fire_error = null, updated_at = now()`,
        [link.org_id, url.toString(), encrypt(fireToken, link.org_id)],
      ));
    } catch (e) {
      await withGlobal((db) => db.query(`update runner_links set used_at = null where token_hash = $1`, [sha256(token)])).catch(() => undefined);
      logger.error({ err: e }, 'runner-page: не удалось сохранить исполнителя');
      return page(res, l, form(token, l, TEXT[l].save_failed), 500);
    }

    const result = await fireRunner(link.org_id, 'setup-check').catch((e) => {
      logger.error({ err: e }, 'runner-page: пробный /fire не удался');
      return 'error' as const;
    });
    if (result === 'broken') {
      return page(res, l, `<p class="err">${TEXT[l].bad_token}</p>`, 400);
    }
    page(res, l, `<p>${TEXT[l].done}</p>`);
  });

  app.use(r);
}
