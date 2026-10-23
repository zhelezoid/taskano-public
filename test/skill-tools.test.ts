import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Все инструменты, которые skill называет, должны существовать на сервере (спека taskano-skill).
// В skill в обратных кавычках встречаются и поля/события — они перечислены явно.
const NOT_TOOLS = new Set([
  'idempotency_key', 'due_date', 'done_criteria', 'expected_result', 'estimate_minutes', 'auto_release_ok', 'nothing_to_do',
  'people_without_ready', 'not_acknowledged', 'waiting_resolved', 'proposal_decided', 'owner_instruction', 'on_arrival',
  'expected_at', 'next_check_at', 'external_id', 'setup_check', 'waiting_for', 'check_date', 'goal_change',
  'routine_fire_payload', 'invite_code',
  'close_candidates', 'due_assumed', 'done_claim', 'set_by', 'owner_activity', 'updated_at',
  // Исходы повторного приглашения (спека person-presence): skill учит пересказывать их владельцу.
  'invitation_resent', 'app_nudge_sent', 'already_using_app',
  // Коды отказов сервера: в skill они объясняют, чем кончится неверный вызов.
  'not_found', 'validation_failed', 'limit_exceeded',
  // Поля ответа get_capabilities: skill называет их, сверяя свою свежесть.
  'current_skill_version', 'min_skill_version', 'skill_repo', 'server_version',
  // Поле ответа create_task: из него skill собирает ссылку на задачу.
  'short_id',
  // Поле get_task/find_task и настройка группы (спека self-set-due).
  'due_request', 'due_from_chat',
  // Поле блока attention сводки (спека owner-attention).
  'waiting_review',
  // Поле фото из рабочей группы (описание быстрой модели): skill велит не подменять им взгляд.
  'text_on_image',
  // Поле create_task/update_task: проверяющий обычного дела (спека task-reviewer).
  'check_person',
  // Аргументы raise_alert: частота раундов тревоги (спека announcement-alerts).
  'per_day', 'escalated_per_day', 'escalate_after_days',
]);

// Имена событий сводки агента — не инструменты: берём прямо из AGENT_EVENT_TYPES, чтобы не расходиться.
function eventTypes(): Set<string> {
  const src = readFileSync('src/runtime/briefing.ts', 'utf8');
  const block = src.match(/AGENT_EVENT_TYPES = new Set\(\[([\s\S]*?)\]\)/)![1]!;
  return new Set([...block.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!));
}

function registered(): Set<string> {
  const dir = 'src/mcp/tools';
  const names = new Set<string>();
  for (const f of readdirSync(dir)) {
    const src = readFileSync(join(dir, f), 'utf8');
    for (const m of src.matchAll(/registerTool\(\s*'([a-z_]+)'/g)) names.add(m[1]!);
  }
  return names;
}

function mentioned(): Set<string> {
  // Список файлов не перечисляется руками: новая методика (worker.md) иначе молча осталась бы
  // непроверенной, и придуманный в ней инструмент дожил бы до человека.
  const dir = 'skill/skills/taskano';
  const files = [...readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => join(dir, f)), 'skill/routine-prompt.md'];
  const names = new Set<string>();
  const events = eventTypes();
  for (const f of files) {
    for (const m of readFileSync(f, 'utf8').matchAll(/`([a-z]+(?:_[a-z]+)+)(?:\(|`)/g)) if (!NOT_TOOLS.has(m[1]!) && !events.has(m[1]!)) names.add(m[1]!);
  }
  return names;
}

describe('skill ↔ сервер', () => {
  it('каждый инструмент, упомянутый в skill, зарегистрирован в MCP', () => {
    const reg = registered();
    const missing = [...mentioned()].filter((n) => !reg.has(n));
    expect(missing).toEqual([]);
  });
  it('SKILL.md имеет frontmatter name и description', () => {
    const s = readFileSync('skill/skills/taskano/SKILL.md', 'utf8');
    expect(s).toMatch(/^---\nname: taskano\nversion: \d+\.\d+\.\d+\ndescription: .+\n---/);
  });
  // Версия skill (спека taskano-skill): сервер называет её человеку и самому skill,
  // поэтому строка в коде и строка во frontmatter обязаны совпадать — иначе skill решит, что он
  // устарел, и полезет обновляться на ровном месте (или наоборот, проспит обновление).
  it('версия в skill совпадает с версией, которую называет сервер', () => {
    const declared = readFileSync('skill/skills/taskano/SKILL.md', 'utf8').match(/^version:\s*(\S+)$/m)?.[1];
    // Версия живёт в config/product.ts: её берёт и коннектор, и письмо владельцу.
    const served = readFileSync('src/config/product.ts', 'utf8')
      .match(/CURRENT_SKILL_VERSION = '([^']+)'/)?.[1];
    expect(declared).toBeTruthy();
    expect(served).toBe(declared);
  });
  // Плагин: версия манифеста — та же, что у skill; коннектор — боевой адрес, без
  // заголовков (вход — OAuth, токен в репозитории не живёт).
  it('плагин: версия как у skill, коннектор — https://taskano.app/mcp без заголовков', () => {
    const declared = readFileSync('skill/skills/taskano/SKILL.md', 'utf8').match(/^version:\s*(\S+)$/m)?.[1];
    const plugin = JSON.parse(readFileSync('skill/.claude-plugin/plugin.json', 'utf8'));
    expect(plugin.name).toBe('taskano');
    expect(plugin.version).toBe(declared);
    const market = JSON.parse(readFileSync('skill/.claude-plugin/marketplace.json', 'utf8'));
    expect(market.plugins.map((p: { name: string }) => p.name)).toEqual(['taskano']);
    const mcp = JSON.parse(readFileSync('skill/.mcp.json', 'utf8'));
    expect(mcp.mcpServers.taskano).toEqual({ type: 'http', url: 'https://taskano.app/mcp' });
  });
});
