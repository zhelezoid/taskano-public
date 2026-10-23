import { afterAll, describe, expect, it, vi } from 'vitest';

// Боевая ветка почты (спека demo-access): с RESEND_API_KEY письма идут в Resend, а не в outbox. Проверка
// «outbox пуст» её не видит — здесь Resend подменён, и считается сам вызов отправки (ревью диффа).

const sent: string[] = [];
vi.mock('resend', () => ({
  Resend: class { emails = { send: async (m: { to: string }) => { sent.push(m.to); return { error: null }; } }; },
}));

process.env.RESEND_API_KEY = 're_test_key';
const { sendEmail } = await import('../src/email/send.js');
afterAll(() => { delete process.env.RESEND_API_KEY; });

const mail = (to: string) => ({ to, subject: 's', html: 'h', text: 't' });

describe('почта демо-компании при заданном ключе Resend', () => {
  it('вымышленным людям и демо-владельцу Resend не зовётся, настоящему человеку — зовётся', async () => {
    process.env.DEMO_LOGIN_EMAIL = 'demo@taskano.app';
    process.env.DEMO_LOGIN_CODE_SHA256 = 'a'.repeat(64);
    await sendEmail(mail('emma.clarke@demo.taskano.app'));
    await sendEmail(mail('demo@taskano.app'));
    expect(sent).toEqual([]);
    await sendEmail(mail('real@test.local'));
    expect(sent).toEqual(['real@test.local']);
  });
});
