// Клиент API Mini App (спека mini-app, «Контракт»). Каждый запрос несёт initData Telegram
// для проверки на сервере — там же решается, кто это и что ему показывать.
import type { Announcement } from './announcement-gate.js';

export interface TaskSource {
  id: string;
  kind: string;
  title: string;
  url: string | null;
  status: string | null;
  quote: string | null;
}

/** Проект дела (спека projects): папка по теме; у закрытого — замок, его видит только хозяин. */
export interface TaskProject {
  id: string;
  name: string;
  private: boolean;
  /** Ключ проекта; вместе с номером дела складывается в обозначение «NOR-001». */
  key: string;
}

export interface TaskCard {
  id: string;
  short_id: string;
  title: string;
  due_date: string | null;
  status: string;
  version: number;
  requires_result: boolean;
  /** Какой результат просит автор; при `required` «Завершить» открывает поле результата (спека required-result). */
  expected_result: { type: 'text' | 'number' | 'file' | 'photo'; required: boolean; min_length: number } | null;
  is_translated: boolean;
  why: string | null;
  done_criteria: string | null;
  /** «Как это делается» — объяснение для того, кто не читал разговор постановщика. */
  description: string | null;
  bot_link: string;
  important: boolean;
  category: 'do' | 'decide' | 'someday' | null;
  waiting_for: string | null;
  next_check_at: string | null;
  photos: number;
  sources: TaskSource[];
  shared_with: { org_id: string; name: string } | null;
  project: TaskProject | null;
  /** Обозначение дела для человека: «NOR-001» (спека projects-stage2). */
  key: string | null;
  /** Когда дело поставили — метаданные карточки, мелким шрифтом. В строке списка поля нет. */
  created_at?: string;
  /** В деле есть новое для смотрящего — реплика или результат не от него (спека unread-and-deeplink). */
  unread?: boolean;
  /** Только на карточке (спека self-set-due): смотрящий может поставить срок календарём. */
  can_set_due?: boolean;
  /** Смотрящий может попросить исполнителя назвать срок (автор, владелец, админ). */
  can_request_due?: boolean;
  /** Открытая просьба назвать срок; `to_me` — смотрящий и есть тот, кого просят. */
  due_request?: DueRequest | null;
  /** Только на карточке (спека task-reviewer): кто поставил, кто делает, кто проверяет. */
  people?: TaskPeople;
  /** Последний сданный результат — у сданного и завершённого дела. */
  result?: TaskResult | null;
  /** Начато без «Взять» первым действием исполнителя — чем и когда (спека auto-start). Только на карточке. */
  auto_started?: { via: 'comment' | 'attachment' | 'submit'; at: string } | null;
}

export interface TaskPeople {
  author: string;
  assignee: string;
  reviewer: string | null;
  my_role: 'author' | 'assignee' | 'reviewer' | 'manager';
}

export interface TaskResult {
  text: string | null;
  number: number | null;
  /** Сколько файлов приложено; сами файлы живут в Telegram. */
  files: number;
}

export interface DueRequest {
  requested_at: string;
  by_name: string;
  to_me: boolean;
  /** Зачем нужен срок — словами просившего, уже на языке читающего. */
  text: string | null;
}

/** Действия карточки; набор приходит с сервера, приложение своих правил не держит. */
export type TaskAction = 'take' | 'stop' | 'done' | 'postpone' | 'question' | 'unclear' | 'decline';

/** Быстрые даты переноса: считает рабочий календарь человека на сервере. */
export type PostponeChoice = 'tomorrow' | 'day_after' | 'week';

export interface CompanyLists {
  now: TaskCard[];
  queue: TaskCard[];
  waiting_external: TaskCard[];
  submitted: TaskCard[];
  waiting: TaskCard[];
  /** Перенесённые дела до их дня. Нет у списка из кэша до этой версии. */
  scheduled?: TaskCard[];
}

/** Доска со счётчиком открытых дел человека (спека projects-stage2). */
export interface Board {
  id: string;
  key: string;
  name: string;
  private: boolean;
  open: number;
}

/** Человек компании со счётчиком открытых дел — для фильтра списка (только владельцу и админу). */
export interface Person {
  id: string;
  name: string;
  open: number;
  /** Приглашён, но ещё не вошёл в бота: дела на нём висят, а он их не видит. */
  invited: boolean;
  /** У человека есть дело с новым для смотрящего — точка на чипе (спека unread-and-deeplink). */
  unread: boolean;
}

export interface ProjectTasksResponse {
  lang: string;
  org_id: string;
  name: string;
  /** Дела проекта — у каждого имя исполнителя: список общий, а не одного человека. */
  tasks: (TaskCard & { assignee_name: string | null })[];
}

export interface PeopleTasksResponse {
  lang: string;
  org_id: string;
  name: string;
  tasks: TaskCard[];
}

export interface CompanySpace {
  org_id: string;
  name: string;
  kind: 'company';
  /** Человек управляет этой компанией (владелец или админ): ему виден раздел «Компания». */
  manages: boolean;
  /** Компания, куда человека позвали, а он ещё не вошёл: первое действие по её делу принимает приглашение. */
  invited?: boolean;
  lists: CompanyLists;
  /** Доски, на которых у человека есть дела; своя закрытая идёт первой. */
  projects: Board[];
  /** Люди компании: приходят только владельцу и админу, у остальных список пуст. */
  people: Person[];
  /** Сколько дел закрыто за окно — число видно до раскрытия раздела (спека completed-list). */
  completed_count: number;
}

export interface PersonalSpace {
  org_id: string;
  name: string;
  kind: 'personal';
  lists: { open: TaskCard[] };
  completed_count: number;
  projects: Board[];
  people: Person[];
}

export type Space = CompanySpace | PersonalSpace;

export type { Announcement } from './announcement-gate.js';

export interface ListsResponse {
  lang: string;
  spaces: Space[];
  /** Старые первыми; пусто — заслона нет. */
  announcements: Announcement[];
  /** Дело, которое человек взял, — шапка показывает его на любом экране. null, если ничего не взято. */
  in_progress: InProgress | null;
}

/** Взятое дело: что человек делает прямо сейчас и с какой минуты (спека mini-app). */
export interface InProgress {
  task_id: string;
  title: string;
  /** Начало текущего отрезка работы. */
  started_at: string;
  /** Сколько уже наработано по делу до этого отрезка, секунды. */
  worked_seconds: number;
  company: string | null;
}

/** Раздел «Завершённые» (спека completed-list): грузится отдельно, по нажатию. */
export interface CompletedSpace {
  org_id: string;
  name: string;
  kind: 'company' | 'personal';
  tasks: TaskCard[];
}

export interface CompletedResponse {
  lang: string;
  spaces: CompletedSpace[];
}

export interface TaskNote {
  id: string;
  kind: string;
  answered?: boolean;
  author: string;
  mine: boolean;
  text: string;
  at: string;
}

/** Фото дела (спека task-photos): из рабочей группы или прикреплённое человеком. */
export interface TaskPhoto {
  id: string;
  source: 'group' | 'person';
  author: string | null;
  at: string;
}

export interface TaskResponse {
  lang: string;
  task: TaskCard;
  /** Дело лежит в личном пространстве — у него свои кнопки (звёздочка, пометка «рабочее»). */
  personal: boolean;
  /** Записи по делу: реплики человека и ответы агента, старые первыми. */
  notes: TaskNote[];
  /** Что разрешено сделать с делом сейчас — считает сервер по таблице переходов ядра
   *  (спека miniapp-task-actions). */
  actions: TaskAction[];
}

/** Раздел «Компания» (спека miniapp-company): управление глазами — люди, проекты, агенты. */
export interface CompanyPerson {
  id: string;
  name: string;
  /** Это я: свою строку не выводят из компании — отменить такое было бы уже некому. */
  me: boolean;
  email: string | null;
  language: string;
  role: string;
  status: string;
  in_telegram: boolean;
  /** Когда последний раз заходил в бота и в приложение — словами ('within the last hour', 'today', 'yesterday',
   *  'N days ago') и днём YYYY-MM-DD в поясе смотрящего (спека person-presence). Только у активных. */
  last_seen_bot: string | null;
  last_seen_bot_on: string | null;
  last_seen_app: string | null;
  last_seen_app_on: string | null;
  /** С какой даты отметки пишутся (YYYY-MM-DD): null до неё — «не видели», а не «не заходил». */
  seen_tracked_since: string;
  /** Когда человек вошёл в компанию; null — приглашён и не принял или вошёл до учёта этой даты. */
  joined_at: string | null;
  open: number;
  /** Кто он и что закрывает (спека person-profile): агент читает это перед тем, как поручать. */
  about: string | null;
}

export interface CompanyProject {
  id: string;
  key: string;
  name: string;
  private: boolean;
  open: number;
  /** Состав закрытого проекта: кто видит его дела, помимо хозяина. */
  members: { user_id: string; name: string }[];
}

export interface CompanyAgent {
  id: string;
  name: string;
  status: string;
  owner: string | null;
}

export interface CompanyResponse {
  org_id: string;
  org_name: string;
  role: string;
  people: CompanyPerson[];
  projects: CompanyProject[];
  agents: CompanyAgent[];
}

/** Итоги работы (спека stats-page): сколько сделано за период, кем и на каком проекте. */
export type StatsPeriod = 'today' | 'yesterday' | '7d' | '30d' | 'this_month' | 'last_month';

export interface StatsRow {
  id: string;
  name: string;
  done: number;
  submitted: number;
  dropped: number;
  open: number;
  /** Отработано за период, минут. */
  minutes: number;
}

/**
 * Задача человека со временем за период. `id: null` без `hidden` — время без задачи; `hidden` —
 * дело закрытого проекта, которое смотрящему не видно: ни номера, ни названия.
 */
export interface StatsTask {
  id: string | null;
  key: string | null;
  title: string | null;
  hidden: boolean;
  minutes: number;
}

export interface StatsPerson extends StatsRow {
  tasks: StatsTask[];
}

export interface StatsResponse {
  org_id: string;
  org_name: string;
  /** Видно всю компанию — владельцу и админу; остальным приходят только их числа. */
  whole_org: boolean;
  period: StatsPeriod;
  from: string;
  to: string;
  tz: string;
  /** Название месяца у календарных периодов — чтобы не гадать, какой месяц идёт в счёт. */
  label: string | null;
  totals: { done: number; submitted: number; dropped: number; minutes: number };
  people: StatsPerson[];
  projects: StatsRow[];
}

/** Токен только на чтение (спека read-tokens): сам токен в списке не приходит — только при выпуске. */
export interface ReadToken {
  id: string;
  label: string;
  created_at: string;
  last_used_at: string | null;
}

/** Токен агента (спека agent-tokens): сам токен в списке не приходит — только при выпуске. */
export interface AgentToken {
  id: string;
  label: string;
  agent_id: string;
  agent_name: string;
  created_at: string;
  expires_at: string;
  last_used_at: string | null;
}

export class ApiError extends Error {
  constructor(public status: number, public code: string, public body: unknown) {
    super(code);
  }
}

function initData(): string {
  return window.Telegram?.WebApp?.initData ?? '';
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': initData(), ...(init.headers ?? {}) },
    });
  } catch {
    throw new ApiError(0, 'network', null);
  }
  if (!res.ok) {
    let body: { code?: string } | null = null;
    try { body = await res.json(); } catch { /* тело могло быть пустым */ }
    throw new ApiError(res.status, body?.code ?? `http_${res.status}`, body);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/**
 * Запрос, который несёт не JSON: само изображение туда или обратно. Фото дела закрыты той же подписью
 * Telegram, поэтому `<img src>` на адрес не годится — клиент забирает байты и делает `blob:` адрес.
 */
async function requestBinary(path: string, init: RequestInit = {}): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(path, { ...init, headers: { 'X-Telegram-Init-Data': initData(), ...(init.headers ?? {}) } });
  } catch {
    throw new ApiError(0, 'network', null);
  }
  if (!res.ok) {
    let body: { code?: string } | null = null;
    try { body = await res.json(); } catch { /* тело могло быть не JSON (413 от разбора тела) */ }
    throw new ApiError(res.status, body?.code ?? `http_${res.status}`, body);
  }
  return res;
}

export const api = {
  lists: (): Promise<ListsResponse> => request('/app/api/lists'),
  completed: (): Promise<CompletedResponse> => request('/app/api/completed'),
  confirmAnnouncement: (id: string): Promise<{ ok: true; confirmed_at: string }> =>
    request(`/app/api/announcements/${id}/confirm`, { method: 'POST' }),
  reopen: (id: string): Promise<{ ok: true; status: string }> =>
    request(`/app/api/tasks/${id}/reopen`, { method: 'POST' }),
  task: (id: string): Promise<TaskResponse> => request(`/app/api/tasks/${id}`),
  personTasks: (id: string): Promise<PeopleTasksResponse> => request(`/app/api/people/${id}/tasks`),
  projectTasks: (id: string): Promise<ProjectTasksResponse> => request(`/app/api/projects/${id}/tasks`),
  done: (id: string, version: number, result?: { text?: string; number?: number }): Promise<{ ok: true }> =>
    request(`/app/api/tasks/${id}/done`, { method: 'POST', body: JSON.stringify({ version, result }) }),
  comment: (id: string, text: string): Promise<{ ok: true }> =>
    request(`/app/api/tasks/${id}/comment`, { method: 'POST', body: JSON.stringify({ text }) }),
  photos: (id: string): Promise<{ attachments: TaskPhoto[] }> => request(`/app/api/tasks/${id}/attachments`),
  /** Байты фото — для `blob:` адреса миниатюры. */
  photo: async (id: string, attId: string): Promise<Blob> =>
    (await requestBinary(`/app/api/tasks/${id}/attachments/${attId}`)).blob(),
  /** Тело — само изображение; ответ — сколько фото у дела теперь. */
  attachPhoto: async (id: string, image: Blob): Promise<{ id: string; photos: number }> =>
    (await requestBinary(`/app/api/tasks/${id}/attachments`, {
      method: 'POST', headers: { 'Content-Type': image.type || 'image/jpeg' }, body: image,
    })).json(),
  take: (id: string, version: number): Promise<{ ok: true }> =>
    request(`/app/api/tasks/${id}/take`, { method: 'POST', body: JSON.stringify({ version }) }),
  /** «Остановить»: дело возвращается в очередь, таймер встаёт (пара к «Взял»). */
  stop: (id: string, version: number): Promise<{ ok: true }> =>
    request(`/app/api/tasks/${id}/stop`, { method: 'POST', body: JSON.stringify({ version }) }),
  postpone: (id: string, to: PostponeChoice, version: number): Promise<{ ok: true; due_date: string }> =>
    request(`/app/api/tasks/${id}/postpone`, { method: 'POST', body: JSON.stringify({ to, version }) }),
  // Версия карточки уходит со всеми действиями: без неё чужая правка применяется молча (ревью).
  question: (id: string, text: string, kind: 'question' | 'unclear', version: number): Promise<{ ok: true }> =>
    request(`/app/api/tasks/${id}/question`, { method: 'POST', body: JSON.stringify({ text, kind, version }) }),
  decline: (id: string, text: string, version: number): Promise<{ ok: true }> =>
    request(`/app/api/tasks/${id}/decline`, { method: 'POST', body: JSON.stringify({ text, version }) }),
  /** Срок календарём: ответ — карточка целиком, как после открытия. */
  setDue: (id: string, date: string, version: number): Promise<TaskResponse> =>
    request(`/app/api/tasks/${id}/due`, { method: 'POST', body: JSON.stringify({ date, version }) }),
  requestDue: (id: string): Promise<TaskResponse> =>
    request(`/app/api/tasks/${id}/due-request`, { method: 'POST', body: JSON.stringify({}) }),
  reorderPersonal: (ids: string[]): Promise<{ ok: true }> =>
    request('/app/api/personal/reorder', { method: 'POST', body: JSON.stringify({ ids }) }),
  setImportant: (id: string, important: boolean): Promise<{ ok: true }> =>
    request(`/app/api/personal/${id}/important`, { method: 'POST', body: JSON.stringify({ important }) }),
  deletePersonal: (id: string): Promise<{ ok: true }> =>
    request(`/app/api/personal/${id}`, { method: 'DELETE' }),
  setSomeday: (id: string, someday: boolean): Promise<{ ok: true; category: string }> =>
    request(`/app/api/personal/${id}/someday`, { method: 'POST', body: JSON.stringify({ someday }) }),
  setShare: (id: string, orgId: string | null): Promise<{ ok: true }> =>
    request(`/app/api/personal/${id}/share`, { method: 'POST', body: JSON.stringify({ org_id: orgId }) }),
  company: (org?: string): Promise<CompanyResponse> => request(`/app/api/company${org ? `?org=${encodeURIComponent(org)}` : ''}`),
  stats: (period: StatsPeriod, org?: string): Promise<StatsResponse> =>
    request(`/app/api/stats?period=${period}${org ? `&org=${encodeURIComponent(org)}` : ''}`),
  // Приложение отражает, а не управляет: людей и проекты заводят разговором с
  // агентом. Единственное, что человек пишет о компании, — свой собственный профиль.
  setAbout: (org: string, id: string, about: string | null): Promise<{ ok: true; about: string | null }> =>
    request(`/app/api/company/people/${id}/about`, { method: 'POST', body: JSON.stringify({ org, about }) }),
  // «Доступ для программ» (спека read-tokens): токен показывается один раз — в ответе выпуска.
  readTokens: (): Promise<ReadToken[]> => request('/app/api/read-tokens'),
  issueReadToken: (label: string): Promise<{ id: string; token: string }> =>
    request('/app/api/read-tokens', { method: 'POST', body: JSON.stringify({ label }) }),
  revokeReadToken: (id: string): Promise<{ ok: true }> => request(`/app/api/read-tokens/${id}`, { method: 'DELETE' }),
  // Токены агентов (спека agent-tokens): только владельцу компании, токен — один раз в ответе выпуска.
  agentTokens: (org: string): Promise<AgentToken[]> => request(`/app/api/agent-tokens?org=${encodeURIComponent(org)}`),
  issueAgentToken: (org: string, agent: string, label: string): Promise<{ id: string; token: string; expires_at: string }> =>
    request('/app/api/agent-tokens', { method: 'POST', body: JSON.stringify({ org, agent, label }) }),
  revokeAgentToken: (org: string, id: string): Promise<{ ok: true }> =>
    request(`/app/api/agent-tokens/${id}?org=${encodeURIComponent(org)}`, { method: 'DELETE' }),
};
