import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import './helpers.js';
import { closePools, withGlobal } from '../src/db/pool.js';
import { addMember, ensureUserByEmail } from '../src/core/people.js';
import { runConnectorReminders } from '../src/worker/connector.js';
import { tickOrg } from '../src/worker/tick.js';
import { outbox } from '../src/email/send.js';
import { connectClient } from './mcp-client.js';
import { inOrg, makeOrg, MON_10, minutes } from './helpers.js';

// Человек есть, коннектора нет (спека mcp-and-oauth). Письмо — единственный способ дотянуться:
// в Telegram владелец может не заходить вовсе, а без коннектора компания стоит.

afterAll(closePools);

/** Член компании с подтверждённой почтой, «созревший» для напоминания (членство сутки назад). */
async function member(
  orgId: string, role: 'owner' | 'admin' | 'member', lang = 'ru', joinedAt = new Date(MON_10.getTime() - 3 * 86400000),
): Promise<{ id: string; email: string }> {
  const email = `conn-${randomUUID()}@test.local`;
  const id = await withGlobal(async (db) => {
    const { user } = await ensureUserByEmail(db, email, { verified: true, language: lang });
    await addMember(db, orgId, user.id, role);
    await db.query(`update memberships set joined_at = $3 where org_id = $1 and user_id = $2`, [orgId, user.id, joinedAt]);
    return user.id as string;
  });
  return { id, email };
}

const mailsTo = (email: string) => outbox.filter((m) => m.to === email);

describe('напоминание о неподключённом коннекторе', () => {
  let orgId: string;

  beforeEach(async () => {
    ({ orgId } = await makeOrg());
  });

  it('владельцу и админу без коннектора письмо уходит, рядовому исполнителю — нет', async () => {
    const admin = await member(orgId, 'admin');
    const worker = await member(orgId, 'member');

    await inOrg(orgId, (db) => runConnectorReminders(db, orgId, MON_10));

    expect(mailsTo(admin.email)).toHaveLength(1);
    // Рядовой работает в Telegram, коннектор ему не нужен — письмо было бы спамом ни о чём.
    expect(mailsTo(worker.email)).toHaveLength(0);
  });

  it('рассылка стоит в тике организации, а не только в тесте', async () => {
    const admin = await member(orgId, 'admin');

    // Через настоящий тик: иначе строку вызова можно убрать из tickOrg и ни один тест не заметит.
    await tickOrg(orgId, MON_10);

    expect(mailsTo(admin.email)).toHaveLength(1);
  });

  it('письмо приходит на языке человека и называет адрес коннектора', async () => {
    const ru = await member(orgId, 'admin', 'ru');
    const tr = await member(orgId, 'admin', 'tr');

    await inOrg(orgId, (db) => runConnectorReminders(db, orgId, MON_10));

    expect(mailsTo(ru.email)[0]!.subject).toMatch(/не соединена/);
    expect(mailsTo(tr.email)[0]!.subject).toMatch(/bağlı değil/);
    for (const m of [mailsTo(ru.email)[0]!, mailsTo(tr.email)[0]!]) {
      expect(m.text).toContain('/mcp');
      expect(m.html).toContain('Add custom connector');
    }
  });

  it('не чаще раза в сутки и только в рабочее окно организации', async () => {
    const owner = await member(orgId, 'admin');

    await inOrg(orgId, (db) => runConnectorReminders(db, orgId, MON_10));
    // Через час — рано.
    await inOrg(orgId, (db) => runConnectorReminders(db, orgId, minutes(MON_10, 60)));
    expect(mailsTo(owner.email)).toHaveLength(1);

    // Ночью следующего дня — рабочее окно закрыто, письма нет.
    await inOrg(orgId, (db) => runConnectorReminders(db, orgId, new Date(MON_10.getTime() + 36 * 3600_000)));
    expect(mailsTo(owner.email)).toHaveLength(1);

    // На следующий рабочий день в рабочее время — второе письмо.
    await inOrg(orgId, (db) => runConnectorReminders(db, orgId, new Date(MON_10.getTime() + 24 * 3600_000)));
    expect(mailsTo(owner.email)).toHaveLength(2);
  });

  it('границы «созрел» и «сутки прошли» — ровно на пороге письмо уходит', async () => {
    // Членство ровно за 20 часов до тика: порог пройден, значит пишем.
    const owner = await member(orgId, 'admin', 'ru', new Date(MON_10.getTime() - 20 * 3600_000));
    await inOrg(orgId, (db) => runConnectorReminders(db, orgId, MON_10));
    expect(mailsTo(owner.email)).toHaveLength(1);

    // Ровно 20 часов с прошлого письма — тоже порог: второе письмо уходит.
    const next = new Date(MON_10.getTime() + 24 * 3600_000);
    await withGlobal((db) => db.query(`update connector_reminders set last_sent_at = $2 where user_id = $1`,
      [owner.id, new Date(next.getTime() - 20 * 3600_000)]));
    await inOrg(orgId, (db) => runConnectorReminders(db, orgId, next));
    expect(mailsTo(owner.email)).toHaveLength(2);
  });

  it('пять писем, и больше никогда; последнее говорит, что оно последнее', async () => {
    const owner = await member(orgId, 'admin');

    for (let day = 0; day < 8; day++) {
      await inOrg(orgId, (db) => runConnectorReminders(db, orgId, new Date(MON_10.getTime() + day * 24 * 3600_000)));
    }

    const mails = mailsTo(owner.email);
    expect(mails).toHaveLength(5);
    expect(mails.at(-1)!.text).toMatch(/последнее напоминание/);
    // Предыдущие письма такого не обещают — иначе обещание было бы ложью четыре раза подряд.
    expect(mails[0]!.text).not.toMatch(/последнее напоминание/);
  });

  it('подключил коннектор — писать перестаём', async () => {
    const email = `conn-${randomUUID()}@test.local`;
    await connectClient(email);                       // человек прошёл вход и получил токен
    const id = await withGlobal(async (db) => {
      const { user } = await ensureUserByEmail(db, email, { verified: true });
      await addMember(db, orgId, user.id, 'admin');
      await db.query(`update memberships set joined_at = $3 where org_id = $1 and user_id = $2`,
        [orgId, user.id, new Date(MON_10.getTime() - 3 * 86400000)]);
      return user.id as string;
    });
    expect(id).toBeTruthy();

    const before = mailsTo(email).length;
    await inOrg(orgId, (db) => runConnectorReminders(db, orgId, MON_10));
    expect(mailsTo(email)).toHaveLength(before);
  });

  it('коннектор отключён или отозван — пишем снова: компания стоит так же, как без него', async () => {
    const email = `conn-${randomUUID()}@test.local`;
    await connectClient(email);
    const id = await withGlobal(async (db) => {
      const { user } = await ensureUserByEmail(db, email, { verified: true });
      await addMember(db, orgId, user.id, 'admin');
      await db.query(`update memberships set joined_at = $3 where org_id = $1 and user_id = $2`,
        [orgId, user.id, new Date(MON_10.getTime() - 3 * 86400000)]);
      // Человек нажал Disconnect в claude.ai (или цепочку отозвали по краже токена). Строки из
      // oauth_tokens не удаляются никогда — remains только пометка.
      await db.query(`update oauth_tokens set revoked_at = now() where user_id = $1`, [user.id]);
      return user.id as string;
    });
    expect(id).toBeTruthy();

    const before = mailsTo(email).length;
    await inOrg(orgId, (db) => runConnectorReminders(db, orgId, MON_10));
    expect(mailsTo(email)).toHaveLength(before + 1);
  });

  it('человеку, заведённому только что, не пишем: приветственное письмо ушло минуту назад', async () => {
    const email = `conn-${randomUUID()}@test.local`;
    await withGlobal(async (db) => {
      const { user } = await ensureUserByEmail(db, email, { verified: true });
      await addMember(db, orgId, user.id, 'admin');    // joined_at = сейчас
    });

    await inOrg(orgId, (db) => runConnectorReminders(db, orgId, MON_10));
    expect(mailsTo(email)).toHaveLength(0);
  });

  it('человеку, которого стёрли по запросу, не пишем', async () => {
    const gone = await member(orgId, 'admin');
    await withGlobal((db) => db.query(`update users set anonymized_at = now() where id = $1`, [gone.id]));

    await inOrg(orgId, (db) => runConnectorReminders(db, orgId, MON_10));
    expect(mailsTo(gone.email)).toHaveLength(0);
  });

  it('владелец двух компаний получает одно письмо в день: коннектор у него один', async () => {
    const second = await makeOrg();
    const person = await member(orgId, 'admin');
    await withGlobal(async (db) => {
      await addMember(db, second.orgId, person.id, 'admin');
      await db.query(`update memberships set joined_at = $3 where org_id = $1 and user_id = $2`,
        [second.orgId, person.id, new Date(MON_10.getTime() - 3 * 86400000)]);
    });

    await inOrg(orgId, (db) => runConnectorReminders(db, orgId, MON_10));
    await inOrg(second.orgId, (db) => runConnectorReminders(db, second.orgId, MON_10));

    // Письмо про коннектор — про человека, а не про компанию: второе было бы про то же самое.
    expect(mailsTo(person.email)).toHaveLength(1);
  });
});
