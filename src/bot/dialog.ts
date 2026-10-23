import { withGlobal, type Db } from '../db/pool.js';

// Состояние диалога бота — таблица bot_dialogs (глобальный слой, без org): переживает рестарт
// (спека telegram-bot, edge cases). `user_key = 'tg:<telegram_user_id>'` — до привязки человека
// его ещё нет в users, поэтому ключ не по user_id.

export interface DialogState {
  state: string;
  data: Record<string, unknown>;
}

export const IDLE: DialogState = { state: 'idle', data: {} };

// Ключи данных, которые переживают смену состояния (счётчик «пишет на другом языке» и т.п.) —
// не относятся к конкретному шагу диалога, поэтому не стираются при переходе в новое состояние.
const STICKY_PREFIX = '_';

export function userKey(telegramUserId: number): string {
  return `tg:${telegramUserId}`;
}

export async function loadDialog(db: Db, key: string): Promise<DialogState & { updatedAt?: Date }> {
  const r = await db.query('select state, data, updated_at from bot_dialogs where user_key = $1', [key]);
  if (!r.rowCount) return { state: IDLE.state, data: {} };
  return {
    state: r.rows[0].state as string, data: (r.rows[0].data as Record<string, unknown>) ?? {},
    updatedAt: r.rows[0].updated_at as Date,
  };
}

/**
 * Строка диалога под замком до конца транзакции: чтение-изменение-запись списка ожиданий идёт
 * внутри неё. Без замка два быстрых нажатия читали один список и второе затирало первое.
 */
async function lockDialog(db: Db, key: string): Promise<void> {
  await db.query(
    `insert into bot_dialogs(user_key, state, data, updated_at) values ($1, 'idle', '{}', now()) on conflict (user_key) do nothing`, [key]);
  await db.query('select 1 from bot_dialogs where user_key = $1 for update', [key]);
}

export async function saveDialog(db: Db, key: string, next: DialogState, now: Date = new Date()): Promise<void> {
  const prev = await loadDialog(db, key);
  const sticky = Object.fromEntries(Object.entries(prev.data).filter(([k]) => k.startsWith(STICKY_PREFIX)));
  const data = { ...sticky, ...next.data };
  await db.query(
    `insert into bot_dialogs(user_key, state, data, updated_at) values ($1, $2, $3, $4)
     on conflict (user_key) do update set state = excluded.state, data = excluded.data, updated_at = excluded.updated_at`,
    [key, next.state, JSON.stringify(data), now],
  );
}

export async function clearDialog(db: Db, key: string, now: Date = new Date()): Promise<void> {
  await saveDialog(db, key, IDLE, now);
}

/** Обёртки поверх withGlobal — bot_dialogs вне слоя организации. */
export const dialogDb = <T>(fn: (db: Db) => Promise<T>): Promise<T> => withGlobal(fn);

export async function getSticky(db: Db, key: string, field: string): Promise<unknown> {
  const d = await loadDialog(db, key);
  return d.data[`${STICKY_PREFIX}${field}`];
}

export async function setSticky(db: Db, key: string, field: string, value: unknown, now: Date = new Date()): Promise<void> {
  const d = await loadDialog(db, key);
  await saveDialog(db, key, { state: d.state, data: { ...d.data, [`${STICKY_PREFIX}${field}`]: value } }, now);
}

// ---------------------------------------------------------------- ожидания ответа по делу

/**
 * Ожидание текста по делу: нажали «Вопрос», «Отказаться», «Результат»… на карточке и бот ждёт
 * ответа (спека multi-company-person, п.1). Их может быть несколько сразу — карточки разных дел и
 * разных компаний лежат в одном чате вперемешку, — и ответ по делу А не должен уйти делу Б. Живут
 * списком в той же строке `bot_dialogs` (липкое поле: переживает смену состояния другими диалогами),
 * а `state`/`data` строки — последнее нажатие, как и раньше.
 */
export interface TaskWait {
  state: string;
  data: Record<string, unknown>;
  /** Когда нажали: по нему «последнее нажатие» и окно «переспросить, к какому делу». */
  at: string;
}

const WAITS_FIELD = 'waits';
// Больше пяти начатых ответов разом человек не держит; старейший вытесняется, а не копится навсегда.
const MAX_WAITS = 5;

export async function loadWaits(db: Db, key: string): Promise<TaskWait[]> {
  const raw = await getSticky(db, key, WAITS_FIELD);
  return Array.isArray(raw) ? (raw as TaskWait[]).filter((w) => w && typeof w.state === 'string' && w.data) : [];
}

async function saveWaits(db: Db, key: string, waits: TaskWait[], current: DialogState, now: Date): Promise<void> {
  const d = await loadDialog(db, key);
  const sticky = Object.fromEntries(Object.entries(d.data).filter(([k]) => k.startsWith(STICKY_PREFIX)));
  await saveDialog(db, key, { state: current.state, data: { ...sticky, ...current.data, [`${STICKY_PREFIX}${WAITS_FIELD}`]: waits } }, now);
}

/** Начать (или переначать) ожидание ответа по делу `data.shortId`: оно становится последним нажатием. */
export async function pushWait(db: Db, key: string, state: string, data: Record<string, unknown>, now: Date = new Date()): Promise<void> {
  await lockDialog(db, key);
  const waits = (await loadWaits(db, key)).filter((w) => w.data.shortId !== data.shortId);
  waits.push({ state, data, at: now.toISOString() });
  await saveWaits(db, key, waits.slice(-MAX_WAITS), { state, data }, now);
}

/**
 * Ответ по делу получен или отменён: ожидание снимается, а последним нажатием снова становится
 * предыдущее ещё не отвеченное — следующий текст без reply уйдёт туда, а не пропадёт.
 */
export async function finishWait(db: Db, key: string, shortId: unknown, now: Date = new Date()): Promise<void> {
  await lockDialog(db, key);
  const waits = (await loadWaits(db, key)).filter((w) => w.data.shortId !== shortId);
  const last = waits.at(-1);
  await saveWaits(db, key, waits, last ? { state: last.state, data: last.data } : IDLE, now);
}

/** Непонятное текстовое сообщение, пока бот спрашивает «К какому делу?» — дождётся выбора дела. */
export interface HeldMessage {
  text: string;
  photoFileId?: string;
  documentFileId?: string;
  documentName?: string;
  // Фото к делу (спека task-photos): дедупликация до скачивания, альбом, изображение ли файл.
  photoUniqueId?: string;
  documentUniqueId?: string;
  documentMime?: string;
  documentSize?: number;
  mediaGroupId?: string;
}

export async function holdMessage(db: Db, key: string, msg: HeldMessage, now: Date = new Date()): Promise<void> {
  await lockDialog(db, key);
  await setSticky(db, key, 'held', msg, now);
}

/**
 * Забрать отложенное сообщение — один раз и одним запросом: два быстрых нажатия «К какому делу?»
 * не отправят его в два дела. Второе ждёт замка строки, а после него видит поле уже пустым.
 */
export async function takeHeldMessage(db: Db, key: string): Promise<HeldMessage | null> {
  const r = await db.query(
    `update bot_dialogs b set data = b.data - '${STICKY_PREFIX}held'
       from (select data->'${STICKY_PREFIX}held' as held from bot_dialogs where user_key = $1 for update) old
      where b.user_key = $1 and jsonb_typeof(old.held) = 'object'
      returning old.held`,
    [key]);
  return (r.rows[0]?.held as HeldMessage | undefined) ?? null;
}

// ---------------------------------------------------------------- пачки фото (спека task-photos)

/** Фото в Telegram: по `fileId` его скачивают, `uniqueId` — тот же файл под другим `fileId`. */
export interface PhotoRef { fileId: string; uniqueId?: string }

/**
 * Пачка фото — одно фото или альбом. Альбом Telegram присылает отдельными апдейтами с общим
 * `media_group_id`, иногда параллельно, а вопрос «К какому делу?» и подтверждение должны быть по
 * одному на альбом. Пачка помнит, к какому делу идут её фото (`shortId`), сколько прикреплено и где
 * подтверждение, а пока дело не выбрано — держит фото (`files`).
 */
export interface PhotoBatch {
  /** message_id первого фото: им пачка названа в кнопках «К какому делу прикрепить?». */
  key: string;
  mediaGroupId?: string;
  at: string;
  shortId?: string;
  files: PhotoRef[];
  count: number;
  confirmId?: number;
  /** Подтверждение уже отправляется — остальные фото только правят его число. */
  sending?: boolean;
  /** Пачке отказано (дел нет, дело закрыто): остальные фото альбома молча не принимаются. */
  closed?: boolean;
  /** Пачка — часть сдачи или вопроса: её фото дело не начинают, это решает само действие (спека auto-start). */
  withoutStart?: boolean;
}

const BATCHES_FIELD = 'photo_batches';
// Альбом приходит за секунды; через четверть часа его фото уже не догоняют.
const BATCH_TTL_MS = 15 * 60_000;
const MAX_BATCHES = 5;

async function withBatches<T>(db: Db, key: string, fn: (list: PhotoBatch[]) => T): Promise<T> {
  await lockDialog(db, key);
  const raw = await getSticky(db, key, BATCHES_FIELD);
  const now = Date.now();
  const list = (Array.isArray(raw) ? raw as PhotoBatch[] : []).filter((b) => b && now - Date.parse(b.at) <= BATCH_TTL_MS);
  const out = fn(list);
  await setSticky(db, key, BATCHES_FIELD, list.slice(-MAX_BATCHES));
  return out;
}

/** Ответ на фото альбома, у которого пачка уже есть: к какому делу, держать до выбора или не принимать. */
export type BatchJoin = { kind: 'attach'; batch: PhotoBatch } | { kind: 'held' } | { kind: 'closed' };

function joinInto(b: PhotoBatch, file: PhotoRef): BatchJoin {
  if (b.closed) return { kind: 'closed' };
  if (b.shortId) return { kind: 'attach', batch: { ...b } };
  b.files.push(file);
  return { kind: 'held' };
}

/** Фото альбома, чья пачка уже заведена; `null` — пачки нет (первое фото альбома или не альбом). */
export async function joinPhotoBatch(db: Db, key: string, mediaGroupId: string, file: PhotoRef): Promise<BatchJoin | null> {
  return withBatches(db, key, (list) => {
    const b = list.find((x) => x.mediaGroupId === mediaGroupId);
    return b ? joinInto(b, file) : null;
  });
}

/**
 * Завести пачку для первого фото. Сосед по альбому успел раньше — `created: false` и ответ, как у
 * `joinPhotoBatch`: проверка и запись идут под одним замком строки диалога.
 */
export async function openPhotoBatch(
  db: Db, key: string, init: { key: string; mediaGroupId?: string; shortId?: string; files: PhotoRef[]; withoutStart?: boolean }, file: PhotoRef,
): Promise<{ created: true } | ({ created: false } & BatchJoin)> {
  return withBatches(db, key, (list) => {
    const same = init.mediaGroupId ? list.find((x) => x.mediaGroupId === init.mediaGroupId) : undefined;
    if (same) return { created: false as const, ...joinInto(same, file) };
    list.push({
      key: init.key, mediaGroupId: init.mediaGroupId, at: new Date().toISOString(), shortId: init.shortId, files: init.files, count: 0,
      ...(init.withoutStart ? { withoutStart: true } : {}),
    });
    return { created: true as const };
  });
}

/** Выбор дела на «К какому делу прикрепить?»: забрать фото пачки один раз — второе нажатие получит `null`. */
export async function choosePhotoBatch(db: Db, key: string, batchKey: string, shortId: string): Promise<PhotoRef[] | null> {
  return withBatches(db, key, (list) => {
    const b = list.find((x) => x.key === batchKey);
    if (!b || b.closed || b.shortId) return null;
    const files = b.files;
    b.shortId = shortId;
    b.files = [];
    return files;
  });
}

/**
 * Прикреплено ещё `n`: новый счёт и где подтверждение. `send` — подтверждения ещё нет и его никто не
 * шлёт: отправить его выпало этому вызову (решается под замком, поэтому отправитель у альбома один).
 */
export async function countPhotoBatch(
  db: Db, key: string, batchKey: string, n: number,
): Promise<{ count: number; confirmId?: number; send: boolean }> {
  return withBatches(db, key, (list) => {
    const b = list.find((x) => x.key === batchKey);
    if (!b) return { count: n, send: true };
    b.count += n;
    if (b.confirmId === undefined && !b.sending) { b.sending = true; return { count: b.count, send: true }; }
    return { count: b.count, confirmId: b.confirmId, send: false };
  });
}

/** Подтверждение отправлено: запомнить его и вернуть счёт — соседи могли прикрепить своё, пока оно шло. */
export async function confirmPhotoBatch(db: Db, key: string, batchKey: string, confirmId: number): Promise<number> {
  return withBatches(db, key, (list) => {
    const b = list.find((x) => x.key === batchKey);
    if (!b) return 0;
    b.confirmId = confirmId;
    return b.count;
  });
}

/** Пачке отказано или её отменили: остальные фото альбома не принимаются, держать нечего. */
export async function closePhotoBatch(db: Db, key: string, batchKey: string): Promise<void> {
  await withBatches(db, key, (list) => {
    const b = list.find((x) => x.key === batchKey);
    if (b) { b.closed = true; b.files = []; }
  });
}
