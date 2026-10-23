import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Аннотации инструментов (спека connector-surface): каталог Claude и каталог приложений ChatGPT
// проверяют их у каждого инструмента. openWorldHint по умолчанию по спеке MCP — true, то есть «ходит
// наружу»; поэтому он проставлен явно везде: true — только у тех, кто достаёт за пределы аккаунта
// (письмо на произвольный адрес, вызов внешнего адреса исполнителя).

const DIR = 'src/mcp/tools';
// Наружу — то, что достаёт за пределы аккаунта: письмо на произвольный адрес, вызов адреса исполнителя,
// и действия, после которых другому человеку уходит сообщение в Telegram (так их оценила автоматическая
// проверка каталога ChatGPT 02.10.2026).
const OPEN_WORLD = ['add_project_member', 'add_step', 'answer_question', 'ask_about_task', 'ask_done', 'cancel_task',
  'comment_task', 'connect_runner', 'create_project', 'create_task', 'invite_person', 'move_to_org', 'offboard_person',
  'propose_change', 'raise_alert', 'release_step', 'request_due', 'review_result', 'send_announcement', 'set_person_settings', 'submit_task', 'update_plan'];
// Разрушающие — снимают дело, человека или доступ, перезаписывают целиком (методика, заметка агента,
// источник, настройки человека) или отправляют то, что не отозвать (приглашение).
const DESTRUCTIVE = ['add_source', 'cancel_task', 'invite_person', 'offboard_person', 'remove_project_member',
  'set_agent_note', 'set_person_settings', 'set_playbook', 'update_group', 'ask_about_task'];

function annotations(): { name: string; body: string }[] {
  const out: { name: string; body: string }[] = [];
  for (const f of readdirSync(DIR).filter((x) => x.endsWith('.ts'))) {
    const src = readFileSync(`${DIR}/${f}`, 'utf8');
    for (const m of src.matchAll(/annotations: \{([^}]*)\}/g)) {
      const before = [...src.slice(0, m.index).matchAll(/registerTool\(\s*'([a-z_]+)'/g)];
      const name = before.at(-1)?.[1];
      if (!name) throw new Error(`${f}: аннотации без registerTool`);
      out.push({ name, body: m[1] ?? '' });
    }
  }
  return out;
}

describe('аннотации инструментов', () => {
  it('у каждого инструмента — title, readOnlyHint, destructiveHint и openWorldHint', () => {
    const all = annotations();
    expect(all.length).toBeGreaterThanOrEqual(62);
    const missing = all.filter(({ body }) =>
      !/title: ["']/.test(body) || !/readOnlyHint: (true|false)/.test(body)
      || !/destructiveHint: (true|false)/.test(body) || !/openWorldHint: (true|false)/.test(body));
    expect(missing.map((a) => a.name)).toEqual([]);
  });

  it('наружу ходят приглашение, исполнитель и действия, которые пишут человеку в Telegram', () => {
    const open = annotations().filter(({ body }) => /openWorldHint: true/.test(body)).map((a) => a.name).sort();
    expect(open).toEqual(OPEN_WORLD);
  });

  it('разрушающими помечены ровно те, что снимают, перезаписывают или шлют без отзыва', () => {
    const d = annotations().filter(({ body }) => /destructiveHint: true/.test(body)).map((a) => a.name).sort();
    expect(d).toEqual([...DESTRUCTIVE].sort());
  });

  it('читающий инструмент не помечен разрушающим', () => {
    const bad = annotations().filter(({ body }) => /readOnlyHint: true/.test(body) && /destructiveHint: true/.test(body));
    expect(bad.map((a) => a.name)).toEqual([]);
  });
});
