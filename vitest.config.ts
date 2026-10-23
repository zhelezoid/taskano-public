import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    // Тесты делят одну базу: последовательно, чтобы счётчики и курсоры были детерминированы.
    fileParallelism: false,
    // Тесты читают письма из outbox и не шлют настоящих: ключ из оболочки разработчика отправлял
    // письма на example.com и ронял ~70 тестов ответом 403.
    env: { RESEND_API_KEY: '' },
    testTimeout: 20000,
    hookTimeout: 60000,
  },
});
