import type { Mail } from '../send.js';

const T: Record<string, { subject: string; body: (code: string) => string }> = {
  ru: { subject: 'Код входа в Taskano', body: (c) => `Ваш код входа: ${c}\nОн действует 10 минут. Если вы не входили в Taskano, просто удалите это письмо.` },
  tr: { subject: 'Taskano giriş kodu', body: (c) => `Giriş kodunuz: ${c}\nKod 10 dakika geçerlidir. Taskano'ya giriş yapmadıysanız bu e-postayı silebilirsiniz.` },
  vi: { subject: 'Mã đăng nhập Taskano', body: (c) => `Mã đăng nhập của bạn: ${c}\nMã có hiệu lực trong 10 phút. Nếu bạn không đăng nhập Taskano, hãy bỏ qua email này.` },
  en: { subject: 'Your Taskano sign-in code', body: (c) => `Your sign-in code: ${c}\nIt is valid for 10 minutes. If you did not try to sign in to Taskano, you can ignore this email.` },
};

const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);

export function loginCodeMail(to: string, code: string, lang: string): Mail {
  const t = T[lang] ?? T.en!;
  const text = t.body(code);
  const html = `<div style="font-family:system-ui,sans-serif;font-size:16px;line-height:1.5">${text.split('\n').map((l) => `<p>${esc(l).replace(code, `<b style="font-size:28px;letter-spacing:4px">${code}</b>`)}</p>`).join('')}</div>`;
  return { to, subject: t.subject, text, html };
}
