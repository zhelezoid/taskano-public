import type { Mail } from '../send.js';

// Письмо владельцу новой компании (спека pilot-deploy, «Подписание клиента»). До него клиент получал
// компанию и ничего больше: ни слова о том, что делать дальше. Это стоило пилоту первого клиента —
// он подключил бота, начал разговаривать с Клодом, тот бодро отвечал «поставил задачу», а в
// приложении было пусто: коннектор не был подключён, инструментов у Клода не было вовсе.
//
// Поэтому здесь три шага по порядку и — отдельной строкой — как убедиться, что всё работает.
//
// Оформление (методика refero-design, ссылки в спеке): ведущий источник — собственный лендинг
// taskano.app, его же палитра и ритм; у SST (sst.dev) взят один приём — моноширинный блок как
// главный визуальный мотив: адрес коннектора здесь и есть то, ради чего письмо открывают.
// Картинок нет совсем: они грузятся не у всех, а шаги должны читаться сразу.
//
// Вёрстка письма, а не страницы: таблицы вместо flex, стили в атрибутах, ширина 600, системные
// шрифты. Внешние шрифты в почте не грузятся, и Schibsted Grotesk с лендинга здесь недоступен.

interface Links { site: string; connector: string; skill: string }

interface Text {
  subject: (org: string) => string;
  lead: (org: string) => string;
  steps: [string, string][];
  addressLabel: string;
  checkTitle: string;
  check: string;
  warnTitle: string;
  warn: string;
  outro: string;
  openSite: string;
}

const T: Record<string, Text> = {
  ru: {
    subject: (org) => `«${org}» в Taskano: три шага, чтобы начать`,
    lead: (org) => `Компания «${org}» заведена. Осталось соединить её с вашим Клодом — три шага, минут пять.`,
    steps: [
      ['Поставьте skill', 'На сайте — кнопка «Get the Claude skill». Без него Клод увидит инструменты, но не будет знать, как руководить людьми.'],
      ['Добавьте коннектор', 'В claude.ai: Настройки → Connectors → Add custom connector. Адрес — ниже.'],
      ['Войдите по этой почте', 'Нажмите Connect, введите этот адрес — придёт код из шести цифр. После этого откройте новый разговор с Клодом.'],
    ],
    addressLabel: 'Адрес коннектора',
    checkTitle: 'Как убедиться, что получилось',
    check: 'Попросите Клода: «покажи, что у меня в Taskano». Он должен ответить фактами о вашей компании, а не общими словами.',
    warnTitle: 'Если приложение пустое',
    warn: 'Клод говорит, что поставил задачу, а в приложении ничего нет — значит коннектор не подключён и задача никуда не записалась. Вернитесь ко второму шагу.',
    outro: 'Люди, которых вы позовёте, работают в Telegram-боте и ничего из этого не делают: им приходит приглашение и одно дело за раз.',
    openSite: 'Открыть taskano.app',
  },
  en: {
    subject: (org) => `“${org}” in Taskano: three steps to start`,
    lead: (org) => `Your company “${org}” is set up. What is left is connecting it to your Claude — three steps, about five minutes.`,
    steps: [
      ['Install the skill', 'The “Get the Claude skill” button on the site. Without it Claude sees the tools but does not know how to lead people with them.'],
      ['Add the connector', 'In claude.ai: Settings → Connectors → Add custom connector. The address is below.'],
      ['Sign in with this email', 'Press Connect and enter this address — a six-digit code will arrive. Then open a new conversation with Claude.'],
    ],
    addressLabel: 'Connector address',
    checkTitle: 'How to know it worked',
    check: 'Ask Claude: “show me what I have in Taskano”. It should answer with facts about your company, not in general terms.',
    warnTitle: 'If the app stays empty',
    warn: 'Claude says it has set a task and nothing appears in the app — the connector is not connected and nothing was recorded. Go back to step two.',
    outro: 'The people you invite work in the Telegram bot and do none of this: they get an invitation and one task at a time.',
    openSite: 'Open taskano.app',
  },
  tr: {
    subject: (org) => `Taskano'da “${org}”: başlamak için üç adım`,
    lead: (org) => `“${org}” şirketi hazır. Geriye Claude'unuza bağlamak kaldı — üç adım, yaklaşık beş dakika.`,
    steps: [
      ['Skill\'i kurun', 'Sitedeki “Get the Claude skill” düğmesi. O olmadan Claude araçları görür ama insanları nasıl yöneteceğini bilmez.'],
      ['Bağlayıcıyı ekleyin', 'claude.ai içinde: Settings → Connectors → Add custom connector. Adres aşağıda.'],
      ['Bu e-posta ile girin', 'Connect\'e basın ve bu adresi girin — altı haneli bir kod gelecek. Sonra Claude ile yeni bir sohbet açın.'],
    ],
    addressLabel: 'Bağlayıcı adresi',
    checkTitle: 'Çalıştığını nasıl anlarsınız',
    check: 'Claude\'a sorun: “Taskano\'da neyim var, göster”. Genel laflarla değil, şirketinizin gerçek bilgileriyle cevap vermeli.',
    warnTitle: 'Uygulama boş kalıyorsa',
    warn: 'Claude görev verdiğini söylüyor ama uygulamada hiçbir şey görünmüyorsa, bağlayıcı bağlı değildir ve hiçbir şey kaydedilmemiştir. İkinci adıma dönün.',
    outro: 'Davet ettiğiniz kişiler Telegram botunda çalışır ve bunların hiçbirini yapmaz: davet alır ve her seferinde tek bir iş görürler.',
    openSite: 'taskano.app adresini aç',
  },
  vi: {
    subject: (org) => `“${org}” trên Taskano: ba bước để bắt đầu`,
    lead: (org) => `Công ty “${org}” đã sẵn sàng. Việc còn lại là kết nối với Claude của bạn — ba bước, khoảng năm phút.`,
    steps: [
      ['Cài skill', 'Nút “Get the Claude skill” trên trang web. Không có nó, Claude thấy công cụ nhưng không biết cách dẫn dắt công việc.'],
      ['Thêm connector', 'Trong claude.ai: Settings → Connectors → Add custom connector. Địa chỉ ở dưới.'],
      ['Đăng nhập bằng email này', 'Bấm Connect và nhập địa chỉ này — một mã sáu chữ số sẽ được gửi tới. Sau đó mở cuộc trò chuyện mới với Claude.'],
    ],
    addressLabel: 'Địa chỉ connector',
    checkTitle: 'Làm sao biết đã xong',
    check: 'Hãy hỏi Claude: “cho tôi xem tôi có gì trong Taskano”. Claude phải trả lời bằng dữ liệu thật của công ty, không nói chung chung.',
    warnTitle: 'Nếu ứng dụng vẫn trống',
    warn: 'Claude nói đã giao việc mà ứng dụng không có gì — nghĩa là connector chưa kết nối và không có gì được lưu. Hãy quay lại bước hai.',
    outro: 'Những người bạn mời làm việc trong bot Telegram và không phải làm các bước này: họ nhận lời mời và mỗi lần một việc.',
    openSite: 'Mở taskano.app',
  },
};

// Палитра лендинга: письмо и сайт — один продукт, расходиться им не в чем.
const INK = '#1A1F36';
const MUTED = '#5A6078';
const PAPER = '#F2F4F6';
const LINE = '#D9DDE5';
const ACCENT = '#2F45E8';
const MARK = '#FFE36E';
// Кавычки внутри — только одинарные: значение уходит в атрибут style="…", и двойная кавычка
// закрыла бы атрибут раньше времени. Письмо тогда рисуется Times вместо системного шрифта —
// поймано просмотром, а не чтением кода.
const SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace";

const esc = (s: string): string => s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);

/** Шаг: номер в квадрате, заголовок, объяснение. Номер — таблицей, иначе Outlook ломает выравнивание. */
function step(n: number, title: string, body: string): string {
  return `<tr><td style="padding:0 0 22px">
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td width="28" valign="top" style="width:28px">
<div style="width:24px;height:24px;background:${INK};border-radius:4px;color:#fff;font:600 13px/24px ${SANS};text-align:center">${n}</div>
</td>
<td valign="top" style="padding-left:12px">
<div style="font:600 16px/1.4 ${SANS};color:${INK}">${esc(title)}</div>
<div style="font:400 15px/1.55 ${SANS};color:${MUTED};padding-top:3px">${esc(body)}</div>
</td>
</tr></table></td></tr>`;
}

export function welcomeOwnerMail(to: string, orgName: string, lang: string, links: Links): Mail {
  const t = T[lang] ?? T.en!;

  const text = [
    t.lead(orgName),
    '',
    ...t.steps.map(([title, body], i) => `${i + 1}. ${title}. ${body}`),
    '',
    `${t.addressLabel}: ${links.connector}`,
    `Skill: ${links.skill}`,
    '',
    `${t.checkTitle}. ${t.check}`,
    '',
    `${t.warnTitle}. ${t.warn}`,
    '',
    t.outro,
    links.site,
  ].join('\n');

  const html = `<!doctype html>
<html lang="${esc(lang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>${esc(t.subject(orgName))}</title>
<style>
/* Почтовые клиенты режут внешние стили, но @media в head понимают Gmail, Apple Mail и Outlook для
   мобильных — на узком экране отступы в 32px съедали бы половину ширины. */
@media only screen and (max-width:480px) {
  .card { padding:24px 20px 22px !important }
  .pad { padding:20px !important }
  .h1 { font-size:21px !important }
}
</style></head>
<body style="margin:0;padding:0;background:${PAPER}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${PAPER}">
<tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:100%">

<tr><td style="padding:0 0 18px;font:600 15px/1 ${SANS};color:${INK};letter-spacing:-0.01em">Taskano</td></tr>

<tr><td class="card" style="background:#fff;border:1px solid ${LINE};border-radius:14px;padding:32px 32px 28px">

<div class="h1" style="font:600 24px/1.25 ${SANS};color:${INK};letter-spacing:-0.02em">${esc(t.lead(orgName).split('.')[0]!)}.</div>
<div style="font:400 16px/1.55 ${SANS};color:${MUTED};padding:10px 0 26px">${esc(t.lead(orgName).split('. ').slice(1).join('. '))}</div>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
${t.steps.map(([title, body], i) => step(i + 1, title, body)).join('')}
</table>

<div style="background:${PAPER};border-radius:8px;padding:14px 16px;margin:4px 0 24px">
<div style="font:600 11px/1 ${SANS};color:${MUTED};letter-spacing:0.08em;text-transform:uppercase">${esc(t.addressLabel)}</div>
<div style="font:400 15px/1.5 ${MONO};color:${INK};padding-top:7px;word-break:break-all">${esc(links.connector)}</div>
</div>

<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td style="background:${ACCENT};border-radius:8px">
<a href="${esc(links.skill)}" style="display:inline-block;padding:12px 22px;font:600 15px/1 ${SANS};color:#fff;text-decoration:none">${esc(t.steps[0]![0])} →</a>
</td></tr></table>

</td></tr>

<tr><td style="padding:16px 0 0">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#fff;border:1px solid ${LINE};border-radius:14px">
<tr><td class="pad" style="padding:22px 24px">
<div style="font:600 15px/1.4 ${SANS};color:${INK}">${esc(t.checkTitle)}</div>
<div style="font:400 15px/1.55 ${SANS};color:${MUTED};padding-top:6px">${esc(t.check)}</div>
</td></tr>
<tr><td class="pad" style="padding:0 24px 22px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${PAPER};border-radius:8px">
<tr>
<td width="4" style="width:4px;background:${MARK};border-radius:8px 0 0 8px">&nbsp;</td>
<td style="padding:14px 16px">
<div style="font:600 14px/1.4 ${SANS};color:${INK}">${esc(t.warnTitle)}</div>
<div style="font:400 14px/1.55 ${SANS};color:${MUTED};padding-top:4px">${esc(t.warn)}</div>
</td></tr></table>
</td></tr></table>
</td></tr>

<tr><td style="padding:22px 4px 0;font:400 14px/1.55 ${SANS};color:${MUTED}">${esc(t.outro)}</td></tr>
<tr><td style="padding:14px 4px 0;font:400 14px/1 ${SANS}">
<a href="${esc(links.site)}" style="color:${ACCENT};text-decoration:none">${esc(t.openSite)}</a>
</td></tr>

</table></td></tr></table></body></html>`;

  return { to, subject: t.subject(orgName), text, html };
}
