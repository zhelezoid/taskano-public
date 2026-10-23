// Сообщения бота из уведомлений и дайджест уходят с `parse_mode: 'HTML'` (спека bot-messages).
// Разметку ставит только код; всё, что пришло из данных, — названия, имена, реплики людей, переводы, —
// проходит через `esc`. Сырой `<` в названии иначе ломал бы разметку, и Telegram отвечал бы 400 —
// сообщение терялось бы целиком.

/** Предел длины текста сообщения в Telegram. */
export const TELEGRAM_TEXT_LIMIT = 4096;

/** Экранирование для parse_mode HTML: Telegram требует ровно эти три символа. */
export function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function bold(text: string): string {
  return `<b>${esc(text)}</b>`;
}

/** Обрезать простой (ещё не экранированный) текст — до экранирования, чтобы не разрезать `&amp;`. */
export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}
