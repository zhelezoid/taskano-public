import type { Lang } from '../i18n/index.js';

// Оформление страницы входа OAuth (спека oauth-login-page): рядом с формой — что даёт Taskano.
// Всё своё и встроенное: на странице вводится вход, поэтому ни внешних скриптов, ни шрифтов с CDN,
// ни картинок с чужих адресов — только логотип с этого же сервера. Примеры нарисованы разметкой.
// Подписи кнопок и «Итоги» — те же слова, что человек увидит в боте и приложении (src/i18n, app/src/i18n.ts).

interface Promo {
  about: string; tagline: string; sub: string;
  points: [string, string][];
  bot: string; msg_title: string; msg_body: string; take: string; question: string;
  card_title: string; due_label: string; due: string; due_by: string; time_label: string; time: string;
  stats: string; done_label: string; hours_label: string;
  privacy: string; terms: string;
}

const PROMO: Record<Lang, Promo> = {
  ru: {
    about: 'О Taskano', tagline: 'ИИ-агенты ведут людей по делу.',
    sub: 'Задачи приходят людям в Telegram. Агент ведёт каждый шаг и проверяет результат.',
    points: [
      ['В Telegram, на своём языке', 'Бот присылает задачи — каждому на родном языке.'],
      ['Агент ведёт по шагам', 'Что сделать, зачем и что считается готовым.'],
      ['Срок называет исполнитель', 'Дату ставит тот, кто делает. Просьба и ответ записаны.'],
      ['Время и «Итоги»', 'Время по каждому делу и сводка: что сделано, кем, по какому проекту.'],
    ],
    bot: 'бот', msg_title: 'NOR-004 · Пересчитать товар 4471', msg_body: 'Сфотографируйте полку и посчитайте штуки.', take: 'Взять', question: 'Вопрос',
    card_title: 'Пересчитать товар 4471', due_label: 'Срок', due: '7 окт', due_by: 'назначен исполнителем', time_label: 'Время', time: '1 ч 20 мин',
    stats: 'Итоги · неделя', done_label: 'Сделано', hours_label: 'Часов',
    privacy: 'Конфиденциальность', terms: 'Условия',
  },
  tr: {
    about: 'Taskano hakkında', tagline: 'Yapay zekâ ajanları ekibi iş boyunca yönlendirir.',
    sub: 'Görevler Telegram\'dan gelir. Ajan her adımı yönetir ve sonucu kontrol eder.',
    points: [
      ['Telegram\'da, kendi dilinde', 'Bot görevleri herkese kendi dilinde gönderir.'],
      ['Ajan adım adım yönlendirir', 'Ne yapılacak, neden ve ne zaman bitmiş sayılır.'],
      ['Tarihi işi yapan belirler', 'Son tarihi görevi yapan kişi seçer. İstek ve yanıt kayıtlıdır.'],
      ['Süre ve Sonuçlar', 'Her görevin süresi ve özet: ne yapıldı, kim yaptı, hangi projede.'],
    ],
    bot: 'bot', msg_title: 'NOR-004 · 4471 ürününü yeniden say', msg_body: 'Rafın fotoğrafını çekin ve adetleri sayın.', take: 'Üstlen', question: 'Soru',
    card_title: '4471 ürününü yeniden say', due_label: 'Son tarih', due: '7 Eki', due_by: 'görevi yapan belirledi', time_label: 'Süre', time: '1 sa 20 dk',
    stats: 'Sonuçlar · bu hafta', done_label: 'Tamamlanan', hours_label: 'Saat',
    privacy: 'Gizlilik', terms: 'Koşullar',
  },
  vi: {
    about: 'Về Taskano', tagline: 'Tác tử AI dẫn dắt mọi người qua từng việc.',
    sub: 'Việc được gửi qua Telegram. Tác tử hướng dẫn từng bước và kiểm tra kết quả.',
    points: [
      ['Trên Telegram, bằng ngôn ngữ của mỗi người', 'Bot gửi việc cho mỗi người bằng ngôn ngữ của họ.'],
      ['Tác tử dẫn từng bước', 'Làm gì, vì sao và thế nào là xong.'],
      ['Người làm tự chọn hạn', 'Người thực hiện chọn ngày. Yêu cầu và câu trả lời đều được lưu lại.'],
      ['Thời gian và Kết quả', 'Thời gian cho từng việc và bản tổng hợp: đã làm gì, ai làm, thuộc dự án nào.'],
    ],
    bot: 'bot', msg_title: 'NOR-004 · Kiểm đếm lại mã 4471', msg_body: 'Chụp ảnh kệ hàng và đếm số lượng.', take: 'Nhận việc', question: 'Hỏi',
    card_title: 'Kiểm đếm lại mã 4471', due_label: 'Hạn', due: '7/10', due_by: 'do người làm chọn', time_label: 'Thời gian', time: '1 giờ 20 phút',
    stats: 'Kết quả · tuần này', done_label: 'Đã xong', hours_label: 'Giờ',
    privacy: 'Quyền riêng tư', terms: 'Điều khoản',
  },
  en: {
    about: 'About Taskano', tagline: 'AI agents lead people through the work.',
    sub: 'Tasks reach people in Telegram. An agent guides each step and checks the result.',
    points: [
      ['Telegram, in their own language', 'The bot sends each person tasks in their language.'],
      ['An agent leads step by step', 'What to do, why, and what counts as done.'],
      ['The doer names the due date', 'The person doing the task picks the date. The request and the answer are on record.'],
      ['Time and Results', 'Time on each task and a summary: what was done, by whom, on which project.'],
    ],
    bot: 'bot', msg_title: 'NOR-004 · Recount item 4471', msg_body: 'Photograph the shelf and count the units.', take: 'Take', question: 'Question',
    card_title: 'Recount item 4471', due_label: 'Due', due: 'Oct 7', due_by: 'set by the assignee', time_label: 'Time', time: '1 h 20 min',
    stats: 'Results · this week', done_label: 'Done', hours_label: 'Hours',
    privacy: 'Privacy', terms: 'Terms',
  },
};

// Цвета и радиусы — те же, что у лендинга (src/web/site/index.html), чтобы вход выглядел частью сайта.
// Шрифт — системный: Schibsted Grotesk лендинг берёт с Google Fonts, а сюда внешний адрес нельзя.
export const LOGIN_CSS = `:root{--paper:#F2F4F6;--surface:#fff;--ink:#1A1F36;--muted:#5A6078;--line:#D9DDE5;--accent:#2F45E8;--accent-hover:#2436D0;
--chat:#DCE3EC;--kb:rgba(255,255,255,.7);--err:#B00020;--done:#0F8A5F;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--paper:#11141F;--surface:#1B2031;--ink:#E8EAF2;--muted:#9AA0B8;--line:#2C3247;--accent:#6F80FF;--accent-hover:#8A98FF;
--chat:#232A3F;--kb:rgba(255,255,255,.06);--err:#FF7A8A;--done:#3FC48F}}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
font-size:16px;line-height:1.5;-webkit-font-smoothing:antialiased}
.shell{max-width:1080px;margin:0 auto;padding:16px 16px 32px;display:grid;gap:16px;grid-template-columns:minmax(0,1fr);grid-template-areas:"head" "form" "promo" "foot"}
.head{grid-area:head;display:flex;align-items:center;gap:12px}
.head img{width:36px;height:36px;border-radius:9px;background:#fff;flex:none}
.brand{font-weight:700;font-size:17px;letter-spacing:-.01em;line-height:1.2}
.tagline{margin:0;color:var(--muted);font-size:14px;line-height:1.3}
main{grid-area:form;background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:24px 20px;width:100%}
h1{font-size:21px;line-height:1.25;letter-spacing:-.01em;margin:0 0 14px}
label{display:block;font-size:14px;color:var(--muted);margin:12px 0 6px}
input{width:100%;font:inherit;font-size:17px;padding:11px 12px;border:1px solid var(--line);border-radius:8px;background:var(--surface);color:var(--ink)}
input:focus{outline:2px solid var(--accent);outline-offset:1px;border-color:transparent}
button{margin-top:16px;width:100%;font:inherit;font-size:16px;font-weight:600;min-height:46px;padding:11px;border:0;border-radius:999px;background:var(--accent);color:#fff;cursor:pointer}
button:hover{background:var(--accent-hover)}
:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
.err{color:var(--err);font-size:14px;margin-top:10px}.muted{color:var(--muted);font-size:14px}a{color:var(--accent)}
.promo{grid-area:promo;min-width:0}
.sub{margin:0 0 18px;color:var(--muted);font-size:15px;max-width:34rem}
.points{list-style:none;margin:0 0 20px;padding:0;display:grid;gap:12px}
.points li{display:grid;grid-template-columns:20px minmax(0,1fr);gap:10px}
.points li::before{content:"";width:8px;height:8px;border-radius:50%;background:var(--accent);margin:8px 0 0 6px}
.points b{display:block;font-size:15px;letter-spacing:-.005em}
.points span{color:var(--muted);font-size:14px}
.demo{display:grid;gap:10px}
.chat{background:var(--chat);border-radius:16px;padding:12px}
.chat-head{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:700;margin:0 0 8px}
.chat-head img{width:24px;height:24px;border-radius:50%;background:#fff}
.chat-head small{font-weight:400;color:var(--muted)}
.bubble{background:var(--surface);border-radius:14px 14px 14px 4px;padding:10px 12px;font-size:14px}
.bubble b{display:block;margin-bottom:2px}
.kb{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:6px}
.kb span{background:var(--kb);border-radius:9px;text-align:center;padding:7px 4px;font-size:13px;font-weight:600;color:var(--accent)}
.row2{display:grid;grid-template-columns:minmax(0,1.3fr) minmax(0,1fr);gap:10px}
.mini{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:12px;font-size:13px;min-width:0}
.mini .id{font-size:12px;font-weight:700;color:var(--accent);letter-spacing:.02em}
.mini .t{font-weight:600;font-size:14px;margin:2px 0 8px;line-height:1.3}
.kv{display:flex;justify-content:space-between;gap:8px;border-top:1px solid var(--line);padding-top:6px;margin-top:6px}
.kv span{color:var(--muted)}.kv b{text-align:right}
.note{display:block;color:var(--done);font-size:12px;text-align:right}
.big{font-size:26px;font-weight:800;letter-spacing:-.03em;line-height:1.1}
.stat{display:flex;gap:16px;margin-top:6px}.stat div span{display:block;color:var(--muted);font-size:12px}
.foot{grid-area:foot;display:flex;gap:16px;font-size:13px;color:var(--muted)}
.foot a{color:var(--muted);text-decoration:none}.foot a:hover{color:var(--ink)}
@media (min-width:760px){
.shell{min-height:100vh;align-content:center;padding:32px;column-gap:clamp(32px,6vw,80px);row-gap:20px;
grid-template-columns:minmax(0,1.15fr) minmax(320px,400px);grid-template-areas:"head form" "promo form" "foot form"}
main{align-self:center;padding:32px 28px}
.head img{width:44px;height:44px;border-radius:11px}.brand{font-size:20px}
.points{grid-template-columns:1fr 1fr;column-gap:20px}
.tagline{font-size:clamp(24px,2.6vw,32px);color:var(--ink);font-weight:800;letter-spacing:-.03em;line-height:1.1}
.head{align-items:flex-start;flex-direction:column;gap:10px}}`;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Короткая шапка над формой: логотип и одна строка — на телефоне форма остаётся на первом экране. */
export function promoHead(l: Lang): string {
  const p = PROMO[l];
  return `<header class="head"><img src="/logo-96.png?v=2" width="36" height="36" alt="">
<div><div class="brand">Taskano</div><p class="tagline">${esc(p.tagline)}</p></div></header>`;
}

/** Что даёт Taskano и три нарисованных примера. Разметка без ссылок и картинок извне. */
export function promoBody(l: Lang): string {
  const p = PROMO[l];
  const points = p.points.map(([h, t]) => `<li><div><b>${esc(h)}</b><span>${esc(t)}</span></div></li>`).join('');
  return `<section class="promo" aria-label="${esc(p.about)}"><p class="sub">${esc(p.sub)}</p>
<ul class="points">${points}</ul>
<div class="demo" aria-hidden="true">
<div class="chat"><div class="chat-head"><img src="/logo-96.png?v=2" width="24" height="24" alt="">Taskano <small>${esc(p.bot)}</small></div>
<div class="bubble"><b>${esc(p.msg_title)}</b>${esc(p.msg_body)}</div>
<div class="kb"><span>${esc(p.take)}</span><span>${esc(p.question)}</span></div></div>
<div class="row2">
<div class="mini"><div class="id">NOR-004</div><div class="t">${esc(p.card_title)}</div>
<div class="kv"><span>${esc(p.due_label)}</span><b>${esc(p.due)}</b></div><span class="note">${esc(p.due_by)}</span>
<div class="kv"><span>${esc(p.time_label)}</span><b>${esc(p.time)}</b></div></div>
<div class="mini"><div class="t">${esc(p.stats)}</div><div class="stat">
<div><div class="big">12</div><span>${esc(p.done_label)}</span></div><div><div class="big">18</div><span>${esc(p.hours_label)}</span></div></div></div>
</div></div></section>`;
}

/** Подвал: правовые страницы — в новой вкладке, чтобы не потерять незаконченный вход. */
export function promoFoot(l: Lang): string {
  const p = PROMO[l];
  return `<footer class="foot"><a href="/privacy" target="_blank" rel="noopener">${esc(p.privacy)}</a><a href="/terms" target="_blank" rel="noopener">${esc(p.terms)}</a></footer>`;
}

// Кнопка «Войти через Google» (спека google-login) — по правилам бренда Google: белая,
// серая рамка #747775, тёмный текст #1F1F1F, разноцветная «G» слева. Логотип — встроенный SVG:
// картинку с адреса Google сюда нельзя, на странице вводится вход. Цвета не следуют теме сайта —
// их задаёт бренд Google, и белая кнопка у него допустима и на тёмном фоне.
// Стиль добавляется в <head> только страницам, где кнопка есть: остальные остаются байт в байт прежними.
export const GOOGLE_CSS = `.gsi{margin:0 0 4px}
.gbtn{display:flex;align-items:center;justify-content:center;gap:12px;width:100%;min-height:46px;padding:11px 16px;border:1px solid #747775;border-radius:999px;
background:#fff;color:#1F1F1F;font-size:16px;font-weight:600;text-decoration:none}
.gbtn:hover{background:#F2F2F2;color:#1F1F1F}.gbtn svg{flex:none}
.or{display:flex;align-items:center;gap:10px;margin:16px 0 0;color:var(--muted);font-size:13px}
.or::before,.or::after{content:"";flex:1;border-top:1px solid var(--line)}`;

/** Логотип «G» Google, 18×18 — тот же контур, что у их собственной кнопки входа. */
export const GOOGLE_G = `<svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true" focusable="false">`
  + `<path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>`
  + `<path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>`
  + `<path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>`
  + `<path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>`;
