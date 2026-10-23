import { BlockList, isIP } from 'node:net';
import type { RequestHandler } from 'express';
import { ipKeyGenerator } from 'express-rate-limit';

// Простой ограничитель в памяти процесса: web один, этого достаточно для пилота.
// Ключ по умолчанию — адрес, но у Mini App он общий на всех клиентов Telegram, поэтому там
// передают `key` и считают по человеку: иначе один торопливый человек закрывал бы вход остальным.

/**
 * Диапазоны Cloudflare — официальный список https://www.cloudflare.com/ips-v4 и
 * https://www.cloudflare.com/ips-v6, снят 2026-10-01. Меняется редко; Cloudflare объявляет смену
 * заранее. Устаревший список отказывает в безопасную сторону: запрос с нового узла считается по
 * адресу узла, а не по заголовку.
 */
const CLOUDFLARE_V4 = [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18', '108.162.192.0/18',
  '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13',
  '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
];
const CLOUDFLARE_V6 = [
  '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32',
];

const cloudflare = new BlockList();
for (const range of CLOUDFLARE_V4) { const [net, bits] = range.split('/'); cloudflare.addSubnet(net!, Number(bits), 'ipv4'); }
for (const range of CLOUDFLARE_V6) { const [net, bits] = range.split('/'); cloudflare.addSubnet(net!, Number(bits), 'ipv6'); }

/** Адрес узла Cloudflare? IPv4 в записи IPv6 (`::ffff:1.2.3.4`) — тот же IPv4. */
export function isCloudflare(ip: string | undefined): boolean {
  if (!ip) return false;
  const v4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)?.[1];
  if (v4) return cloudflare.check(v4, 'ipv4');
  const family = isIP(ip);
  return family === 4 ? cloudflare.check(ip, 'ipv4') : family === 6 ? cloudflare.check(ip, 'ipv6') : false;
}

/**
 * Адрес клиента. taskano.app стоит за Cloudflare, и `req.ip` за ним — адрес узла Cloudflare, общий
 * для многих людей: потолок по нему давал постороннему закрыть вход всем, кто пришёл через тот же
 * узел (ревью диффа demo-access). Поэтому за Cloudflare верим `CF-Connecting-IP` — но только если
 * запрос и правда пришёл от Cloudflare: сервер доступен и напрямую, и заголовок, выставленный самим
 * клиентом, давал бы новый счётчик на каждый запрос — то есть обход всех потолков (аудит безопасности).
 * `req.ip` при `trust proxy 1` — адрес, с которого соединились с nginx (последний в X-Forwarded-For).
 */
export function clientIp(req: Parameters<RequestHandler>[0]): string {
  const cf = req.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && isIP(cf.trim()) && isCloudflare(req.ip)) return cf.trim();
  return req.ip || 'unknown';
}

/**
 * Ключ потолка по адресу клиента. IPv6 — по сети /56, как у express-rate-limit: провайдер выдаёт
 * человеку целую сеть, и счёт по /128 давал бы новый счётчик на каждый адрес из неё.
 */
export function clientKey(req: Parameters<RequestHandler>[0]): string {
  return ipKeyGenerator(clientIp(req));
}

export function rateLimit(opts: { windowMs: number; max: number; key?: (req: Parameters<RequestHandler>[0]) => string }): RequestHandler {
  const hits = new Map<string, { count: number; reset: number }>();
  return (req, res, next) => {
    const now = Date.now();
    const key = opts.key ? opts.key(req) : clientKey(req);
    let h = hits.get(key);
    if (!h || h.reset <= now) { h = { count: 0, reset: now + opts.windowMs }; hits.set(key, h); }
    h.count++;
    if (hits.size > 10_000) for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
    if (h.count > opts.max) { res.status(429).set('Retry-After', String(Math.ceil((h.reset - now) / 1000))).send('Too many requests'); return; }
    next();
  };
}

/**
 * Потолок неудачных попыток по адресу: подбор токена упирается в 429, а адрес, уже упёршийся, до
 * конца окна в базу не ходит вовсе. Удачные запросы сюда не попадают — владелец с настоящим токеном
 * за тем же адресом продолжает работать.
 */
export function failureCeiling(opts: { windowMs: number; max: number }): { blocked: (req: Parameters<RequestHandler>[0]) => boolean; fail: (req: Parameters<RequestHandler>[0]) => void } {
  const failed = new Map<string, { n: number; until: number }>();
  return {
    blocked(req) {
      const f = failed.get(clientKey(req));
      return !!f && f.until > Date.now() && f.n >= opts.max;
    },
    fail(req) {
      const now = Date.now();
      const key = clientKey(req);
      const f = failed.get(key);
      const cur = f && f.until > now ? f : { n: 0, until: now + opts.windowMs };
      cur.n += 1;
      failed.set(key, cur);
      if (failed.size > 10_000) for (const [k, v] of failed) if (v.until <= now) failed.delete(k);
    },
  };
}
