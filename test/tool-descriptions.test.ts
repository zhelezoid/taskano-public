import { describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { buildMcpServer } from '../src/mcp/server.js';

// Каталог коннекторов Anthropic (подтверждение при подаче): в описаниях инструментов нет указаний
// модели, ссылок на другие инструменты и скрытого текста. Как вести себя с инструментами — дело
// скилла и инструкций сервера, не описаний (спека connector-surface).

function collect(): Record<string, string> {
  const out: Record<string, string> = {};
  const orig = McpServer.prototype.registerTool;
  const spy = function (this: McpServer, name: string, cfg: { description?: string; inputSchema?: Record<string, { description?: string }> }, cb: unknown) {
    const params = Object.values(cfg.inputSchema ?? {}).map((v) => v?.description ?? '');
    out[name] = [cfg.description ?? '', ...params].join('\n');
    return (orig as Function).call(this, name, cfg, cb);
  };
  (McpServer.prototype as unknown as { registerTool: unknown }).registerTool = spy;
  try {
    buildMcpServer({ userId: '00000000-0000-0000-0000-000000000000' } as never);
  } finally {
    (McpServer.prototype as unknown as { registerTool: unknown }).registerTool = orig;
  }
  return out;
}

describe('описания инструментов коннектора', () => {
  const tools = collect();
  const names = Object.keys(tools);

  it('все 62 собраны', () => {
    expect(names).toHaveLength(62);
  });

  it('не ссылаются на другие инструменты', () => {
    const refs = names.flatMap((n) => names.filter((o) => o !== n && new RegExp(`\\b${o}\\b`).test(tools[n]!)).map((o) => `${n} → ${o}`));
    expect(refs).toEqual([]);
  });

  it('не указывают модели, как себя вести, и не прячут текст', () => {
    const MODEL = /\b(do not follow|never follow|not instructions|obey|you must|always call|ask not)\b/i;
    // Невидимые символы: нулевой ширины, направление письма, мягкий перенос.
    const HIDDEN = /[​-‏‪-‮⁠-⁤﻿­]/;
    const bad = names.filter((n) => MODEL.test(tools[n]!) || HIDDEN.test(tools[n]!));
    expect(bad).toEqual([]);
  });
});
