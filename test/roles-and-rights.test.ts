import { afterAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import './helpers.js';
import { closePools } from '../src/db/pool.js';
import { buildMcpServer } from '../src/mcp/server.js';
import { cancelTask, createTask, setCheckDate, updateTask } from '../src/core/tasks.js';
import { invitePerson, resendInvitation } from '../src/core/invitations.js';
import { transition } from '../src/core/lifecycle.js';
import { addProjectMember, createProject, setTaskProject } from '../src/core/projects.js';
import { addManual } from '../src/core/time.js';
import type { Task } from '../src/core/types.js';
import { addPerson, inOrg, makeAgent, makeOrg, MON_10, uniq } from './helpers.js';

// Спека roles-and-rights, машинные пункты Acceptance. Правило, которым всё это объясняется:
// роль даёт право распорядиться делом, но не даёт права говорить за человека, что он его сделал.

afterAll(closePools);

async function mcp(userId: string): Promise<Client> {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await buildMcpServer({ userId }).connect(serverT);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(clientT);
  return client;
}

async function call(userId: string, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; data: any }> {
  const r = await (await mcp(userId)).callTool({ name, arguments: args }) as { isError?: boolean; content: { type: string; text: string }[] };
  return { isError: !!r.isError, data: JSON.parse(r.content[0]!.text) };
}

const user = (userId: string) => ({ kind: 'user' as const, userId });
const byAgent = (agentId: string, userId: string) => ({ kind: 'agent' as const, agentId, userId });

const base = { why: 'зачем', doneCriteria: 'критерий', dueDate: '2026-12-31', description: 'как делать: открыть таблицу и свериться' };

/** Компания: владелец с агентом, двое рядовых, посторонний рядовой и гость. */
async function world() {
  const { orgId, ownerId } = await makeOrg();
  const memberId = await addPerson(orgId, 'member');
  const workerId = await addPerson(orgId, 'member');
  const strangerId = await addPerson(orgId, 'member');
  const guestId = await addPerson(orgId, 'guest');
  const agentId = await makeAgent(orgId, ownerId);
  return { orgId, ownerId, memberId, workerId, strangerId, guestId, agentId };
}

type World = Awaited<ReturnType<typeof world>>;

/** Дело, которое рядовой поставил коллеге: автор — человек, исполнитель — другой человек. */
async function taskFromMember(w: World, title: string): Promise<Task> {
  return inOrg(w.orgId, (db) => createTask(db, { ...base, title, assigneeUserId: w.workerId }, user(w.memberId), MON_10));
}

describe('кто ставит дела людям', () => {
  it('рядовой ставит дело другому человеку; гость — только себе', async () => {
    const w = await world();

    const task = await taskFromMember(w, 'позвонить поставщику');
    expect(task.author_user_id).toBe(w.memberId);
    expect(task.assignee_user_id).toBe(w.workerId);

    // Гость — человек со стороны: компания ему дел не раздаёт, и он её людям тоже.
    await expect(inOrg(w.orgId, (db) => createTask(db, { ...base, title: 'сделай за меня', assigneeUserId: w.workerId }, user(w.guestId), MON_10)))
      .rejects.toThrow(/guest can only set tasks for themselves/);
    const own = await inOrg(w.orgId, (db) => createTask(db, { ...base, title: 'своё дело', assigneeUserId: w.guestId }, user(w.guestId), MON_10));
    expect(own.assignee_user_id).toBe(w.guestId);
  });
});

describe('состав компании меняют владелец и админ', () => {
  it('рядовой не приглашает людей — ни рядовым, ни владельцем', async () => {
    const w = await world();
    const invite = (role: 'member' | 'owner', actorUserId: string) => inOrg(w.orgId, (db) => invitePerson(
      db, { email: `invitee-${uniq()}@test.local`, role }, user(actorUserId)));

    await expect(invite('member', w.memberId)).rejects.toThrow(/Required role/);
    // Ровно этим путём рядовой делал владельцем вторую свою почту.
    await expect(invite('owner', w.memberId)).rejects.toThrow(/Required role/);

    expect((await invite('member', w.ownerId)).membershipStatus).toBe('invited');
  });

  it('агент рядового — не лазейка: повторить приглашение он не может, агент владельца может', async () => {
    const w = await world();
    const email = `invitee-${uniq()}@test.local`;
    await inOrg(w.orgId, (db) => invitePerson(db, { email, role: 'member' }, user(w.ownerId)));
    const memberAgent = await makeAgent(w.orgId, w.memberId);

    await expect(inOrg(w.orgId, (db) => resendInvitation(db, email, byAgent(memberAgent, w.memberId))))
      .rejects.toThrow(/Required role/);

    const resent = await inOrg(w.orgId, (db) => resendInvitation(db, email, byAgent(w.agentId, w.ownerId)));
    expect(resent.result).toBe('invitation_resent');
  });
});

describe('распоряжение делом против свидетельства о работе', () => {
  it('владелец правит и отменяет чужое дело', async () => {
    const w = await world();
    const task = await taskFromMember(w, 'собрать цены');

    const updated = await inOrg(w.orgId, (db) => updateTask(db, task.id, { title: 'собрать цены трёх поставщиков' }, user(w.ownerId)));
    expect(updated.title).toBe('собрать цены трёх поставщиков');

    const cancelled = await inOrg(w.orgId, (db) => cancelTask(db, task.id, user(w.ownerId), 'передумали'));
    expect(cancelled.status).toBe('cancelled');
  });

  it('принять результат за исполнителя владелец не может — это дело автора', async () => {
    const w = await world();
    const task = await taskFromMember(w, 'сдать отчёт');
    await inOrg(w.orgId, async (db) => {
      await transition(db, task.id, 'take', user(w.workerId), { now: MON_10 });
      await transition(db, task.id, 'submit', user(w.workerId), { now: MON_10, result: { text: 'готово' } });
    });

    // В «Итогах» иначе появилась бы запись, что человек сдал работу, которую он не сдавал.
    const byOwner = await call(w.ownerId, 'review_result', { org: w.orgId, task: task.id });
    expect(byOwner.isError).toBe(true);
    expect(byOwner.data.code).toBe('forbidden');

    const byAuthor = await call(w.memberId, 'review_result', { org: w.orgId, task: task.id });
    expect(byAuthor.isError).toBe(false);
    expect(byAuthor.data.status).toBe('done');
  });

  it('человек, поставивший дело, сохраняет права после adopt_task', async () => {
    const w = await world();
    const task = await taskFromMember(w, 'сверить остатки');

    const adopted = await call(w.ownerId, 'adopt_task', { org: w.orgId, agent: w.agentId, task: task.id });
    expect(adopted.isError).toBe(false);
    expect(adopted.data.author_agent_id).toBe(w.agentId);

    // Усыновление даёт агенту ведение, но не отнимает дело у того, кто его поставил.
    const updated = await inOrg(w.orgId, (db) => updateTask(db, task.id, { title: 'сверить остатки склада' }, user(w.memberId)));
    expect(updated.title).toBe('сверить остатки склада');
    const cancelled = await inOrg(w.orgId, (db) => cancelTask(db, task.id, user(w.memberId), 'уже сверили'));
    expect(cancelled.status).toBe('cancelled');
  });
});

describe('сдаёт работу только исполнитель', () => {
  it('submit_task по чужому делу отклоняется, даже если вместо «личного» назвали компанию', async () => {
    const w = await world();
    const task = await taskFromMember(w, 'забрать документы');

    const r = await call(w.memberId, 'submit_task', { org: w.orgId, task: task.id });
    expect(r.isError).toBe(true);
    expect(r.data.code).toBe('not_found');

    const still = await inOrg(w.orgId, (db) => db.query('select status from tasks where id = $1', [task.id]));
    expect(still.rows[0].status).not.toBe('submitted');
  });
});

describe('управленческие ручки закрыты ролью', () => {
  it('методику компании переписывает владелец, рядовой — нет', async () => {
    const w = await world();

    const byMember = await call(w.memberId, 'set_playbook', { org: w.orgId, text: 'работаем как я скажу' });
    expect(byMember.isError).toBe(true);
    expect(byMember.data.code).toBe('forbidden');

    expect((await call(w.ownerId, 'set_playbook', { org: w.orgId, text: 'сначала спрашиваем срок' })).isError).toBe(false);
    expect((await call(w.memberId, 'get_playbook', { org: w.orgId })).data.text).toBe('сначала спрашиваем срок');
  });

  it('сводка направлений и её подтверждение — владельцу, не рядовому', async () => {
    const w = await world();
    await taskFromMember(w, 'разгрузить машину');

    const briefing = await call(w.memberId, 'get_briefing', { org: w.orgId });
    expect(briefing.isError).toBe(true);
    expect(briefing.data.code).toBe('forbidden');
    const ack = await call(w.memberId, 'ack_briefing', { org: w.orgId, cursor: '0:0' });
    expect(ack.isError).toBe(true);
    expect(ack.data.code).toBe('forbidden');

    // Рутину запускает коннектор владельца — ей эта же ручка обязана отвечать как прежде.
    const own = await call(w.ownerId, 'get_briefing', { org: w.orgId });
    expect(own.isError).toBe(false);
    expect((await call(w.ownerId, 'ack_briefing', { org: w.orgId, cursor: own.data.cursor })).isError).toBe(false);
  });

  it('часы всех людей видит владелец; рядовому отдаются только его часы', async () => {
    const w = await world();
    const mine = await inOrg(w.orgId, (db) => createTask(db, { ...base, title: 'мои часы', assigneeUserId: w.memberId }, user(w.memberId), MON_10));
    const theirs = await taskFromMember(w, 'чужие часы');
    await inOrg(w.orgId, async (db) => {
      await addManual(db, w.memberId, mine.id, 30);
      await addManual(db, w.workerId, theirs.id, 90);
    });
    const period = { from: '2000-01-01', to: '2100-01-01' };

    const all = await call(w.ownerId, 'time_report', { org: w.orgId, ...period });
    expect(all.data.totalMinutes).toBe(120);

    // Рядовому не отказ, а свои часы: ровно те же числа, что ему показывает приложение.
    const own = await call(w.memberId, 'time_report', { org: w.orgId, ...period });
    expect(own.data.totalMinutes).toBe(30);
    const asked = await call(w.memberId, 'time_report', { org: w.orgId, ...period, person: w.workerId });
    expect(asked.data.totalMinutes).toBe(30);

    // Имя, о котором спросил рядовой, не разбирается вовсе: у поглощённого `list_time_entries` было
    // так же, и слияние не имеет права это менять (ревью слияний). Иначе вместо своих часов человек
    // получал бы «такого человека нет».
    const unknown = await call(w.memberId, 'time_report', { org: w.orgId, ...period, person: 'Нет Такого Человека' });
    expect(unknown.data.totalMinutes).toBe(30);

    // Тот же отчёт, спрошенный записями (слияние `list_time_entries` в `time_report`).
    const entries = await call(w.memberId, 'time_report', { org: w.orgId, ...period, entries: true });
    expect(entries.data.entries.map((e: { user_id: string }) => e.user_id)).toEqual([w.memberId]);
    const ownerEntries = await call(w.ownerId, 'time_report', { org: w.orgId, ...period, entries: true });
    expect(ownerEntries.data.entries).toHaveLength(2);
  });
});

describe('источник к делу дописывают автор, исполнитель и владелец', () => {
  it('посторонний рядовой не подкладывает цитату в чужое дело', async () => {
    const w = await world();
    const task = await taskFromMember(w, 'договориться о доставке');
    const source = (userId: string, title: string) => call(userId, 'add_source', {
      org: w.orgId, task: task.id, kind: 'chat', title, quote: 'сказал, что доставка в пятницу',
    });

    // Цитату источника исполнитель читает как основание дела — подложить её со стороны нельзя.
    const stranger = await source(w.strangerId, 'разговор, которого не было');
    expect(stranger.isError).toBe(true);
    expect(stranger.data.code).toBe('forbidden');

    expect((await source(w.memberId, 'разговор 19 сентября')).isError).toBe(false);
    expect((await source(w.workerId, 'звонок в транспортную')).isError).toBe(false);
    expect((await source(w.ownerId, 'письмо поставщика')).isError).toBe(false);
  });
});

describe('правка чужого дела не проходит молча', () => {
  it('владелец правит чужое дело — уведомление уходит автору и исполнителю', async () => {
    const w = await world();
    const task = await taskFromMember(w, 'подготовить смету');

    await inOrg(w.orgId, (db) => updateTask(db, task.id, { dueDate: '2026-12-25' }, user(w.ownerId)));

    const notified = await inOrg(w.orgId, (db) => db.query(
      `select user_id from notifications where task_id = $1 and kind = 'task_changed_by_manager' order by user_id`, [task.id]));
    expect(notified.rows.map((r) => r.user_id).sort()).toEqual([w.memberId, w.workerId].sort());
  });
});

// Находки ревью диффа: места, где право обходилось не в лоб, а через перенос дела или через
// действия, у которых проверки не было вовсе.

describe('приёмку нельзя отключить переносом дела', () => {
  it('рабочее дело, перенесённое в закрытую доску исполнителя, приёмку не теряет', async () => {
    const w = await world();
    // Исполнитель — владелец компании: он и хозяин своей доски, и вправе распорядиться делом,
    // то есть может перенести его к себе, никого в доску не пуская.
    const board = await inOrg(w.orgId, (db) => createProject(db, { name: `Своё ${uniq()}`, private: true }, user(w.ownerId)), w.ownerId);
    const task = await inOrg(w.orgId, (db) => createTask(db,
      { ...base, title: 'свериться с поставщиком', assigneeUserId: w.ownerId }, user(w.memberId), MON_10));

    await inOrg(w.orgId, (db) => setTaskProject(db, task.id, board.id, user(w.ownerId)), w.ownerId);

    const after = await inOrg(w.orgId, (db) => transition(db, task.id, 'submit', user(w.ownerId)), w.ownerId);

    // Дело поставил другой человек — сдача остаётся сдачей, а принимает её автор.
    expect(after.status).toBe('submitted');
  });

  it('своё дело на своей доске закрывается сдачей и попадает в «сделано»', async () => {
    const w = await world();
    const board = await inOrg(w.orgId, (db) => createProject(db, { name: `Своё ${uniq()}`, private: true }, user(w.memberId)), w.memberId);
    const mine = await inOrg(w.orgId, (db) => createTask(db,
      { title: 'разобрать бумаги', assigneeUserId: w.memberId, project: board.id }, user(w.memberId), MON_10), w.memberId);

    const after = await inOrg(w.orgId, (db) => transition(db, mine.id, 'submit', user(w.memberId)), w.memberId);

    expect(after.status).toBe('done');
    // «Итоги» считают сделанное по событию приёмки: без него закрытое дело висело бы сданным вечно.
    const kinds = await inOrg(w.orgId, (db) => db.query(
      `select type from events where task_id = $1 order by at`, [mine.id]), w.memberId);
    expect(kinds.rows.map((r: { type: string }) => r.type)).toContain('task_accepted');
  });

  it('доска перестаёт быть личной, как только на неё добавили второго', async () => {
    const w = await world();
    const board = await inOrg(w.orgId, (db) => createProject(db, { name: `Общее ${uniq()}`, private: true }, user(w.memberId)), w.memberId);
    await inOrg(w.orgId, (db) => addProjectMember(db, board.id, w.workerId, user(w.memberId)), w.memberId);

    // Дело себе же, но доска уже общая — значит работа общая, и правила у неё общие.
    const r = inOrg(w.orgId, (db) => createTask(db,
      { title: 'без объяснения', assigneeUserId: w.memberId, project: board.id }, user(w.memberId), MON_10), w.memberId);

    await expect(r).rejects.toThrow(/Missing required fields/);
  });
});

describe('ожидания и перенос проекта', () => {
  it('дату проверки двигают автор, исполнитель и владелец — посторонний нет', async () => {
    const w = await world();
    const waiting = await inOrg(w.orgId, (db) => createTask(db, {
      kind: 'waiting', title: 'ответ банка', why: 'зачем', assigneeUserId: w.workerId,
      waiting: { waitingFor: 'банк', nextCheckAt: new Date(MON_10.getTime() + 86400000).toISOString() },
    }, user(w.memberId), MON_10));
    const later = new Date(MON_10.getTime() + 5 * 86400000);

    await expect(inOrg(w.orgId, (db) => setCheckDate(db, waiting.id, later, user(w.strangerId))))
      .rejects.toThrow(/forbidden|Only the author/);
    // Исполнителю приходит напоминание «пора проверить» — двигать дату он вправе.
    await expect(inOrg(w.orgId, (db) => setCheckDate(db, waiting.id, later, user(w.workerId)))).resolves.toBeTruthy();
    await expect(inOrg(w.orgId, (db) => setCheckDate(db, waiting.id, later, user(w.ownerId)))).resolves.toBeTruthy();
  });

  it('перенос чужого дела в другой проект доходит до автора и исполнителя', async () => {
    const w = await world();
    const task = await taskFromMember(w, 'собрать документы');
    const other = await inOrg(w.orgId, (db) => createProject(db, { name: `Проект ${uniq()}` }, user(w.ownerId)), w.ownerId);

    await inOrg(w.orgId, (db) => setTaskProject(db, task.id, other.id, user(w.ownerId)), w.ownerId);

    const n = await inOrg(w.orgId, (db) => db.query(
      `select user_id from notifications where task_id = $1 and kind = 'task_changed_by_manager'`, [task.id]));
    expect(n.rows.map((r: { user_id: string }) => r.user_id).sort())
      .toEqual([w.memberId, w.workerId].sort());
  });
});
