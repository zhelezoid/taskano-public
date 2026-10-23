import { describe, expect, it } from 'vitest';
import { isAllowedRedirect } from '../src/oauth/provider.js';

// Адрес возврата после входа — только у известных клиентов: claude.ai, ChatGPT, клиент на компьютере
// человека (Claude Code). Любой другой позволил бы выманить вход фишинговой ссылкой.

describe('адрес возврата OAuth', () => {
  it.each([
    'https://claude.ai/api/mcp/auth_callback',
    'https://claude.com/api/mcp/auth_callback',
    'https://chatgpt.com/connector_platform_oauth_redirect',
    'https://chatgpt.com/connector/oauth/abc_DEF-123',
    'http://localhost:54123/callback',
    'http://127.0.0.1:8976/oauth/callback',
    'http://[::1]:3000/cb',
  ])('пускает %s', (uri) => expect(isAllowedRedirect(uri)).toBe(true));

  it.each([
    'https://attacker.example/cb',
    'https://chatgpt.com.attacker.example/connector_platform_oauth_redirect',
    'https://chatgpt.com/connector/oauth/../../evil',
    'https://chatgpt.com/connector/oauth/x?next=https://evil',
    'https://chatgpt.com/other',
    'http://chatgpt.com/connector_platform_oauth_redirect',
    'https://localhost/callback',
    'http://localhost.attacker.example/cb',
    'http://user:pw@localhost:1/cb',
    'http://192.168.1.5:3000/cb',
    'javascript:alert(1)',
    'not a url',
  ])('не пускает %s', (uri) => expect(isAllowedRedirect(uri)).toBe(false));
});
