// Имена, которых на поверхности больше нет (спека connector-surface): каждое слито с соседним
// инструментом, и разница между ними стала полем. Skill у людей закэширован и ещё какое-то время
// будет звать старые имена — на «unknown tool» модель гадает, поэтому отвечаем по-человечески:
// чем звать теперь и какое поле передать.

export const MERGED_TOOLS: Record<string, string> = {
  list_orgs: 'whoami — your organizations come back in its `orgs` field',
  list_people: 'find_person — without `query` it returns everyone in the organization',
  list_tasks: 'find_task — the same filters (person, status, plan, project, mine_only), `query` is optional',
  find_by_external: 'find_task with external: { system, id }',
  personal_add: 'create_task with org: "personal"',
  personal_update: 'update_task with org: "personal"',
  personal_list: 'find_task with org: "personal"',
  personal_done: 'submit_task with org: "personal" — a personal item needs no result',
  create_waiting: "create_task with kind: 'waiting' and waiting_for",
  set_check_date: 'update_task with next_check_at',
  update_source: 'add_source — a repeat with the same (system, external_id) or (task, url) refreshes the snapshot',
  say_about_task: 'comment_task — it takes the key of your own task as well as its id',
  decline_task: "ask_about_task with kind: 'decline' — the reason goes into `text`",
  resend_invitation: 'invite_person with resend: true',
  pause_group: "update_group with status: 'paused'",
  resume_group: "update_group with status: 'active'",
  set_person_about: 'set_person_settings with about',
  set_task_project: 'update_task with project — the history goes with the item, and it gets a new key in the new project',
  list_time_entries: 'time_report with entries: true',
  accept_result: 'review_result — verdict: "accept" (the default)',
  request_rework: 'review_result with verdict: "rework"',
};

/** Ответ на вызов слитого имени — в том же виде, что и любая ошибка инструмента (`runTool`). */
export function mergedToolResponse(body: unknown): Record<string, unknown> | null {
  const call = body as { method?: unknown; id?: unknown; params?: { name?: unknown } } | null;
  if (!call || typeof call !== 'object' || call.method !== 'tools/call') return null;
  const name = call.params?.name;
  if (typeof name !== 'string') return null;
  const instead = MERGED_TOOLS[name];
  if (!instead) return null;
  return {
    jsonrpc: '2.0',
    id: call.id ?? null,
    result: {
      isError: true,
      content: [{
        type: 'text',
        text: JSON.stringify({
          code: 'not_found',
          message: `There is no tool "${name}" any more: it is merged into ${instead}.`,
          details: { merged_into: instead },
        }),
      }],
    },
  };
}
