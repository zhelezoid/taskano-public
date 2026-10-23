import type { Db } from '../db/pool.js';

export interface PersonalPlaceInput {
  /** Проект дела — уже разрешённый id, не имя. */
  projectId: string | null | undefined;
  assigneeUserId: string | null;
  authorUserId: string | null;
  authorAgentId?: string | null;
}

/**
 * Личное место: дело, которое человек завёл себе сам и держит на доске, где больше никого нет
 * (спека projects-stage2).
 *
 * Личное живёт по своим правилам — без обязательных «зачем», «как понять, что готово», срока и
 * источника, и «сделал» закрывает дело сразу, без приёмки. Определять это видом организации больше
 * нельзя: после переезда личное — закрытая доска человека внутри компании, и по виду организации
 * такое дело выглядит рабочим. Старое личное пространство (`kind='personal'`) остаётся у тех, кто
 * ещё не переехал, поэтому проверяем оба признака.
 *
 * Мало того, что доска закрыта и принадлежит исполнителю: человек должен быть сам себе и автором.
 * Иначе рабочее дело, перенесённое в закрытую доску исполнителя, теряло бы приёмку — сдача сразу
 * становилась бы выполнением, и ни автор, ни владелец компании уже не могли бы сказать «переделай».
 * Дело, которое ведёт агент, личным тоже не становится: за ним стоит ведение, а не своя заметка.
 *
 * Определение было размазано по трём местам с разным смыслом (создание дела, требование источника,
 * смена статуса) — расхождение между ними и прятало личные дела от коннектора.
 */
export async function isPersonalPlace(db: Db, input: PersonalPlaceInput): Promise<boolean> {
  const { projectId, assigneeUserId, authorUserId, authorAgentId } = input;

  // Старое личное пространство личное целиком: там человек один, и дело, записанное его же агентом,
  // остаётся его личным делом. Условия ниже — про закрытую доску внутри компании, где рядом живёт
  // общая работа и перепутать их нельзя.
  const org = await db.query(`select kind from orgs where id = current_setting('app.org_id')::uuid`);
  if (org.rows[0]?.kind === 'personal') return true;

  if (authorAgentId) return false;
  if (!assigneeUserId || !authorUserId || assigneeUserId !== authorUserId) return false;
  if (!projectId || !/^[0-9a-f-]{36}$/i.test(projectId)) return false;

  // Доска личная, пока на неё никого не добавили: с появлением второго человека это уже общая
  // работа, и правила у неё общие.
  const p = await db.query(
    `select 1 from projects p
      where p.id = $1 and p.private and p.owner_user_id = $2 and p.status = 'active'
        and not exists (select 1 from project_members m where m.project_id = p.id and m.user_id <> $2)`,
    [projectId, assigneeUserId]);
  return (p.rowCount ?? 0) > 0;
}
