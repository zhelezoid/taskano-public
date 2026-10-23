import { describe, expect, it } from 'vitest';
import { runTool } from '../src/mcp/context.js';
import { AppError } from '../src/core/errors.js';

// Требование каталога коннекторов (спека connector-surface): ошибка отвечает, что случилось и что
// делать. Немая «Internal Server Error» — одна из названных причин отказа в публикации.

function body(r: Awaited<ReturnType<typeof runTool>>): { code: string; message: string; details: unknown } {
  return JSON.parse((r.content[0] as { text: string }).text);
}

describe('ошибки инструментов', () => {
  it('ожидаемая ошибка несёт машинный код и человеческое объяснение', async () => {
    const r = await runTool(async () => { throw new AppError('validation_failed', 'Say at least two characters', { field: 'query' }); });

    expect(r.isError).toBe(true);
    expect(body(r).code).toBe('validation_failed');
    expect(body(r).message).toContain('two characters');
    expect(body(r).details).toEqual({ field: 'query' });
  });

  it('непредвиденная ошибка не раскрывает внутренностей, но даёт номер случая и что делать дальше', async () => {
    const r = await runTool(async () => { throw new Error('connection terminated: password authentication failed for user "taskano"'); });

    const out = body(r);
    expect(out.code).toBe('internal');
    // Ни текста исключения, ни следов устройства сервера наружу не уходит.
    expect(JSON.stringify(out)).not.toContain('password');
    expect(JSON.stringify(out)).not.toContain('taskano"');
    // Зато есть номер, по которому поддержка находит запись в логе, и он же лежит в details.
    const incident = (out.details as { incident: string }).incident;
    expect(incident).toMatch(/^[0-9a-f]{8}$/);
    expect(out.message).toContain(incident);
    // И сказано, что делать: проверить, прошёл ли вызов, и куда писать.
    expect(out.message).toMatch(/get_task|find_task/);
    expect(out.message).toContain('support@taskano.app');
  });

  it('номер случая свой у каждого сбоя — иначе по нему ничего не найти', async () => {
    const boom = async (): Promise<never> => { throw new Error('boom'); };
    const a = body(await runTool(boom));
    const b = body(await runTool(boom));

    expect((a.details as { incident: string }).incident).not.toBe((b.details as { incident: string }).incident);
  });
});
