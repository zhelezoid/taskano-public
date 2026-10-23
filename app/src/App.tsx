import { Fragment } from 'preact';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import {
  api, ApiError, type Announcement, type Board, type CompanyLists, type CompanyResponse, type Person, type PostponeChoice, type Space,
  type StatsPerson, type StatsPeriod, type StatsResponse, type StatsRow, type TaskAction, type TaskCard, type TaskNote, type TaskProject,
  type TaskSource, type InProgress, type ReadToken, type ProjectTasksResponse, type TaskPeople, type TaskResult,
  type AgentToken, type CompanyAgent,
} from './api.js';
import { dayDate, dueLabel, durationLabel, elapsedLabel, noteTime, seenLabel, shortDate, t, type StringKey } from './i18n.js';
import { parseRichText, type Piece } from './rich-text.js';
import { taskFromLaunch } from './deeplink.js';
import { showStatsHeading } from './stats-heading.js';
import { PhotoViewer } from './PhotoViewer.js';
import { AnnouncementGate } from './AnnouncementGate.js';
import { EMPTY_GATE, gateConfirmed, gateCurrent, gateProgress, gateReplace, isBlocking, type GateState } from './announcement-gate.js';
import { openPicker } from './date-picker.js';

// Список дел человека (спека mini-app). Вид — нативные сгруппированные списки Telegram:
// крупная карточка «Сейчас», ниже разделы; цвета — из темы Telegram (светлая и тёмная).

const SECTIONS = ['queue', 'waiting_external', 'submitted', 'waiting'] as const;
type Section = (typeof SECTIONS)[number];

const tg = (): NonNullable<Window['Telegram']>['WebApp'] | undefined => window.Telegram?.WebApp;
const haptic = {
  tap: () => tg()?.HapticFeedback?.impactOccurred('light'),
  select: () => tg()?.HapticFeedback?.selectionChanged(),
  success: () => tg()?.HapticFeedback?.notificationOccurred('success'),
};

function applyTheme(): void {
  const app = tg();
  const p = app?.themeParams;
  if (!p) return;
  const root = document.documentElement.style;
  const map: [keyof typeof p, string][] = [
    ['bg_color', '--bg'], ['secondary_bg_color', '--bg-grouped'], ['section_bg_color', '--bg-section'],
    ['text_color', '--text'], ['hint_color', '--hint'], ['subtitle_text_color', '--subtitle'],
    ['section_header_text_color', '--section-header'], ['accent_text_color', '--accent'], ['link_color', '--link'],
    ['button_color', '--button'], ['button_text_color', '--button-text'], ['destructive_text_color', '--destructive'],
    ['section_separator_color', '--separator'],
  ];
  for (const [key, cssVar] of map) { const v = p[key]; if (v) root.setProperty(cssVar, v); }
  document.documentElement.dataset.scheme = app?.colorScheme ?? 'light';
  try {
    app?.setHeaderColor?.('secondary_bg_color');
    app?.setBackgroundColor?.('secondary_bg_color');
  } catch { /* старые клиенты Telegram */ }
}

/** Отступы под панель Telegram и вырез экрана (Bot API 8.0): в полноэкранном режиме панель лежит
 *  поверх приложения. Старые клиенты полей не отдают — остаются env(safe-area-inset-*). */
function applyInsets(): void {
  const app = tg();
  const root = document.documentElement.style;
  const top = (app?.contentSafeAreaInset?.top ?? 0) + (app?.safeAreaInset?.top ?? 0);
  const bottom = (app?.contentSafeAreaInset?.bottom ?? 0) + (app?.safeAreaInset?.bottom ?? 0);
  root.setProperty('--inset-top', `${top}px`);
  root.setProperty('--inset-bottom', `${bottom}px`);
}

function Due(props: { lang: string; date: string | null }): preact.JSX.Element | null {
  const d = dueLabel(props.lang, props.date);
  if (!d) return null;
  return <span class={`due${d.past ? ' past' : ''}${d.soon ? ' soon' : ''}`}>{d.text}</span>;
}

/** Сегодня по часам телефона — нижняя граница календаря: срок в прошлом сервер всё равно отобьёт. */
function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Кнопка срока (спека self-set-due). Поле даты лежит прозрачным поверх кнопки, и нажатие
 * приходит в него само: так календарь открывается на iOS и Android. Раньше поле было скрыто и
 * открывалось из кода — `showPicker()`/`click()` — и у части клиентов не открывалось вовсе.
 * Где нажатие на поле календарь не открывает (компьютер), зовём `showPicker()`; не вышло — поле видно.
 */
function DuePicker(props: { date: string | null; label: string; disabled: boolean; class: string; onPick: (date: string) => void }): preact.JSX.Element {
  const [inline, setInline] = useState(false);
  const pick = (e: Event): void => {
    const v = (e.currentTarget as HTMLInputElement).value;
    if (v && v !== props.date) props.onPick(v);
  };
  if (inline) {
    return <input type="date" class="date-input-inline" min={todayIso()} value={props.date ?? ''} disabled={props.disabled} onChange={pick} />;
  }
  return (
    <span class="date-picker">
      <span class={`${props.class}${props.disabled ? ' is-disabled' : ''}`} aria-hidden="true">{props.label}</span>
      <input
        type="date" class="date-input-over" min={todayIso()} value={props.date ?? ''} disabled={props.disabled}
        aria-label={props.label}
        onClick={(e) => {
          haptic.tap();
          if (!openPicker(e.currentTarget as HTMLInputElement) && !window.matchMedia('(pointer: coarse)').matches) setInline(true);
        }}
        onChange={pick}
      />
    </span>
  );
}

/** Наибольшая сторона фото перед отправкой (спека task-photos): снимок телефона иначе идёт по сети целиком. */
const PHOTO_MAX_SIDE = 2560;

/**
 * Уменьшить фото на устройстве: canvas → JPEG 0.9. Метаданные снимка (геометка) при этом не
 * переносятся; поворот по EXIF браузер применяет сам при разборе. Не разобрал — отправляем как есть,
 * и решает сервер: он примет JPEG, PNG и WebP и скажет, если формат чужой.
 */
async function shrinkPhoto(file: File): Promise<Blob> {
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(file); } catch { return file; }
  const scale = Math.min(1, PHOTO_MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx2d = canvas.getContext('2d');
  if (!ctx2d) { bitmap.close(); return file; }
  ctx2d.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
  return blob ?? file;
}

/** Отказ загрузки — словами: «не получилось» на чужой формат или предел — бесполезный совет. */
function photoError(e: unknown): StringKey {
  if (!(e instanceof ApiError)) return 'photo_failed';
  if (e.status === 413) return 'photo_too_big';
  if (e.status === 415) return 'photo_unsupported';
  if (e.code === 'limit_exceeded' || e.status === 429) return 'photo_limit';
  if (e.status === 403) return 'photo_forbidden';
  if (e.status === 404) return 'photo_closed';
  return 'photo_failed';
}

type PhotoState = { kind: 'idle' } | { kind: 'uploading'; n: number; total: number } | { kind: 'done' } | { kind: 'error'; key: StringKey };

/**
 * Фото дела в карточке (спека task-photos): ряд миниатюр и «Прикрепить фото». Фото закрыты подписью
 * Telegram, поэтому байты забираются запросом и показываются через `blob:` адрес. Нажатие — во весь
 * экран. Ряд перечитывается, когда меняется число фото у дела.
 */
const PHOTO_ROW = 12;

function TaskPhotos(props: {
  task: TaskCard; lang: string; busy: boolean; canAttach: boolean; onAttached: (t: TaskCard) => Promise<void>;
}): preact.JSX.Element | null {
  const { task, lang } = props;
  const [thumbs, setThumbs] = useState<{ id: string; url: string }[]>([]);
  const [viewing, setViewing] = useState<string | null>(null);
  const [state, setState] = useState<PhotoState>({ kind: 'idle' });
  // Сразу — первые PHOTO_ROW фото, остальные по кнопке: у дела из рабочей группы их бывает сотня, и
  // разом они съели бы общий лимит запросов человека (ревью 07.10).
  const [showAll, setShowAll] = useState(false);
  const [total, setTotal] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!task.photos) { setThumbs([]); return; }
    let alive = true;
    const made: string[] = [];
    void (async () => {
      try {
        const { attachments } = await api.photos(task.id);
        if (alive) setTotal(attachments.length);
        const loaded = await Promise.all((showAll ? attachments : attachments.slice(0, PHOTO_ROW)).map(async (a) => {
          const blob = await api.photo(task.id, a.id).catch(() => null);
          if (!blob || !alive) return null;
          const url = URL.createObjectURL(blob);
          made.push(url);
          return { id: a.id, url };
        }));
        if (alive) setThumbs(loaded.filter((x): x is { id: string; url: string } => x !== null));
      } catch { /* ряд необязательный: не загрузился — карточка работает дальше */ }
    })();
    return () => { alive = false; for (const url of made) URL.revokeObjectURL(url); };
  }, [task.id, task.photos, showAll]);

  const pick = (files: FileList | null): void => {
    const list = files ? [...files] : [];
    if (input.current) input.current.value = '';
    if (!list.length) return;
    void (async () => {
      let attached = 0;
      for (let i = 0; i < list.length; i++) {
        setState({ kind: 'uploading', n: i + 1, total: list.length });
        try {
          await api.attachPhoto(task.id, await shrinkPhoto(list[i]!));
          attached += 1;
        } catch (e) {
          setState({ kind: 'error', key: photoError(e) });
          if (attached) await props.onAttached(task).catch(() => undefined);
          return;
        }
      }
      haptic.success();
      setState({ kind: 'done' });
      await props.onAttached(task).catch(() => undefined);
    })();
  };

  if (!task.photos && !props.canAttach) return null;
  const uploading = state.kind === 'uploading';
  return (
    <div class="task-block">
      <div class="task-block-label">{t(lang, 'photos_title')}</div>
      {thumbs.length > 0 && (
        <div class="photo-row">
          {thumbs.map((p) => (
            <button key={p.id} class="photo-thumb" aria-label={t(lang, 'photo_open')} onClick={() => { haptic.tap(); setViewing(p.url); }}>
              <img src={p.url} alt="" />
            </button>
          ))}
        </div>
      )}
      {!showAll && total > PHOTO_ROW && (
        <button class="link-btn" onClick={() => { haptic.tap(); setShowAll(true); }}>
          {t(lang, 'photo_show_all', { n: total })}
        </button>
      )}
      {props.canAttach && (
        <>
          <button class="link-btn" disabled={props.busy || uploading} onClick={() => { haptic.tap(); input.current?.click(); }}>
            {t(lang, 'photo_attach')}
          </button>
          <input
            ref={input} type="file" accept="image/*" multiple class="file-input-hidden" tabIndex={-1} aria-hidden="true"
            onChange={(e) => pick((e.currentTarget as HTMLInputElement).files)}
          />
        </>
      )}
      {state.kind === 'uploading' && <div class="comment-hint">{t(lang, 'photo_uploading', { n: state.n, total: state.total })}</div>}
      {state.kind === 'done' && <div class="comment-hint">{t(lang, 'photo_attached')}</div>}
      {state.kind === 'error' && <div class="comment-hint">{t(lang, state.key)}</div>}
      {/* Свой просмотр с приближением пальцами: масштаб страницы в Mini App выключен. */}
      {viewing && <PhotoViewer src={viewing} closeLabel={t(lang, 'photo_close')} onClose={() => setViewing(null)} />}
    </div>
  );
}

/**
 * Поле обязательного результата (спека required-result): «Завершить» у дела с замком раскрывает его
 * прямо на карточке — текст, число или фото — и «Сдать» тут же. В бот не уводим: приложение уже было
 * тем местом, где нажали, а просьба в другом месте и была причиной этого правила. Что достаточно, решает
 * сервер: отказ приходит строкой под полем, свои пороги клиент не держит.
 */
function ResultBox(props: {
  task: TaskCard; lang: string; busy: boolean;
  /** Существующая загрузка фото дела — для photo/file; число приложенных видно в ней же. */
  photos: preact.JSX.Element | null;
  onSubmit: (result: { text: string }) => Promise<void>; onCancel: () => void;
}): preact.JSX.Element {
  const { task, lang } = props;
  const expected = task.expected_result!;
  const attachType = expected.type === 'photo' || expected.type === 'file';
  // Файл в приложении не загрузить, поэтому его закрывает и текст — где лежит файл, ссылка (спека required-result).
  const typed = expected.type === 'text' || expected.type === 'file';
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [refusal, setRefusal] = useState<StringKey | null>(null);
  const min = expected.min_length;

  const submit = (): void => {
    if (sending) return;
    setSending(true);
    setRefusal(null);
    void (async () => {
      try {
        await props.onSubmit({ text: text.trim() });
      } catch (e) {
        setRefusal(resultError(e));
        setSending(false);
      }
    })();
  };

  return (
    <div class="task-block result-box">
      <div class="task-block-label">{t(lang, 'result_title')}</div>
      {typed && (
        <textarea
          class="comment-input result-input" rows={3} value={text} maxLength={COMMENT_MAX_LENGTH}
          placeholder={t(lang, expected.type === 'file' ? 'result_file_ph' : 'result_text_ph', { min })} disabled={props.busy || sending}
          onInput={(e) => { setText((e.currentTarget as HTMLTextAreaElement).value); setRefusal(null); }}
        />
      )}
      {expected.type === 'number' && (
        <input
          class="comment-input result-input" type="text" inputMode="decimal" value={text}
          placeholder={t(lang, 'result_number_ph')} disabled={props.busy || sending}
          onInput={(e) => { setText((e.currentTarget as HTMLInputElement).value); setRefusal(null); }}
        />
      )}
      {attachType && <div class="comment-hint">{t(lang, expected.type === 'file' ? 'result_file_hint' : 'result_photo_hint')}</div>}
      {attachType && props.photos}
      <div class="task-actions">
        <button class="btn tinted" disabled={props.busy || sending || (!attachType && !text.trim())}
          onClick={() => { haptic.tap(); submit(); }}>
          {t(lang, 'result_submit')}
        </button>
        <button class="btn tinted" disabled={sending} onClick={() => { haptic.tap(); props.onCancel(); }}>{t(lang, 'mode_cancel')}</button>
      </div>
      {refusal && <div class="comment-hint">{t(lang, refusal, { min })}</div>}
    </div>
  );
}

/** Отказ сдачи словами: что именно приложить — по виду результата, который назвал сервер. */
function resultError(e: unknown): StringKey {
  if (!(e instanceof ApiError)) return 'action_failed';
  if (e.status === 429) return 'too_fast_hint';
  if (e.code === 'stale_version') return 'action_stale';
  const details = (e.body as { details?: { reason?: string; type?: string; hint?: string } } | null)?.details;
  if (e.code === 'validation_failed' && details?.reason === 'result_required') {
    if (details.type === 'number') return details.hint === 'number_format' ? 'result_need_number_plain' : 'result_need_number';
    return details.type === 'text' ? 'result_need_text' : details.type === 'file' ? 'result_need_file' : 'result_need_photo';
  }
  return 'action_failed';
}

/**
 * Поле реплики в карточке дела (спека task-comments): реплика агенту, задача не двигается.
 * `mode` меняет только смысл отправки (спека miniapp-task-actions): вопрос, «непонятно»
 * и отказ пишутся в это же поле, а не в три отдельных.
 */
function CommentBox(props: {
  lang: string; disabled: boolean; onSend: (text: string) => Promise<void>;
  mode?: ComposerMode; onCancelMode?: () => void;
}): preact.JSX.Element {
  const { lang, disabled, onSend, mode } = props;
  const [text, setText] = useState('');
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'limit' | 'too_long' | 'failed'>('idle');

  const send = (): void => {
    const body = text.trim();
    if (!body || state === 'sending') return;
    setState('sending');
    void (async () => {
      try {
        await onSend(body);
        setText('');
        setState('sent');
        haptic.success();
      } catch (e) {
        // «Попробуйте ещё раз» на слишком длинный текст — бесполезный совет: говорим, что не так.
        const code = e instanceof ApiError ? e.code : null;
        setState(code === 'limit_exceeded' ? 'limit' : code === 'validation_failed' ? 'too_long' : 'failed');
      }
    })();
  };

  // Поле растёт под текст, как в мессенджере: одна строка пустым, дальше до пяти строк, потом прокрутка.
  const grow = (el: HTMLTextAreaElement): void => {
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, COMMENT_MAX_HEIGHT)}px`;
  };

  return (
    <div class="comment-box">
      {mode && (
        <div class="composer-mode">
          <span>{t(lang, MODE_LABEL[mode])}</span>
          <button class="link-btn" onClick={() => { haptic.tap(); props.onCancelMode?.(); }}>{t(lang, 'mode_cancel')}</button>
        </div>
      )}
      <div class="comment-row">
        <textarea
          class="comment-input" rows={1} value={text} placeholder={t(lang, mode ? MODE_PLACEHOLDER[mode] : 'comment_placeholder')} maxLength={COMMENT_MAX_LENGTH}
          disabled={disabled || state === 'sending'}
          onInput={(e) => {
            const el = e.currentTarget as HTMLTextAreaElement;
            setText(el.value); setState('idle'); grow(el);
          }}
          // Enter отправляет, Shift+Enter — перенос строки: привычка из мессенджеров.
          onKeyDown={(e) => {
            const ev = e as KeyboardEvent;
            if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); send(); }
          }}
        />
        <button
          class="comment-send" aria-label={t(lang, 'comment_send')} title={t(lang, 'comment_send')}
          disabled={disabled || state === 'sending' || !text.trim()} onClick={send}
        >
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
            <path d="M12 19V6M12 6l-6 6M12 6l6 6" fill="none" stroke="currentColor" stroke-width="2.2"
              stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
      </div>
      {state === 'sent' && <div class="comment-hint">{t(lang, mode ? MODE_SENT[mode] : 'comment_sent')}</div>}
      {state === 'limit' && <div class="comment-hint">{t(lang, 'comment_limit')}</div>}
      {state === 'too_long' && <div class="comment-hint">{t(lang, 'comment_too_long')}</div>}
      {state === 'failed' && <div class="comment-hint">{t(lang, 'comment_failed')}</div>}
    </div>
  );
}

/**
 * Развёрнутая карточка «Сейчас». Разворачивается только взятое дело (спека mini-app): пока человек
 * не нажал «Взял», предложенное дело стоит в списке строкой, как остальные. Раньше развёрнутым
 * всегда было первое дело очереди — человек видел раскрытую карточку того, за что не брался, и
 * «Взял» не менял на экране ничего.
 */
function NowCard(props: {
  task: TaskCard | undefined; lang: string; busy: boolean; startedAt?: string | null; workedSeconds?: number;
  /** Есть ли что брать: «дел нет» и «дела есть, но не взяты» — разные состояния и разные слова. */
  hasQueue?: boolean;
  onStop?: (t: TaskCard) => void;
  onDone: (t: TaskCard) => void; onComment: (t: TaskCard, text: string) => Promise<void>; onOpen: (t: TaskCard) => void;
}): preact.JSX.Element {
  const { task, lang, busy, onDone, onComment, onOpen } = props;
  // Взятое дело читается прямо здесь: раньше в «Сейчас» были только название и «зачем»,
  // а что делать и как понять, что готово, — лишь в карточке за нажатием на название, о котором никто
  // не догадывался. Владелец: «взятую задачу нельзя раскрыть и читать».
  const [more, setMore] = useState(false);
  if (!task) {
    return (
      <div class="now-card empty">
        <div class="eyebrow">{t(lang, 'now')}</div>
        <div class="now-empty-title">{t(lang, props.hasQueue ? 'nothing_taken' : 'nothing_now')}</div>
        <div class="now-empty-hint">{t(lang, props.hasQueue ? 'nothing_taken_hint' : 'nothing_now_hint')}</div>
      </div>
    );
  }
  return (
    <div class="now-card" data-task-id={task.id}>
      <div class="eyebrow">
        {t(lang, 'now')}
        {/* Таймер прямо в развёрнутой карточке: она разворачивается только у взятого дела, и счёт
            идёт здесь же — отдельная строка сверху дублировала бы его (спека mini-app). */}
        {task.status === 'rework' && <span class="tag">{t(lang, 'rework')}</span>}
        {task.is_translated && <span class="tag muted">{t(lang, 'translated')}</span>}
      </div>
      {/* Нажатие на название — карточка дела (спека miniapp-task-card): в «Сейчас» нет только критерия готовности. */}
      <button class="now-title" onClick={() => onOpen(task)}>{task.title}</button>
      {task.why && (
        <div class="now-why"><span class="now-why-label">{t(lang, 'why')}:</span> {task.why}</div>
      )}
      {task.due_date && <div class="now-meta"><Due lang={lang} date={task.due_date} /></div>}
      {(task.description || task.done_criteria) && (
        <button class="link-btn now-more" aria-expanded={more} onClick={() => { haptic.select(); setMore(!more); }}>
          {t(lang, more ? 'now_less' : 'now_more')}
        </button>
      )}
      {more && (
        <>
          {task.done_criteria && (
            <div class="task-block">
              <div class="task-block-label">{t(lang, 'done_criteria')}</div>
              <RichText text={task.done_criteria} class="task-block-text" />
            </div>
          )}
          {task.description && (
            <div class="task-block">
              <div class="task-block-label">{t(lang, 'how')}</div>
              <RichText text={task.description} class="task-block-text task-block-long" />
            </div>
          )}
          {/* Фото, переписка и источники — в карточке целиком: здесь только то, что нужно для работы. */}
          <button class="link-btn now-more" onClick={() => onOpen(task)}>{t(lang, 'now_open_full')}</button>
        </>
      )}
      <div class="now-actions">
        {/* Первой — пара к «Взять»: она же показывает, что работа идёт, и сколько уже. Время внутри
            кнопки, а не отдельной подписью: кнопка и есть то, чем этот счёт останавливают. */}
        {props.onStop && (
          <button class="btn tinted working" disabled={busy} onClick={() => { haptic.tap(); props.onStop!(task); }}>
            <span class="pulse" aria-hidden="true" />
            {t(lang, 'stop')}
            {props.startedAt && <RunningTime startedAt={props.startedAt} workedSeconds={props.workedSeconds} class="btn-time" />}
          </button>
        )}
        <button class="btn tinted" disabled={busy} onClick={() => onDone(task)}>{t(lang, 'finish')}</button>
      </div>
      <CommentBox lang={lang} disabled={busy} onSend={(text) => onComment(task, text)} />
    </div>
  );
}

/** Режим поля ввода: чем станет отправленный текст (спека miniapp-task-actions). */
type ComposerMode = 'question' | 'unclear' | 'decline';
const MODE_LABEL: Record<ComposerMode, StringKey> = {
  question: 'mode_question', unclear: 'mode_unclear', decline: 'mode_decline',
};
const MODE_PLACEHOLDER: Record<ComposerMode, StringKey> = {
  question: 'question_placeholder', unclear: 'unclear_placeholder', decline: 'decline_placeholder',
};
const MODE_SENT: Record<ComposerMode, StringKey> = {
  question: 'question_sent', unclear: 'unclear_sent', decline: 'declined_sent',
};

/** Столько же, сколько принимает сервер (`COMMENT_MAX_LENGTH` в src/core/comments.ts). */
const COMMENT_MAX_LENGTH = 2000;
/** Докуда растёт поле реплики: пять строк, дальше прокрутка внутри него. */
const COMMENT_MAX_HEIGHT = 132;

/** Можно ли вообще открыть эту ссылку: ссылкой рисуем только то, по чему нажатие сработает. */
function openable(url: string | null): boolean {
  if (!url) return false;
  try {
    const p = new URL(url).protocol;
    return p === 'http:' || p === 'https:';
  } catch { return false; }
}

/** Ссылку источника приносит агент — открываем только http(s), чужие схемы игнорируем. */
function openSource(url: string): void {
  try {
    const u = new URL(url);
    if (u.protocol === 'http:' || u.protocol === 'https:') tg()?.openLink?.(u.href);
  } catch { /* не адрес — открывать нечего */ }
}

/** К началу списка: вернувшись из карточки, человек должен увидеть «Сейчас», а не середину очереди. */
function scrollToTop(): void {
  try { window.scrollTo({ top: 0, behavior: 'auto' }); } catch { window.scrollTo(0, 0); }
}

/**
 * Откуда открыли дело (15.10.2026, владелец: «где зашёл в дело в списке, там и вышел» — и дело подсвечено,
 * пока не ткну в другое место). Список на время карточки снимается со страницы целиком, поэтому место
 * запоминаем здесь: где стояла строка на экране и прокрутка страницы, если строки потом не окажется.
 */
let returnSpot: { id: string; top: number | null; y: number } | null = null;

function taskRow(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-task-id="${CSS.escape(id)}"]`);
}

function rememberSpot(id: string): void {
  // top = null: строки на экране не было (открыли из шапки или раздела «Компания») — вернём прокрутку как есть.
  returnSpot = { id, top: taskRow(id)?.getBoundingClientRect().top ?? null, y: window.scrollY };
}

/** Раскрытые разделы («Отложено», «Завершённые», «Когда-нибудь») и доска-фильтр переживают карточку:
 *  иначе дело из раскрытого раздела после возврата оказывалось в свёрнутом, и вернуться было некуда. */
const foldMemory = new Set<string>();
const boardMemory: { board: string | null } = { board: null };
function useFold(key: string): [boolean, (open: boolean) => void] {
  const [open, setOpenState] = useState(foldMemory.has(key));
  return [open, (v: boolean) => { if (v) foldMemory.add(key); else foldMemory.delete(key); setOpenState(v); }];
}

/** Идущие цифры: пересчитываются на устройстве раз в секунду, сервер для этого не дёргается. */
function RunningTime(props: { startedAt: string; workedSeconds?: number; class?: string }): preact.JSX.Element {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [props.startedAt]);
  return <span class={props.class ?? 'running-time'}>{elapsedLabel(props.startedAt, new Date(), props.workedSeconds)}</span>;
}

/**
 * Шапка «сейчас в работе» (спека mini-app). «Взял» ничем не отзывалось: человек нажимал кнопку и
 * дальше не видел ни что он взял, ни сколько с этим сидит, — а слот тем временем занят, и очередь
 * других компаний стоит. Поэтому подпись видна на любом экране приложения, а не только в списке.
 *
 * Время считаем на месте от начала работы — секунду в секунду, от `started_at` с сервера: цифры
 * должны бежать, иначе непонятно, идёт ли счёт. Сервер ради этого не дёргаем.
 */
function RunningBar(props: { running: InProgress; lang: string; onOpen: (taskId: string) => void }): preact.JSX.Element {
  const { running } = props;
  return (
    <button class="running" onClick={() => { haptic.tap(); props.onOpen(running.task_id); }}>
      <RunningTime startedAt={running.started_at} workedSeconds={running.worked_seconds} />
      <span class="running-title">{running.title}</span>
      {running.company && <span class="running-company">{running.company}</span>}
    </button>
  );
}

/**
 * Текст дела с сохранённой структурой (спека miniapp-task-card): абзацы, перечисления и ссылки.
 * Раньше всё это выводилось одной строкой — переносы схлопывались, перечисление было неотличимо от
 * сплошного текста, а ссылку нельзя было нажать. Разметка не разбирается (см. `rich-text.ts`):
 * карточку пишет агент, и его вывод — текст, а не язык разметки.
 */
function RichText(props: { text: string; class?: string }): preact.JSX.Element {
  const blocks = parseRichText(props.text);
  const pieces = (ps: Piece[]): (preact.JSX.Element | string)[] => ps.map((piece, i) => (
    piece.kind === 'link'
      ? <button key={i} class="text-link" onClick={() => { haptic.tap(); openSource(piece.url); }}>{piece.text}</button>
      : piece.text
  ));
  return (
    <div class={props.class ? `rich ${props.class}` : 'rich'}>
      {blocks.map((b, i) => (b.kind === 'list'
        ? (b.ordered
          ? <ol key={i} class="rich-list">{b.items.map((it, j) => <li key={j}>{pieces(it)}</li>)}</ol>
          : <ul key={i} class="rich-list">{b.items.map((it, j) => <li key={j}>{pieces(it)}</li>)}</ul>)
        : (
          <p key={i} class="rich-p">
            {b.lines.map((line, j) => (
              <>
                {j > 0 && <br />}
                {pieces(line)}
              </>
            ))}
          </p>
        )))}
    </div>
  );
}

/** Материалы дела (спека task-context): откуда дело и что о нём известно — на карточке, развёрнутым
 *  списком. Ссылка открывается во встроенном браузере Telegram, у внешнего источника рядом — статус
 *  из слепка, ниже — цитата-основание. */
function Sources(props: { sources: TaskSource[]; lang: string }): preact.JSX.Element | null {
  if (!props.sources.length) return null;
  return (
    <div class="row-sources">
      <div class="sources-label">{t(props.lang, 'sources', { count: props.sources.length })}</div>
      <ul class="source-list">
        {props.sources.map((s) => (
          <li key={s.id}>
            <div class="source-line">
              {openable(s.url)
                ? <button class="source-link" onClick={() => { haptic.tap(); openSource(s.url!); }}>{s.title}</button>
                : <span>{s.title}</span>}
              {s.status && <span class="source-status">{s.status}</span>}
            </div>
            {s.quote && <blockquote class="source-quote">{s.quote}</blockquote>}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Замок у закрытого проекта (спека projects): его дела видит только хозяин. */
function Lock(props: { lang: string }): preact.JSX.Element {
  return (
    <svg class="lock" width="10" height="13" viewBox="0 0 10 13" role="img" aria-label={t(props.lang, 'private_project')}>
      <rect x="0.9" y="5.4" width="8.2" height="7" rx="1.8" fill="currentColor" />
      <path d="M2.8 5.4V3.6a2.2 2.2 0 0 1 4.4 0v1.8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
    </svg>
  );
}

/** «Кто в деле» (спека task-reviewer): постановщик, исполнитель и проверяющий видят друг друга, а
 *  смотрящий — своё место среди них. Проверяющего нет — строки нет. */
function People(props: { people: TaskPeople; lang: string }): preact.JSX.Element {
  const { people, lang } = props;
  const rows: { role: TaskPeople['my_role']; label: StringKey; name: string }[] = [
    { role: 'author', label: 'people_author', name: people.author },
    { role: 'assignee', label: 'people_assignee', name: people.assignee },
    ...(people.reviewer ? [{ role: 'reviewer' as const, label: 'people_reviewer' as const, name: people.reviewer }] : []),
  ];
  return (
    <div class="task-block">
      <div class="task-block-label">{t(lang, 'people')}</div>
      {rows.map((r) => (
        <div key={r.role} class="task-block-text people-row">
          <span class="people-role">{t(lang, r.label)}</span> {r.name}
          {people.my_role === r.role && <span class="people-you"> · {t(lang, 'people_you')}</span>}
        </div>
      ))}
    </div>
  );
}

/** Что сдано: по этому принимают, и об этом итог постановщику (спека task-reviewer). */
function Result(props: { result: TaskResult; lang: string }): preact.JSX.Element | null {
  const { result, lang } = props;
  if (!result.text?.trim() && result.number === null && !result.files) return null;
  return (
    <div class="task-block">
      <div class="task-block-label">{t(lang, 'result')}</div>
      {result.text?.trim() && <RichText text={result.text} class="task-block-text" />}
      {result.number !== null && <div class="task-block-text">{result.number}</div>}
      {result.files > 0 && <div class="task-block-text">{t(lang, 'result_files', { count: result.files })}</div>}
    </div>
  );
}

/** Заголовок проекта внутри раздела: список разложен по проектам (спека projects). */
function ProjectLine(props: { project: TaskProject; lang: string }): preact.JSX.Element {
  return (
    <div class="project-line">
      {props.project.name}
      {props.project.private && <Lock lang={props.lang} />}
    </div>
  );
}

/** Дела раздела по проектам, в том же порядке, в каком они пришли с сервера. */
function byProject(tasks: TaskCard[]): { project: TaskProject | null; tasks: TaskCard[] }[] {
  const groups: { project: TaskProject | null; tasks: TaskCard[] }[] = [];
  for (const task of tasks) {
    const found = groups.find((g) => (g.project?.id ?? '') === (task.project?.id ?? ''));
    if (found) found.tasks.push(task);
    else groups.push({ project: task.project, tasks: [task] });
  }
  return groups;
}

function Chevron(): preact.JSX.Element {
  return (
    <svg class="chevron" width="8" height="13" viewBox="0 0 8 13" aria-hidden="true">
      <path d="M1.5 1.5 6.5 6.5 1.5 11.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  );
}

function Row(props: { task: TaskCard; lang: string; onOpen: (t: TaskCard) => void; who?: string | null }): preact.JSX.Element {
  const { task, lang } = props;
  return (
    <button class="row" data-task-id={task.id} onClick={() => props.onOpen(task)}>
      <div class="row-body">
        {/* Обозначение видно прямо в списке: дело называют по нему, не открывая карточку. */}
        <div class="row-title">
          {/* Новое в деле — реплика или результат не от смотрящего (спека unread-and-deeplink). */}
          {task.unread && <span class="unread-dot" role="img" aria-label={t(lang, 'unread')} />}
          {task.key && <span class="row-key">{task.key}</span>}
          {task.title}
        </div>
        {(props.who || task.due_date || task.status === 'rework' || task.status === 'done' || task.photos > 0) && (
          <div class="row-meta">
            {/* Чьё дело — в списке проекта, где дела разных людей. */}
            {props.who && <span class="meta-text">{props.who}</span>}
            {task.status === 'rework' && <span class="tag">{t(lang, 'rework')}</span>}
            {task.status === 'done' && <span class="tag muted">{t(lang, 'done_tag')}</span>}
            {task.status !== 'done' && <Due lang={lang} date={task.due_date} />}
            {task.photos > 0 && <span class="meta-text">{t(lang, 'photos', { count: task.photos })}</span>}
          </div>
        )}
      </div>
      <Chevron />
    </button>
  );
}

function Group(props: { title: string; count?: number; children: preact.ComponentChildren }): preact.JSX.Element {
  return (
    <section class="group">
      <h2 class="group-header">
        {props.title}
        {props.count !== undefined && <span class="count">{props.count}</span>}
      </h2>
      <div class="group-body">{props.children}</div>
    </section>
  );
}

/**
 * Свёрнутый раздел под списком: «Отложено» — перенесённые дела до их дня, строка
 * показывает новый срок; «Завершённые» у выбранного человека — актуальное сверху,
 * сделанное не мешает. Пустой раздел не показывается вовсе.
 */
function Folded(props: { title: string; lang: string; tasks: TaskCard[]; onOpen: (t: TaskCard) => void }): preact.JSX.Element | null {
  const { lang, tasks } = props;
  const [open, setOpen] = useFold(`folded:${props.title}`);
  if (tasks.length === 0) return null;
  return (
    <section class="group">
      <h2 class="group-header">
        {props.title}
        <span class="count">{tasks.length}</span>
        <button class="header-link" onClick={() => { haptic.select(); setOpen(!open); }}>
          {t(lang, open ? 'hide' : 'show')}
        </button>
      </h2>
      {open && (
        <div class="group-body">
          {tasks.map((task) => <Row key={task.id} task={task} lang={lang} onOpen={props.onOpen} />)}
        </div>
      )}
    </section>
  );
}

/**
 * «Завершённые» (спека completed-list): свёрнутый раздел под списком, тем же движением, что «Отложено».
 * Список грузится по первому нажатию — в основном запросе он не нужен, заглядывают сюда редко.
 */
function Completed(props: {
  lang: string; count: number; tasks: TaskCard[] | null; onToggle: () => void; onOpen: (t: TaskCard) => void;
}): preact.JSX.Element | null {
  const { lang, tasks, count } = props;
  const [open, setOpen] = useFold('completed');
  // Раздел остался раскрытым с прошлого раза, а список ещё не загружен — догружаем, иначе вечное ожидание.
  useEffect(() => { if (open && tasks === null) props.onToggle(); }, []);
  // Нечего показывать — раздела нет вовсе. Число приходит с основным списком, поэтому видно сразу,
  // а не после раскрытия (спека completed-list).
  if (count === 0) return null;
  return (
    <section class="group">
      <h2 class="group-header">
        {t(lang, 'completed')}
        <span class="count">{tasks?.length ?? count}</span>
        <button class="header-link" onClick={() => { haptic.select(); if (!open) props.onToggle(); setOpen(!open); }}>
          {t(lang, open ? 'hide' : 'show')}
        </button>
      </h2>
      {open && (
        <div class="group-body">
          {tasks === null
            ? <div class="spinner" aria-label={t(lang, 'loading')} />
            : tasks.map((task) => <Row key={task.id} task={task} lang={lang} onOpen={props.onOpen} />)}
        </div>
      )}
    </section>
  );
}

/**
 * Раздел «Компания» (спека miniapp-company): люди, проекты и их состав, агенты. Открывается владельцу
 * и админу — кнопки нет у того, кому сервер раздел не отдал.
 */
function CompanySection(props: { data: CompanyResponse; lang: string; onChanged: () => Promise<void>; onOpen: (t: TaskCard) => void }): preact.JSX.Element {
  const { data, lang } = props;
  const [tab, setTabState] = useState<'people' | 'projects' | 'agents'>(companyMemory.tab);
  const setTab = (k: 'people' | 'projects' | 'agents'): void => { companyMemory.tab = k; setTabState(k); };
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<string | null>): Promise<void> => {
    setBusy(true);
    try {
      const said = await fn();
      setNote(said);
      haptic.success();
      await props.onChanged();
    } catch {
      setNote(t(lang, 'company_failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="company">
      <div class="segmented" role="tablist">
        {(['people', 'projects', 'agents'] as const).map((k) => (
          <button key={k} role="tab" aria-selected={tab === k} class={`segment${tab === k ? ' active' : ''}`}
            onClick={() => { haptic.select(); setTab(k); setNote(null); }}>
            {t(lang, k === 'people' ? 'company_people' : k === 'projects' ? 'company_projects' : 'company_agents')}
          </button>
        ))}
      </div>
      {note && <div class="banner">{note}</div>}
      {tab === 'people' && <PeopleTab data={data} lang={lang} busy={busy} run={run} />}
      {tab === 'projects' && <ProjectsTab data={data} lang={lang} onOpen={props.onOpen} />}
      {tab === 'agents' && (
        <Group title={t(lang, 'company_agents')} count={data.agents.length}>
          {data.agents.map((a) => (
            <div key={a.id} class="person-row">
              <span class="person-name">{a.name}</span>
              <span class="person-meta">{a.status === 'paused' ? t(lang, 'agent_paused') : a.owner ?? ''}</span>
            </div>
          ))}
        </Group>
      )}
    </div>
  );
}

/**
 * «Итоги» (спека stats-page): сколько сделано за период, кем и на каком проекте. Числа и списки —
 * ни графиков, ни прогнозов: страница отвечает «сколько», а «почему» остаётся в разговоре.
 */
function StatsSection(props: { lang: string; orgId?: string; named: boolean }): preact.JSX.Element {
  const { lang, orgId } = props;
  const [period, setPeriod] = useState<StatsPeriod>('today');
  const [data, setData] = useState<StatsResponse | null>(null);
  const [failed, setFailed] = useState(false);
  // Чьи задачи раскрыты: один человек за раз — список под строкой, а не отдельный экран.
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setData(null);
    setFailed(false);
    setExpanded(null);
    void api.stats(period, orgId).then(
      (r) => { if (alive) setData(r); },
      () => { if (alive) setFailed(true); },
    );
    return () => { alive = false; };
  }, [period, orgId]);

  // Строка человека или проекта: справа крупно — сколько отработано, под именем словами —
  // сколько закрыто, сдано и в работе. Прежняя строка «10 +4 · 10 ч 33 мин 7 в работе» была частоколом
  // цифр без подписей: владелец не мог прочитать, кто сколько отработал.
  const meta = (r: StatsRow): preact.JSX.Element => (
    <span class="stat-hours">{r.minutes > 0 ? durationLabel(lang, r.minutes) : t(lang, 'stats_no_time')}</span>
  );
  const facts = (r: StatsRow): preact.JSX.Element | null => {
    const parts = [
      r.done > 0 ? t(lang, 'stats_line_done', { n: r.done }) : null,
      r.submitted > 0 ? t(lang, 'stats_line_submitted', { n: r.submitted }) : null,
      r.open > 0 ? t(lang, 'stats_line_open', { n: r.open }) : null,
    ].filter(Boolean);
    return parts.length ? <span class="stat-facts">{parts.join(' · ')}</span> : null;
  };
  const label = (r: StatsRow): preact.JSX.Element => (
    <span class="person-name stat-who"><span class="stat-name">{r.name}</span>{facts(r)}</span>
  );
  // Больше отработал — выше: страница отвечает на «кто сколько отработал».
  const byTime = <T extends StatsRow>(list: T[]): T[] => [...list].sort((a, b) => b.minutes - a.minutes || b.done - a.done);

  const rows = (title: string, list: StatsRow[]): preact.JSX.Element | null => (list.length ? (
    <Group title={title} count={list.length}>
      {byTime(list).map((r) => (
        <div key={r.id} class="person-row">
          {label(r)}
          {meta(r)}
        </div>
      ))}
    </Group>
  ) : null);

  // Строка человека раскрывает, на что ушло его время. Задачи без времени не раскрываются: там нечего
  // показывать, а пустой список выглядел бы как сбой.
  const people = (list: StatsPerson[]): preact.JSX.Element | null => (list.length ? (
    <Group title={t(lang, 'stats_people')} count={list.length}>
      {/* Fragment, а не обёртка: иначе каждая строка стала бы последней в своём блоке и потеряла черту. */}
      {byTime(list).map((r) => (
        <Fragment key={r.id}>
          {r.tasks.length ? (
            <button class="person-row stats-toggle" aria-expanded={expanded === r.id}
              onClick={() => { haptic.select(); setExpanded(expanded === r.id ? null : r.id); }}>
              {label(r)}
              {meta(r)}
            </button>
          ) : (
            <div class="person-row">
              {label(r)}
              {meta(r)}
            </div>
          )}
          {expanded === r.id && r.tasks.map((x, i) => (
            <div key={x.id ?? `none-${i}`} class="person-row stats-task">
              <span class="person-name">
                {x.key && <span class="row-key">{x.key}</span>}
                {x.hidden ? t(lang, 'stats_hidden_task') : x.id === null ? t(lang, 'stats_no_task') : x.title}
              </span>
              <span class="person-meta">{durationLabel(lang, x.minutes)}</span>
            </div>
          ))}
        </Fragment>
      ))}
    </Group>
  ) : null);

  return (
    <div class="company">
      <div class="segmented segmented-wrap" role="tablist">
        {(['today', 'yesterday', '7d', '30d', 'this_month', 'last_month'] as StatsPeriod[]).map((p) => (
          <button key={p} role="tab" aria-selected={period === p} class={`segment${period === p ? ' active' : ''}`}
            onClick={() => { haptic.select(); setPeriod(p); }}>
            {t(lang, `p_${p}` as StringKey)}
          </button>
        ))}
      </div>
      {failed && <div class="banner">{t(lang, 'company_failed')}</div>}
      {!data && !failed && <div class="spinner" aria-label={t(lang, 'loading')} />}
      {data && (
        <>
          {/* Чьи это итоги — когда компаний несколько: числа без имени путаются. */}
          {props.named && <div class="stats-company">{data.org_name}</div>}
          {/* Название месяца рядом с календарным периодом: иначе непонятно, какой месяц в счёте. */}
          {data.label && <div class="stats-label">{data.label}</div>}
          {/* Сутки считаются по поясу компании — это сказано прямо, когда компаний несколько (спека stats-page). */}
          {props.named && <div class="stats-label">{t(lang, 'stats_tz', { tz: data.tz })}</div>}
          <Group title={t(lang, 'stats')}>
            <div class="person-row"><span class="person-name">{t(lang, 'stats_worked')}</span><span class="count">{durationLabel(lang, data.totals.minutes)}</span></div>
            <div class="person-row"><span class="person-name">{t(lang, 'stats_done')}</span><span class="count">{data.totals.done}</span></div>
            <div class="person-row"><span class="person-name">{t(lang, 'stats_submitted')}</span><span class="count">{data.totals.submitted}</span></div>
            <div class="person-row"><span class="person-name">{t(lang, 'stats_dropped')}</span><span class="count">{data.totals.dropped}</span></div>
          </Group>
          {/* Откуда время: таймер в деле. Кто его не включает, у того «время не записано», а не ноль работы. */}
          <div class="stats-label">{t(lang, 'stats_time_note')}</div>
          {/* Пусто за период — так и сказано, без придумывания. */}
          {data.totals.done === 0 && data.totals.submitted === 0 && <div class="banner">{t(lang, 'stats_empty')}</div>}
          {data.whole_org && people(data.people)}
          {data.whole_org && rows(t(lang, 'stats_projects'), data.projects.filter((p) => p.done + p.submitted + p.open + p.minutes > 0))}
        </>
      )}
    </div>
  );
}

/**
 * Только что выпущенный токен — один раз, с «Скопировать» и предупреждением. Общий для токенов чтения и
 * токенов агентов. Буфер обмена есть не в каждом WebView Telegram: не вышло — токен остаётся
 * выделяемым текстом.
 */
function IssuedToken(props: { lang: string; title: string; token: string; onDone: () => void }): preact.JSX.Element {
  const { lang, title, token, onDone } = props;
  const [copied, setCopied] = useState<'yes' | 'manual' | null>(null);
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(token);
      haptic.success();
      setCopied('yes');
    } catch {
      setCopied('manual');
    }
  };
  return (
    <Group title={title}>
      <div class="confirm">
        <p>{t(lang, 'programs_once')}</p>
        <code class="token-value">{token}</code>
        {copied === 'yes' && <p>{t(lang, 'programs_copied')}</p>}
        {copied === 'manual' && <p>{t(lang, 'programs_copy_manual')}</p>}
        <div class="add-form token-actions">
          <button class="primary" onClick={() => { void copy(); }}>{t(lang, 'programs_copy')}</button>
          <button class="secondary" onClick={() => { haptic.tap(); onDone(); }}>{t(lang, 'programs_done')}</button>
        </div>
      </div>
    </Group>
  );
}

/**
 * «Доступ для программ» (спека read-tokens): токен только на чтение для программы на компьютере
 * человека. Выпускает и отзывает его сам человек здесь — не в разговоре с Claude, чтобы токен не
 * попал в переписку модели. Сам токен виден один раз, сразу после выпуска; список его не содержит.
 */
function ReadTokensSection(props: { lang: string }): preact.JSX.Element {
  const { lang } = props;
  const [tokens, setTokens] = useState<ReadToken[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [label, setLabel] = useState('');
  const [note, setNote] = useState<string | null>(null);
  // Только что выпущенный токен: живёт в памяти экрана, пока человек не нажмёт «Готово».
  const [issued, setIssued] = useState<{ label: string; token: string } | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try { setTokens(await api.readTokens()); setFailed(false); } catch { setFailed(true); }
  }, []);
  useEffect(() => { void reload(); }, [reload]);

  const issue = async (): Promise<void> => {
    const name = label.trim();
    if (!name) return;
    setBusy(true);
    setNote(null);
    try {
      const r = await api.issueReadToken(name);
      setIssued({ label: name, token: r.token });
      setLabel('');
      haptic.success();
      await reload();
    } catch (e) {
      const code = e instanceof ApiError ? e.code : null;
      setNote(t(lang, code === 'limit_exceeded' ? 'programs_limit' : code === 'stale_session' ? 'programs_fresh_app' : 'company_failed'));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (id: string): Promise<void> => {
    setBusy(true);
    setNote(null);
    try {
      await api.revokeReadToken(id);
      haptic.success();
      setConfirming(null);
      await reload();
    } catch {
      setNote(t(lang, 'company_failed'));
    } finally {
      setBusy(false);
    }
  };

  const example = `curl -H "Authorization: Bearer tkr_…" "${location.origin}/api/read/changes?org=<id>&cursor=<cursor>"`;

  return (
    <div class="company">
      <div class="stats-label">{t(lang, 'programs_why')}</div>
      {note && <div class="banner">{note}</div>}
      {issued && <IssuedToken lang={lang} title={issued.label} token={issued.token} onDone={() => setIssued(null)} />}
      {failed && <div class="banner">{t(lang, 'company_failed')}</div>}
      {!tokens && !failed && <div class="spinner" aria-label={t(lang, 'loading')} />}
      {tokens && (
        <Group title={t(lang, 'programs_list')} count={tokens.length}>
          {!tokens.length && <div class="person-row"><span class="person-name">{t(lang, 'programs_empty')}</span></div>}
          {tokens.map((tk) => (
            <div key={tk.id} class="person-row">
              <span class="person-name stat-who">
                <span class="stat-name">{tk.label}</span>
                <span class="stat-facts">
                  {t(lang, 'programs_created', { when: noteTime(lang, tk.created_at) })}
                  {' · '}
                  {tk.last_used_at ? t(lang, 'programs_used', { when: noteTime(lang, tk.last_used_at) }) : t(lang, 'programs_never_used')}
                </span>
              </span>
              {confirming !== tk.id && (
                <button class="row-action" disabled={busy} onClick={() => { haptic.tap(); setConfirming(tk.id); }}>{t(lang, 'programs_revoke')}</button>
              )}
              {confirming === tk.id && (
                <div class="confirm token-confirm">
                  <p>{t(lang, 'programs_revoke_confirm', { label: tk.label })}</p>
                  <button class="danger" disabled={busy} onClick={() => { void revoke(tk.id); }}>{t(lang, 'programs_revoke')}</button>
                  <button class="secondary" onClick={() => setConfirming(null)}>{t(lang, 'cancel')}</button>
                </div>
              )}
            </div>
          ))}
        </Group>
      )}
      <Group title={t(lang, 'programs_issue')}>
        <div class="add-form">
          <input type="text" maxLength={100} value={label} placeholder={t(lang, 'programs_label')}
            onInput={(e) => setLabel((e.target as HTMLInputElement).value)} />
          <button class="primary" disabled={busy || !label.trim()} onClick={() => { void issue(); }}>{t(lang, 'programs_issue')}</button>
        </div>
      </Group>
      <Group title={t(lang, 'programs_example')}>
        <div class="confirm"><code class="token-value">{example}</code></div>
      </Group>
    </div>
  );
}

/**
 * Токены агентов (спека agent-tokens): программа на сервере ставит задачи и тревоги от имени агента.
 * Раздел — только владельцу компании: роль приходит с сервера, приложение её не угадывает, а ручки
 * токенов сами держат границу (админу они ответят 403). Сам токен виден один раз, сразу после выпуска.
 */
function AgentTokensSection(props: { lang: string; orgId: string }): preact.JSX.Element | null {
  const { lang, orgId } = props;
  // null — ещё не знаем, владелец ли; агенты компании — из того же ответа, что и роль.
  const [agents, setAgents] = useState<CompanyAgent[] | null>(null);
  const [tokens, setTokens] = useState<AgentToken[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [agent, setAgent] = useState('');
  const [label, setLabel] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [issued, setIssued] = useState<{ label: string; token: string } | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try { setTokens(await api.agentTokens(orgId)); setFailed(false); } catch { setFailed(true); }
  }, [orgId]);
  useEffect(() => {
    let alive = true;
    setAgents(null);
    void (async () => {
      try {
        const company = await api.company(orgId);
        if (!alive || company.role !== 'owner') return;
        setAgents(company.agents);
        setAgent((cur) => (company.agents.some((a) => a.id === cur) ? cur : company.agents[0]?.id ?? ''));
        await reload();
      } catch {
        // Не управляет компанией — раздела нет вовсе, как и кнопки «Компания».
      }
    })();
    return () => { alive = false; };
  }, [orgId, reload]);

  if (!agents) return null;

  const issue = async (): Promise<void> => {
    const name = label.trim();
    if (!name || !agent) return;
    setBusy(true);
    setNote(null);
    try {
      const r = await api.issueAgentToken(orgId, agent, name);
      setIssued({ label: name, token: r.token });
      setLabel('');
      haptic.success();
      await reload();
    } catch (e) {
      const code = e instanceof ApiError ? e.code : null;
      setNote(t(lang, code === 'limit_exceeded' ? 'agent_tokens_limit' : code === 'stale_session' ? 'programs_fresh_app' : 'company_failed'));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (id: string): Promise<void> => {
    setBusy(true);
    setNote(null);
    try {
      await api.revokeAgentToken(orgId, id);
      haptic.success();
      setConfirming(null);
      await reload();
    } catch {
      setNote(t(lang, 'company_failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="company agent-tokens">
      <div class="stats-company">{t(lang, 'agent_tokens')}</div>
      <div class="stats-label">{t(lang, 'agent_tokens_why')}</div>
      {note && <div class="banner">{note}</div>}
      {issued && <IssuedToken lang={lang} title={issued.label} token={issued.token} onDone={() => setIssued(null)} />}
      {failed && <div class="banner">{t(lang, 'company_failed')}</div>}
      {!tokens && !failed && <div class="spinner" aria-label={t(lang, 'loading')} />}
      {tokens && (
        <Group title={t(lang, 'agent_tokens')} count={tokens.length}>
          {!tokens.length && <div class="person-row"><span class="person-name">{t(lang, 'agent_tokens_empty')}</span></div>}
          {tokens.map((tk) => (
            <div key={tk.id} class="person-row">
              <span class="person-name stat-who">
                <span class="stat-name">{tk.label}</span>
                <span class="stat-facts">
                  {t(lang, 'agent_tokens_agent', { name: tk.agent_name })}
                  {' · '}
                  {t(lang, 'programs_created', { when: noteTime(lang, tk.created_at) })}
                  {' · '}
                  {t(lang, 'agent_tokens_until', { date: dayDate(lang, tk.expires_at) })}
                  {' · '}
                  {tk.last_used_at ? t(lang, 'programs_used', { when: noteTime(lang, tk.last_used_at) }) : t(lang, 'programs_never_used')}
                </span>
              </span>
              {confirming !== tk.id && (
                <button class="row-action" disabled={busy} onClick={() => { haptic.tap(); setConfirming(tk.id); }}>{t(lang, 'programs_revoke')}</button>
              )}
              {confirming === tk.id && (
                <div class="confirm token-confirm">
                  <p>{t(lang, 'agent_tokens_revoke_confirm', { label: tk.label })}</p>
                  <button class="danger" disabled={busy} onClick={() => { void revoke(tk.id); }}>{t(lang, 'programs_revoke')}</button>
                  <button class="secondary" onClick={() => setConfirming(null)}>{t(lang, 'cancel')}</button>
                </div>
              )}
            </div>
          ))}
        </Group>
      )}
      <Group title={t(lang, 'agent_tokens_issue')}>
        {!agents.length && <div class="person-row"><span class="person-name">{t(lang, 'agent_tokens_no_agents')}</span></div>}
        {agents.length > 0 && (
          <div class="add-form">
            <select aria-label={t(lang, 'agent_tokens_pick')} value={agent} onChange={(e) => setAgent((e.target as HTMLSelectElement).value)}>
              {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
            <input type="text" maxLength={100} value={label} placeholder={t(lang, 'agent_tokens_label')}
              onInput={(e) => setLabel((e.target as HTMLInputElement).value)} />
            <button class="primary" disabled={busy || !agent || !label.trim()} onClick={() => { void issue(); }}>{t(lang, 'agent_tokens_issue')}</button>
          </div>
        )}
      </Group>
    </div>
  );
}

type RunFn = (fn: () => Promise<string | null>) => Promise<void>;

/**
 * Люди компании (спека miniapp-company): приложение отражает, а не заводит. Пригласить
 * человека и вывести его можно только разговором с агентом — там называют, кто он и что закрывает,
 * а форма из трёх полей контекста не даёт и профиль оставляет пустым.
 */
function PeopleTab(props: { data: CompanyResponse; lang: string; busy: boolean; run: RunFn }): preact.JSX.Element {
  const { data, lang, busy, run } = props;
  // Своё поле человек правит сам: у исполнителя может не быть агента вовсе, а сказать о себе он вправе.
  const [editing, setEditing] = useState(false);
  const [about, setAbout] = useState('');

  return (
    <Group title={t(lang, 'company_people')} count={data.people.length}>
      {data.people.map((p) => (
        <div key={p.id} class="person-row">
          {p.me ? (
            <button class="person-name person-open" onClick={() => { haptic.select(); setEditing(!editing); setAbout(p.about ?? ''); }}>
              {p.name}
              <span class="person-about">{p.about ?? t(lang, 'about_empty')}</span>
            </button>
          ) : (
            <span class="person-name person-open">
              {p.name}
              <span class="person-about">{p.about ?? t(lang, 'about_empty')}</span>
              {seenLabel(lang, p) && <span class="person-about">{seenLabel(lang, p)}</span>}
            </span>
          )}
          <span class="person-meta">
            {p.open > 0 && <span class="count">{p.open}</span>}
            {!p.in_telegram && <span class="person-warn">{t(lang, 'not_in_bot')}</span>}
          </span>
          {p.me && editing && (
            <div class="add-form">
              <textarea rows={3} value={about} placeholder={t(lang, 'about_placeholder')}
                onInput={(e) => setAbout((e.target as HTMLTextAreaElement).value)} />
              <button class="primary" disabled={busy} onClick={() => {
                const text = about.trim();
                setEditing(false);
                void run(async () => {
                  await api.setAbout(data.org_id, p.id, text || null);
                  return t(lang, 'about_saved');
                });
              }}>{t(lang, 'about_save')}</button>
              <button class="secondary" onClick={() => setEditing(false)}>{t(lang, 'cancel')}</button>
            </div>
          )}
        </div>
      ))}
      <div class="hint-line">{t(lang, 'people_hint')}</div>
    </Group>
  );
}

/** Проекты компании: что есть и кто в них. Заводят и меняют состав разговором с агентом. */
/** Что было открыто в «Компании», пока смотрели дело: возврат из карточки — туда же. */
const companyMemory: { tab: 'people' | 'projects' | 'agents'; project: string | null } = { tab: 'people', project: null };

/**
 * Проекты компании. Нажатие открывает дела проекта — чьё, какое, срок, — и по делу
 * можно провалиться в карточку. Раньше раскрывалась только строка доступа («видит вся компания»), и
 * число рядом с проектом (все его открытые дела) не с чем было сверить: на главном экране у того же
 * проекта стоит число твоих дел.
 */
function ProjectsTab(props: { data: CompanyResponse; lang: string; onOpen: (t: TaskCard) => void }): preact.JSX.Element {
  const { data, lang } = props;
  const [open, setOpenState] = useState<string | null>(companyMemory.project);
  const setOpen = (id: string | null): void => { companyMemory.project = id; setOpenState(id); };
  const [tasks, setTasks] = useState<ProjectTasksResponse['tasks'] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!open) { setTasks(null); return undefined; }
    let alive = true;
    setTasks(null);
    setFailed(false);
    void api.projectTasks(open).then((r) => { if (alive) setTasks(r.tasks); }, () => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [open]);

  return (
    <Group title={t(lang, 'company_projects')} count={data.projects.length}>
      {data.projects.map((p) => (
        <div key={p.id} class="project-row">
          <button class="project-head" aria-expanded={open === p.id} onClick={() => { haptic.select(); setOpen(open === p.id ? null : p.id); }}>
            <span class="row-key">{p.key}</span>
            <span class="person-name">{p.name}</span>
            {p.open > 0 && <span class="person-meta">{t(lang, 'project_open_count', { n: p.open })}</span>}
          </button>
          {open === p.id && (
            <div class="project-members">
              {p.private
                ? p.members.map((m) => <div key={m.user_id} class="person-row"><span class="person-name">{m.name}</span></div>)
                : <p class="person-meta">{t(lang, 'project_open_all')}</p>}
              {p.private && p.members.length === 0 && <p class="person-meta">{t(lang, 'project_only_owner')}</p>}
              {failed && <div class="group-empty">{t(lang, 'card_failed')}</div>}
              {!tasks && !failed && <div class="spinner" aria-label={t(lang, 'loading')} />}
              {tasks && (tasks.length
                ? tasks.map((task) => <Row key={task.id} task={task} lang={lang} who={task.assignee_name} onOpen={props.onOpen} />)
                : <div class="group-empty">{t(lang, 'project_no_tasks')}</div>)}
            </div>
          )}
        </div>
      ))}
      <div class="hint-line">{t(lang, 'projects_hint')}</div>
    </Group>
  );
}

function CompanyView(props: {
  lists: CompanyLists; lang: string; busyIds: Set<string>; offline: boolean; projects: Board[]; people: Person[];
  /** С какой минуты идёт взятое дело — для таймера в развёрнутой карточке. */
  startedAt?: string | null;
  /** Сколько уже наработано по нему прежде: таймер показывает всё время, а не последний подход. */
  workedSeconds?: number;
  onStop: (t: TaskCard) => void;
  onDone: (t: TaskCard) => void; onComment: (t: TaskCard, text: string) => Promise<void>; onOpen: (t: TaskCard) => void;
  completed: TaskCard[] | null; completedCount: number; onLoadCompleted: () => void;
  /** Чей список смотрим: null — свой. Хранится у App: карточка дела заменяет этот экран целиком, и
   *  выбор, живший здесь, пропадал — «Назад» из дела сотрудника приводил в свой список (30.09). */
  person: string | null; onPerson: (id: string | null) => void;
}): preact.JSX.Element {
  const { lists, lang, busyIds, offline, onDone, onComment, onOpen, projects, people } = props;
  // Разворачиваем только то, что человек взял. Предложенное делом очереди остаётся строкой: пока
  // «Взял» не нажато, дело ничем не отличается от других, и показывать его раскрытым нечестно.
  const taken = lists.now.find((t) => t.status === 'in_progress');
  const offered = lists.now.filter((t) => t.status !== 'in_progress');
  // Чей список смотрим: null — свой. Владелец и админ видят, что в работе у людей (только чтение).
  const { person, onPerson: setPerson } = props;
  const [theirs, setTheirs] = useState<{ name: string; tasks: TaskCard[] } | null>(null);
  const [theirsFailed, setTheirsFailed] = useState(false);

  useEffect(() => {
    if (!person) { setTheirs(null); setTheirsFailed(false); return undefined; }
    let alive = true;
    setTheirs(null);
    setTheirsFailed(false);
    void (async () => {
      try {
        const r = await api.personTasks(person);
        if (alive) setTheirs({ name: r.name, tasks: r.tasks });
      } catch {
        if (alive) setTheirsFailed(true);
      }
    })();
    return () => { alive = false; };
  }, [person]);
  // Открыл дело из списка человека — точка на его строке гаснет здесь же (спека unread-and-deeplink):
  // список человека живёт в своём состоянии и перечитывается только при смене человека.
  const openTheirs = (task: TaskCard): void => {
    if (task.unread) {
      setTheirs((prev) => (prev ? { ...prev, tasks: prev.tasks.map((x) => (x.id === task.id ? { ...x, unread: false } : x)) } : prev));
    }
    onOpen(task);
  };
  // Доска, по которой отфильтрован список: null — все. Дел стало много, и без фильтра свои закрытые
  // дела перемешиваются с рабочими (спека projects-stage2).
  const [boardState, setBoardState] = useState<string | null>(boardMemory.board);
  const setBoard = (id: string | null): void => { boardMemory.board = id; setBoardState(id); };
  // Доска из другого пространства здесь не фильтр: список был бы пуст без видимой причины.
  const board = boardState && projects.some((b) => b.id === boardState) ? boardState : null;
  const onBoard = (list: TaskCard[]): TaskCard[] => (board ? list.filter((t) => t.project?.id === board) : list);
  return (
    <>
      {!person && (
        <NowCard
          task={taken} lang={lang} busy={offline || (taken ? busyIds.has(taken.id) : false)}
          hasQueue={offered.length > 0 || lists.queue.length > 0}
          startedAt={props.startedAt} workedSeconds={props.workedSeconds}
          onDone={onDone} onComment={onComment} onOpen={onOpen} onStop={props.onStop}
        />
      )}
      {people.length > 0 && (
        <div class="projects" role="tablist">
          <button class={`project-chip${person === null ? ' on' : ''}`} onClick={() => { haptic.select(); foldMemory.clear(); setPerson(null); }}>
            {t(lang, 'my_tasks')}
          </button>
          {people.map((p) => (
            <button key={p.id} class={`project-chip${person === p.id ? ' on' : ''}`}
              onClick={() => { haptic.select(); foldMemory.clear(); setPerson(p.id); }}>
              {p.unread && <span class="unread-dot" role="img" aria-label={t(lang, 'unread')} />}
              {p.name} <span class="project-count">{p.open}</span>
              {p.invited && <span class="project-count" title={t(lang, 'not_in_bot')}>•</span>}
            </button>
          ))}
        </div>
      )}
      {person && (
        theirsFailed ? <div class="group-empty">{t(lang, 'card_failed')}</div>
          : !theirs ? <div class="center-screen"><div class="spinner" aria-label={t(lang, 'loading')} /></div>
            : (
              // У человека сверху только актуальное, завершённое — свёрнутым разделом ниже.
              <>
                <Group title={t(lang, 'their_tasks', { name: theirs.name })} count={theirs.tasks.filter((x) => x.status !== 'done').length}>
                  {people.find((p) => p.id === person)?.invited && (
                    <div class="group-empty">{t(lang, 'not_in_bot')}</div>
                  )}
                  {theirs.tasks.some((x) => x.status !== 'done')
                    ? theirs.tasks.filter((x) => x.status !== 'done').map((task) => <Row key={task.id} task={task} lang={lang} onOpen={openTheirs} />)
                    : <div class="group-empty">{t(lang, 'their_tasks_empty')}</div>}
                </Group>
                <Folded title={t(lang, 'completed')} lang={lang} tasks={theirs.tasks.filter((x) => x.status === 'done')} onOpen={openTheirs} />
              </>
            )
      )}
      {!person && projects.length > 1 && (
        <div class="projects" role="tablist">
          <button class={`project-chip${board === null ? ' on' : ''}`} onClick={() => { haptic.select(); setBoard(null); }}>
            {t(lang, 'all_projects')}
          </button>
          {projects.map((b) => (
            <button key={b.id} class={`project-chip${board === b.id ? ' on' : ''}`}
              onClick={() => { haptic.select(); setBoard(b.id); }}>
              {b.private && <Lock lang={lang} />}{b.name} <span class="project-count">{b.open}</span>
            </button>
          ))}
        </div>
      )}
      {!person && SECTIONS.map((s: Section) => {
        // Дело, предложенное очередью, но не взятое, стоит первым в «В очереди»: оно следующее,
        // но развёрнутым его не показываем — за него ещё не взялись.
        const tasks = s === 'queue' ? [...onBoard(offered), ...onBoard(lists[s])] : onBoard(lists[s]);
        return tasks.length > 0 && (
          <Group key={s} title={t(lang, s as StringKey)} count={tasks.length}>
            {byProject(tasks).flatMap((g) => [
              ...(g.project ? [<ProjectLine key={`p:${g.project.id}`} project={g.project} lang={lang} />] : []),
              ...g.tasks.map((task) => <Row key={task.id} task={task} lang={lang} onOpen={onOpen} />),
            ])}
          </Group>
        );
      })}
      {!person && <Folded title={t(lang, 'postponed_section')} lang={lang} tasks={onBoard(lists.scheduled ?? [])} onOpen={onOpen} />}
      {!person && (
        <Completed lang={lang} count={props.completedCount} tasks={props.completed} onToggle={props.onLoadCompleted} onOpen={onOpen} />
      )}
    </>
  );
}

function CheckCircle(props: { checked: boolean; disabled: boolean; onClick: () => void }): preact.JSX.Element {
  return (
    <button class={`check${props.checked ? ' checked' : ''}`} disabled={props.disabled} onClick={props.onClick} aria-label="done">
      <svg width="14" height="11" viewBox="0 0 14 11" aria-hidden="true">
        <path d="M1.5 5.5 5 9 12.5 1.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </button>
  );
}

function Grip(props: { onPointerDown: (e: PointerEvent) => void }): preact.JSX.Element {
  return (
    <span class="grip" onPointerDown={props.onPointerDown} aria-hidden="true">
      <svg width="14" height="10" viewBox="0 0 14 10"><path d="M1 1h12M1 5h12M1 9h12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" /></svg>
    </span>
  );
}

function Star(props: { on: boolean; disabled: boolean; label: string; onClick: () => void }): preact.JSX.Element {
  return (
    <button class={`icon-btn star${props.on ? ' on' : ''}`} disabled={props.disabled} onClick={props.onClick} aria-label={props.label} aria-pressed={props.on}>
      <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 3.2l2.6 5.5 6 .8-4.4 4.1 1.1 5.9L12 16.6l-5.3 2.9 1.1-5.9L3.4 9.5l6-.8z"
          fill={props.on ? 'currentColor' : 'none'} stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" />
      </svg>
    </button>
  );
}

/** Пометка «рабочее» у личного дела (спека owner-feedback): название компании, нажатие — снять. */
function SharedChip(props: { name: string; disabled: boolean; lang: string; onClick: () => void }): preact.JSX.Element {
  return (
    <button
      class="shared-chip" disabled={props.disabled} onClick={props.onClick}
      title={t(props.lang, 'shared_label', { org: props.name })} aria-label={t(props.lang, 'unshare')}
    >
      {props.name}
    </button>
  );
}

// Разделы личного: сначала важное, потом по виду; отложенное свёрнуто.
type Bucket = 'important' | 'do' | 'decide' | 'waiting' | 'someday';
const BUCKETS: Bucket[] = ['important', 'do', 'decide', 'waiting', 'someday'];
const BUCKET_LABEL: Record<Bucket, StringKey> = {
  important: 'important', do: 'cat_do', decide: 'cat_decide', waiting: 'cat_waiting', someday: 'cat_someday',
};
function bucketOf(task: TaskCard): Bucket {
  if (task.waiting_for !== null || task.status === 'waiting') return 'waiting';
  if (task.category === 'someday') return 'someday';
  if (task.important) return 'important';
  return task.category === 'decide' ? 'decide' : 'do';
}

function PersonalView(props: {
  tasks: TaskCard[]; lang: string; offline: boolean; busyIds: Set<string>;
  onDone: (t: TaskCard) => void; onReorder: (ids: string[]) => void; onImportant: (t: TaskCard, on: boolean) => void;
  onUnshare: (t: TaskCard) => void; onOpen: (t: TaskCard) => void;
  completed: TaskCard[] | null; completedCount: number; onLoadCompleted: () => void;
}): preact.JSX.Element {
  const { tasks, lang, offline, busyIds, onDone, onReorder, onImportant, onUnshare, onOpen } = props;
  const [order, setOrder] = useState<TaskCard[]>(tasks);
  const [doneIds, setDoneIds] = useState<Set<string>>(new Set());
  const [showSomeday, setShowSomeday] = useFold('someday');
  const drag = useRef<{ id: string } | null>(null);
  useEffect(() => setOrder(tasks), [tasks]);

  if (order.length === 0) {
    return (
      <div class="empty-state">
        <div class="empty-title">{t(lang, 'personal_empty')}</div>
        <div class="empty-hint">{t(lang, 'personal_empty_hint')}</div>
      </div>
    );
  }

  // Перетаскивание — внутри раздела.
  const onGripDown = (id: string) => (e: PointerEvent): void => {
    if (offline) return;
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    drag.current = { id };
    haptic.select();
  };
  const onPointerMove = (e: PointerEvent): void => {
    const st = drag.current;
    if (!st) return;
    const over = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('[data-task-id]');
    const overId = over?.dataset.taskId;
    if (!overId || overId === st.id) return;
    setOrder((prev) => {
      const from = prev.findIndex((x) => x.id === st.id);
      const to = prev.findIndex((x) => x.id === overId);
      if (from < 0 || to < 0 || bucketOf(prev[from]!) !== bucketOf(prev[to]!)) return prev;
      const next = [...prev];
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item!);
      haptic.select();
      return next;
    });
  };
  const onPointerUp = (): void => {
    if (!drag.current) return;
    drag.current = null;
    onReorder(order.map((x) => x.id));
  };

  const complete = (task: TaskCard): void => {
    // Дело с обязательным результатом круг не закрывает: onDone откроет карточку с полем результата.
    if (task.expected_result?.required) { onDone(task); return; }
    setDoneIds((prev) => new Set(prev).add(task.id));
    haptic.success();
    setTimeout(() => onDone(task), 350);
  };

  return (
    <div onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
      {BUCKETS.map((b) => {
        const items = order.filter((x) => bucketOf(x) === b);
        if (!items.length) return null;
        const collapsed = b === 'someday' && !showSomeday;
        return (
          <section key={b} class={`group${b === 'important' ? ' important' : ''}`}>
            <h2 class="group-header">
              {b === 'important' && <span class="star-mark" aria-hidden="true">★</span>}
              {t(lang, BUCKET_LABEL[b])}
              <span class="count">{items.length}</span>
              {b === 'someday' && (
                <button class="header-link" onClick={() => { haptic.select(); setShowSomeday(!showSomeday); }}>
                  {t(lang, showSomeday ? 'hide' : 'show')}
                </button>
              )}
            </h2>
            {!collapsed && (
              <div class="group-body">
                {items.map((task) => {
                  const checked = doneIds.has(task.id);
                  const busy = offline || busyIds.has(task.id);
                  const due = dueLabel(lang, task.due_date);
                  return (
                    // Ключ — на строке: список личного перетаскивается, порядок элементов меняется.
                    <div key={task.id} class={`row personal${checked ? ' is-done' : ''}`} data-task-id={task.id}>
                      <CheckCircle checked={checked} disabled={busy || checked} onClick={() => complete(task)} />
                      <button class="row-body row-open" onClick={() => onOpen(task)}>
                        <div class="row-title">{task.title}</div>
                        {(b === 'waiting' || due) && (
                          <div class="row-meta">
                            {b === 'waiting' && task.next_check_at && (
                              <span class="due nowrap">{t(lang, 'check_on', { date: shortDate(lang, task.next_check_at) })}</span>
                            )}
                            {b === 'waiting' && task.waiting_for && <span class="meta-text">{task.waiting_for}</span>}
                            {due && <span class={`due${due.past ? ' past' : ''}${due.soon ? ' soon' : ''}`}>{due.text}</span>}
                          </div>
                        )}
                      </button>
                      {task.shared_with && (
                        <SharedChip name={task.shared_with.name} disabled={busy} lang={lang}
                          onClick={() => { haptic.tap(); onUnshare(task); }} />
                      )}
                      {b !== 'waiting' && (
                        <Star on={task.important} disabled={busy} label={t(lang, 'mark_important')}
                          onClick={() => { haptic.tap(); onImportant(task, !task.important); }} />
                      )}
                      <Grip onPointerDown={onGripDown(task.id)} />
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        );
      })}
      <Completed lang={lang} count={props.completedCount} tasks={props.completed} onToggle={props.onLoadCompleted} onOpen={props.onOpen} />
    </div>
  );
}

/** Открытая карточка дела: содержимое приходит отдельным запросом (`GET /app/api/tasks/:id`), пока его
 *  нет — ожидание или ошибка. `personal` — из какого пространства открыли: у личного дела свои действия. */
interface OpenCard {
  id: string; personal: boolean; task: TaskCard | null; notes: TaskNote[]; actions: TaskAction[]; failed: boolean;
  /** «Завершить» нажато в списке у дела с обязательным результатом: поле результата открыто сразу (спека required-result). */
  finish?: boolean;
}

// Подпись к записи, которая не просто реплика: вопрос, «непонятно», ответ, причина возврата.
const NOTE_KIND: Record<string, StringKey> = {
  question: 'note_question', unclear: 'note_unclear', answer: 'note_answer', rework_reason: 'note_rework',
};

/** Записи по делу: что писали люди и что отвечал агент. Без них «Написать» — письмо в никуда. */
function Notes(props: { notes: TaskNote[]; lang: string }): preact.JSX.Element | null {
  if (!props.notes.length) return null;
  return (
    <div class="task-block">
      <div class="task-block-label">{t(props.lang, 'notes')}</div>
      <ul class="note-list">
        {props.notes.map((n) => (
          <li key={n.id} class={`note${n.mine ? ' mine' : ''}`}>
            <div class="note-author">
              {n.mine ? t(props.lang, 'note_mine') : n.author}
              <span class="note-time"> · {noteTime(props.lang, n.at)}</span>
            </div>
            {NOTE_KIND[n.kind] && (
              <div class="note-kind">
                {t(props.lang, NOTE_KIND[n.kind]!)}
                {n.answered === false && <span class="tag">{t(props.lang, 'note_waiting_answer')}</span>}
              </div>
            )}
            <RichText text={n.text} class="note-text" />
          </li>
        ))}
      </ul>
    </div>
  );
}

// Состояние дела человеческими словами. Чего в списке не бывает (draft, закрытые) — без подписи.
const STATE_LABEL: Record<string, StringKey> = {
  active: 'state_in_progress', in_progress: 'state_in_progress', blocked: 'state_blocked',
  ready: 'state_ready', scheduled: 'state_scheduled', rework: 'state_rework',
  waiting_external: 'waiting_external', submitted: 'submitted', waiting: 'cat_waiting',
};

/** Экран карточки дела (спека miniapp-task-card): дело целиком — зачем, что считается сделанным,
 *  материалы, фото, реплика. Возврат — кнопкой «Назад» Telegram; сама себя карточка не обновляет. */
/** Статусы, из которых сдача разрешена (`submit.from`, src/core/lifecycle.ts). */
/** Быстрые даты переноса: считает их сервер рабочим календарём человека. */
const postponeChoices: { code: PostponeChoice; key: StringKey }[] = [
  { code: 'tomorrow', key: 'postpone_tomorrow' },
  { code: 'day_after', key: 'postpone_day_after' },
  { code: 'week', key: 'postpone_week' },
];

function TaskScreen(props: {
  card: OpenCard; lang: string; busy: boolean; onRetry: () => void;
  onDone: (t: TaskCard) => void; onComment: (t: TaskCard, text: string) => Promise<void>;
  /** Сдача с результатом из поля на карточке; отказ сервера летит в поле. */
  onSubmitResult: (t: TaskCard, result: { text: string }) => Promise<void>;
  onPhotos: (t: TaskCard) => Promise<void>;
  onImportant: (t: TaskCard, on: boolean) => void; onUnshare: (t: TaskCard) => void;
  onReopen: (t: TaskCard) => void; onTake: (t: TaskCard) => void; onStop: (t: TaskCard) => void;
  /** Дело в работе: если это оно, кнопка «Остановить» показывает идущее время. */
  running?: InProgress | null;
  onDefer: (t: TaskCard, someday: boolean) => void;
  error: StringKey | null;
  onPostpone: (t: TaskCard, to: PostponeChoice) => void;
  onQuestion: (t: TaskCard, text: string, kind: 'question' | 'unclear') => Promise<void>;
  onDecline: (t: TaskCard, text: string) => Promise<void>;
  onSetDue: (t: TaskCard, date: string) => void;
  onRequestDue: (t: TaskCard) => void;
}): preact.JSX.Element {
  const { card, lang, busy } = props;
  const [mode, setMode] = useState<ComposerMode | undefined>(undefined);
  const [picking, setPicking] = useState(false);
  // Поле результата у дела с замком: открывает «Завершить» (спека required-result).
  const [finishing, setFinishing] = useState(card.finish === true);
  // Редкие действия спрятаны за «⋯»: они нужны в одном случае из десяти, а места занимали столько же.
  const [more, setMore] = useState(false);
  const task = card.task;
  if (!task) {
    if (!card.failed) return <div class="center-screen"><div class="spinner" aria-label={t(lang, 'loading')} /></div>;
    return (
      <div class="empty-state">
        <div class="empty-title">{t(lang, 'card_failed')}</div>
        <button class="btn tinted retry" onClick={props.onRetry}>{t(lang, 'retry')}</button>
      </div>
    );
  }
  const state = STATE_LABEL[task.status];
  const can = (a: TaskAction): boolean => card.actions.includes(a);
  const hasMore = (['postpone', 'question', 'unclear', 'decline'] as const).some(can) || Boolean(task.can_request_due);
  const due = dueLabel(lang, task.due_date);
  const asked = task.due_request;
  // Замок на сдаче: «Завершить» раскрывает поле результата вместо немедленной сдачи.
  const locked = task.expected_result?.required === true && can('done');
  const resultOpen = locked && finishing;
  // Фото-результат прикладывается внутри поля: тот же ряд и кнопка, что и в блоке фото, но под рукой.
  const photoInBox = resultOpen && (task.expected_result!.type === 'photo' || task.expected_result!.type === 'file');
  const photoBlock = <TaskPhotos task={task} lang={lang} busy={busy} canAttach={task.status !== 'done'} onAttached={props.onPhotos} />;
  return (
    <div class="task-card">
      {(state || task.is_translated) && (
        <div class="task-state">
          {state && <span>{t(lang, state)}</span>}
          {task.is_translated && <span class="tag muted">{t(lang, 'translated')}</span>}
        </div>
      )}
      {task.key && <div class="task-key">{task.key}</div>}
      <div class="task-title">{task.title}</div>
      {(task.due_date || task.waiting_for || task.next_check_at || task.can_set_due) && (
        <div class="task-meta">
          {/* Срок ставит и исполнитель — календарём; кто не вправе, видит подпись. */}
          {task.can_set_due ? (
            <DuePicker
              date={task.due_date} disabled={busy} class={`link-btn due-btn${due?.past ? ' past' : ''}`}
              label={due ? t(lang, 'due_edit', { date: due.text }) : t(lang, 'due_pick')}
              onPick={(date) => props.onSetDue(task, date)}
            />
          ) : <Due lang={lang} date={task.due_date} />}
          {task.waiting_for && <span class="meta-text">{t(lang, 'waiting_for', { who: task.waiting_for })}</span>}
          {task.next_check_at && (
            <span class="due nowrap">{t(lang, 'check_on', { date: shortDate(lang, task.next_check_at) })}</span>
          )}
        </div>
      )}
      {task.project && (
        <div class="task-block">
          <div class="task-block-label">{t(lang, 'project')}</div>
          <div class="task-block-text">
            {task.project.name}
            {task.project.private && <Lock lang={lang} />}
          </div>
        </div>
      )}
      {/* В личном деле все роли — один человек: блок ничего бы не сообщил. */}
      {task.people && !card.personal && <People people={task.people} lang={lang} />}
      {task.why && (
        <div class="task-block">
          <div class="task-block-label">{t(lang, 'why')}</div>
          <RichText text={task.why} class="task-block-text" />
        </div>
      )}
      {task.done_criteria && (
        <div class="task-block">
          <div class="task-block-label">{t(lang, 'done_criteria')}</div>
          <RichText text={task.done_criteria} class="task-block-text" />
        </div>
      )}
      {/* Сданное — сразу под критерием: принимающий сверяет одно с другим. */}
      {task.result && <Result result={task.result} lang={lang} />}
      {/* «Как делать» — самый длинный блок, поэтому идёт после короткого критерия готовности. */}
      {task.description && (
        <div class="task-block">
          <div class="task-block-label">{t(lang, 'how')}</div>
          <RichText text={task.description} class="task-block-text task-block-long" />
        </div>
      )}
      <Sources sources={task.sources} lang={lang} />
      {/* Фото дела видны и прикрепляются здесь же (спека task-photos); у завершённого — только видны. */}
      {!photoInBox && photoBlock}
      {/* У завершённого дела реплика ни к кому не идёт: вести его больше некому (спека completed-list). */}
      {task.status !== 'done' && (
        <CommentBox
          lang={lang} disabled={busy} mode={mode} onCancelMode={() => setMode(undefined)}
          onSend={async (text) => {
            if (mode === 'decline') await props.onDecline(task, text);
            else if (mode) await props.onQuestion(task, text, mode);
            else await props.onComment(task, text);
            setMode(undefined);
          }}
        />
      )}
      {/* Записи — под полем ввода, новые сверху (решение владельца 30.09): написал — и видишь свою
          реплику сразу под полем, а не в конце длинной ленты. */}
      <Notes notes={card.notes} lang={lang} />
      {card.personal && (
        <div class="task-personal">
          <Star on={task.important} disabled={busy} label={t(lang, 'mark_important')}
            onClick={() => { haptic.tap(); props.onImportant(task, !task.important); }} />
          <button class="btn tinted" disabled={busy}
            onClick={() => { haptic.tap(); props.onDefer(task, task.category !== 'someday'); }}>
            {t(lang, task.category === 'someday' ? 'undefer' : 'defer')}
          </button>
          {task.shared_with && (
            <SharedChip name={task.shared_with.name} disabled={busy} lang={lang}
              onClick={() => { haptic.tap(); props.onUnshare(task); }} />
          )}
        </div>
      )}
      {/* Просьба назвать срок — тому, кого просят: кто и когда просил, и сразу календарь. */}
      {asked?.to_me && task.can_set_due && (
        <div class="due-ask">
          <span>{t(lang, 'due_asked', { name: asked.by_name, when: noteTime(lang, asked.requested_at) })}</span>
          {asked.text && <RichText text={asked.text} class="due-ask-text" />}
          <DuePicker date={task.due_date} disabled={busy} class="btn tinted" label={t(lang, 'due_choose')}
            onPick={(date) => props.onSetDue(task, date)} />
        </div>
      )}
      {/* Поле результата — там же, где нажали «Завершить»: ни в бот, ни на другой экран не уходим. */}
      {resultOpen && (
        <ResultBox
          task={task} lang={lang} busy={busy} photos={photoBlock}
          onSubmit={(result) => props.onSubmitResult(task, result)} onCancel={() => setFinishing(false)}
        />
      )}
      {props.error && <div class="task-error">{t(lang, props.error)}</div>}
      {task.created_at && (
        <div class="task-created">{t(lang, 'created_at', { date: shortDate(lang, task.created_at) })}</div>
      )}
      {/* Начато без «Взять» (спека auto-start): постановщик видит, что дело начато и чем. */}
      {task.auto_started && (
        <div class="task-created">
          {t(lang, 'auto_started', { via: t(lang, `auto_started_${task.auto_started.via}` as StringKey), when: noteTime(lang, task.auto_started.at) })}
        </div>
      )}
      {/* Что можно сделать с делом, решает сервер по таблице переходов ядра:
          приложение своей копии правил не держит и кнопку в тупик не рисует. */}
      {picking ? (
        <div class="task-actions">
          {postponeChoices.map((c) => (
            <button key={c.code} class="btn tinted" disabled={busy}
              onClick={() => { haptic.tap(); setPicking(false); props.onPostpone(task, c.code); }}>
              {t(lang, c.key)}
            </button>
          ))}
          <button class="btn tinted" onClick={() => { haptic.tap(); setPicking(false); }}>{t(lang, 'mode_cancel')}</button>
        </div>
      ) : (
        <>
          {/* Кнопок у дела до шести, и в один ряд они не помещались — человек читал стену
              одинаковых слов и искал глазами нужное. Впереди то, что делают с делом прямо сейчас
              (взять, остановить, сдать), остальное — за «⋯»: перенос, вопрос и отказ случаются
              заметно реже, но место занимали столько же. */}
          <div class="task-actions">
            {can('take') && (
              <button class="btn tinted" disabled={busy} onClick={() => { haptic.tap(); props.onTake(task); }}>{t(lang, 'take')}</button>
            )}
            {/* Пара к «Взять»: сел не за то или отвлекли — дело возвращается в очередь, счёт встаёт.
                Время идёт внутри кнопки: по ней видно, что дело в работе, и сколько уже. */}
            {can('stop') && (
              <button class="btn tinted working" disabled={busy} onClick={() => { haptic.tap(); props.onStop(task); }}>
                <span class="pulse" aria-hidden="true" />
                {t(lang, 'stop')}
                {props.running?.task_id === task.id && (
                  <RunningTime startedAt={props.running.started_at} workedSeconds={props.running.worked_seconds} class="btn-time" />
                )}
              </button>
            )}
            {can('done') && !resultOpen && (
              <button class="btn tinted" disabled={busy}
                onClick={() => { if (locked) { haptic.tap(); setFinishing(true); } else props.onDone(task); }}>
                {t(lang, 'finish')}
              </button>
            )}
            {task.status === 'done' && (
              <button class="btn tinted" disabled={busy} onClick={() => { haptic.tap(); props.onReopen(task); }}>
                {t(lang, 'reopen')}
              </button>
            )}
            {hasMore && (
              <button class="btn tinted more" disabled={busy} aria-expanded={more} aria-label={t(lang, 'more')}
                onClick={() => { haptic.tap(); setMore(!more); }}>⋯</button>
            )}
          </div>
          {more && hasMore && (
            <div class="action-menu">
              {can('postpone') && (
                <button class="action-row" disabled={busy} onClick={() => { haptic.tap(); setMore(false); setPicking(true); }}>{t(lang, 'postpone')}</button>
              )}
              {can('question') && (
                <button class="action-row" disabled={busy} onClick={() => { haptic.tap(); setMore(false); setMode('question'); }}>{t(lang, 'question')}</button>
              )}
              {can('unclear') && (
                <button class="action-row" disabled={busy} onClick={() => { haptic.tap(); setMore(false); setMode('unclear'); }}>{t(lang, 'unclear')}</button>
              )}
              {can('decline') && (
                <button class="action-row danger" disabled={busy} onClick={() => { haptic.tap(); setMore(false); setMode('decline'); }}>{t(lang, 'decline')}</button>
              )}
              {/* Попросить исполнителя назвать срок; просьба уже открыта — видно, когда просили. */}
              {task.can_request_due && (asked
                ? <div class="action-row muted">{t(lang, 'due_requested', { when: noteTime(lang, asked.requested_at) })}</div>
                : (
                  <button class="action-row" disabled={busy} onClick={() => { haptic.tap(); setMore(false); props.onRequestDue(task); }}>
                    {t(lang, 'request_due')}
                  </button>
                ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

interface ScreensProps {
  /** Объявления из последнего ответа сервера; на отказ входа — пусто. */
  onAnnouncements: (items: Announcement[], lang?: string) => void;
  /** Поверх экрана заслон объявления: «Назад» Telegram ему не подчиняется и под ним ничего не закрывает. */
  blocked: boolean;
}

function AppScreens(props: ScreensProps): preact.JSX.Element {
  const { onAnnouncements, blocked } = props;
  const [lang, setLang] = useState('en');
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [authFailed, setAuthFailed] = useState(false);
  const [offline, setOffline] = useState(false);
  // Почему список не обновился: связи нет или человек нажимал слишком часто и упёрся в потолок.
  // Под одним текстом «нет связи» второе выглядело бы поломкой интернета, и человек чинил бы вайфай.
  const [offlineKey, setOfflineKey] = useState<StringKey>('offline_hint');
  const [activeSpace, setActiveSpace] = useState(0);
  // Сотрудник, чей список открыт в компании (null — свой): переживает открытие карточки дела.
  const [viewPerson, setViewPerson] = useState<string | null>(null);
  // «Компания» и «Итоги» показывают ту компанию, чья вкладка открыта: у человека их может быть
  // несколько, и молчаливый выбор первой показывал бы чужие числа под именем текущей компании.
  // Из «Личного» показывать нечего — тогда сервер берёт первую компанию, как и раньше.
  const openSpace = (sp: Space[], i: number): Space | undefined => sp[Math.min(i, Math.max(0, sp.length - 1))];
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [card, setCard] = useState<OpenCard | null>(null);
  const cardRef = useRef(card);
  cardRef.current = card;
  // Завершённые: null — ещё не грузили (раздел свёрнут), массив — то, что пришло с сервера.
  const [completed, setCompleted] = useState<Record<string, TaskCard[]> | null>(null);
  // Что сказать про неудавшееся действие: строка показывается в карточке и гаснет при следующем.
  const [actionError, setActionError] = useState<StringKey | null>(null);
  // Раздел «Компания» (спека miniapp-company): null — сервер его не отдал, значит кнопки нет.
  const [company, setCompany] = useState<CompanyResponse | null>(null);
  const [companyOpen, setCompanyOpen] = useState(false);
  // «Итоги» (спека stats-page): отдельный экран, грузится по нажатию — в основном списке он не нужен.
  const [statsOpen, setStatsOpen] = useState(false);
  // «Доступ для программ» (спека read-tokens): токены только на чтение — отдельный экран, как «Итоги».
  const [programsOpen, setProgramsOpen] = useState(false);
  // Дело, которое человек взял: видно в шапке на любом экране (спека mini-app).
  const [running, setRunning] = useState<InProgress | null>(null);
  // Компания берётся с открытой вкладки, а не первая попавшаяся: у человека их может быть
  // несколько, и молчаливый выбор показывал бы чужие дела под именем текущей компании.
  const openedSpace = openSpace(spaces, activeSpace);
  // Раздел «Компания» — про ту компанию, чья вкладка открыта, и только если человек ею управляет.
  // В одной компании он владелец, в другой рядовой: кнопка на чужой вкладке вела бы в «не найдено».
  const companyOrgId = openedSpace?.kind === 'company' && openedSpace.manages ? openedSpace.org_id : undefined;
  // «Итоги» видны всем, поэтому берут открытую вкладку компании независимо от роли: рядовому в
  // компании Б иначе показывались его числа из первой компании под видом текущей.
  const statsOrgId = openedSpace?.kind === 'company' ? openedSpace.org_id : undefined;
  const loadCompany = useCallback(async (orgId?: string) => {
    try { setCompany(await api.company(orgId)); } catch { setCompany(null); }
  }, []);

  const load = useCallback(async () => {
    try {
      const data = await api.lists();
      setSpaces(data.spaces);
      setRunning(data.in_progress);
      setLang(data.lang);
      onAnnouncements(data.announcements ?? [], data.lang);
      setAuthFailed(false);
      setOffline(false);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) { onAnnouncements([]); setAuthFailed(true); return; }
      // Оффлайн: держим последний список из памяти, действия блокируются (спека mini-app, edge cases).
      setOfflineKey(e instanceof ApiError && e.status === 429 ? 'too_fast_hint' : 'offline_hint');
      setOffline(true);
    } finally {
      setLoaded(true);
    }
  }, [onAnnouncements]);

  // Назад из карточки — список перечитывается: точка на чипе человека зависит от всех его дел, и
  // погасить её может только сервер.
  const closeCard = useCallback(() => { setCard(null); void load(); }, [load]);

  const listShown = card === null;
  // Дело, из которого вернулись: подсвечено, пока человек не нажмёт куда-нибудь ещё.
  const [highlight, setHighlight] = useState<string | null>(null);
  useEffect(() => {
    if (!highlight) return undefined;
    const clear = (): void => setHighlight(null);
    document.addEventListener('pointerdown', clear, { capture: true, once: true });
    return () => document.removeEventListener('pointerdown', clear, { capture: true });
  }, [highlight]);

  // Вернулись из карточки — к тому же месту списка. Строка ставится туда, где стояла на экране; список
  // в это время ещё перечитывается (и список человека грузится заново), поэтому место держим, пока строка
  // не появится и не постоит ~0.8 с (но не дольше 5 с), и бросаем, как только человек сам тронул экран.
  // Строки нет (дело закрыли) — та же прокрутка страницы.
  useEffect(() => {
    if (listShown === false || !returnSpot) return undefined;
    const spot = returnSpot;
    returnSpot = null;
    setHighlight(spot.id);
    let stopped = false;
    const until = Date.now() + 5000;
    let foundAt = 0;
    const stop = (): void => { stopped = true; };
    const opts = { capture: true, passive: true };
    for (const ev of ['pointerdown', 'touchstart', 'wheel'] as const) window.addEventListener(ev, stop, opts);
    const step = (): void => {
      if (stopped) return;
      const row = spot.top === null ? null : taskRow(spot.id);
      if (row && spot.top !== null) {
        window.scrollBy(0, row.getBoundingClientRect().top - spot.top);
        foundAt ||= Date.now();
      } else window.scrollTo(0, spot.y);
      const now = Date.now();
      if (now < until && !(foundAt && now - foundAt > 800)) requestAnimationFrame(step);
    };
    step();
    return () => {
      stopped = true;
      for (const ev of ['pointerdown', 'touchstart', 'wheel'] as const) window.removeEventListener(ev, stop, opts);
    };
  }, [listShown]);

  useEffect(() => {
    const app = tg();
    app?.ready();
    app?.expand();
    applyTheme();
    applyInsets();
    app?.onEvent('themeChanged', applyTheme);
    app?.onEvent('safeAreaChanged', applyInsets);
    app?.onEvent('contentSafeAreaChanged', applyInsets);
    app?.onEvent('viewportChanged', applyInsets);
    // Открыли кнопкой «Открыть задачу» из уведомления — сразу на карточку дела, тем же путём, что
    // дело из шапки (спека unread-and-deeplink). Карточка грузится вместе со списком, а показывается
    // после него — список не мелькает перед ней. Недоступное дело отвечает 404, и карточка сама
    // возвращает к списку — без ошибки на весь экран.
    const launched = taskFromLaunch(window.location.search, app?.initDataUnsafe?.start_param);
    if (launched) setCard({ id: launched, personal: false, task: null, notes: [], actions: [], failed: false });
    void load();
    // Вернулся из бота (ответил, перенёс) — список мог измениться.
    const onVisible = (): void => { if (document.visibilityState === 'visible') void load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      app?.offEvent('themeChanged', applyTheme);
      app?.offEvent('safeAreaChanged', applyInsets);
      app?.offEvent('contentSafeAreaChanged', applyInsets);
      app?.offEvent('viewportChanged', applyInsets);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load]);

  // Содержимое открытой карточки: грузим один раз на открытие (и ещё раз по кнопке «Ещё раз»).
  const cardId = card?.id;
  const cardPending = Boolean(card) && !card!.task && !card!.failed;
  useEffect(() => {
    if (!cardId || !cardPending) return;
    let alive = true;
    void (async () => {
      try {
        const r = await api.task(cardId);
        // `personal` берём из ответа сервера: в списке он мог устареть, если дело переехало.
        if (alive) setCard((c) => (c && c.id === cardId ? { ...c, task: r.task, personal: r.personal, notes: r.notes, actions: r.actions } : c));
      } catch (e) {
        if (!alive) return;
        if (e instanceof ApiError && e.status === 401) { setCard(null); setAuthFailed(true); return; }
        // Дело закрыли или перенесли в другое пространство — по прежней ссылке его нет: назад к списку.
        if (e instanceof ApiError && e.status === 404) { setCard(null); void load(); return; }
        setCard((c) => (c && c.id === cardId ? { ...c, failed: true } : c));
      }
    })();
    return () => { alive = false; };
  }, [cardId, cardPending, load]);

  // Возврат из карточки — кнопкой «Назад» Telegram, ею же приходит системный жест назад.
  const cardOpen = card !== null;
  const [noBackButton, setNoBackButton] = useState(false);
  useEffect(() => {
    const back = tg()?.BackButton;
    // Объект BackButton есть в SDK всегда, а на клиентах старше Bot API 6.1 его show/onClick молча
    // ничего не делают. Поэтому признак берём по факту: показали — проверили, что видно.
    if (!back) { setNoBackButton(true); return; }
    // Под заслоном объявления «Назад» не показываем и не слушаем: карточка под ним закрылась бы вслепую.
    if (!cardOpen || blocked) { back.hide(); return; }
    const close = (): void => closeCard();
    back.onClick(close);
    back.show();
    setNoBackButton(back.isVisible === false);
    // Кнопка гаснет вместе с карточкой: над списком ей висеть незачем.
    return () => { back.offClick(close); back.hide(); };
  }, [cardOpen, closeCard, blocked]);

  const withBusy = useCallback(async (id: string, fn: () => Promise<void>) => {
    setBusyIds((prev) => new Set(prev).add(id));
    try { await fn(); } finally {
      setBusyIds((prev) => { const next = new Set(prev); next.delete(id); return next; });
    }
  }, []);

  /** Открыть карточку дела сразу с полем результата (спека required-result). Вид пространства придёт с сервера вместе с карточкой. */
  const openForResult = useCallback((task: TaskCard) => {
    haptic.tap();
    rememberSpot(task.id);
    setActionError(null);
    setCard({ id: task.id, personal: false, task: null, notes: [], actions: [], failed: false, finish: true });
    scrollToTop();
  }, []);

  const onDone = useCallback((task: TaskCard) => {
    // Дело с обязательным результатом не сдаётся из списка вслепую: открываем его карточку с полем результата.
    if (task.expected_result?.required) { openForResult(task); return; }
    void withBusy(task.id, async () => {
      try {
        await api.done(task.id, task.version);
        haptic.success();
      } catch (e) {
        // Список мог устареть: замок поставили после того, как он загрузился. Сервер отказал — не глотаем
        // отказ молча перечиткой, а открываем карточку с полем, куда результат вписывают (спека required-result).
        const details = e instanceof ApiError ? (e.body as { details?: { reason?: string } } | null)?.details : null;
        if (e instanceof ApiError && e.code === 'validation_failed' && details?.reason === 'result_required') openForResult(task);
      } finally {
        await load();
      }
    });
  }, [load, openForResult, withBusy]);

  const onImportant = useCallback((task: TaskCard, on: boolean) => {
    // Сразу показываем звёздочку, сервер догоняет; при ошибке список перечитается.
    setSpaces((prev) => prev.map((s) => (s.kind === 'personal'
      ? { ...s, lists: { open: s.lists.open.map((x) => (x.id === task.id ? { ...x, important: on } : x)) } } : s)));
    void withBusy(task.id, async () => { try { await api.setImportant(task.id, on); } finally { await load(); } });
  }, [load, withBusy]);

  const onUnshare = useCallback((task: TaskCard) => {
    // Пометка «рабочее» снимается здесь же: со следующей сводки агенты дело не видят (спека owner-feedback).
    setSpaces((prev) => prev.map((s) => (s.kind === 'personal'
      ? { ...s, lists: { open: s.lists.open.map((x) => (x.id === task.id ? { ...x, shared_with: null } : x)) } } : s)));
    void withBusy(task.id, async () => { try { await api.setShare(task.id, null); } finally { await load(); } });
  }, [load, withBusy]);

  // Реплика к делу: список от неё не меняется — перечитывать нечего, ошибку показывает сама карточка.
  const onComment = useCallback((task: TaskCard, text: string) => api.comment(task.id, text).then(() => undefined), []);

  // На карточке запись должна появиться сразу: иначе человек пишет, поле очищается — и следа нет.
  const onCardComment = useCallback(async (task: TaskCard, text: string) => {
    await api.comment(task.id, text);
    const r = await api.task(task.id);
    setCard((c) => (c && c.id === task.id ? { ...c, task: r.task, notes: r.notes, actions: r.actions } : c));
  }, []);

  // Фото прикреплены — карточка перечитывается: по новому числу фото ряд миниатюр подтянет и их.
  const onCardPhotos = useCallback(async (task: TaskCard) => {
    const r = await api.task(task.id);
    setCard((c) => (c && c.id === task.id ? { ...c, task: r.task, notes: r.notes, actions: r.actions } : c));
  }, []);

  const loadCompleted = useCallback(() => {
    void (async () => {
      try {
        const r = await api.completed();
        const byOrg: Record<string, TaskCard[]> = {};
        for (const sp of r.spaces) byOrg[sp.org_id] = sp.tasks;
        setCompleted(byOrg);
      } catch {
        // Раздел необязательный: не грузится — остаётся свёрнутым, список работать не перестаёт.
        setCompleted({});
      }
    })();
  }, []);

  // Вернуть дело, закрытое по ошибке: карточка закрывается, список и раздел перечитываются —
  // дело уходит из «Завершённых» и появляется в работе.
  const onReopen = useCallback((task: TaskCard) => {
    void withBusy(task.id, async () => {
      try {
        await api.reopen(task.id);
        haptic.success();
      } finally {
        setCard(null);
        setCompleted(null);
        await load();
      }
    });
  }, [load, withBusy]);

  const onReorderPersonal = useCallback((ids: string[]) => {
    void (async () => { try { await api.reorderPersonal(ids); } finally { await load(); } })();
  }, [load]);

  // Открытая карточка гасит точку в своих списках сразу, не дожидаясь сервера (спека unread-and-deeplink).
  const markSeen = useCallback((id: string) => {
    const clear = (list: TaskCard[]): TaskCard[] => list.map((x) => (x.id === id && x.unread ? { ...x, unread: false } : x));
    setSpaces((prev) => prev.map((s): Space => (s.kind === 'personal'
      ? { ...s, lists: { open: clear(s.lists.open) } }
      : {
        ...s,
        lists: {
          now: clear(s.lists.now), queue: clear(s.lists.queue), waiting_external: clear(s.lists.waiting_external),
          submitted: clear(s.lists.submitted), waiting: clear(s.lists.waiting), scheduled: clear(s.lists.scheduled ?? []),
        },
      })));
  }, []);

  // Нажали на дело — карточка открывается здесь же (спека miniapp-task-card).
  const openCard = useCallback((task: TaskCard, personal: boolean) => {
    haptic.tap();
    markSeen(task.id);
    // Ошибка прошлого действия к новому делу отношения не имеет: без этого человек, получивший
    // «дело изменилось» на одном деле, видел ту же строку над кнопками у каждого следующего.
    rememberSpot(task.id);
    setActionError(null);
    setCard({ id: task.id, personal, task: null, notes: [], actions: [], failed: false });
    // Список мог быть прокручен далеко вниз, а страница у приложения одна: без этого карточка
    // открывалась на середине, и человек видел не заголовок дела, а записи по нему.
    scrollToTop();
  }, [markSeen]);

  /** Из шапки «в работе»: дела в списке может не быть (оно из другой компании) — открываем по id.
   *  Вид пространства придёт с сервера вместе с карточкой, поэтому здесь он не угадывается. */
  const openRunning = useCallback((taskId: string) => {
    setActionError(null);
    // С карточки на карточку (шапка «в работе») — место в списке остаётся тем, откуда открыли первую.
    if (!cardRef.current) rememberSpot(taskId);
    setCard({ id: taskId, personal: false, task: null, notes: [], actions: [], failed: false });
    scrollToTop();
  }, []);

  // Закрылось — возвращаемся к списку: в нём этого дела уже нет.
  const onCardDone = useCallback((task: TaskCard) => { setCard(null); onDone(task); }, [onDone]);

  /** Перечитать карточку после действия: статус, срок и набор кнопок приходят с сервера. */
  const refreshCard = useCallback(async (id: string) => {
    const r = await api.task(id);
    setCard((c) => (c && c.id === id ? { ...c, task: r.task, notes: r.notes, actions: r.actions } : c));
  }, []);

  // Сдача из поля результата. Отказ сервера не глотаем: его показывает поле, карточка остаётся открытой.
  // Устаревшая версия: карточку перечитываем, а набранный текст остаётся в поле — человек жмёт «Сдать» ещё раз.
  const onCardSubmit = useCallback((task: TaskCard, result: { text: string }) => withBusy(task.id, async () => {
    try {
      await api.done(task.id, task.version, result);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'stale_version') { await refreshCard(task.id).catch(() => undefined); await load(); }
      throw e;
    }
    haptic.success();
    setActionError(null);
    setCard(null);
    await load();
  }), [load, refreshCard, withBusy]);

  /**
   * Действие с карточки: отказ сервера показываем человеку и перечитываем дело. Без этого
   * «карточка устарела» пропадала молча, и кнопка упиралась в тот же отказ бесконечно (ревью).
   */
  const runAction = useCallback((task: TaskCard, act: () => Promise<unknown>) => {
    void withBusy(task.id, async () => {
      try {
        await act();
        setActionError(null);
        haptic.success();
      } catch (e) {
        const code = e instanceof ApiError ? e.code : null;
        const tooFast = e instanceof ApiError && e.status === 429;
        setActionError(tooFast ? 'too_fast_hint' : code === 'stale_version' ? 'action_stale' : 'action_failed');
      } finally {
        await refreshCard(task.id);
        await load();
      }
    });
  }, [load, refreshCard, withBusy]);

  /**
   * «Взял» из карточки дела: возвращаемся в список и к его началу. Человек берётся за дело, чтобы
   * начать работать, — ему нужна карточка «Сейчас» с идущим счётом, а не та же страница с
   * описанием. Оставаясь на месте, он не видел ни что дело взято, ни что пошло время.
   *
   * Отказ (устаревшая версия, чужая правка) карточку не закрывает: человек должен прочитать, что
   * не прошло, а не гадать, почему список не изменился.
   */
  const onCardTake = useCallback((task: TaskCard) => {
    void withBusy(task.id, async () => {
      try {
        await api.take(task.id, task.version);
        haptic.success();
        setActionError(null);
        returnSpot = null; // к «Сейчас» наверху, а не на прежнее место
        setCard(null);
        scrollToTop();
      } catch (e) {
        const code = e instanceof ApiError ? e.code : null;
        const tooFast = e instanceof ApiError && e.status === 429;
        setActionError(tooFast ? 'too_fast_hint' : code === 'stale_version' ? 'action_stale' : 'action_failed');
        await refreshCard(task.id);
      } finally {
        await load();
      }
    });
  }, [load, refreshCard, withBusy]);

  /** «Остановить»: дело возвращается в очередь, таймер встаёт. Карточку закрываем — дело больше не
   *  в работе, и держать её открытой значит предлагать действия, которых у дела уже нет. */
  const onStop = useCallback((task: TaskCard) => {
    void withBusy(task.id, async () => {
      try { await api.stop(task.id, task.version); } finally { returnSpot = null; setCard(null); scrollToTop(); await load(); }
    });
  }, [load, withBusy]);

  const onCardPostpone = useCallback((task: TaskCard, to: PostponeChoice) => {
    runAction(task, () => api.postpone(task.id, to, task.version));
  }, [runAction]);

  // Срок календарём и просьба назвать срок (спека self-set-due): статус не меняется, карточка перечитывается.
  const onCardSetDue = useCallback((task: TaskCard, date: string) => {
    runAction(task, () => api.setDue(task.id, date, task.version));
  }, [runAction]);
  const onCardRequestDue = useCallback((task: TaskCard) => {
    runAction(task, () => api.requestDue(task.id));
  }, [runAction]);

  // Вопрос, «Непонятно» и отказ уходят текстом из того же поля: ошибку показывает поле,
  // поэтому здесь её не глушим — дальше её ловит CommentBox и пишет человеку, что не прошло.
  const onCardQuestion = useCallback(async (task: TaskCard, text: string, kind: 'question' | 'unclear') => {
    await api.question(task.id, text, kind, task.version);
    await refreshCard(task.id);
    await load();
  }, [load, refreshCard]);

  const onCardDecline = useCallback(async (task: TaskCard, text: string) => {
    await api.decline(task.id, text, task.version);
    // Отказ закрывает дело: карточка ему больше не нужна, возвращаемся к списку.
    setCard(null);
    await load();
  }, [load]);

  // Звёздочку и пометку «рабочее» карточка показывает сразу, не дожидаясь перечитывания списка.
  const patchCard = (id: string, patch: Partial<TaskCard>): void => {
    setCard((c) => (c?.task && c.task.id === id ? { ...c, task: { ...c.task, ...patch } } : c));
  };
  const onCardImportant = useCallback((task: TaskCard, on: boolean) => {
    patchCard(task.id, { important: on });
    onImportant(task, on);
  }, [onImportant]);
  // «Отложить» у личного дела: уезжает в «Когда-нибудь», той же кнопкой возвращается.
  const onCardDefer = useCallback((task: TaskCard, someday: boolean) => {
    patchCard(task.id, { category: someday ? 'someday' : 'do' });
    void withBusy(task.id, async () => {
      try { await api.setSomeday(task.id, someday); haptic.success(); } finally { await load(); }
    });
  }, [load, withBusy]);

  const onCardUnshare = useCallback((task: TaskCard) => {
    patchCard(task.id, { shared_with: null });
    onUnshare(task);
  }, [onUnshare]);

  if (!loaded) return <div class="center-screen"><div class="spinner" aria-label={t(lang, 'loading')} /></div>;
  if (authFailed) return <div class="center-screen">{t(lang, 'reopen_hint')}</div>;

  if (card) {
    return (
      <div class="screen">
        {offline && <div class="banner">{t(lang, offlineKey)}</div>}
        {/* На карточке чужого дела шапка отвечает на вопрос «а что у меня в работе» — и уводит
            обратно к взятому делу одним нажатием. */}
        {running && running.task_id !== card.id && <RunningBar running={running} lang={lang} onOpen={openRunning} />}
        {/* Запасной выход: если у клиента Telegram нет системной кнопки «Назад», человек иначе
            останется на карточке без возврата к списку. */}
        {noBackButton && (
          <button class="back-link" onClick={() => { haptic.tap(); closeCard(); }}>{t(lang, 'back')}</button>
        )}
        <TaskScreen
          card={card} lang={lang} busy={offline || busyIds.has(card.id)}
          onRetry={() => setCard({ ...card, failed: false })}
          onDone={onCardDone} onSubmitResult={onCardSubmit} onComment={onCardComment} onPhotos={onCardPhotos} onImportant={onCardImportant} onUnshare={onCardUnshare}
          onReopen={onReopen} onTake={onCardTake} onStop={onStop} running={running}
          onPostpone={onCardPostpone} onDefer={onCardDefer}
          onQuestion={onCardQuestion} onDecline={onCardDecline} error={actionError}
          onSetDue={onCardSetDue} onRequestDue={onCardRequestDue}
        />
      </div>
    );
  }

  if (statsOpen) {
    return (
      <div class="screen">
        {offline && <div class="banner">{t(lang, offlineKey)}</div>}
        {running && <RunningBar running={running} lang={lang} onOpen={openRunning} />}
        <button class="back-link" onClick={() => { haptic.tap(); setStatsOpen(false); }}>{t(lang, 'back')}</button>
        <StatsSection lang={lang} orgId={statsOrgId} named={showStatsHeading(spaces)} />
      </div>
    );
  }

  if (programsOpen) {
    return (
      <div class="screen">
        {offline && <div class="banner">{t(lang, offlineKey)}</div>}
        {running && <RunningBar running={running} lang={lang} onOpen={openRunning} />}
        <button class="back-link" onClick={() => { haptic.tap(); setProgramsOpen(false); }}>{t(lang, 'back')}</button>
        <ReadTokensSection lang={lang} />
        {/* Токены агентов — про компанию открытой вкладки и только её владельцу (спека agent-tokens). */}
        {companyOrgId && <AgentTokensSection lang={lang} orgId={companyOrgId} />}
      </div>
    );
  }

  if (companyOpen && company) {
    return (
      <div class="screen">
        {offline && <div class="banner">{t(lang, offlineKey)}</div>}
        {running && <RunningBar running={running} lang={lang} onOpen={openRunning} />}
        <button class="back-link" onClick={() => { haptic.tap(); companyMemory.tab = 'people'; companyMemory.project = null; setCompanyOpen(false); void load(); }}>{t(lang, 'back')}</button>
        <CompanySection data={company} lang={lang} onChanged={() => loadCompany(companyOrgId)} onOpen={(task) => openRunning(task.id)} />
      </div>
    );
  }

  const space = openedSpace;

  return (
    <div class="screen">
      {/* Подсветка строкой стиля, а не пропсом: строки дела рисуют пять разных списков. */}
      {highlight && /^[0-9a-f-]+$/i.test(highlight) && (
        <style>{`[data-task-id="${highlight}"] { background: var(--returned); }`}</style>
      )}
      {offline && <div class="banner">{t(lang, offlineKey)}</div>}
      {/* Взятое дело этого пространства уже развёрнуто карточкой «Сейчас» со своим таймером —
          вторая строка сверху была бы тем же счётом дважды. */}
      {running && !(space?.kind === 'company' && space.lists.now.some((t) => t.id === running.task_id))
        && <RunningBar running={running} lang={lang} onOpen={openRunning} />}
      {spaces.length > 1 && (
        <div class="segmented" role="tablist">
          {spaces.map((s, i) => (
            <button
              key={s.org_id} role="tab" aria-selected={s === space} class={`segment${s === space ? ' active' : ''}`}
              onClick={() => { haptic.select(); foldMemory.clear(); setActiveSpace(i); setViewPerson(null); }}
            >
              {s.kind === 'personal' ? t(lang, 'personal') : s.name}
            </button>
          ))}
        </div>
      )}
      <div class="top-links">
        {companyOrgId && (
          <button class="company-link" onClick={() => { haptic.tap(); setCompanyOpen(true); void loadCompany(companyOrgId); }}>
            {t(lang, 'company')}
          </button>
        )}
        {/* «Итоги» видны всем: исполнителю приходят его собственные числа, а не чужая выработка. */}
        <button class="company-link" onClick={() => { haptic.tap(); setStatsOpen(true); }}>{t(lang, 'stats')}</button>
        <button class="company-link" onClick={() => { haptic.tap(); setProgramsOpen(true); }}>{t(lang, 'programs')}</button>
      </div>
      {space?.kind === 'company' && (
        <CompanyView
          lists={space.lists} lang={lang} busyIds={busyIds} offline={offline} projects={space.projects ?? []}
          people={space.people ?? []}
          startedAt={running && space.lists.now.some((t) => t.id === running.task_id) ? running.started_at : null}
          workedSeconds={running?.worked_seconds}
          onStop={onStop}
          onDone={onDone} onComment={onComment} onOpen={(task) => openCard(task, false)}
          completed={completed ? completed[space.org_id] ?? [] : null} completedCount={space.completed_count}
          onLoadCompleted={loadCompleted}
          person={viewPerson} onPerson={setViewPerson}
        />
      )}
      {space?.kind === 'personal' && (
        <PersonalView
          tasks={space.lists.open} lang={lang} offline={offline} busyIds={busyIds}
          onDone={onDone} onReorder={onReorderPersonal} onImportant={onImportant} onUnshare={onUnshare}
          onOpen={(task) => openCard(task, true)}
          completed={completed ? completed[space.org_id] ?? [] : null} completedCount={space.completed_count}
          onLoadCompleted={loadCompleted}
        />
      )}
    </div>
  );
}

/**
 * Приложение целиком: экраны и поверх любого из них заслон объявления (спека announcements). Заслон
 * живёт здесь, а не в ветках `AppScreens`, у которых ранние выходы (карточка, итоги, компания): иначе
 * он исчезал бы, стоило человеку открыть карточку. Пока список не загружен, объявлений нет — значит,
 * и поверх крутилки заслона не бывает.
 */
export function App(): preact.JSX.Element {
  const [gate, setGate] = useState<GateState>(EMPTY_GATE);
  const onAnnouncements = useCallback((items: Announcement[], lang?: string) => setGate((g) => gateReplace(g, items, lang)), []);
  const onConfirmed = useCallback((id: string) => setGate((g) => gateConfirmed(g, id)), []);
  const current = gateCurrent(gate);
  return (
    <Fragment>
      <AppScreens onAnnouncements={onAnnouncements} blocked={isBlocking(gate)} />
      {current && (
        <AnnouncementGate key={current.id} item={current} lang={gate.lang} {...gateProgress(gate)} onConfirmed={onConfirmed} />
      )}
    </Fragment>
  );
}
