-- Закрыть дело без сдачи — спека step-lifecycle-and-queue.
--
-- Постановщик закрывает выполненное дело, которое исполнитель не сдал кнопкой, — с доказательством:
-- что именно показывает, что работа сделана. Доказательство — реплика по делу (`close_reason`):
-- исполнитель получает его в уведомлении, на своём языке, как причину возврата.

alter table task_messages drop constraint task_messages_kind_check;
alter table task_messages add constraint task_messages_kind_check check (kind in (
  'comment','question','unclear','answer','decline_reason','owner_instruction','rework_reason','due_request',
  'close_reason'));
