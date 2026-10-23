// Разбор текста дела для карточки (спека miniapp-task-card).
//
// Текст в карточку приходит от людей и от агентов: «зачем», критерий готовности, «как делать».
// Писали его как обычный текст — с пустыми строками между абзацами, перечислениями и ссылками. В
// HTML всё это схлопывается в одну простыню: переносы становятся пробелами, список неотличим от
// сплошного текста, ссылку нельзя нажать — её приходится выделять и копировать.
//
// Поэтому текст разбирается здесь: абзацы, перечисления и ссылки. Разметки в нём нет и не будет —
// ни Markdown, ни HTML: карточку пишет агент, и разбирать его вывод как разметку значит пускать в
// приложение то, чего человек не писал. Ссылка распознаётся только по схеме http(s).

export interface TextLink {
  kind: 'link';
  text: string;
  url: string;
}

export interface TextPlain {
  kind: 'text';
  text: string;
}

export type Piece = TextPlain | TextLink;

export interface Paragraph {
  kind: 'paragraph';
  /** Строки абзаца: перенос внутри абзаца человек поставил намеренно, он сохраняется. */
  lines: Piece[][];
}

export interface ListBlock {
  kind: 'list';
  ordered: boolean;
  items: Piece[][];
}

export type Block = Paragraph | ListBlock;

/** Маркер перечисления в начале строки: «- », «— », «• », «* » либо «1. » / «2) ». */
const BULLET_RE = /^\s*(?:[-—•*]|\d{1,3}[.)])\s+/;
// Вид маркера уже подтверждённой строки списка: нумерованный или простой. Пробел после номера здесь
// не требуется — пункт может быть и пустым.
const ORDERED_RE = /^\s*\d{1,3}[.)]/;

/** Строка из одного маркера и ничего больше: «-», «2.». Пункт без текста бывает в середине
 *  перечисления — он его не рвёт. Но сам по себе такой знак списком не начинается: одинокая «-»
 *  между абзацами — отбивка, а не пункт. */
const EMPTY_BULLET_RE = /^\s*(?:[-—•*]|\d{1,3}[.)])\s*$/;

// Хвостовая пунктуация в ссылку не входит: «смотри https://example.com/x, там» — запятая не часть
// адреса. Скобку отрезаем только непарную: в адресах она встречается (Википедия).
const URL_RE = /https?:\/\/[^\s<>«»"']+/gi;

function trimUrl(raw: string): string {
  let url = raw;
  while (url.length > 0) {
    const last = url[url.length - 1]!;
    if ('.,;:!?»"\''.includes(last)) { url = url.slice(0, -1); continue; }
    if (last === ')' && (url.match(/\(/g)?.length ?? 0) < (url.match(/\)/g)?.length ?? 0)) { url = url.slice(0, -1); continue; }
    break;
  }
  return url;
}

/** Строка → куски: обычный текст и ссылки, в порядке следования. */
export function splitLinks(line: string): Piece[] {
  const pieces: Piece[] = [];
  let last = 0;
  for (const m of line.matchAll(URL_RE)) {
    const raw = m[0];
    const url = trimUrl(raw);
    const start = m.index!;
    if (start > last) pieces.push({ kind: 'text', text: line.slice(last, start) });
    pieces.push({ kind: 'link', text: url, url });
    last = start + url.length;
  }
  if (last < line.length) pieces.push({ kind: 'text', text: line.slice(last) });
  return pieces.length ? pieces : [{ kind: 'text', text: line }];
}

/**
 * Текст → блоки. Пустая строка разделяет абзацы; идущие подряд строки с маркером собираются в
 * перечисление. Нумерация перечисления своя — та, что в тексте, отбрасывается вместе с маркером:
 * иначе «1.» показалось бы дважды.
 */
export function parseRichText(text: string): Block[] {
  const blocks: Block[] = [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flushParagraph = (): void => {
    if (!paragraph.length) return;
    blocks.push({ kind: 'paragraph', lines: paragraph.map(splitLinks) });
    paragraph = [];
  };
  const flushList = (): void => {
    if (!list) return;
    blocks.push({ kind: 'list', ordered: list.ordered, items: list.items.map(splitLinks) });
    list = null;
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) { flushParagraph(); flushList(); continue; }
    // Пустой пункт продолжает начатое перечисление, но не начинает новое.
    const bullet = BULLET_RE.exec(line) ?? (list && EMPTY_BULLET_RE.test(line) ? EMPTY_BULLET_RE.exec(line) : null);
    if (bullet) {
      const ordered = ORDERED_RE.test(line);
      flushParagraph();
      // Смена вида маркера начинает новое перечисление: нумерованное и маркированное — разные списки.
      if (list && list.ordered !== ordered) flushList();
      list ??= { ordered, items: [] };
      list.items.push(line.slice(bullet[0].length));
      continue;
    }
    flushList();
    paragraph.push(line.trim());
  }
  flushParagraph();
  flushList();
  return blocks;
}
