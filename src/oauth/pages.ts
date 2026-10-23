import express, { type Request, type Response, Router } from 'express';
import { withGlobal } from '../db/pool.js';
import type { Db } from '../db/pool.js';
import { demoLoginEmail, env, googleLoginEnabled } from '../config/env.js';
import { randomBytes } from 'node:crypto';
import { safeEqual, sha256 } from '../core/crypto.js';
import { DEMO_CODE_RE, demoCodeHash, normalizeDemoCode } from '../core/demo-code.js';
import { issueLoginCode, verifyLoginCode } from '../core/login-codes.js';
import { ensureUserByEmail, mayEnter } from '../core/people.js';
import { AppError } from '../core/errors.js';
import { sendEmail } from '../email/send.js';
import { loginCodeMail } from '../email/templates/login-code.js';
import { issueAuthorizationCode } from './provider.js';
import { logger } from '../log.js';
import { clientIp, clientKey, rateLimit } from '../web/rate-limit.js';
import { langFromRequest } from '../web/accept-language.js';
import { GOOGLE_CSS, GOOGLE_G, LOGIN_CSS, promoBody, promoFoot, promoHead } from './login-promo.js';
import type { Lang } from '../i18n/index.js';

// Страница входа OAuth: почта → код → согласие → redirect в claude.ai (спека mcp-and-oauth).

export const TEXT: Record<Lang, Record<string, string>> = {
  ru: {
    title: 'Вход в Taskano', email: 'Почта', send: 'Получить код', code: 'Код из письма', demo_code: 'Код демо-доступа', demo_bad: 'Код демо-доступа не подошёл. Сверьте его с инструкцией.', sent: 'Мы отправили код на', verify: 'Войти',
    consent: 'Claude получит доступ к Taskano от вашего имени: сможет ставить задачи, читать их статус и отчёты.', allow: 'Разрешить',
    bad_code: 'Код не подошёл или устарел. Проверьте письмо или запросите новый.', expired: 'Сессия входа истекла. Вернитесь в Claude и подключите коннектор заново.',
    wait: 'Код уже отправлен. Новый можно запросить через минуту.', bad_email: 'Проверьте адрес почты.', again: 'Другая почта', send_failed: 'Не удалось отправить код. Попробуйте ещё раз.',
    closed: "Taskano — внутренний инструмент: войти можно только по приглашению. Если вас приглашали — откройте ссылку из письма-приглашения.",
    google: 'Войти через Google', or: 'или', google_cancelled: 'Вход через Google отменён.',
    google_failed: 'Не удалось войти через Google — войдите по коду из почты.', google_browser: 'Откройте вход заново в том же браузере.', google_restart: 'Начните вход заново',
  },
  tr: {
    title: 'Taskano girişi', email: 'E-posta', send: 'Kod al', code: 'E-postadaki kod', demo_code: 'Demo erişim kodu', demo_bad: 'Demo erişim kodu geçersiz. Talimatlardaki kodla karşılaştırın.', sent: 'Kodu şu adrese gönderdik:', verify: 'Giriş yap',
    consent: 'Claude, Taskano\'ya sizin adınıza erişecek: görev oluşturabilecek, durumlarını ve raporları okuyabilecek.', allow: 'İzin ver',
    bad_code: 'Kod geçersiz veya süresi dolmuş. E-postanızı kontrol edin ya da yeni kod isteyin.', expired: 'Giriş oturumu sona erdi. Claude\'a dönüp bağlayıcıyı yeniden ekleyin.',
    wait: 'Kod zaten gönderildi. Yeni kodu bir dakika sonra isteyebilirsiniz.', bad_email: 'E-posta adresini kontrol edin.', again: 'Başka e-posta', send_failed: 'Kod gönderilemedi. Tekrar deneyin.',
    closed: "Taskano şirket içi bir araçtır: yalnızca davetle giriş yapılabilir. Davet aldıysanız, davet e-postasındaki bağlantıyı açın.",
    google: 'Google ile giriş yap', or: 'veya', google_cancelled: 'Google ile giriş iptal edildi.',
    google_failed: 'Google ile giriş yapılamadı — e-postadaki kodla giriş yapın.', google_browser: 'Girişi aynı tarayıcıda yeniden başlatın.', google_restart: 'Girişi yeniden başlatın',
  },
  vi: {
    title: 'Đăng nhập Taskano', email: 'Email', send: 'Nhận mã', code: 'Mã trong email', demo_code: 'Mã truy cập demo', demo_bad: 'Mã truy cập demo không đúng. Hãy đối chiếu với hướng dẫn.', sent: 'Chúng tôi đã gửi mã đến', verify: 'Đăng nhập',
    consent: 'Claude sẽ truy cập Taskano thay mặt bạn: giao việc, xem trạng thái và báo cáo.', allow: 'Cho phép',
    bad_code: 'Mã không đúng hoặc đã hết hạn. Kiểm tra email hoặc yêu cầu mã mới.', expired: 'Phiên đăng nhập đã hết hạn. Hãy quay lại Claude và kết nối lại.',
    wait: 'Mã đã được gửi. Có thể yêu cầu mã mới sau một phút.', bad_email: 'Hãy kiểm tra địa chỉ email.', again: 'Email khác', send_failed: 'Không gửi được mã. Hãy thử lại.',
    closed: "Taskano là công cụ nội bộ: chỉ đăng nhập được khi có lời mời. Nếu bạn đã được mời, hãy mở liên kết trong email mời.",
    google: 'Đăng nhập bằng Google', or: 'hoặc', google_cancelled: 'Đã hủy đăng nhập bằng Google.',
    google_failed: 'Không đăng nhập được bằng Google — hãy đăng nhập bằng mã trong email.', google_browser: 'Hãy mở lại đăng nhập trong cùng trình duyệt.', google_restart: 'Bắt đầu đăng nhập lại',
  },
  en: {
    title: 'Sign in to Taskano', email: 'Email', send: 'Get code', code: 'Code from the email', demo_code: 'Demo access code', demo_bad: 'The demo access code is wrong. Check it against the instructions.', sent: 'We sent a code to', verify: 'Sign in',
    consent: 'Claude will access Taskano on your behalf: create tasks, read their status and reports.', allow: 'Allow',
    bad_code: 'The code is wrong or expired. Check your email or request a new one.', expired: 'The sign-in session expired. Go back to Claude and connect again.',
    wait: 'A code was already sent. You can request a new one in a minute.', bad_email: 'Please check the email address.', again: 'Another email', send_failed: 'Could not send the code. Please try again.',
    closed: "Taskano is an internal tool: sign-in is by invitation only. If you were invited, open the link in the invitation email.",
    google: 'Sign in with Google', or: 'or', google_cancelled: 'Google sign-in was cancelled.',
    google_failed: 'Could not sign in with Google — sign in with a code from your email.', google_browser: 'Start the sign-in again in the same browser.', google_restart: 'Start the sign-in again',
  },
};

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function page(res: Response, l: Lang, body: string, status = 200): void {
  // Рядом с формой — что даёт Taskano (спека oauth-login-page); сама форма и её поля не меняются.
  // Стиль кнопки Google — только там, где она есть: без неё страница байт в байт прежняя.
  const css = body.includes(GOOGLE_MARK) ? LOGIN_CSS + '\n' + GOOGLE_CSS : LOGIN_CSS;
  res.status(status).type('html').set('Cache-Control', 'no-store').send(`<!doctype html><html lang="${l}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>${esc(TEXT[l].title!)}</title>
<link rel="icon" type="image/png" href="/favicon.png?v=2"><style>${css}</style></head>
<body><div class="shell">${promoHead(l)}<main><h1>${esc(TEXT[l].title!)}</h1>${body}</main>${promoBody(l)}${promoFoot(l)}</div></body></html>`);
}

export interface Pending {
  id: string; email: string | null; user_id: string | null; client_name: string | null; redirect_uri: string;
  via_google_cookie_hash: string | null;
  via_code_cookie_hash: string | null;
}

export async function loadPending(id: string): Promise<Pending | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  return withGlobal(async (db) => {
    const r = await db.query(
      `select p.id, p.email, p.user_id, c.metadata->>'client_name' as client_name, p.params->>'redirectUri' as redirect_uri,
              p.via_google_cookie_hash, p.via_code_cookie_hash
         from oauth_pending p join oauth_clients c on c.client_id = p.client_id where p.id = $1 and p.expires_at > now()`, [id]);
    return r.rows[0] ?? null;
  });
}

/**
 * Cookie, к которому привязан вход через Google. Path=/oauth: виден и обратному вызову,
 * и согласию. В имени — начало id сессии входа: два входа в одном браузере (два коннектора, две
 * вкладки) не затирают cookie друг друга.
 */
export const googleCookieName = (pendingId: string) => `tk_g_${pendingId.slice(0, 8)}`;
/** Cookie браузера, который ввёл код из почты: согласие принимается только от него. */
export const codeCookieName = (pendingId: string) => `tk_c_${pendingId.slice(0, 8)}`;
const CODE_COOKIE = { httpOnly: true, secure: true, sameSite: 'lax' as const, path: '/oauth' };
const GOOGLE_MARK = '<div class="gsi">';

/** Значение cookie из заголовка запроса. Своего парсера хватает: значение наше, base64url, без кодирования. */
export function readCookie(req: Request, name: string): string | null {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/** Кнопка «Войти через Google» над полем почты — только когда вход через Google настроен. */
function googleBlock(id: string, l: Lang, note: string): string {
  if (!googleLoginEnabled()) return '';
  const t = TEXT[l];
  return `${GOOGLE_MARK}${note ? `<p class="muted">${esc(note)}</p>` : ''}<a class="gbtn" href="/oauth/google/start/${id}">${GOOGLE_G}<span>${t.google}</span></a>
<p class="or">${t.or}</p></div>`;
}

export function emailForm(id: string, l: Lang, err = '', note = ''): string {
  const t = TEXT[l];
  return `${googleBlock(id, l, note)}<form method="post" action="/oauth/login/${id}/email"><label for="e">${t.email}</label>
<input id="e" name="email" type="email" autocomplete="email" required autofocus>
${err ? `<div class="err">${esc(err)}</div>` : ''}<button>${t.send}</button></form>`;
}

/**
 * Демо-вход (спека demo-access): для одного адреса код постоянный, письма нет. Сверяется хэш —
 * самого кода на сервере нет. Запора после N ошибок нет намеренно: его мог бы вызвать кто угодно
 * и закрыть вход ревьюеру; подбор закрывает длина кода и потолок запросов с адреса.
 */
const isDemo = (email: string): boolean => email === demoLoginEmail();

async function verifyDemoCode(db: Db, pendingId: string, code: string, ip: string): Promise<boolean> {
  // Сначала форма: пустой или чужой формы код не сверяется вовсе, как бы ни был снят хэш.
  const ok = DEMO_CODE_RE.test(normalizeDemoCode(code)) && safeEqual(demoCodeHash(code), env.demoLoginCodeSha256);
  // В аудит — только вход: отказы шли бы строкой на каждый запрос, и поток мусора раздувал бы
  // таблицу, по которой считается здоровье сервиса. Отказы — в лог, с адресом.
  if (ok) await db.query(`insert into admin_audit(actor, action, payload) values ('oauth', 'demo_login', $1)`, [{ pending_id: pendingId, ip }]);
  else logger.warn({ pending_id: pendingId, ip }, 'demo login: wrong code');
  return ok;
}

function codeForm(id: string, l: Lang, email: string, err = ''): string {
  const t = TEXT[l];
  const input = isDemo(email)
    ? `<input id="c" name="code" autocomplete="off" autocapitalize="characters" spellcheck="false" required autofocus>`
    : `<input id="c" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]{6,7}" required autofocus>`;
  return `<p class="muted">${isDemo(email) ? '' : `${t.sent} <b>${esc(email)}</b>`}</p><form method="post" action="/oauth/login/${id}/code">
<label for="c">${isDemo(email) ? t.demo_code : t.code}</label>${input}
${err ? `<div class="err">${esc(err)}</div>` : ''}<button>${t.verify}</button></form>
<p class="muted"><a href="/oauth/login/${id}?restart=1">${t.again}</a></p>`;
}

/**
 * Сессия уже вошла через Google: почта и код её не перехватывают. Иначе знающий pending_id подменял бы
 * человека в чужой сессии своим, а согласие всё ещё ждало бы cookie браузера жертвы. Заново — через
 * «Другая почта» (?restart=1): она снимает и вход, и привязку к браузеру.
 */
function googleTaken(res: Response, l: Lang, id: string): void {
  page(res, l, `<p class="err"><a href="/oauth/login/${id}?restart=1">${TEXT[l].google_restart}</a></p>`, 409);
}

export function oauthPagesRouter(): Router {
  const r = Router();
  r.use('/oauth/login', express.urlencoded({ extended: false, limit: '4kb' }));
  r.post('/oauth/login/*splat', rateLimit({ windowMs: 60_000, max: 20, key: clientKey }));

  r.get('/oauth/login/:id', async (req, res) => {
    const l = langFromRequest(req);
    const p = await loadPending(req.params.id);
    if (!p) return page(res, l, `<p class="err">${TEXT[l].expired}</p>`, 410);
    if (req.query.restart) await withGlobal((db) => db.query('update oauth_pending set email = null, user_id = null, via_google_cookie_hash = null, via_code_cookie_hash = null where id = $1', [p.id]));
    else if (p.user_id) return page(res, l, consentForm(p, l));
    else if (p.email) return page(res, l, codeForm(p.id, l, p.email));
    page(res, l, emailForm(p.id, l));
  });

  r.post('/oauth/login/:id/email', async (req, res) => {
    const l = langFromRequest(req);
    const p = await loadPending(req.params.id);
    if (!p) return page(res, l, `<p class="err">${TEXT[l].expired}</p>`, 410);
    if (p.via_google_cookie_hash) return googleTaken(res, l, p.id);
    const email = String(req.body.email ?? '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return page(res, l, emailForm(p.id, l, TEXT[l].bad_email), 400);
    if (!(await withGlobal((db) => mayEnter(db, email)))) return page(res, l, emailForm(p.id, l, TEXT[l].closed), 403);
    if (isDemo(email)) {
      await withGlobal((db) => db.query('update oauth_pending set email = $2, user_id = null where id = $1', [p.id, email]));
      return page(res, l, codeForm(p.id, l, email));
    }
    try {
      const code = await withGlobal(async (db) => {
        const c = await issueLoginCode(db, email, 'oauth', { pendingId: p.id });
        await db.query('update oauth_pending set email = $2 where id = $1', [p.id, email]);
        return c;
      });
      await sendEmail(loginCodeMail(email, code, l));
      page(res, l, codeForm(p.id, l, email));
    } catch (e) {
      // Почту в сессию входа не записываем: иначе можно подбирать код, который запросил сам владелец почты.
      if (e instanceof AppError && e.code === 'limit_exceeded') return page(res, l, emailForm(p.id, l, TEXT[l].wait), 429);
      logger.error({ err: e }, 'oauth: отправка кода');
      page(res, l, emailForm(p.id, l, TEXT[l].send_failed), 500);
    }
  });

  r.post('/oauth/login/:id/code', async (req, res) => {
    const l = langFromRequest(req);
    const p = await loadPending(req.params.id);
    if (p?.via_google_cookie_hash) return googleTaken(res, l, p.id);
    if (!p || !p.email) return page(res, l, `<p class="err">${TEXT[l].expired}</p>`, 410);
    const code = String(req.body.code ?? '').replace(/\s/g, '');
    // Согласие примем только от браузера, который ввёл верный код (аудит 07.10, HIGH).
    const browser = randomBytes(32).toString('base64url');
    const userId = await withGlobal(async (db) => {
      const ok = isDemo(p.email!)
        ? await verifyDemoCode(db, p.id, code, clientIp(req))
        : await verifyLoginCode(db, p.email!, code, { purpose: 'oauth', pendingId: p.id });
      if (!ok || !(await mayEnter(db, p.email!))) return null;
      const { user } = await ensureUserByEmail(db, p.email!, { language: l, verified: true });
      await db.query('update oauth_pending set user_id = $2, via_code_cookie_hash = $3 where id = $1', [p.id, user.id, sha256(browser)]);
      return user.id;
    });
    if (!userId) return page(res, l, codeForm(p.id, l, p.email, isDemo(p.email) ? TEXT[l].demo_bad! : TEXT[l].bad_code), 400);
    res.cookie(codeCookieName(p.id), browser, { ...CODE_COOKIE, maxAge: 15 * 60_000 });
    page(res, l, consentForm((await loadPending(p.id))!, l));
  });

  r.post('/oauth/login/:id/consent', async (req, res) => {
    const l = langFromRequest(req);
    const p = await loadPending(req.params.id);
    if (!p || !p.user_id) return page(res, l, `<p class="err">${TEXT[l].expired}</p>`, 410);
    // Сессия вошла через Google — согласие только из того же браузера: иначе
    // фишинговая ссылка на наш вход отдавала бы токен браузеру, знающему pending_id. Кодом — как раньше.
    if (p.via_google_cookie_hash) {
      const cookie = readCookie(req, googleCookieName(p.id));
      if (!cookie || !safeEqual(sha256(cookie), p.via_google_cookie_hash)) {
        return page(res, l, `<p class="err">${TEXT[l].google_browser}</p>`, 403);
      }
      res.clearCookie(googleCookieName(p.id), { path: '/oauth', httpOnly: true, secure: true, sameSite: 'lax' });
    } else {
      // Вошли кодом из почты — согласие только из браузера, который этот код ввёл (аудит 07.10, HIGH):
      // иначе тот, кто начал вход и прислал ссылку, забирал токены, пока жертва вводила свой код.
      const cookie = readCookie(req, codeCookieName(p.id));
      if (!p.via_code_cookie_hash || !cookie || !safeEqual(sha256(cookie), p.via_code_cookie_hash)) {
        return page(res, l, `<p class="err">${TEXT[l].google_browser}</p>`, 403);
      }
      res.clearCookie(codeCookieName(p.id), CODE_COOKIE);
    }
    const redirect = await issueAuthorizationCode(p.id, p.user_id);
    res.redirect(302, redirect);
  });

  return r;
}

export function consentForm(p: Pending, l: Lang): string {
  const t = TEXT[l];
  let host = '';
  try { host = new URL(p.redirect_uri).host; } catch { host = '?'; }
  // Кто просит доступ и куда уйдёт код — видно человеку до нажатия (аудит безопасности, п.2).
  return `<p>${t.consent}</p><p class="muted">${esc(p.client_name ?? 'Claude')} · ${esc(host)}</p>
<form method="post" action="/oauth/login/${p.id}/consent"><button>${t.allow}</button></form>`;
}
