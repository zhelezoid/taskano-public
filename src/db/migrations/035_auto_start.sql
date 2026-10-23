-- Чем начато дело, если не кнопкой «Взять» (спека auto-start): первое действие
-- исполнителя — комментарий, вложение или сдача — начинает дело само. null — начато «Взять» или
-- ещё не начато. По этой отметке карточка показывает «Начата автоматически: <действие>».
alter table tasks add column started_via text
  check (started_via in ('comment', 'attachment', 'submit'));

comment on column tasks.started_via is 'Чем начато дело без «Взять»: comment | attachment | submit (спека auto-start)';
