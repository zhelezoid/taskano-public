import type { Db } from '../db/pool.js';
import { sendEmail } from '../email/send.js';
import { connectorReminderMail } from '../email/templates/connector-reminder.js';
import { isWorkingTime, windowSchedule } from '../core/calendar.js';
import { env } from '../config/env.js';
import { SKILL_REPO } from '../config/product.js';
import { logger } from '../log.js';

// Человек есть, коннектора нет (спека mcp-and-oauth). Владелец без коннектора — это компания,
// которая стоит: агент до неё не дотягивается, а Клод в разговоре отвечает и ничего не записывает.
// Приветственное письмо уходит один раз и теряется, поэтому напоминаем — но по правилам:
//
//  · только владельцу и админу: рядовому исполнителю коннектор не нужен, он работает в Telegram,
//    и письмо ему было бы спамом ни о чём;
//  · раз в сутки и только в рабочее окно организации: письмо в три часа ночи не помогает никому;
//  · не в первый же час: приветственное письмо только что ушло, повтор следом выглядит поломкой;
//  · пять раз, и всё. Кто не подключил за пять рабочих дней, либо не хочет, либо ему нужен живой
//    разговор, а не шестое письмо. Последнее письмо честно говорит, что оно последнее;
//  · счёт по человеку, а не по компании: коннектор у человека один на все его компании, и владелец
//    трёх компаний не должен получать три одинаковых письма в день.

const MAX_REMINDERS = 5;
const FIRST_AFTER_MS = 20 * 3600_000;   // не раньше следующего дня после подписания
const EVERY_MS = 20 * 3600_000;         // «раз в сутки» с запасом: тик может прийти чуть раньше

interface Candidate {
  user_id: string;
  email: string;
  language: string | null;
  sent_count: number;
}

/** Рассылка напоминаний о коннекторе. Зовётся из тика организации. */
export async function runConnectorReminders(db: Db, orgId: string, now: Date): Promise<void> {
  const org = (await db.query(
    `select name, agent_window from orgs where id = current_setting('app.org_id')::uuid and kind = 'company'`,
  )).rows[0] as { name: string; agent_window: { tz: string; days: number[]; start: string; end: string } } | undefined;
  if (!org) return;
  if (!isWorkingTime(windowSchedule(org.agent_window), now)) return;

  // Кому писать: владелец и админ компании, у кого нет ЖИВОГО коннектора, кто уже «созрел» (прошли
  // сутки с заведения членства) и кому сегодня ещё не писали.
  //
  // «Живой» — это непросроченный refresh-токен, который не отозван и не ротирован. Строки из
  // oauth_tokens не удаляются никогда, поэтому простое «есть хоть одна строка» означало бы: кто
  // однажды подключился и потом нажал Disconnect (или чью цепочку отозвали по краже токена) — тому
  // мы не напишем уже никогда, хотя его компания встала ровно так же, как если бы он не подключался.
  const rows = (await db.query(
    `select m.user_id, e.email::text as email, u.language, coalesce(r.sent_count, 0) as sent_count
       from memberships m
       join users u on u.id = m.user_id
       join user_emails e on e.user_id = u.id and e.is_primary
       left join connector_reminders r on r.user_id = m.user_id
      where m.org_id = current_setting('app.org_id')::uuid
        and m.status = 'active' and m.role in ('owner', 'admin')
        and u.anonymized_at is null
        and not exists (
          select 1 from oauth_tokens t
           where t.user_id = m.user_id and t.kind = 'refresh'
             and t.revoked_at is null and t.rotated_at is null and t.expires_at > $4)
        and m.joined_at <= $1
        and coalesce(r.sent_count, 0) < $3
        and (r.last_sent_at is null or r.last_sent_at <= $2)`,
    [new Date(now.getTime() - FIRST_AFTER_MS), new Date(now.getTime() - EVERY_MS), MAX_REMINDERS, now],
  )).rows as Candidate[];

  for (const person of rows) {
    const isLast = person.sent_count + 1 >= MAX_REMINDERS;
    try {
      await sendEmail(connectorReminderMail(person.email, org.name, person.language ?? 'en', {
        site: env.publicUrl,
        connector: `${env.publicUrl}/mcp`,
        skill: SKILL_REPO,
      }, isLast));
    } catch (e) {
      // Почта упала — счётчик не двигаем: письмо уйдёт со следующим тиком, а не потеряется молча.
      logger.error({ err: e, orgId, userId: person.user_id }, 'напоминание о коннекторе: письмо не ушло');
      continue;
    }
    await db.query(
      `insert into connector_reminders(user_id, sent_count, last_sent_at)
       values ($1, 1, $2)
       on conflict (user_id) do update
         set sent_count = connector_reminders.sent_count + 1, last_sent_at = excluded.last_sent_at`,
      [person.user_id, now]);
  }
}
