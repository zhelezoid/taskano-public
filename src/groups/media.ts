import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import sharp from 'sharp';
import type { Db } from '../db/pool.js';
import { env } from '../config/env.js';

// Изображения из групп (спека group-intake, «Приём сообщений»): скачать через getFile, повернуть по
// EXIF, снять все метаданные (геометка), уменьшить до 1568 px по длинной стороне (стандарт Claude
// vision), JPEG q=85. Дедупликация по file_unique_id (до скачивания) и по sha256 результата.

export const MEDIA_TTL_MS = 30 * 86400000;
const MAX_SIDE = 1568;
export const MAX_TELEGRAM_FILE_BYTES = 20 * 1024 * 1024;   // предел облачного Bot API на скачивание

type FetchFn = (url: string) => Promise<Response>;
let fetchImpl: FetchFn = (url) => fetch(url);

/** Подмена сети Telegram в тестах (и getFile, и само скачивание идут через неё). */
export function setMediaFetchForTests(fn: FetchFn | undefined): void {
  fetchImpl = fn ?? ((url) => fetch(url));
}

export function mediaPath(relPath: string): string {
  return join(resolve(env.mediaDir), relPath);
}

/** getFile → https://api.telegram.org/file/bot<token>/<file_path>. Любой сбой (протух file_id, > 20 МБ) — исключение. */
export async function downloadTelegramFile(fileId: string): Promise<Buffer> {
  const token = env.telegramBotToken;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN не задан — скачать файл нельзя');
  const meta = await fetchImpl(`https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`);
  const body = (await meta.json()) as { ok: boolean; result?: { file_path?: string; file_size?: number }; description?: string };
  if (!body.ok || !body.result?.file_path) throw new Error(`getFile: ${body.description ?? 'нет file_path'}`);
  if ((body.result.file_size ?? 0) > MAX_TELEGRAM_FILE_BYTES) throw new Error('getFile: файл больше 20 МБ');
  const file = await fetchImpl(`https://api.telegram.org/file/bot${token}/${body.result.file_path}`);
  if (!file.ok) throw new Error(`скачивание файла: HTTP ${file.status}`);
  return Buffer.from(await file.arrayBuffer());
}

export interface CleanImage { data: Buffer; width: number; height: number; sha256: string }

/**
 * Что разбираем. Фото из Telegram приходят JPEG, остальное — то, что люди шлют скриншотами. Прочие
 * декодеры libvips (SVG, TIFF, HEIF, GIF…) — лишняя поверхность для присланного посторонним файла:
 * его разбор идёт в процессе web, и уязвимость декодера становится нашей (аудит безопасности).
 */
const IMAGE_FORMATS = new Set(['jpeg', 'png', 'webp']);

/**
 * Предел пикселей на входе. Файл в пару мегабайт может объявить картинку в сотни мегапикселей, и
 * распаковка съела бы память процесса. 50 Мп — с запасом больше любой камеры телефона.
 */
const MAX_INPUT_PIXELS = 50_000_000;

/** Вложение, которое не разбираем: не картинка, чужой формат или слишком большая. */
export class UnsupportedImageError extends Error {}

/**
 * Сигнатура файла до libvips: `metadata()` запускает декодер любого формата (SVG, TIFF, HEIF…) раньше
 * проверки IMAGE_FORMATS, а с загрузкой из Mini App такой файл приходит прямо по HTTP (ревью 07.10).
 */
function knownSignature(b: Buffer): boolean {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return true;                  // JPEG
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return true; // PNG
  return b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP'; // WebP
}

/**
 * Разбор картинок по одной на процесс. Предел в 50 Мп ограничивает пиксели, но не память: PNG одного
 * цвета на 160 КБ распаковывается в сотни мегабайт, и десяток таких параллельно убивал бы web (512 МБ)
 * вместе с вебхуком бота и /mcp (ревью безопасности 07.10, HIGH). Очередь держит пик на одной картинке.
 */
let decoding: Promise<unknown> = Promise.resolve();
function oneAtATime<T>(fn: () => Promise<T>): Promise<T> {
  const run = decoding.then(fn, fn);
  decoding = run.catch(() => undefined);
  return run;
}
sharp.cache(false);

/** Поворот по EXIF и перекодирование. withMetadata() не вызывается намеренно: без него sharp не
 *  переносит в результат ни EXIF, ни GPS, ни ICC/XMP — это и есть «удаление всех метаданных». */
export async function cleanImage(input: Buffer): Promise<CleanImage> {
  if (!knownSignature(input)) throw new UnsupportedImageError('неподдерживаемое изображение: не JPEG, PNG или WebP');
  return oneAtATime(() => decode(input));
}

async function decode(input: Buffer): Promise<CleanImage> {
  const image = sharp(input, { limitInputPixels: MAX_INPUT_PIXELS });
  // Формат — по содержимому, не по имени файла: заголовок читается без распаковки изображения.
  const meta = await image.metadata().catch(() => null);
  if (!meta?.format || !IMAGE_FORMATS.has(meta.format)) {
    throw new UnsupportedImageError(`неподдерживаемое изображение: ${meta?.format ?? 'не распознано'}`);
  }
  if ((meta.width ?? 0) * (meta.height ?? 0) > MAX_INPUT_PIXELS) {
    throw new UnsupportedImageError(`изображение больше ${MAX_INPUT_PIXELS} пикселей: ${meta.width}×${meta.height}`);
  }
  const { data, info } = await image
    .rotate()
    .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, sha256: createHash('sha256').update(data).digest('hex') };
}

export async function findMediaByUniqueId(db: Db, fileUniqueId: string): Promise<string | null> {
  const r = await db.query('select id from media where file_unique_id = $1 limit 1', [fileUniqueId]);
  return r.rows[0]?.id ?? null;
}

/**
 * Сохранить очищенное изображение организации (вызывается внутри withOrg). Тот же sha256 уже есть —
 * возвращается существующая запись, файл не пишется второй раз. Файл пишется через временное имя и
 * rename — читатель не увидит недописанный JPEG.
 */
export async function storeImage(
  db: Db, orgId: string, img: CleanImage, opts: { fileUniqueId: string | null; sourceMessageId: string | null; now: Date },
): Promise<string> {
  const existing = await db.query('select id from media where sha256 = $1', [img.sha256]);
  if (existing.rowCount) return existing.rows[0].id as string;

  const rel = `${orgId}/${img.sha256}.jpg`;
  const abs = mediaPath(rel);
  await mkdir(dirname(abs), { recursive: true });
  const tmp = `${abs}.${randomUUID()}.tmp`;
  await writeFile(tmp, img.data);
  await rename(tmp, abs);

  const r = await db.query(
    `insert into media(org_id, sha256, file_unique_id, path, width, height, bytes, source_message_id, created_at, expires_at)
     values (current_setting('app.org_id')::uuid, $1, $2, $3, $4, $5, $6, $7, $8, $9)
     on conflict (org_id, sha256) do nothing
     returning id`,
    [img.sha256, opts.fileUniqueId, rel, img.width, img.height, img.data.length, opts.sourceMessageId, opts.now,
      new Date(opts.now.getTime() + MEDIA_TTL_MS)],
  );
  if (r.rowCount) return r.rows[0].id as string;
  return (await db.query('select id from media where sha256 = $1', [img.sha256])).rows[0].id as string;
}

export async function readMediaFile(relPath: string): Promise<Buffer> {
  return readFile(mediaPath(relPath));
}

export async function removeMediaFile(relPath: string): Promise<void> {
  await rm(mediaPath(relPath), { force: true });
}
