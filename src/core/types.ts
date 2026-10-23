/** Кто совершает действие. Агент всегда действует через человека, вызвавшего инструмент. */
export type Actor =
  | { kind: 'user'; userId: string }
  | { kind: 'agent'; agentId: string; userId: string }
  | { kind: 'system' };

export type TaskStatus =
  | 'draft' | 'scheduled' | 'ready' | 'active' | 'in_progress' | 'blocked' | 'waiting_external'
  | 'submitted' | 'rework' | 'done' | 'declined' | 'cancelled' | 'waiting' | 'resolved';

export interface Task {
  id: string;
  short_id: string;
  org_id: string;
  plan_id: string | null;
  /** Проект, в котором лежит дело (спека projects). На этапе 1 ещё может быть null. */
  project_id: string | null;
  /** Кто видит дело, если его проект закрыт; null у открытого — это же условие в политике RLS. */
  private_owner_user_id: string | null;
  position: number;
  kind: 'action' | 'waiting';
  title: string;
  description: string;
  why: string;
  done_criteria: string;
  expected_result: { type: 'text' | 'number' | 'file' | 'photo'; required: boolean } | null;
  origin: string | null;
  links: unknown[];
  rationale: string | null;
  assignee_user_id: string;
  author_agent_id: string | null;
  author_user_id: string;
  /** Проверяющий обычного дела: принимает сданное вместо автора (спека task-reviewer). */
  reviewer_user_id: string | null;
  /** Пометка «рабочее» у личного дела: организация, агентам которой оно видно (спека owner-feedback). */
  shared_org_id: string | null;
  status: TaskStatus;
  due_date: string | null;
  due_tz: string | null;
  activate_at: Date | null;
  priority: 'normal' | 'urgent';
  category: 'do' | 'decide' | 'someday' | null;
  estimate_minutes: number | null;
  auto_release_ok: boolean;
  /** Действует ли правило полноты (спека task-context): у дел до миграции 006 — false. */
  requires_context: boolean;
  source_language: string | null;
  external: unknown;
  waiting: WaitingInfo | null;
  started_at: Date | null;
  /** Чем начато дело без «Взять»: реплика, фото или сдача (спека auto-start); null — «Взять» или не начато. */
  started_via: 'comment' | 'attachment' | 'submit' | null;
  submitted_at: Date | null;
  blocked_at: Date | null;
  status_changed_at: Date;
  /** Когда взяли в последний раз: от этого времени идёт текущий отрезок работы. */
  taken_at: Date | null;
  /** Сумма прежних отрезков работы по делу, секунды: таймер показывает её плюс текущий отрезок. */
  worked_seconds: number;
  acked_at: Date | null;
  reminded_count: number;
  last_reminded_at: Date | null;
  snoozed_until: Date | null;
  created_at: Date;
  updated_at: Date;
  version: number;
  /** Номер дела внутри проекта: «NOR-001» вместе с ключом проекта (спека projects-stage2). */
  number: number | null;
  /** Прежние обозначения после переездов между проектами — по ним дело тоже находится. */
  former_keys: string[];
}

export interface WaitingInfo {
  waiting_for: string;
  expected_at: string | null;      // ISO
  next_check_at: string;           // ISO
  check_user_id: string;
  on_arrival: string | null;
  contact: string | null;
  checks_done?: number;
}

export const OPEN_STATUSES: TaskStatus[] = [
  'draft', 'scheduled', 'ready', 'active', 'in_progress', 'blocked', 'waiting_external', 'submitted', 'rework', 'waiting',
];

/**
 * «Сколько на человеке дел» — одно определение на весь продукт: всё незакрытое, кроме черновика.
 * Черновик ещё не выпущен, человек его не видит, и считать его нагрузкой нечестно. Раньше каждое
 * место считало по-своему, и владелец видел у себя 5 дел при 35 — то же число в разных углах
 * приложения не совпадало.
 */
export const LOAD_STATUSES: TaskStatus[] = OPEN_STATUSES.filter((s) => s !== 'draft');

export const actorAgentId = (a: Actor): string | null => (a.kind === 'agent' ? a.agentId : null);
export const actorUserId = (a: Actor): string | null => (a.kind === 'system' ? null : a.userId);
