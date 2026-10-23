-- Ключи досок: если название доски латиницы не дало, берём из названия организации.
--
-- Миграция 011 считала ключ только из названия доски, и у пилота доски «Разное» и «Личное» получили
-- безликие «B1». Человек ожидает, что дела компании Northwind зовутся «NOR-001», — ключ должен
-- приходить из того имени, которое человек и называет.

with named as (
  select
    p.id,
    p.org_id,
    upper(substring(regexp_replace(o.name, '[^A-Za-z0-9]', '', 'g') from 1 for 3)) as want,
    row_number() over (partition by p.org_id order by p.created_at, p.id) as seq
  from projects p join orgs o on o.id = p.org_id
  where p.key ~ '^B[0-9]+$'
)
update projects p
   set key = case when n.seq = 1 then n.want else n.want || n.seq end
  from named n
 where p.id = n.id
   and length(n.want) >= 2
   -- Занятый ключ не трогаем: перевыдача сломала бы обозначения, уже разошедшиеся по переписке.
   and not exists (select 1 from projects q where q.org_id = n.org_id and q.key = case when n.seq = 1 then n.want else n.want || n.seq end);
