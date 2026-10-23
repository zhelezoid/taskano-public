import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';

export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
export const randomToken = (bytes = 32): string => randomBytes(bytes).toString('base64url');
export const sixDigitCode = (): string => String(randomInt(0, 1_000_000)).padStart(6, '0');

export function hmac(data: string): string {
  return createHmac('sha256', env.hmacSecret).update(data).digest('base64url');
}

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** AES-256-GCM для секретов в базе (токен /fire). Формат: iv.tag.data в base64url. */
export function encrypt(plain: string, aad = ''): string {
  const key = Buffer.from(env.encryptionKey, 'hex');
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  if (aad) c.setAAD(Buffer.from(aad));
  const data = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), data].map((b) => b.toString('base64url')).join('.');
}

/** aad привязывает шифртекст к строке (например, org_id): скопированный в чужую строку не расшифруется. */
export function decrypt(enc: string, aad = ''): string {
  const [iv, tag, data] = enc.split('.').map((s) => Buffer.from(s, 'base64url'));
  if (!tag || tag.length !== 16) throw new Error('decrypt: неверная длина тега');
  const d = createDecipheriv('aes-256-gcm', Buffer.from(env.encryptionKey, 'hex'), iv!, { authTagLength: 16 });
  if (aad) d.setAAD(Buffer.from(aad));
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data!), d.final()]).toString('utf8');
}
