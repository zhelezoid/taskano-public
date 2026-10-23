-- Перенос дела между личным пространством и компанией — спека task-routing.
-- Дело меняет org_id вместе со своей историей, всё одной транзакцией (src/core/routing.ts).

-- Внешние ключи на задачу составные: (org_id, task_id) → tasks(org_id, id). Пока они не отложены,
-- перенос невозможен в принципе: обновишь tasks первым — сработает проверка «на строку ссылаются»,
-- обновишь историю первой — проверка «родителя нет». Поэтому все ссылки на tasks делаются
-- deferrable initially immediate: обычная запись проверяется как раньше (сразу), и только перенос
-- откладывает проверку до commit явным `set constraints all deferred`. Отложенная проверка на
-- commit заодно ловит таблицу, которую забыли перенести, — громкой ошибкой, а не тихой потерей связи.
do $$
declare c record;
begin
  for c in
    select conrelid::regclass::text as tbl, conname, pg_get_constraintdef(oid) as def
      from pg_constraint
     where contype = 'f' and confrelid = 'tasks'::regclass and not condeferrable
  loop
    execute format('alter table %s drop constraint %I', c.tbl, c.conname);
    execute format('alter table %s add constraint %I %s deferrable initially immediate', c.tbl, c.conname, c.def);
  end loop;
end $$;
