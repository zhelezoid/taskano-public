// Реестр видов уведомлений — общий контракт worker (создаёт) и бота (показывает).
// Уровень задаёт способ доставки (спека telegram-bot, «Уведомления владельцу — три уровня»):
// work — рабочее сообщение исполнителю/постановщику; glance — строка без обязательного действия;
// decision — строка + кнопки; feed — не присылается, видно в /feed и дайджесте.

export const NOTIFICATION_KINDS = {
  // исполнителю
  task_now: 'work',             // новая задача в «Сейчас»
  task_updated: 'work',
  task_changed_by_manager: 'work', // владелец или админ правит чужое дело — и автору (спека roles-and-rights)
  task_answer: 'work',          // постановщик ответил на вопрос
  task_rework: 'work',
  task_cancelled: 'work',
  task_closed: 'work',          // постановщик закрыл несданное дело как сделанное
  task_comment: 'work',
  task_photo: 'work',
  read_token_issued: 'glance',  // выпущен токен для программ; payload: { label } (спека read-tokens)           // к делу прикрепили фото; payload: { by_user_id } (спека task-photos)
  reminder: 'work',             // payload: { stage: 'ack' | 'overdue_1' | 'overdue_3' | 'overdue_7' | 'due_tomorrow' }
  reminder_digest: 'work',      // склейка сверх дневного лимита; payload: { task_ids: string[] }
  waiting_check: 'work',        // пора проверить ожидание
  timer_check: 'work',          // таймер идёт 2,5 ч без признаков жизни человека
  timer_autostopped: 'glance',  // таймер закрыт сам; payload: { minutes, reason: 'day_end' | 'idle' }
  digest: 'work',               // утренний дайджест (собирается при доставке)
  maybe_done: 'work',           // из рабочей группы похоже, что сделано; payload: { summary, message_id } (спека group-intake)
  open_app: 'work',             // владелец просит открыть приложение; payload: { by } (спека person-presence)
  due_request: 'work',          // просят назвать срок; payload: { request_id } (спека self-set-due)
  due_request_reminder: 'work', // просьба назвать срок без ответа 1 рабочий день; payload: { request_id }
  announcement: 'work',         // объявление с подтверждением; payload: { announcement_id } (спека announcements)
  announcement_reminder: 'work', // не подтвердил: через 4 рабочих часа, затем раз в рабочий день, до 3; payload: { announcement_id }
  take_prompt: 'work',          // открыл в боте неначатое дело и не начал: «Берёшь сейчас?» через минуту (спека auto-start)
  take_reminder: 'work',        // «Позже — к …» на «Берёшь сейчас?»: «Пора браться» в выбранное время (спека auto-start)
  due_set_from_chat: 'glance',  // срок записан ботом по сообщению исполнителя в чате; payload: { to, chat, group_id }
  // постановщику-человеку
  task_submitted: 'work',
  task_question: 'work',
  task_unclear: 'work',
  not_acknowledged: 'work',     // исполнитель не отреагировал на «Сейчас»
  due_set: 'work',              // исполнитель сам поставил срок; payload: { from, to } (спека self-set-due)
  review_reminder: 'work',      // проверяющий молчит 24 рабочих часа с его стороны; payload: { hours } (спека task-reviewer)
  due_request_ignored: 'work',  // просьба назвать срок без ответа 2 рабочих дня; владельцу агента — уровнем decision
  task_reopened: 'work',        // закрытое дело снова в работе (спека completed-list)
  // владельцу агента / организации
  task_declined: 'decision',
  proposal: 'decision',
  question_unanswered: 'decision',   // вопрос без ответа агента 4 рабочих часа
  review_overdue: 'decision',        // проверяющий молчит 48 рабочих часов; постановщику; payload: { reviewer_id, hours } (спека task-reviewer)
  channel_dead: 'decision',          // человек заблокировал бота; payload: { user_id }
  runner_broken: 'decision',         // /fire отвечает ошибкой; payload: { agent_ids }
  ai_budget_exceeded: 'decision',
  agent_token_issued: 'glance',      // выпущен токен агента; выпустившему владельцу; payload: { label, agent_name } (спека agent-tokens)
  person_offboarded: 'decision',     // исполнителя вывели из организации, его дело отменено
  vetoable: 'glance',                // изменение с правом «Откатить»
  external_overdue: 'glance',        // внешняя сторона не уложилась в срок ожидания
  agents_silent: 'glance',           // routine не приходила 2 рабочих часа окна при событиях; payload: { agent_ids }
  person_stuck: 'glance',            // шаг в работе дольше 2 рабочих дней без движения
  stuck_summary: 'glance',           // недельная сводка застрявших планов (по планам, не по людям)
  invitation_stalled: 'glance',      // приглашение не принято 5 дней; payload: { invitation_id }
  task_done: 'feed',
  task_returned: 'feed',
  task_reviewer_assigned: 'feed',   // назначили проверяющим несданного дела (спека task-reviewer)
  estimate_diverged: 'feed',         // время цикла вдвое больше оценки — без действия, только в ленту (спека bot-messages)
} as const;

export type NotificationKind = keyof typeof NOTIFICATION_KINDS;
