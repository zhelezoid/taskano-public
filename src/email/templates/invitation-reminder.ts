import type { Mail } from '../send.js';

// Напоминание о неприянтом приглашении через 2 дня (спека step-lifecycle-and-queue, «Таймеры»).
// Прямой ссылки нет: токен приглашения хранится хэшем (invitations.token_hash), поэтому ведём
// человека назад к письму-приглашению или к боту по знакомой почте.

const T: Record<string, { subject: string; body: (bot: string) => string }> = {
  ru: {
    subject: 'Вас ждут в Taskano',
    body: (bot) => `Вам приходило приглашение в Taskano — пока не принято.\nОткройте письмо-приглашение и перейдите по ссылке, или напишите боту @${bot} и войдите по этой почте.`,
  },
  tr: {
    subject: 'Taskano\'da sizi bekliyoruz',
    body: (bot) => `Taskano'ya bir davet gönderilmişti — henüz kabul edilmedi.\nDavet e-postasını açıp bağlantıya tıklayın, ya da @${bot} botuna yazıp bu e-posta ile giriş yapın.`,
  },
  vi: {
    subject: 'Bạn được mời vào Taskano',
    body: (bot) => `Bạn đã nhận được lời mời vào Taskano — vẫn chưa được chấp nhận.\nMở email mời và nhấp vào liên kết, hoặc nhắn cho bot @${bot} và đăng nhập bằng email này.`,
  },
  en: {
    subject: 'You are invited to Taskano',
    body: (bot) => `You received an invitation to Taskano — it has not been accepted yet.\nOpen the invitation email and follow the link, or message @${bot} and sign in with this email.`,
  },
};

const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);

export function invitationReminderMail(to: string, lang: string | null | undefined, botUsername: string): Mail {
  const t = T[lang ?? ''] ?? T.en!;
  const text = t.body(botUsername);
  const html = `<div style="font-family:system-ui,sans-serif;font-size:16px;line-height:1.5">${text.split('\n').map((l) => `<p>${esc(l)}</p>`).join('')}</div>`;
  return { to, subject: t.subject, text, html };
}
