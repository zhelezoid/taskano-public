import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { closePools } from '../src/db/pool.js';
import { createTask } from '../src/core/tasks.js';
import { sendAnnouncement } from '../src/core/announcements.js';
import { createProposal, recordVetoable } from '../src/core/proposals.js';
import { notificationLine, notificationText, type NotifRow } from '../src/bot/notif-text.js';
import { NOTIFICATION_KINDS } from '../src/core/notification-kinds.js';
import { LANGS } from '../src/i18n/index.js';
import { addPerson, inOrg, makeAgent, makeOrg, MON_10 } from './helpers.js';

afterAll(closePools);

// Общая защита от «вид уведомления есть в реестре, а текста для него нет» (находка ревью telegram-bot,
// task_comment). digest — рендерится отдельно buildDigest (bot/deliver.ts) из нескольких организаций,
// не через notificationText — единственное законное исключение.
const RENDERED_ELSEWHERE = new Set(['digest']);

const MESSAGE_KINDS = ['answer', 'comment', 'question', 'unclear', 'decline_reason'] as const;

interface Ids { taskId: string; proposalId: string; vetoableId: string; personId: string; agentId: string; invitationId: string; announcementId: string }

function payloadFor(kind: string, ids: Ids): Record<string, unknown> {
  const { taskId, proposalId, vetoableId } = ids;
  switch (kind) {
    case 'reminder': return { stage: 'overdue_1' };
    case 'reminder_digest': return { task_ids: [taskId] };
    case 'proposal': return { proposal_id: proposalId };
    case 'vetoable': return { change_id: vetoableId };
    case 'stuck_summary': return { plan_ids: [taskId] };            // длина массива — всё, что читает рендер
    // Имена — по id при показе (спека bot-messages): в payload лежат id, а не готовые имена.
    case 'channel_dead': return { user_id: ids.personId };
    case 'task_photo': return { by_user_id: ids.personId };
    case 'review_overdue': return { reviewer_id: ids.personId, hours: 48 };
    case 'review_reminder': return { hours: 24 };
    case 'invitation_stalled': return { invitation_id: ids.invitationId };
    case 'runner_broken':
    case 'agents_silent': return { agent_ids: [ids.agentId] };
    case 'announcement':
    case 'announcement_reminder': return { announcement_id: ids.announcementId };
    case 'open_app': return { by: 'Олег' };
    case 'agent_token_issued': return { label: 'сервер склада', agent_name: 'Fabrikam' };
    case 'person_stuck': return { days: 2 };
    default: return {};
  }
}

describe('покрытие текстов уведомлений (notif-text)', () => {
  it('каждый вид NOTIFICATION_KINDS рендерит непустой текст на всех языках бота', async () => {
    const { orgId, ownerId } = await makeOrg();
    const person = await addPerson(orgId);
    const agentId = await makeAgent(orgId, ownerId);
    const actor = { kind: 'agent' as const, agentId, userId: ownerId };
    const base = { why: 'зачем', doneCriteria: 'критерий', dueDate: '2026-12-31', description: 'как делать: открыть таблицу и свериться' };

    await inOrg(orgId, async (db) => {
      const task = await createTask(db, { ...base, title: 'задача для покрытия уведомлений', assigneeUserId: person }, actor, MON_10);
      for (const kind of MESSAGE_KINDS) {
        await db.query(
          `insert into task_messages(org_id, task_id, author_user_id, kind, text)
           values (current_setting('app.org_id')::uuid, $1, $2, $3, $4)`,
          [task.id, person, kind, `текст «${kind}»`],
        );
      }
      const proposal = await createProposal(db, { agentId, type: 'other', summary: 'Проверить план' }, MON_10);
      const vetoableId = await recordVetoable(
        db, { agentId, kind: 'new_person', summary: 'Первый шаг человеку', before: {}, after: {}, taskId: task.id }, MON_10,
      );
      const invitationId = (await db.query(
        `insert into invitations(org_id, email, user_id, role, token_hash)
         values (current_setting('app.org_id')::uuid, 'invitee@test.local', $1, 'member', $2) returning id`,
        [person, `hash-${task.id}`],
      )).rows[0].id as string;
      const { announcement_id: announcementId } = await sendAnnouncement(
        db, { text: 'С понедельника отгрузка до 15:00', to: [person] }, { kind: 'user', userId: ownerId }, MON_10);
      const ids: Ids = { taskId: task.id, proposalId: proposal.id, vetoableId, personId: person, agentId, invitationId, announcementId };

      for (const kind of Object.keys(NOTIFICATION_KINDS)) {
        if (RENDERED_ELSEWHERE.has(kind)) continue;
        const row: NotifRow = {
          id: 'test', kind, level: NOTIFICATION_KINDS[kind as keyof typeof NOTIFICATION_KINDS],
          task_id: task.id, payload: payloadFor(kind, ids), created_at: MON_10,
        };
        for (const lang of LANGS) {
          const text = await notificationText(db, lang, row, person);
          expect(text.trim(), `${kind} / ${lang}`).not.toBe('');
          // Ни «?» вместо имени, ни даты как в базе (спека bot-messages).
          expect(text, `${kind} / ${lang}`).not.toMatch(/(^|[\s>])\?([\s<]|$)/);
          expect(text, `${kind} / ${lang}`).not.toMatch(/\d{4}-\d{2}-\d{2}/);
          const line = await notificationLine(db, lang, row, person);
          expect(line.trim(), `${kind} / ${lang} (строка)`).not.toBe('');
        }
      }
    });
  });
});

/** Все .ts под каталогом — рекурсивно. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(path);
    return e.name.endsWith('.ts') ? [path] : [];
  });
}

/**
 * Виды, которые код передаёт в notify(...) литералом, — с местом вызова. Берётся выражение после
 * `kind:` внутри вызова, так что тернарник `kind: a ? 'x' : 'y'` отдаёт оба вида.
 */
function notifiedKinds(): { kind: string; where: string }[] {
  const found: { kind: string; where: string }[] = [];
  for (const file of sourceFiles(fileURLToPath(new URL('../src', import.meta.url)))) {
    const src = readFileSync(file, 'utf8');
    for (const call of src.matchAll(/\bnotify\(db,\s*\{/g)) {
      const body = src.slice(call.index, src.indexOf('});', call.index));
      const expr = /\bkind:\s*([^,\n]+)/.exec(body)?.[1] ?? '';
      const line = src.slice(0, call.index).split('\n').length;
      // Вид — литерал в начале выражения или ветка тернарника; `action === 'question'` — не вид.
      for (const m of expr.matchAll(/(?:^|[?:])\s*'([a-z_]+)'/g)) found.push({ kind: m[1]!, where: `${file}:${line}` });
    }
  }
  return found;
}

describe('каждый вид, который шлёт код, есть в реестре', () => {
  // Реестр — контракт между тем, кто создаёт уведомление, и тем, кто его показывает: вид мимо
  // реестра не проверяется тестом выше, текста у него нет, и доставка молча его пропускает
  // (task_changed_by_manager, task_reopened, person_offboarded — так и было).
  it('notify(...) в src/ не передаёт видов вне NOTIFICATION_KINDS', () => {
    const found = notifiedKinds();
    // Защита самого теста: разбор вызовов не должен молча перестать находить что-либо.
    expect(found.length).toBeGreaterThan(20);
    expect(found.map((f) => f.kind)).toContain('task_changed_by_manager');
    const missing = found.filter((f) => !(f.kind in NOTIFICATION_KINDS)).map((f) => `${f.kind} (${f.where})`);
    expect(missing).toEqual([]);
  });
});
