// Кодирование callback_data ≤ 64 байт (спека telegram-bot, edge cases): короткие префиксы +
// short_id вместо uuid. Формат задачи — ровно как в спеке: `a:<действие>:<short_id>:<версия>`.

// myes/mno — ответ на «Похоже, готово — отметить?», gph — фото дела (спеки group-intake, task-photos),
// cm — «Написать»: реплика к делу (спека task-comments), ph — «📎 Прикрепить фото» (спека task-photos).
// stp — «Остановить»: пара к «Взял», дело возвращается в очередь (спека mini-app). Не путать с
// ts/te — это таймер учёта времени, который человек ведёт сам.
export type TaskAction = 'take' | 'stp' | 'done' | 'pp' | 'q' | 'u' | 'dec' | 'ts' | 'te' | 'at' | 'orig' | 'rat' | 'wf' | 'cancel' | 'myes' | 'mno' | 'gph' | 'cm' | 'ph';
const TASK_ACTIONS = new Set<TaskAction>(['take', 'stp', 'done', 'pp', 'q', 'u', 'dec', 'ts', 'te', 'at', 'orig', 'rat', 'wf', 'cancel', 'myes', 'mno', 'gph', 'cm', 'ph']);

export function encodeTask(action: TaskAction, shortId: string, version: number): string {
  return `a:${action}:${shortId}:${version}`;
}
export interface TaskCallback { action: TaskAction; shortId: string; version: number }
export function decodeTask(data: string): TaskCallback | null {
  const m = /^a:([a-z]+):(\d+):(\d+)$/.exec(data);
  if (!m || !TASK_ACTIONS.has(m[1] as TaskAction)) return null;
  return { action: m[1] as TaskAction, shortId: m[2]!, version: Number(m[3]) };
}

export type PostponeCode = 'tonight' | 'tomorrow' | 'dayafter' | 'week' | 'pick';
export function encodePostpone(code: PostponeCode, shortId: string, version: number): string {
  return `pp:${code}:${shortId}:${version}`;
}
export function decodePostpone(data: string): { code: PostponeCode; shortId: string; version: number } | null {
  const m = /^pp:(tonight|tomorrow|dayafter|week|pick):(\d+):(\d+)$/.exec(data);
  if (!m) return null;
  return { code: m[1] as PostponeCode, shortId: m[2]!, version: Number(m[3]) };
}

export type WaitAction = 'nochange' | 'arrived' | 'push1' | 'push3' | 'push1w' | 'stop';
export function encodeWait(action: WaitAction, shortId: string): string { return `wt:${action}:${shortId}`; }
export function decodeWait(data: string): { action: WaitAction; shortId: string } | null {
  const m = /^wt:(nochange|arrived|push1w|push1|push3|stop):(\d+)$/.exec(data);
  if (!m) return null;
  return { action: m[1] as WaitAction, shortId: m[2]! };
}

export type AnswerAction = 'understood' | 'more';
export function encodeAnswer(action: AnswerAction, shortId: string, version: number): string { return `aa:${action}:${shortId}:${version}`; }
export function decodeAnswer(data: string): { action: AnswerAction; shortId: string; version: number } | null {
  const m = /^aa:(understood|more):(\d+):(\d+)$/.exec(data);
  if (!m) return null;
  return { action: m[1] as AnswerAction, shortId: m[2]!, version: Number(m[3]) };
}

export type OwnerTaskAction = 'accept' | 'rework' | 'answer';
export function encodeOwnerTask(action: OwnerTaskAction, shortId: string): string { return `ot:${action}:${shortId}`; }
export function decodeOwnerTask(data: string): { action: OwnerTaskAction; shortId: string } | null {
  const m = /^ot:(accept|rework|answer):(\d+)$/.exec(data);
  if (!m) return null;
  return { action: m[1] as OwnerTaskAction, shortId: m[2]! };
}

export type ProposalDecision = 'accept' | 'reject' | 'change';
export function encodeProposal(decision: ProposalDecision, shortId: string): string { return `pr:${decision}:${shortId}`; }
export function decodeProposal(data: string): { decision: ProposalDecision; shortId: string } | null {
  const m = /^pr:(accept|reject|change):(\d+)$/.exec(data);
  if (!m) return null;
  return { decision: m[1] as ProposalDecision, shortId: m[2]! };
}

export function encodeVetoable(shortId: string): string { return `vt:${shortId}`; }
export function decodeVetoable(data: string): { shortId: string } | null {
  const m = /^vt:(\d+)$/.exec(data);
  return m ? { shortId: m[1]! } : null;
}

export type AgentAction = 'pause' | 'resume';
export function encodeAgent(action: AgentAction, agentId: string): string { return `ag:${action}:${agentId}`; }
export function decodeAgent(data: string): { action: AgentAction; agentId: string } | null {
  const m = /^ag:(pause|resume):([0-9a-f-]{36})$/.exec(data);
  if (!m) return null;
  return { action: m[1] as AgentAction, agentId: m[2]! };
}

/** «Прочёл, подтверждаю» под объявлением (спека announcements): uuid объявления, не short_id — у него нет короткого номера. */
export function encodeAnnouncement(announcementId: string): string { return `an:${announcementId}`; }
export function decodeAnnouncement(data: string): { announcementId: string } | null {
  const m = /^an:([0-9a-f-]{36})$/.exec(data);
  return m ? { announcementId: m[1]! } : null;
}

/** «К какому делу?» — выбор дела для текста, пришедшего без reply (спека multi-company-person, п.1). */
export function encodeWhichTask(shortId: string): string { return `wq:${shortId}`; }
export function decodeWhichTask(data: string): { shortId: string } | null {
  const m = /^wq:(\d+)$/.exec(data);
  return m ? { shortId: m[1]! } : null;
}

/**
 * «К какому делу прикрепить?» — фото без контекста (спека task-photos). `batch` — message_id первого
 * фото пачки: вопросов может висеть несколько, и выбор должен забрать ровно свои фото. `x` — «Отмена».
 */
export function encodePhotoTask(shortId: string | 'x', batch: string): string { return `pt:${shortId}:${batch}`; }
export function decodePhotoTask(data: string): { shortId: string | null; batch: string } | null {
  const m = /^pt:(\d+|x):(\d+)$/.exec(data);
  if (!m) return null;
  return { shortId: m[1] === 'x' ? null : m[1]!, batch: m[2]! };
}

/** Выйти из любого текущего диалога бота — «Отмена» работает одинаково везде (edge cases спеки). */
export const UNIVERSAL_CANCEL = 'x:cancel';

export function decodeInvite(data: string): 'yes' | 'no' | null {
  if (data === 'inv:yes') return 'yes';
  if (data === 'inv:no') return 'no';
  return null;
}

export function encodeLang(code: string): string { return `lang:${code}`; }
export function decodeLang(data: string): string | null {
  const m = /^lang:(ru|tr|vi|en)$/.exec(data);
  return m ? m[1]! : null;
}

export type TzCode = 'ist' | 'hcm' | 'msk' | 'utc';
export const TZ_MAP: Record<TzCode, string> = { ist: 'Europe/Istanbul', hcm: 'Asia/Ho_Chi_Minh', msk: 'Europe/Moscow', utc: 'UTC' };
export function encodeTz(code: TzCode): string { return `tz:${code}`; }
export function decodeTz(data: string): string | null {
  const m = /^tz:(ist|hcm|msk|utc)$/.exec(data);
  return m ? TZ_MAP[m[1] as TzCode] : null;
}
export const TZ_CHANGE = 'tz:change';
export const TZ_OK = 'tz:ok';
export const CONSENT_OK = 'consent:ok';

export function encodeShow(shortId: string): string { return `sh:${shortId}`; }
export function decodeShow(data: string): { shortId: string } | null {
  const m = /^sh:(\d+)$/.exec(data);
  return m ? { shortId: m[1]! } : null;
}

export type WaitWhenCode = 'tomorrow' | '3d' | 'week';
export function encodeWaitWhen(code: WaitWhenCode, shortId: string, version: number): string { return `wfw:${code}:${shortId}:${version}`; }
export function decodeWaitWhen(data: string): { code: WaitWhenCode; shortId: string; version: number } | null {
  const m = /^wfw:(tomorrow|3d|week):(\d+):(\d+)$/.exec(data);
  if (!m) return null;
  return { code: m[1] as WaitWhenCode, shortId: m[2]!, version: Number(m[3]) };
}

export type ReminderAction = 'today' | 'tomorrow' | 'cant' | 'nochange' | 'nottoday';
export function encodeReminder(action: ReminderAction, shortId: string): string { return `rm:${action}:${shortId}`; }
export function decodeReminder(data: string): { action: ReminderAction; shortId: string } | null {
  const m = /^rm:(today|tomorrow|cant|nochange|nottoday):(\d+)$/.exec(data);
  if (!m) return null;
  return { action: m[1] as ReminderAction, shortId: m[2]! };
}

/**
 * «Берёшь сейчас?» и «Пора браться» (спека auto-start): `tp:take:<short_id>` — взять без версии
 * карточки (за минуту она могла смениться), `tp:later:<h1|h3|tm>:<short_id>` — напомнить позже.
 */
export type TakeLaterCode = 'h1' | 'h3' | 'tm';
export type TakePromptCallback = { action: 'take'; shortId: string } | { action: 'later'; code: TakeLaterCode; shortId: string };
export function encodeTakePrompt(shortId: string): string { return `tp:take:${shortId}`; }
export function encodeTakeLater(code: TakeLaterCode, shortId: string): string { return `tp:later:${code}:${shortId}`; }
export function decodeTakePrompt(data: string): TakePromptCallback | null {
  const take = /^tp:take:(\d+)$/.exec(data);
  if (take) return { action: 'take', shortId: take[1]! };
  const later = /^tp:later:(h1|h3|tm):(\d+)$/.exec(data);
  return later ? { action: 'later', code: later[1] as TakeLaterCode, shortId: later[2]! } : null;
}
