import type { Mail } from '../send.js';

// Приглашение человеку, которого позвали работать (спеки telegram-bot, mcp-and-oauth).
//
// До этого письмо было одной строкой с кнопкой: «такой-то приглашает вас в организацию». Человек,
// который про Taskano никогда не слышал, из него не понимал ни что это, ни что с ним делать, ни
// почему в почте ссылка на какого-то бота. Он открывал бота — и первое дело падало в чат, где до
// этого не было ничего.
//
// Поэтому здесь: кто позвал и в какую компанию (это первое, что человек хочет знать), три строки о
// том, как устроена работа, и шаги по порядку — до ярлыка приложения на телефоне, потому что иначе
// приложение живёт внутри чата и человек его больше не находит.
//
// Цель — сразу под заголовком (спека person-presence): письмо вело кнопкой в бота, а приложение
// пряталось во втором шаге, и люди входили в бота, не открыв приложения ни разу. Теперь с первых
// строк сказано, что шагов два и второй — приложение; шаги называют кнопки, которые человек увидит.
//
// Оформление (методика refero-design): ведущий источник — наши же письма владельцу, та же палитра,
// тот же ритм и карточка; у страницы установки Around (around.co) взят один приём — шаги как
// документация: крупный номер, короткий заголовок действия, пояснение под ним и отдельная плашка с
// тем, куда именно нажимать. Картинок нет: они грузятся не у всех, а шаги должны читаться сразу.
//
// Вёрстка письма, а не страницы: таблицы вместо flex, стили в атрибутах, ширина 600, системные
// шрифты. Кавычки внутри style="…" — только одинарные, иначе атрибут рвётся.

export interface InvitationInfo {
  inviterName: string;
  orgName: string;
  personName?: string | null;
  /** Роль, с которой зовут: управляющему видны чужие дела, и обещать обратное нельзя. */
  role?: 'owner' | 'admin' | 'member' | 'guest';
  link: string;
}

interface Text {
  subject: (inviter: string, org: string) => string;
  hello: (name: string) => string;
  lead: (inviter: string, org: string) => string;
  /** Зачем всё это: два шага и где лежат дела — прямо под заголовком. */
  goal: string;
  howTitle: string;
  how: string[];
  steps: [string, string][];
  appHint: string;
  open: string;
  outro: string;
  outroManager: string;
}

// Названия кнопок здесь — те же строки, что стоят в боте и в приложении (src/i18n/*.json:
// btn.yes_its_me, btn.open_app, menu.app_button, btn.done; app/src/i18n.ts: add_to_home). «Старт» —
// кнопка самого Telegram под пустым чатом с ботом. Письмо — единственная инструкция,
// которую человек читает до первой карточки: разойдясь в слове, оно отправляет искать кнопку,
// которой на экране нет.
const T: Record<string, Text> = {
  ru: {
    subject: (inviter, org) => `${inviter} зовёт вас работать в «${org}»`,
    hello: (name) => `${name}, здравствуйте.`,
    lead: (inviter, org) => `${inviter} приглашает вас в компанию «${org}» в Taskano. Работать вы будете в Telegram — ставить ничего не нужно.`,
    goal: 'Чтобы начать, два шага: подтвердить вход в боте Taskano в Telegram и открыть приложение — в нём все ваши дела.',
    howTitle: 'Как это устроено',
    how: [
      'Вам приходит одно дело за раз — с тем, что сделать, зачем и как понять, что готово.',
      'Сделали — нажали «Завершить». Непонятно — задали вопрос прямо в карточке, он попадёт тому, кто дело поставил.',
      'Дела приходят на вашем языке — его вы выберете при входе.',
    ],
    steps: [
      ['Подтвердите вход в боте', 'Кнопка ниже откроет чат с ботом Taskano в Telegram. Нажмите «Старт» внизу экрана, потом «Да, это я». Бот спросит язык, часовой пояс и согласие на обработку данных — это минута.'],
      ['Откройте приложение', 'Сразу после входа бот пришлёт кнопку «Открыть приложение» — нажмите её. Потом приложение открывается кнопкой «Войти в приложение» слева от поля ввода в чате с ботом.'],
      ['Вынесите его на экран телефона', 'В приложении нажмите «…» в правом верхнем углу и выберите «На экран „Домой“» — значок Taskano встанет рядом с остальными приложениями. Одинаково на iPhone и Android.'],
    ],
    appHint: 'Такого пункта в меню нет — значит значок уже стоит или ваш Telegram так пока не умеет: помогает обновление приложения.',
    open: 'Шаг 1: открыть бота в Telegram',
    outro: 'Вы видите только свои дела. Чужие — нет, даже в той же компании.',
    outroManager: 'Вас зовут управлять: вам будут видны дела всей компании, а не только свои.',
  },
  en: {
    subject: (inviter, org) => `${inviter} invites you to work in “${org}”`,
    hello: (name) => `Hello ${name},`,
    lead: (inviter, org) => `${inviter} invites you to the company “${org}” in Taskano. You will work in Telegram — nothing to install.`,
    goal: 'To start, two steps: confirm your sign-in in the Taskano bot in Telegram and open the app — all your tasks are there.',
    howTitle: 'How it works',
    how: [
      'One task at a time — with what to do, why, and how to tell it is done.',
      'Done — press “Finish”. Not clear — ask right on the card, and the question reaches whoever set the task.',
      'Tasks come in your own language — you pick it when you sign in.',
    ],
    steps: [
      ['Confirm your sign-in in the bot', 'The button below opens a chat with the Taskano bot in Telegram. Press “Start” at the bottom of the screen, then “Yes, that\'s me”. The bot will ask your language, time zone and consent to data processing — about a minute.'],
      ['Open the app', 'Right after you sign in, the bot sends an “Open app” button — press it. After that, the app opens with the “Open app” button left of the input field in the chat with the bot.'],
      ['Put it on your phone screen', 'In the app open the “…” menu in the top right corner and choose “Add to Home Screen” — a Taskano icon appears next to your other apps. The same on iPhone and Android.'],
    ],
    appHint: 'No such menu item — the icon is already there, or your Telegram cannot do it yet: updating the app usually helps.',
    open: 'Step 1: open the bot in Telegram',
    outro: 'You only see your own tasks. Other people’s stay theirs, even in the same company.',
    outroManager: 'You are invited to manage: you will see the tasks of the whole company, not only your own.',
  },
  tr: {
    subject: (inviter, org) => `${inviter} sizi “${org}” şirketinde çalışmaya çağırıyor`,
    hello: (name) => `Merhaba ${name},`,
    lead: (inviter, org) => `${inviter} sizi Taskano’da “${org}” şirketine davet ediyor. Çalışma Telegram’da olacak — hiçbir şey kurmanız gerekmiyor.`,
    goal: 'Başlamak için iki adım: Telegram’daki Taskano botunda girişinizi onaylayın ve uygulamayı açın — tüm işleriniz orada.',
    howTitle: 'Nasıl işliyor',
    how: [
      'Size tek seferde bir iş gelir — ne yapılacağı, neden ve neyin bitmiş sayıldığı ile birlikte.',
      'Bitirdiniz — “Tamamla” düğmesi. Anlaşılmadı — kartın üzerinden sorun, soru işi veren kişiye ulaşır.',
      'İşler kendi dilinizde gelir — dili girişte siz seçersiniz.',
    ],
    steps: [
      ['Botta girişinizi onaylayın', 'Aşağıdaki düğme Telegram’da Taskano botuyla sohbeti açar. Ekranın altındaki “Başlat”a, ardından “Evet, benim”e basın. Bot dilinizi, saat diliminizi ve verilerinizin işlenmesine onayınızı sorar — bir dakika sürer.'],
      ['Uygulamayı açın', 'Girişten hemen sonra bot “Uygulamayı aç” düğmesini gönderir — ona basın. Sonra uygulama, bot sohbetinde yazı alanının solundaki “Uygulamayı aç” düğmesiyle açılır.'],
      ['Ana ekrana ekleyin', 'Uygulamada sağ üstteki “…” menüsünü açın ve “Ana Ekrana Ekle” seçeneğini seçin — diğer uygulamaların yanında Taskano simgesi belirir. iPhone’da ve Android’de aynı.'],
    ],
    appHint: 'Menüde böyle bir seçenek yoksa simge zaten duruyordur ya da Telegram’ınız bunu henüz yapamıyordur: uygulamayı güncellemek genelde yeter.',
    open: '1. adım: botu Telegram’da açın',
    outro: 'Yalnızca kendi işlerinizi görürsünüz. Başkalarınınki aynı şirkette bile size görünmez.',
    outroManager: 'Yönetmek için davet ediliyorsunuz: yalnızca kendi işlerinizi değil, tüm şirketin işlerini göreceksiniz.',
  },
  vi: {
    subject: (inviter, org) => `${inviter} mời bạn làm việc tại “${org}”`,
    hello: (name) => `Chào ${name},`,
    lead: (inviter, org) => `${inviter} mời bạn vào công ty “${org}” trên Taskano. Bạn sẽ làm việc trong Telegram — không cần cài gì cả.`,
    goal: 'Để bắt đầu, chỉ cần hai bước: xác nhận đăng nhập trong bot Taskano trên Telegram và mở ứng dụng — mọi việc của bạn đều ở đó.',
    howTitle: 'Cách hoạt động',
    how: [
      'Mỗi lần bạn nhận một việc — kèm việc phải làm, để làm gì và thế nào là xong.',
      'Xong rồi — bấm “Hoàn tất”. Chưa rõ — hỏi ngay trên thẻ việc, câu hỏi sẽ đến người giao việc.',
      'Việc đến bằng tiếng của bạn — bạn chọn ngôn ngữ khi đăng nhập.',
    ],
    steps: [
      ['Xác nhận đăng nhập trong bot', 'Nút bên dưới mở cuộc trò chuyện với bot Taskano trên Telegram. Bấm “Bắt đầu” ở cuối màn hình, rồi bấm “Đúng, là tôi”. Bot sẽ hỏi ngôn ngữ, múi giờ và sự đồng ý xử lý dữ liệu — khoảng một phút.'],
      ['Mở ứng dụng', 'Ngay sau khi đăng nhập, bot sẽ gửi nút “Mở ứng dụng” — hãy bấm vào. Sau đó, ứng dụng mở bằng nút “Mở ứng dụng” bên trái ô nhập trong cuộc trò chuyện với bot.'],
      ['Thêm vào màn hình chính', 'Trong ứng dụng mở menu “…” ở góc trên bên phải và chọn “Thêm vào màn hình chính” — biểu tượng Taskano xuất hiện cạnh các ứng dụng khác. Giống nhau trên iPhone và Android.'],
    ],
    appHint: 'Không thấy mục đó trong menu — có thể biểu tượng đã có sẵn, hoặc Telegram của bạn chưa hỗ trợ: cập nhật ứng dụng thường là đủ.',
    open: 'Bước 1: mở bot trong Telegram',
    outro: 'Bạn chỉ thấy việc của mình. Việc của người khác vẫn là của họ, kể cả trong cùng công ty.',
    outroManager: 'Bạn được mời để quản lý: bạn sẽ thấy việc của cả công ty, không chỉ việc của mình.',
  },
};

/**
 * Шаг про значок приложения на экране телефона с оговоркой под ним — общий с письмом про приложение
 * (open-app.ts): одна инструкция, одними словами, в обоих письмах.
 */
export function homeScreenStep(lang: string): { step: [string, string]; hint: string } {
  const t = T[lang] ?? T.en!;
  return { step: t.steps[2]!, hint: t.appHint };
}

const INK = '#1A1F36';
const MUTED = '#5A6078';
const PAPER = '#F2F4F6';
const LINE = '#D9DDE5';
const ACCENT = '#2F45E8';
// Кавычки внутри — только одинарные: значение уходит в атрибут style="…".
const SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

const esc = (s: string): string => s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);

export function invitationMail(to: string, info: InvitationInfo, lang: string): Mail {
  const t = T[lang] ?? T.en!;
  const name = info.personName?.trim();
  // Управляющему видны чужие дела — ему нельзя обещать обратное (спека roles-and-rights).
  const outro = info.role === 'owner' || info.role === 'admin' ? t.outroManager : t.outro;

  const text = [
    ...(name ? [t.hello(name), ''] : []),
    t.lead(info.inviterName, info.orgName),
    t.goal,
    '',
    `${t.howTitle}:`,
    ...t.how.map((h) => `— ${h}`),
    '',
    ...t.steps.map(([title, body], i) => `${i + 1}. ${title}. ${body}`),
    '',
    info.link,
    '',
    outro,
  ].join('\n');

  const html = `<!doctype html>
<html lang="${esc(lang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>${esc(t.subject(info.inviterName, info.orgName))}</title>
<style>@media only screen and (max-width:480px){.card{padding:24px 20px !important}}</style></head>
<body style="margin:0;padding:0;background:${PAPER}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${PAPER}">
<tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:100%">

<tr><td style="padding:0 0 18px;font:600 15px/1 ${SANS};color:${INK};letter-spacing:-0.01em">Taskano</td></tr>

<tr><td class="card" style="background:#fff;border:1px solid ${LINE};border-radius:14px;padding:30px 32px 26px">

${name ? `<div style="font:400 15px/1.5 ${SANS};color:${MUTED};padding:0 0 6px">${esc(t.hello(name))}</div>` : ''}
<div style="font:600 21px/1.35 ${SANS};color:${INK};letter-spacing:-0.015em">${esc(t.lead(info.inviterName, info.orgName))}</div>
<div style="font:400 15px/1.55 ${SANS};color:${INK};padding:10px 0 0">${esc(t.goal)}</div>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:22px 0 4px">
<tr><td style="background:${PAPER};border-radius:10px;padding:16px 18px">
<div style="font:600 11px/1 ${SANS};color:${MUTED};letter-spacing:0.08em;text-transform:uppercase;padding:0 0 10px">${esc(t.howTitle)}</div>
${t.how.map((h) => `<div style="font:400 15px/1.55 ${SANS};color:${INK};padding:0 0 7px">${esc(h)}</div>`).join('')}
</td></tr></table>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:22px 0 0">
${t.steps.map(([title, body], i) => `<tr><td style="padding:0 0 16px">
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
<a href="${esc(info.link)}" style="display:inline-block;padding:13px 24px;font:600 15px/1 ${SANS};color:#fff;text-decoration:none">${esc(t.open)} →</a>
</td></tr></table>

<div style="font:400 13px/1.5 ${SANS};color:${MUTED};padding:16px 0 0">${esc(t.appHint)}</div>
</td></tr>

<tr><td style="padding:16px 4px 0;font:400 13px/1.5 ${SANS};color:${MUTED}">${esc(outro)}</td></tr>

</table></td></tr></table></body></html>`;

  return { to, subject: t.subject(info.inviterName, info.orgName), text, html };
}
