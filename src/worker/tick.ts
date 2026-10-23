import { withGlobal, withOrgBackground, withSystem, type Db } from '../db/pool.js';
import { activateScheduled } from '../core/tasks.js';
import { expireProposals } from '../core/proposals.js';
import { fillSlot } from '../core/queue.js';
import { maybeFire, checkSilence } from '../runtime/fire.js';
import { logger } from '../log.js';
import { runTaskTimers } from './timers.js';
import { runAlertRounds, runAnnouncementReminders } from '../core/announcements.js';
import { runInvitationTimers } from './invitations.js';
import { runConnectorReminders } from './connector.js';
import { runDelivery } from './delivery.js';
import { runDigest } from './digest.js';
import { runAiBudget } from './budget.js';

// Один тик автопилота: по всем организациям, каждая в своём withOrg, ошибка одной не валит остальные
// (спека step-lifecycle-and-queue, «Автопилот»; agent-runtime, «/fire»).

async function heartbeat(now: Date): Promise<void> {
  await withGlobal((db) => db.query(
    `insert into admin_audit(actor, action, payload) values ('worker', 'worker_heartbeat', $1)`,
    [{ at: now.toISOString() }],
  ));
}

async function listOrgIds(): Promise<string[]> {
  const r = await withSystem((db) => db.query('select id from orgs order by created_at'));
  return r.rows.map((row) => row.id as string);
}

/**
 * Одна фоновая задача тика — в своей точке сохранения: упала — откатывается только она, с именем в
 * логе, остальные задачи организации идут дальше и коммитятся. Одна транзакция на всё без этого
 * значила, что любая ошибка в конце тика откатывала сделанное в начале — вместе с отметками об
 * отправленных письмах (напоминания о приглашении и коннекторе ушли бы повторно).
 */
async function step(db: Db, orgId: string, name: string, fn: () => Promise<unknown>): Promise<void> {
  await db.query('savepoint tick_step');
  try {
    await fn();
  } catch (e) {
    await db.query('rollback to savepoint tick_step');
    logger.error({ err: e, orgId, step: name }, 'tick: задача упала, остальные продолжают');
  }
  await db.query('release savepoint tick_step');
}

export async function tickOrg(orgId: string, now: Date): Promise<void> {
  try {
    await tickOrgMain(orgId, now);
  } finally {
    // Доставка — после коммита, своей транзакцией (аудит архитектуры, CRIT). Отправку в Telegram
    // откатить нельзя, поэтому ей не место внутри общей транзакции тика: (1) всё, что тик только что
    // поставил — напоминания таймеров, дайджест, — уже закоммичено и уходит в этом же тике, а не
    // следующим; (2) тик не держит незакрытых замков на уведомлениях, пока доставка своим
    // соединением отмечает их отправленными (сводка напоминаний, дописанная тиком, иначе ждала бы
    // сама себя). Упавшая основная часть доставку не останавливает: уже поставленное должно уйти.
    await withOrgBackground(orgId, (db) => runDelivery(db, orgId, now))
      .catch((e) => logger.error({ err: e, orgId }, 'tick: доставка упала'));
  }

  await maybeFire(orgId, now).catch((e) => logger.error({ err: e, orgId }, 'tick: maybeFire упал'));
  await checkSilence(orgId, now).catch((e) => logger.error({ err: e, orgId }, 'tick: checkSilence упал'));
}

async function tickOrgMain(orgId: string, now: Date): Promise<void> {
  await withOrgBackground(orgId, async (db) => {
    await step(db, orgId, 'activateScheduled', () => activateScheduled(db, now));

    // Слот мог освободиться сам по себе (истёк час blocked) — без нового события это никто не
    // пересчитает. Берём не только `blocked`: слот теперь один на человека поперёк компаний, и
    // освободить его могло событие в другой компании — там наполнить его этой очередью некому, а
    // здесь человек так и стоял бы с делами наготове и без «Сейчас» (спека multi-company).
    await step(db, orgId, 'fillSlot', async () => {
      // У личного пространства очереди и «Сейчас» нет (спека telegram-bot, «Личное»): иначе личное
      // дело становилось active, получало напоминание с «Не могу», а вопрос в личном ядро отклоняет.
      const kind = (await db.query('select kind from orgs where id = $1', [orgId])).rows[0]?.kind;
      if (kind === 'personal') return;
      const waiting = (await db.query(
        `select distinct assignee_user_id from tasks
          where kind = 'action' and status in ('blocked', 'ready', 'rework') and assignee_user_id is not null`,
      )).rows as { assignee_user_id: string }[];
      for (const row of waiting) await fillSlot(db, row.assignee_user_id, now);
    });

    await step(db, orgId, 'runTaskTimers', () => runTaskTimers(db, now));
    await step(db, orgId, 'expireProposals', () => expireProposals(db, now));
    await step(db, orgId, 'runAnnouncementReminders', () => runAnnouncementReminders(db, now));
    await step(db, orgId, 'runAlertRounds', () => runAlertRounds(db, now));
    await step(db, orgId, 'runInvitationTimers', () => runInvitationTimers(db, now));
    await step(db, orgId, 'runConnectorReminders', () => runConnectorReminders(db, orgId, now));
    await step(db, orgId, 'runDigest', () => runDigest(db, orgId, now));
    await step(db, orgId, 'runAiBudget', () => runAiBudget(db, orgId, now));
  });
}

export async function runTick(now: Date = new Date()): Promise<void> {
  await heartbeat(now);
  const orgIds = await listOrgIds();
  for (const orgId of orgIds) {
    try {
      await tickOrg(orgId, now);
    } catch (e) {
      logger.error({ err: e, orgId }, 'tick: организация упала, продолжаем остальные');
    }
  }
}
