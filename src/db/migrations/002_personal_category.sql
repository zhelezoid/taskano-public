-- Вид личного дела: «сделать», «решить», «когда-нибудь/заморожено».
-- null — «сделать». В организациях не используется: там порядок задаёт очередь.
alter table tasks add column category text check (category in ('do', 'decide', 'someday'));
