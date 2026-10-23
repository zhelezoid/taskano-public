-- Приглашённый отказался от дела компании, куда его лишь позвали (спека multi-company-person):
-- «Отказаться» — не вход. Дело отклоняется как обычно, а приглашение получает свой
-- статус: не «отозвано» (это решение компании) и не «истекло» (это время), а отказ самого человека.

alter table invitations drop constraint invitations_status_check;
alter table invitations add constraint invitations_status_check
  check (status in ('pending','accepted','expired','revoked','declined'));
