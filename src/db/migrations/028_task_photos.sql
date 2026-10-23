-- Фото и скриншоты к делу из лички бота и из Mini App — спека task-photos.
-- Вложение дела раньше появлялось только из рабочей группы (source = 'group'). Теперь его прикрепляет
-- и сам причастный человек (source = 'person'), и автор нужен: по нему считается суточный предел и
-- уведомляется вторая сторона. У фото из группы автора здесь нет — он у сообщения группы.

alter table task_attachments drop constraint task_attachments_source_check;
alter table task_attachments add constraint task_attachments_source_check check (source in ('group','person'));

alter table task_attachments add column author_user_id uuid references users(id);
alter table task_attachments add constraint task_attachments_person_author
  check (source <> 'person' or author_user_id is not null);

-- Предел «30 фото на человека на дело за сутки» считается по этому индексу.
create index on task_attachments(task_id, author_user_id, created_at);
