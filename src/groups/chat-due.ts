// Срок из рабочего чата (спека self-set-due) — процедурные проверки сервера. Модель
// решает, что в сообщении назван срок; сервер проверяет, что дата в тексте вообще есть и что её
// назвал тот, кто вправе. Смысл сервер не оценивает — только то, что можно проверить без модели.

const L = '(?<!\\p{L})';          // начало слова для любых алфавитов: \b в JS знает только латиницу

const MONTHS = [
  // ru — по основе: «октября», «окт.», «в октябре»
  'янв', 'фев', 'мар', 'апр', 'ма[йяе]', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек',
  // en
  'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec',
  // tr
  'ocak', 'şubat', 'mart', 'nisan', 'mayıs', 'haziran', 'temmuz', 'ağustos', 'eylül', 'ekim', 'kasım', 'aralık',
];

const WEEKDAYS = [
  'понедельник', 'вторник', 'сред[ауые]', 'четверг', 'пятниц', 'суббот', 'воскресень',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'pazartesi', 'salı', 'çarşamba', 'perşembe', 'cuma', 'cumartesi', 'pazar',
  'thứ hai', 'thứ ba', 'thứ tư', 'thứ năm', 'thứ sáu', 'thứ bảy', 'chủ nhật',
];

const RELATIVE = [
  'сегодня', 'завтра', 'послезавтра', 'через (\\d+|день|неделю|месяц|пару)', 'на (этой|следующей) неделе', 'к концу (дня|недели|месяца)',
  'today', 'tonight', 'tomorrow', 'day after tomorrow', 'in (\\d+|a|one|two|three) (days?|weeks?)', '(this|next) week', 'end of (the )?(day|week|month)',
  'bugün', 'yarın', 'öbür gün', 'haftaya', '\\d+ (gün|hafta) sonra', '(bu|gelecek) hafta', 'hafta sonuna',
  'hôm nay', 'ngày mai', 'ngày kia', 'tuần (này|sau|tới)', '\\d+ (ngày|tuần) nữa', 'cuối tuần',
];

const DATE_PATTERNS: RegExp[] = [
  /\d{4}-\d{2}-\d{2}/u,                                       // 2026-10-05
  /(?<!\d)\d{1,2}[./]\d{1,2}(?!\d)/u,                         // 5.10, 05/10
  new RegExp(`(?<!\\d)\\d{1,2}(-?(го|е|ое|му|th|st|nd|rd|'?[ıiuü]))?\\s*${L}(${MONTHS.join('|')})`, 'iu'),   // 5 октября, 5th oct, 5 ekim
  new RegExp(`${L}(${MONTHS.join('|')})\\p{L}*\\.?\\s+\\d{1,2}(?!\\d)`, 'iu'),                            // October 5
  /ngày\s+\d{1,2}|tháng\s+\d{1,2}/iu,                          // ngày 5, tháng 10
  new RegExp(`${L}(к|до|by|until|before)\\s+\\d{1,2}(-?(го|му|е|th|st|nd|rd))?(?!\\d)`, 'iu'),              // к 5-му, by the 5th
  new RegExp(`${L}(${WEEKDAYS.join('|')})`, 'iu'),
  new RegExp(`${L}(${RELATIVE.join('|')})`, 'iu'),
];

/** Есть ли в тексте указание на дату: число с месяцем, день недели, «завтра», «через неделю»… */
export function mentionsDate(text: string): boolean {
  const s = text.normalize('NFC');
  return DATE_PATTERNS.some((re) => re.test(s));
}

/** Упоминает ли сообщение дело прямо: `#номер` или обозначение («NOR-001», «nor-1»). */
export function mentionsTask(text: string, shortId: string | number, key: string | null): boolean {
  if (new RegExp(`#${shortId}(?!\\d)`).test(text)) return true;
  const m = key ? /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/.exec(key) : null;
  if (!m) return false;
  return new RegExp(`(?<![A-Za-z0-9])${m[1]}-0*${Number(m[2])}(?!\\d)`, 'i').test(text);
}

export interface ChatDueAuthor {
  author: string;
  assignee: string;
  taskAuthor: string;
  /** Автор сообщения — owner/admin организации. */
  authorIsManager: boolean;
  /** Сообщение прямо указывает на дело: упоминает его или отвечает на сообщение, привязанное к нему. */
  pointsAtTask: boolean;
}

/**
 * Вправе ли автор сообщения назвать срок делу из чата. Исполнитель и автор дела — да. Owner/admin — только
 * когда сообщение прямо указывает на это дело: иначе его «сделаем к пятнице» о чём-то своём модель могла
 * приписать чужому делу. Посторонний — никогда.
 */
export function mayNameDueInChat(a: ChatDueAuthor): boolean {
  if (a.author === a.assignee || a.author === a.taskAuthor) return true;
  return a.authorIsManager && a.pointsAtTask;
}
