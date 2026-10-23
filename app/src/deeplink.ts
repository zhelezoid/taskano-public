// Дело, на котором открыть приложение (спека unread-and-deeplink). Кнопка «Открыть задачу» под
// уведомлением ведёт на `/app/?task=<id>`; ссылка вида `t.me/<bot>?startapp=task_<id>` приходит
// параметром запуска Telegram. Чистая функция — чтобы проверять её без браузера.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * id дела из адреса (`?task=`) или параметра запуска (`task_<id>`); адрес важнее. Не uuid —
 * игнорируется: мусор в ссылке не должен ни уводить на ошибку, ни уходить запросом на сервер.
 */
export function taskFromLaunch(search: string, startParam?: string | null): string | null {
  const candidates = [
    new URLSearchParams(search).get('task'),
    startParam?.startsWith('task_') ? startParam.slice('task_'.length) : null,
  ];
  const id = candidates.find((c): c is string => Boolean(c) && UUID_RE.test(c!));
  return id ? id.toLowerCase() : null;
}
