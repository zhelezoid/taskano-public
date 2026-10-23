import { afterAll, describe, expect, it } from 'vitest';
import './helpers.js';
import { closePools, withGlobal } from '../src/db/pool.js';
import { setPersonAbout } from '../src/core/people.js';
import { offboardPerson } from '../src/core/invitations.js';
import { addPerson, inOrg, makeAgent, makeOrg } from './helpers.js';

// Профиль человека (спека person-profile): кто он и что закрывает. Пишут люди, читает агент.

afterAll(closePools);

const ABOUT = 'Закупки по Турции, говорит по-турецки, в документах не силён';

async function scene() {
  const { orgId, ownerId } = await makeOrg();
  const worker = await addPerson(orgId, 'member');
  const other = await addPerson(orgId, 'member');
  return { orgId, ownerId, worker, other, owner: { kind: 'user' as const, userId: ownerId } };
}

const aboutOf = async (orgId: string, userId: string): Promise<string | null> =>
  (await withGlobal((db) => db.query(
    'select about from memberships where org_id = $1 and user_id = $2', [orgId, userId]))).rows[0].about;

describe('профиль человека (спека person-profile)', () => {
  it('владелец пишет профиль, человек правит свой сам', async () => {
    const s = await scene();
    await inOrg(s.orgId, (db) => setPersonAbout(db, s.worker, ABOUT, s.owner), s.ownerId);
    expect(await aboutOf(s.orgId, s.worker)).toBe(ABOUT);

    // Исполнитель лучше всех знает, что он закрывает: свой профиль он правит сам.
    await inOrg(s.orgId, (db) => setPersonAbout(db, s.worker, 'Теперь ещё и логистика',
      { kind: 'user', userId: s.worker }), s.worker);
    expect(await aboutOf(s.orgId, s.worker)).toBe('Теперь ещё и логистика');
  });

  it('рядовой исполнитель чужой профиль не правит', async () => {
    const s = await scene();
    await expect(inOrg(s.orgId, (db) => setPersonAbout(db, s.other, 'чужими словами',
      { kind: 'user', userId: s.worker }), s.worker)).rejects.toThrow(/owner or an admin/);
    expect(await aboutOf(s.orgId, s.other)).toBeNull();
  });

  it('агент профиль читает, но не пишет: это слова людей о людях', async () => {
    const s = await scene();
    const agentId = await makeAgent(s.orgId, s.ownerId);
    await expect(inOrg(s.orgId, (db) => setPersonAbout(db, s.worker, 'вывод модели',
      { kind: 'agent', agentId, userId: s.ownerId }), s.ownerId)).rejects.toThrow(/agent/);
  });

  it('профиль — абзац, а не досье: длинный текст отклоняется', async () => {
    const s = await scene();
    await expect(inOrg(s.orgId, (db) => setPersonAbout(db, s.worker, 'я'.repeat(2001), s.owner), s.ownerId))
      .rejects.toThrow(/2000/);
  });

  it('вывод человека уносит профиль вместе с членством', async () => {
    const s = await scene();
    await inOrg(s.orgId, (db) => setPersonAbout(db, s.worker, ABOUT, s.owner), s.ownerId);
    await inOrg(s.orgId, (db) => offboardPerson(db, s.worker, s.owner), s.ownerId);
    // Членство помечено выведенным — профиль вместе с ним уходит из виду: чужих заметок о человеке
    // в компании не остаётся.
    const row = await withGlobal((db) => db.query(
      `select status, about from memberships where org_id = $1 and user_id = $2`, [s.orgId, s.worker]));
    expect(row.rows[0].status).toBe('removed');
    // Не «стал недоступен», а стёрт: иначе профиль всплывёт при повторном приглашении того же
    // человека — чужими словами годичной давности (ревью диффа).
    expect(row.rows[0].about).toBeNull();
    await expect(inOrg(s.orgId, (db) => setPersonAbout(db, s.worker, 'ещё слово', s.owner), s.ownerId))
      .rejects.toThrow(/not in the organization/);
  });
});
