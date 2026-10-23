-- Ключ доски и номер дела внутри неё (спека projects-stage2).
--
-- У дела есть `short_id` — сквозной технический номер: им живут кнопки бота и ссылки. Человеку он
-- ничего не говорит и не привязан к теме работы. Ключ доски («NOR») и номер внутри неё («NOR-001»)
-- решают другую задачу: назвать дело так, чтобы обозначение можно было произнести вслух, послать
-- в переписке и найти по нему.

alter table projects add column key text;
alter table projects add column next_number integer not null default 1;

-- Ключ уникален в организации и не меняется после выдачи: он уходит в чужие заметки и переписку.
create unique index projects_key_unique on projects(org_id, key) where key is not null;

alter table tasks add column number integer;
-- Прежние обозначения дела после переездов между досками: «NOR-12», посланное кому-то, обязано
-- находиться и после того, как дело переехало и получило новый номер.
alter table tasks add column former_keys text[] not null default '{}';

-- Номер уникален внутри доски. Дыры (отменённое дело унесло свой номер) — нормально, повтор — нет.
create unique index tasks_board_number_unique on tasks(project_id, number) where number is not null;

-- ============================================================ ключи существующим доскам
--
-- Ключ считается из названия: буквы латиницы и цифры, первые 3 символа в верхнем регистре. Названия
-- на кириллице (у пилота это «Разное» и «Личное») латинских букв не дают — им достаётся запасной
-- ключ по порядку: B1, B2, … в пределах организации. Переименовать ключ владелец сможет руками.
with candidates as (
  select
    p.id,
    p.org_id,
    upper(substring(regexp_replace(p.name, '[^A-Za-z0-9]', '', 'g') from 1 for 3)) as base,
    row_number() over (partition by p.org_id order by p.created_at, p.id) as seq
  from projects p
),
assigned as (
  select
    c.id,
    case when length(coalesce(c.base, '')) >= 2 then c.base else 'B' || c.seq end as want,
    c.org_id,
    c.seq
  from candidates c
)
update projects p
   set key = case
     -- Совпадение ключей внутри организации разводим порядковым номером доски.
     when exists (
       select 1 from assigned a2
        where a2.org_id = a.org_id and a2.want = a.want and a2.id <> a.id and a2.seq < a.seq
     ) then a.want || a.seq
     else a.want
   end
  from assigned a
 where p.id = a.id;

alter table projects alter column key set not null;

-- ============================================================ номера существующим делам
--
-- Порядок выдачи — порядок создания дела: так номера читаются как история доски.
with numbered as (
  select id, project_id, row_number() over (partition by project_id order by created_at, id) as n
    from tasks where project_id is not null
)
update tasks t set number = numbered.n from numbered where t.id = numbered.id;

update projects p
   set next_number = coalesce((select max(t.number) from tasks t where t.project_id = p.id), 0) + 1;

comment on column projects.key is 'Ключ доски: 2–5 букв, уникален в организации, не меняется после выдачи';
comment on column tasks.former_keys is 'Прежние обозначения дела (NOR-12) после переездов между досками';
