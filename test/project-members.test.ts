import { afterAll, describe, expect, it } from 'vitest';
import './helpers.js';
import { closePools, withOrg, withOrgBackground } from '../src/db/pool.js';
import { addProjectMember, createProject, listProjects, removeProjectMember } from '../src/core/projects.js';
import { createTask } from '../src/core/tasks.js';
import { offboardPerson } from '../src/core/invitations.js';
import { addPerson, inOrg, makeAgent, makeOrg, MON_10 } from './helpers.js';

const base = { why: 'зачем', doneCriteria: 'критерий', dueDate: '2026-12-31', description: 'как делать: открыть таблицу и свериться' };

// Состав закрытой доски (спека projects-stage2): дела видят те, кого добавили, —
// не вся компания и не один хозяин.

afterAll(closePools);

/** Закрытая доска владельца с одним делом на ней и посторонний сотрудник рядом. */
async function board() {
  const { orgId, ownerId } = await makeOrg();
  const mate = await addPerson(orgId, 'member');
  const outsider = await addPerson(orgId, 'member');
  const actor = { kind: 'user' as const, userId: ownerId };
  const project = await inOrg(orgId, (db) => createProject(db, { name: `Доска ${Date.now()}`, private: true }, actor), ownerId);
  const task = await inOrg(orgId, (db) => createTask(db, {
    ...base, title: 'Дело закрытой доски', assigneeUserId: ownerId, project: project.id, release: true,
  }, actor, MON_10), ownerId);
  return { orgId, ownerId, mate, outsider, project, task, actor };
}

const seenBy = async (orgId: string, taskId: string, userId: string): Promise<number> =>
  (await inOrg(orgId, (db) => db.query('select id from tasks where id = $1', [taskId]), userId)).rowCount ?? 0;

describe('состав закрытой доски (спека projects-stage2)', () => {
  it('добавленный видит дела доски, посторонний сотрудник — нет', async () => {
    const w = await board();
    expect(await seenBy(w.orgId, w.task.id, w.mate)).toBe(0);

    await inOrg(w.orgId, (db) => addProjectMember(db, w.project.id, w.mate, w.actor), w.ownerId);
    expect(await seenBy(w.orgId, w.task.id, w.mate)).toBe(1);
    // Требование владельца дословно: видят те, кого добавили в этот проект, а не все.
    expect(await seenBy(w.orgId, w.task.id, w.outsider)).toBe(0);
  });

  it('снятие из состава убирает дела из виду', async () => {
    const w = await board();
    await inOrg(w.orgId, (db) => addProjectMember(db, w.project.id, w.mate, w.actor), w.ownerId);
    await inOrg(w.orgId, (db) => removeProjectMember(db, w.project.id, w.mate, w.actor), w.ownerId);
    expect(await seenBy(w.orgId, w.task.id, w.mate)).toBe(0);
  });

  it('агент не видит дела закрытой доски и не правит её состав', async () => {
    const w = await board();
    const agentId = await makeAgent(w.orgId, w.ownerId);
    await inOrg(w.orgId, (db) => addProjectMember(db, w.project.id, w.mate, w.actor), w.ownerId);

    // Агент смотрит без действующего лица — закрытое дело для него не существует.
    const agentView = await withOrg(w.orgId, (db) => db.query('select id from tasks where id = $1', [w.task.id]));
    expect(agentView.rowCount).toBe(0);
    await expect(inOrg(w.orgId, (db) => addProjectMember(db, w.project.id, w.outsider,
      { kind: 'agent', agentId, userId: w.ownerId } as any), w.ownerId)).rejects.toThrow(/agent/i);
  });

  it('состав меняет хозяин доски или админ, а не любой участник', async () => {
    const w = await board();
    await inOrg(w.orgId, (db) => addProjectMember(db, w.project.id, w.mate, w.actor), w.ownerId);
    // Участник видит доску, но не раздаёт доступ к ней дальше.
    await expect(inOrg(w.orgId, (db) => addProjectMember(db, w.project.id, w.outsider,
      { kind: 'user', userId: w.mate }), w.mate)).rejects.toThrow();
    expect(await seenBy(w.orgId, w.task.id, w.outsider)).toBe(0);
  });

  it('участник ставит дело на доску себе, посторонний туда не целится', async () => {
    const w = await board();
    await inOrg(w.orgId, (db) => addProjectMember(db, w.project.id, w.mate, w.actor), w.ownerId);
    const mine = await inOrg(w.orgId, (db) => createTask(db, {
      ...base, title: 'Дело участника', assigneeUserId: w.mate, project: w.project.id, release: true,
    }, { kind: 'user', userId: w.mate }, MON_10), w.mate);
    expect(await seenBy(w.orgId, mine.id, w.ownerId)).toBe(1);

    await expect(inOrg(w.orgId, (db) => createTask(db, {
      ...base, title: 'Чужое дело', assigneeUserId: w.outsider, project: w.project.id, release: true,
    }, { kind: 'user', userId: w.outsider }, MON_10), w.outsider)).rejects.toThrow();
  });

  it('доска в списке проектов у участника есть, у постороннего нет', async () => {
    const w = await board();
    await inOrg(w.orgId, (db) => addProjectMember(db, w.project.id, w.mate, w.actor), w.ownerId);
    const forMate = await inOrg(w.orgId, (db) => listProjects(db, w.mate), w.mate);
    expect(forMate.map((p) => p.id)).toContain(w.project.id);
    const forOutsider = await inOrg(w.orgId, (db) => listProjects(db, w.outsider), w.outsider);
    expect(forOutsider.map((p) => p.id)).not.toContain(w.project.id);
    // Состав виден вместе со списком: кто ставит дело, тот знает, кому оно станет видно.
    expect(forMate.find((p) => p.id === w.project.id)!.members.length).toBe(1);
  });

  it('фоновая работа по делам доски идёт как прежде: воркер их видит', async () => {
    const w = await board();
    const seen = await withOrgBackground(w.orgId, (db) => db.query('select id from tasks where id = $1', [w.task.id]));
    expect(seen.rowCount).toBe(1);
  });

  it('вывод человека из компании снимает его из составов, чужая работа остаётся', async () => {
    const w = await board();
    await inOrg(w.orgId, (db) => addProjectMember(db, w.project.id, w.mate, w.actor), w.ownerId);
    const mateTask = await inOrg(w.orgId, (db) => createTask(db, {
      ...base, title: 'Дело участника', assigneeUserId: w.mate, project: w.project.id, release: true,
    }, { kind: 'user', userId: w.mate }, MON_10), w.mate);

    await inOrg(w.orgId, (db) => offboardPerson(db, w.mate, w.actor), w.ownerId);
    // Ушедшего в составе нет, а доска и дело на ней живы: хозяину они по-прежнему нужны.
    // Смотрим под org-контекстом: в withGlobal политика org_isolation вернула бы 0 строк всегда,
    // и проверка была бы ложноположительной (ревью диффа).
    const left = await inOrg(w.orgId, (db) => db.query('select 1 from project_members where user_id = $1', [w.mate]), w.ownerId);
    expect(left.rowCount).toBe(0);
    expect(await seenBy(w.orgId, mateTask.id, w.ownerId)).toBe(1);
    expect(await seenBy(w.orgId, w.task.id, w.ownerId)).toBe(1);
  });
  it('имя чужой закрытой доски не выдаётся: закрыта — значит не называет себя', async () => {
    const w = await board();
    // Рядовой сотрудник компании читает список досок — чужой закрытой там нет вовсе,
    // ни строкой с нулём дел (ревью диффа: имя доски и есть то, что от неё скрывают).
    const seen = await inOrg(w.orgId, (db) => db.query(
      'select id, name from projects where id = $1', [w.project.id]), w.outsider);
    expect(seen.rowCount).toBe(0);

    await inOrg(w.orgId, (db) => addProjectMember(db, w.project.id, w.mate, w.actor), w.ownerId);
    const forMember = await inOrg(w.orgId, (db) => db.query(
      'select id from projects where id = $1', [w.project.id]), w.mate);
    expect(forMember.rowCount).toBe(1);

    // Воркер обходит доски без действующего лица — иначе таймеры по закрытым доскам встанут.
    const background = await withOrgBackground(w.orgId, (db) => db.query(
      'select id from projects where id = $1', [w.project.id]));
    expect(background.rowCount).toBe(1);
  });
});
