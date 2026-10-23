-- Проверяющий у обычного дела — спека task-reviewer.
--
-- Назван — сданный результат принимает или возвращает он, а не автор. У ожидания проверяющий
-- остаётся в `waiting.check_user_id`: там он смотрит, пришло ли внешнее, а не оценивает работу.

alter table tasks add column reviewer_user_id uuid references users(id);

create index tasks_reviewer_idx on tasks(org_id, reviewer_user_id) where reviewer_user_id is not null;
