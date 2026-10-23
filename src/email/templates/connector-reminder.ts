import type { Mail } from '../send.js';

// Напоминание владельцу: человек в системе есть, коннектора нет (спека mcp-and-oauth).
//
// Приветственное письмо уходит один раз и теряется среди других. Без коннектора компания стоит:
// агент до неё не дотягивается, а Клод в разговоре выглядит работающим и ничего не записывает —
// на этом пилот теряет клиента молча.
//
// Письмо короче приветственного намеренно: это не инструкция заново, а толчок. Всё лишнее убрано,
// чтобы адрес коннектора был виден сразу — оформление то же, что у первого письма.

interface Links { site: string; connector: string; skill: string }

interface Text {
  subject: (org: string) => string;
  lead: (org: string) => string;
  why: string;
  steps: string[];
  addressLabel: string;
  cta: string;
  last: string;
}

const T: Record<string, Text> = {
  ru: {
    subject: (org) => `«${org}» ещё не соединена с вашим Клодом`,
    lead: (org) => `В компании «${org}» пока не подключён коннектор.`,
    why: 'Пока его нет, Клод не видит ваших дел и не может ничего записать: в разговоре он будет отвечать, но в приложении останется пусто.',
    steps: [
      'claude.ai → Настройки → Connectors → Add custom connector',
      'Connect → войти по этой почте → код из шести цифр',
    ],
    addressLabel: 'Адрес коннектора',
    cta: 'Открыть taskano.app',
    last: 'Это последнее напоминание — дальше писать не будем.',
  },
  en: {
    subject: (org) => `“${org}” is not connected to your Claude yet`,
    lead: (org) => `The connector for “${org}” is still not set up.`,
    why: 'Until it is, Claude cannot see your tasks or record anything: it will keep answering in the conversation while the app stays empty.',
    steps: [
      'claude.ai → Settings → Connectors → Add custom connector',
      'Connect → sign in with this email → a six-digit code',
    ],
    addressLabel: 'Connector address',
    cta: 'Open taskano.app',
    last: 'This is the last reminder — we will not write again.',
  },
  tr: {
    subject: (org) => `“${org}” henüz Claude'unuza bağlı değil`,
    lead: (org) => `“${org}” şirketinde bağlayıcı hâlâ kurulmadı.`,
    why: 'Kurulmadan Claude işlerinizi göremez ve hiçbir şey kaydedemez: sohbette cevap vermeye devam eder ama uygulama boş kalır.',
    steps: [
      'claude.ai → Settings → Connectors → Add custom connector',
      'Connect → bu e-posta ile giriş → altı haneli kod',
    ],
    addressLabel: 'Bağlayıcı adresi',
    cta: 'taskano.app adresini aç',
    last: 'Bu son hatırlatma — bir daha yazmayacağız.',
  },
  vi: {
    subject: (org) => `“${org}” vẫn chưa kết nối với Claude của bạn`,
    lead: (org) => `Connector cho “${org}” vẫn chưa được thiết lập.`,
    why: 'Chưa có nó, Claude không thấy công việc của bạn và không lưu được gì: trong trò chuyện vẫn trả lời, nhưng ứng dụng vẫn trống.',
    steps: [
      'claude.ai → Settings → Connectors → Add custom connector',
      'Connect → đăng nhập bằng email này → mã sáu chữ số',
    ],
    addressLabel: 'Địa chỉ connector',
    cta: 'Mở taskano.app',
    last: 'Đây là lời nhắc cuối — chúng tôi sẽ không viết nữa.',
  },
};

const INK = '#1A1F36';
const MUTED = '#5A6078';
const PAPER = '#F2F4F6';
const LINE = '#D9DDE5';
const ACCENT = '#2F45E8';
// Кавычки внутри — только одинарные: значение уходит в атрибут style="…".
const SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace";

const esc = (s: string): string => s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);

export function connectorReminderMail(
  to: string, orgName: string, lang: string, links: Links, isLast: boolean,
): Mail {
  const t = T[lang] ?? T.en!;

  const text = [
    t.lead(orgName),
    t.why,
    '',
    ...t.steps.map((s, i) => `${i + 1}. ${s}`),
    '',
    `${t.addressLabel}: ${links.connector}`,
    links.site,
    ...(isLast ? ['', t.last] : []),
  ].join('\n');

  const html = `<!doctype html>
<html lang="${esc(lang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>${esc(t.subject(orgName))}</title>
<style>@media only screen and (max-width:480px){.card{padding:24px 20px !important}}</style></head>
<body style="margin:0;padding:0;background:${PAPER}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${PAPER}">
<tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:100%">

<tr><td style="padding:0 0 18px;font:600 15px/1 ${SANS};color:${INK};letter-spacing:-0.01em">Taskano</td></tr>

<tr><td class="card" style="background:#fff;border:1px solid ${LINE};border-radius:14px;padding:30px 32px 26px">
<div style="font:600 21px/1.3 ${SANS};color:${INK};letter-spacing:-0.015em">${esc(t.lead(orgName))}</div>
<div style="font:400 16px/1.55 ${SANS};color:${MUTED};padding:10px 0 22px">${esc(t.why)}</div>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
${t.steps.map((s, i) => `<tr><td style="padding:0 0 10px">
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td width="28" valign="top" style="width:28px">
<div style="width:24px;height:24px;background:${INK};border-radius:4px;color:#fff;font:600 13px/24px ${SANS};text-align:center">${i + 1}</div>
</td>
<td valign="top" style="padding-left:12px;font:400 15px/1.6 ${SANS};color:${INK}">${esc(s)}</td>
</tr></table></td></tr>`).join('')}
</table>

<div style="background:${PAPER};border-radius:8px;padding:14px 16px;margin:14px 0 22px">
<div style="font:600 11px/1 ${SANS};color:${MUTED};letter-spacing:0.08em;text-transform:uppercase">${esc(t.addressLabel)}</div>
<div style="font:400 15px/1.5 ${MONO};color:${INK};padding-top:7px;word-break:break-all">${esc(links.connector)}</div>
</div>

<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td style="background:${ACCENT};border-radius:8px">
<a href="${esc(links.site)}" style="display:inline-block;padding:12px 22px;font:600 15px/1 ${SANS};color:#fff;text-decoration:none">${esc(t.cta)} →</a>
</td></tr></table>
</td></tr>

${isLast ? `<tr><td style="padding:16px 4px 0;font:400 13px/1.5 ${SANS};color:${MUTED}">${esc(t.last)}</td></tr>` : ''}

</table></td></tr></table></body></html>`;

  return { to, subject: t.subject(orgName), text, html };
}
