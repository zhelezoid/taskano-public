import { useEffect, useState } from 'preact/hooks';
import { api, ApiError, type Announcement } from './api.js';
import { canConfirm, INITIAL_CHECKED } from './announcement-gate.js';
import { t } from './i18n.js';

// Заслон объявления (спека announcements): пока у человека есть неподтверждённое объявление, оно лежит
// поверх любого экрана. Закрыть его нельзя ничем, кроме «Прочёл, подтверждаю» и OK: кнопку «Назад»
// Telegram сюда не подключаем, а App на это время отключает свою. Текст — текстом, не разметкой:
// его пишут люди, и preact экранирует его сам.

export function AnnouncementGate(props: {
  item: Announcement; lang: string; position: number; total: number; onConfirmed: (id: string) => void;
}): preact.JSX.Element {
  const [checked, setChecked] = useState(INITIAL_CHECKED);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  // Под заслоном вертикальный жест не должен сворачивать приложение: иначе его можно «закрыть» свайпом.
  useEffect(() => {
    const wa = window.Telegram?.WebApp as { disableVerticalSwipes?: () => void; enableVerticalSwipes?: () => void } | undefined;
    try { wa?.disableVerticalSwipes?.(); } catch { /* старый клиент */ }
    return () => { try { wa?.enableVerticalSwipes?.(); } catch { /* старый клиент */ } };
  }, []);

  const confirm = async (): Promise<void> => {
    if (!canConfirm(checked, busy)) return;
    setBusy(true);
    setFailed(false);
    try {
      await api.confirmAnnouncement(props.item.id);
      window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred('success');
      props.onConfirmed(props.item.id);
    } catch (e) {
      // Объявления для человека больше нет (404: вышел из компании, удалена организация): заслон не
      // должен застрять на нём вечной ошибкой — снимаем из очереди.
      if (e instanceof ApiError && e.status === 404) props.onConfirmed(props.item.id);
      else setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="announcement-gate" role="dialog" aria-modal="true">
      <div class="announcement-card">
        <div class="announcement-head">
          <span class="announcement-title">{t(props.lang, 'announcement_title')}</span>
          {props.total > 1 && <span class="announcement-progress">{t(props.lang, 'announcement_progress', { n: props.position, total: props.total })}</span>}
        </div>
        <div class="announcement-from">
          {props.item.agent
            ? t(props.lang, 'announcement_from_via', { name: props.item.from, agent: props.item.agent })
            : t(props.lang, 'announcement_from', { name: props.item.from })}
        </div>
        <div class="announcement-text">{props.item.text}</div>
      </div>
      <div class="announcement-actions">
        <label class="announcement-check">
          <input type="checkbox" checked={checked} disabled={busy} onChange={(e) => setChecked((e.currentTarget as HTMLInputElement).checked)} />
          <span>{t(props.lang, 'announcement_check')}</span>
        </label>
        {failed && <div class="task-error">{t(props.lang, 'company_failed')}</div>}
        <button class="btn primary announcement-ok" disabled={!canConfirm(checked, busy)} onClick={() => { void confirm(); }}>
          {t(props.lang, 'announcement_ok')}
        </button>
      </div>
    </div>
  );
}
