import type { Mail } from '../send.js';
import { homeScreenStep } from './invitation.js';

// «Откройте приложение» — повторное приглашение человеку, который уже вошёл (спека person-presence).
//
// Случай, ради которого письмо есть: человек принял приглашение в боте, взял дело — и пропал, а
// приложения, где лежат все его дела, не открывал ни разу. Письмо-приглашение ему уже не поможет:
// входить заново некуда, а ссылка из него ведёт в бота, где он и так есть. Поэтому здесь одна
// кнопка — прямо в приложение (`?startapp` открывает главное приложение бота), и запасной путь, если
// ссылка не сработает. Шаг «вынести на экран» — тот же, что в приглашении, теми же словами.
//
// Вёрстка — как у письма-приглашения: таблицы, стили в атрибутах, ширина 600, системные шрифты.
// Кавычки внутри style="…" — только одинарные, иначе атрибут рвётся.

export interface OpenAppInfo {
  /** Кто попросил: имя владельца или админа, без имени — название компании. */
  requesterName: string;
  orgName: string;
  botUsername: string;
}

interface Text {
  subject: (org: string) => string;
  lead: (org: string) => string;
  step: [string, string];
  open: string;
  fallback: (bot: string) => string;
  signature: (who: string) => string;
}

// Названия кнопок — те же строки, что в боте (src/i18n/*.json: menu.app_button): запасной путь
// отправляет искать кнопку глазами, и слово обязано совпасть с экраном.
const T: Record<string, Text> = {
  ru: {
    subject: (org) => `Ваши дела в «${org}» — в приложении Taskano`,
    lead: (org) => `Вы уже подключены к Taskano. Все ваши дела в «${org}» — в приложении: что сделать сейчас, что дальше и что ждёт ответа.`,
    step: ['Откройте приложение', 'Кнопка ниже откроет его прямо в Telegram. Если Telegram спросит — нажмите «Открыть».'],
    open: 'Открыть приложение',
    fallback: (bot) => `Кнопка не сработала — откройте в Telegram чат с @${bot} и нажмите «Войти в приложение» слева от поля ввода.`,
    signature: (who) => `Письмо отправлено по просьбе ${who}.`,
  },
  en: {
    subject: (org) => `Your tasks in “${org}” are in the Taskano app`,
    lead: (org) => `You are already connected to Taskano. All your tasks in “${org}” are in the app: what to do now, what comes next and what is waiting for an answer.`,
    step: ['Open the app', 'The button below opens it right in Telegram. If Telegram asks, press “Open”.'],
    open: 'Open the app',
    fallback: (bot) => `The button did not work? Open the chat with @${bot} in Telegram and press “Open app” left of the input field.`,
    signature: (who) => `This email was sent at the request of ${who}.`,
  },
  tr: {
    subject: (org) => `“${org}” şirketindeki işleriniz Taskano uygulamasında`,
    lead: (org) => `Taskano’ya zaten bağlısınız. “${org}” şirketindeki tüm işleriniz uygulamada: şimdi ne yapılacağı, sırada ne olduğu ve neyin yanıt beklediği.`,
    step: ['Uygulamayı açın', 'Aşağıdaki düğme onu doğrudan Telegram’da açar. Telegram sorarsa “Aç”a basın.'],
    open: 'Uygulamayı aç',
    fallback: (bot) => `Düğme çalışmadı mı? Telegram’da @${bot} sohbetini açın ve yazı alanının solundaki “Uygulamayı aç” düğmesine basın.`,
    signature: (who) => `Bu e-posta şu kişinin isteğiyle gönderildi: ${who}.`,
  },
  vi: {
    subject: (org) => `Việc của bạn ở “${org}” nằm trong ứng dụng Taskano`,
    lead: (org) => `Bạn đã kết nối với Taskano. Mọi việc của bạn ở “${org}” đều trong ứng dụng: việc cần làm ngay, việc tiếp theo và việc đang chờ trả lời.`,
    step: ['Mở ứng dụng', 'Nút bên dưới mở ứng dụng ngay trong Telegram. Nếu Telegram hỏi, hãy bấm “Mở”.'],
    open: 'Mở ứng dụng',
    fallback: (bot) => `Nút không hoạt động? Mở cuộc trò chuyện với @${bot} trong Telegram và bấm “Mở ứng dụng” bên trái ô nhập.`,
    signature: (who) => `Email này được gửi theo yêu cầu của ${who}.`,
  },
};

const INK = '#1A1F36';
const MUTED = '#5A6078';
const PAPER = '#F2F4F6';
const LINE = '#D9DDE5';
const ACCENT = '#2F45E8';
// Кавычки внутри — только одинарные: значение уходит в атрибут style="…".
const SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

const esc = (s: string): string => s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);

/** Ссылка на главное приложение бота: открывает Mini App сразу, минуя чат. */
export function openAppLink(botUsername: string): string {
  return `https://t.me/${botUsername}?startapp`;
}

export function openAppMail(to: string, info: OpenAppInfo, lang: string): Mail {
  const t = T[lang] ?? T.en!;
  const home = homeScreenStep(T[lang] ? lang : 'en');
  const steps: [string, string][] = [t.step, home.step];
  const link = openAppLink(info.botUsername);

  const text = [
    t.lead(info.orgName),
    '',
    ...steps.map(([title, body], i) => `${i + 1}. ${title}. ${body}`),
    '',
    link,
    '',
    t.fallback(info.botUsername),
    home.hint,
    '',
    t.signature(info.requesterName),
  ].join('\n');

  const html = `<!doctype html>
<html lang="${esc(lang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>${esc(t.subject(info.orgName))}</title>
<style>@media only screen and (max-width:480px){.card{padding:24px 20px !important}}</style></head>
<body style="margin:0;padding:0;background:${PAPER}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${PAPER}">
<tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:100%">

<tr><td style="padding:0 0 18px;font:600 15px/1 ${SANS};color:${INK};letter-spacing:-0.01em">Taskano</td></tr>

<tr><td class="card" style="background:#fff;border:1px solid ${LINE};border-radius:14px;padding:30px 32px 26px">

<div style="font:600 21px/1.35 ${SANS};color:${INK};letter-spacing:-0.015em">${esc(t.lead(info.orgName))}</div>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:22px 0 0">
${steps.map(([title, body], i) => `<tr><td style="padding:0 0 16px">
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td width="30" valign="top" style="width:30px">
<div style="width:26px;height:26px;background:${INK};border-radius:6px;color:#fff;font:600 13px/26px ${SANS};text-align:center">${i + 1}</div>
</td>
<td valign="top" style="padding-left:12px">
<div style="font:600 15px/1.4 ${SANS};color:${INK}">${esc(title)}</div>
<div style="font:400 15px/1.55 ${SANS};color:${MUTED};padding-top:3px">${esc(body)}</div>
</td>
</tr></table></td></tr>`).join('')}
</table>

<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0 0"><tr>
<td style="background:${ACCENT};border-radius:8px">
<a href="${esc(link)}" style="display:inline-block;padding:13px 24px;font:600 15px/1 ${SANS};color:#fff;text-decoration:none">${esc(t.open)} →</a>
</td></tr></table>

<div style="font:400 13px/1.5 ${SANS};color:${MUTED};padding:16px 0 0">${esc(t.fallback(info.botUsername))}</div>
<div style="font:400 13px/1.5 ${SANS};color:${MUTED};padding:8px 0 0">${esc(home.hint)}</div>
</td></tr>

<tr><td style="padding:16px 4px 0;font:400 13px/1.5 ${SANS};color:${MUTED}">${esc(t.signature(info.requesterName))}</td></tr>

</table></td></tr></table></body></html>`;

  return { to, subject: t.subject(info.orgName), text, html };
}
