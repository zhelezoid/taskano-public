import { Resend } from 'resend';
import { demoLoginEmail, env } from '../config/env.js';
import { logger } from '../log.js';

// Транспорт почты. Шаблоны писем — src/email/templates. Без RESEND_API_KEY (разработка, тесты)
// письма не уходят, а складываются в outbox — тесты читают коды оттуда.

export interface Mail { to: string; subject: string; html: string; text: string }

export const outbox: Mail[] = [];
const OUTBOX_LIMIT = 1000;
let client: Resend | undefined;

/** Домен вымышленных людей демо-компании (спека demo-access): у него нет почты. */
export const DEMO_PEOPLE_DOMAIN = 'demo.taskano.app';

/** Письма демо-компании не уходят: вымышленным адресам — отказы, а они бьют репутацию домена отправки. */
function isDemoAddress(to: string): boolean {
  const addr = to.trim().toLowerCase();
  return addr.endsWith(`@${DEMO_PEOPLE_DOMAIN}`) || addr === demoLoginEmail();
}

export async function sendEmail(mail: Mail): Promise<void> {
  if (isDemoAddress(mail.to)) {
    logger.info({ to: mail.to, subject: mail.subject }, 'email suppressed (demo)');
    return;
  }
  if (!env.resendApiKey) {
    // Без ключа (разработка, тесты) письма копятся здесь; на бою без ключа очередь не растёт без
    // предела — держим последние OUTBOX_LIMIT (аудит 07.10).
    outbox.push(mail);
    if (outbox.length > OUTBOX_LIMIT) outbox.splice(0, outbox.length - OUTBOX_LIMIT);
    if (!env.isProduction) logger.info({ to: mail.to, subject: mail.subject }, 'email (dev outbox)');
    return;
  }
  client ??= new Resend(env.resendApiKey);
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const { error } = await client.emails.send({ from: env.emailFrom, to: mail.to, subject: mail.subject, html: mail.html, text: mail.text });
    if (!error) return;
    lastError = error;
    await new Promise((r) => setTimeout(r, 500 * attempt));
  }
  throw new Error(`Resend: письмо не отправлено: ${JSON.stringify(lastError)}`);
}
