
// Чистая логика заслона объявлений (спека announcements) — отдельно от вёрстки, чтобы её можно было
// проверить без браузера: очередь «по одному, старые первыми», когда заслон закрывает экран и когда
// нажимается OK.

// Без импорта из api.ts: тест подключает этот файл под настройками сервера, где нет окна Telegram.
/** Неподтверждённое объявление (спека announcements): заслон поверх любого экрана. `text` — уже на языке человека. */
export interface Announcement {
  id: string;
  org_id: string;
  from: string;
  /** Объявление отправил агент от имени `from`: заслон говорит об этом честно. */
  agent: string | null;
  text: string;
  translated: boolean;
  sent_at: string;
}

export interface GateState {
  items: Announcement[];
  lang: string;
  /** Сколько подтверждено из этой пачки: «2 из 3», а не вечное «1 из N». */
  done: number;
}

export const EMPTY_GATE: GateState = { items: [], lang: 'en', done: 0 };

/** Галочка снята, пока человек сам её не поставил: подтверждение — осознанное. */
export const INITIAL_CHECKED = false;

/** Свежий список с сервера. Пусто — пачка кончилась, счётчик «N из M» начинается заново. */
export function gateReplace(g: GateState, items: Announcement[], lang?: string): GateState {
  return { items, lang: lang ?? g.lang, done: items.length ? g.done : 0 };
}

/** Подтверждено (или сервер сказал, что объявления для человека нет): убрать из очереди. */
export function gateConfirmed(g: GateState, id: string): GateState {
  const items = g.items.filter((a) => a.id !== id);
  return items.length === g.items.length ? g : { ...g, items, done: g.done + 1 };
}

/** Объявление, которое закрывает экран сейчас: одно, самое старое. */
export function gateCurrent(g: GateState): Announcement | null {
  return g.items[0] ?? null;
}

/** Закрывает ли заслон экран (а значит, «Назад» Telegram под ним отключена). */
export function isBlocking(g: GateState): boolean {
  return gateCurrent(g) !== null;
}

/** OK нажимается только с галочкой и не во время отправки. */
export function canConfirm(checked: boolean, busy: boolean): boolean {
  return checked && !busy;
}

export function gateProgress(g: GateState): { position: number; total: number } {
  return { position: g.done + 1, total: g.done + g.items.length };
}
