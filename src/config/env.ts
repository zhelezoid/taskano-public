import { EMPTY_SHA256 } from '../core/demo-code.js';

// Конфиг только из окружения (ни адресов, ни ключей в коде).
function opt(name: string, fallback = ''): string {
  return process.env[name] ?? fallback;
}

export const env = {
  get publicUrl() { return opt('PUBLIC_URL', 'http://localhost:3000').replace(/\/$/, ''); },
  get port() { return Number(opt('PORT', '3000')); },
  get databaseUrl() { return opt('DATABASE_URL', 'postgres://taskano_owner:dev@127.0.0.1:55432/taskano'); },
  get databaseAppUrl() { return opt('DATABASE_APP_URL', 'postgres://taskano_app:dev_app@127.0.0.1:55432/taskano'); },
  get databaseSystemUrl() { return opt('DATABASE_SYSTEM_URL', 'postgres://taskano_system:dev_system@127.0.0.1:55432/taskano'); },
  get telegramBotToken() { return opt('TELEGRAM_BOT_TOKEN'); },
  get telegramBotUsername() { return opt('TELEGRAM_BOT_USERNAME', 'taskano_test_bot'); },
  get telegramWebhookSecret() { return opt('TELEGRAM_WEBHOOK_SECRET'); },
  get telegramTestBotToken() { return opt('TELEGRAM_TEST_BOT_TOKEN'); },
  get ownerTelegramChatId() { return opt('OWNER_TELEGRAM_CHAT_ID'); },
  get anthropicApiKey() { return opt('ANTHROPIC_API_KEY'); },
  get resendApiKey() { return opt('RESEND_API_KEY'); },
  get emailFrom() { return opt('EMAIL_FROM', 'Taskano <no-reply@example.com>'); },
  // 32 байта в hex. В dev — фиксированный ключ, в проде обязателен свой (проверяется при старте).
  get encryptionKey() { return opt('ENCRYPTION_KEY', '0'.repeat(64)); },
  get hmacSecret() { return opt('HMAC_SECRET', 'dev-hmac-secret'); },
  get version() { return opt('TASKANO_VERSION', 'dev'); },
  get logLevel() { return opt('LOG_LEVEL', 'info'); },
  // Изображения из рабочих групп (спека group-intake): в compose — том, общий для web и worker.
  get mediaDir() { return opt('MEDIA_DIR', './data/media'); },
  get isProduction() { return opt('NODE_ENV') === 'production'; },
  // Открытая регистрация (спека open-signup): предохранитель от наплыва новых компаний без кода.
  // Внутренний режим (решение владельца 20.10.2026): посторонний не входит и компанию не
  // заводит — только участники компаний и приглашённые. На бою INTERNAL_ONLY=1.
  get internalOnly() { return opt('INTERNAL_ONLY', '0') === '1'; },
  get signupOrgsPerDay() { return Number(opt('SIGNUP_ORGS_PER_DAY', '50')); },
  // Демо-вход для ревьюера каталога (спека demo-access): почта и sha256 постоянного кода. Сам код
  // в окружение не кладётся. Пусто хоть одно — демо-входа нет.
  get demoLoginEmail() { return opt('DEMO_LOGIN_EMAIL').trim().toLowerCase(); },
  get demoLoginCodeSha256() { return opt('DEMO_LOGIN_CODE_SHA256').trim().toLowerCase(); },
  // Вход через Google на странице подключения (спека google-login). Пусто хоть одно — кнопки нет.
  get googleClientId() { return opt('GOOGLE_CLIENT_ID').trim(); },
  get googleClientSecret() { return opt('GOOGLE_CLIENT_SECRET').trim(); },
  // Подтверждение домена в каталоге ChatGPT: токен из кабинета OpenAI, публичный по смыслу (его
  // отдаёт /.well-known/openai-apps-challenge). Пусто — адрес отвечает 404.
  get openaiAppsChallenge() { return opt('OPENAI_APPS_CHALLENGE').trim(); },
};

/** Почта демо-входа, если он включён; иначе null. */
export function demoLoginEmail(): string | null {
  return env.demoLoginEmail && env.demoLoginCodeSha256 ? env.demoLoginEmail : null;
}

/** Вход через Google включён: заданы и client id, и секрет. */
export function googleLoginEnabled(): boolean {
  return Boolean(env.googleClientId && env.googleClientSecret);
}

/**
 * Положили сам код вместо хэша — лучше не стартовать, чем молча не пускать ревьюера. Хэш пустой
 * строки (снят с незаданной переменной) открыл бы вход пустым кодом. Адрес — только служебный
 * demo…@taskano.app: постоянный код на адресе настоящего человека открыл бы его аккаунт, а его
 * письма молча глушились бы (ревью диффа).
 */
export function assertDemoEnv(): void {
  const h = env.demoLoginCodeSha256;
  if (h && !/^[0-9a-f]{64}$/.test(h)) throw new Error('DEMO_LOGIN_CODE_SHA256 — sha256 кода, 64 hex-символа, а не сам код');
  if (h === EMPTY_SHA256) throw new Error('DEMO_LOGIN_CODE_SHA256 — хэш пустой строки: код не задан. Выпустите код командой demo-code');
  const e = env.demoLoginEmail;
  if (e && !/^demo[a-z0-9-]*@taskano\.app$/.test(e)) throw new Error('DEMO_LOGIN_EMAIL — только служебный адрес demo…@taskano.app');
}

export function assertProductionEnv(): void {
  assertDemoEnv();
  if (!env.isProduction) return;
  const required = ['PUBLIC_URL', 'DATABASE_APP_URL', 'DATABASE_SYSTEM_URL', 'TELEGRAM_BOT_TOKEN',
    'TELEGRAM_WEBHOOK_SECRET', 'ENCRYPTION_KEY', 'HMAC_SECRET', 'RESEND_API_KEY', 'EMAIL_FROM'];
  const missing = required.filter((n) => !process.env[n]);
  if (missing.length) throw new Error(`Не заданы переменные окружения: ${missing.join(', ')}`);
  if (!/^[0-9a-f]{64}$/i.test(env.encryptionKey) || /^0+$/.test(env.encryptionKey)) throw new Error('ENCRYPTION_KEY — 64 hex-символа, не нулевой');
  if (env.hmacSecret.length < 32) throw new Error('HMAC_SECRET — не короче 32 символов');
  if (!env.publicUrl.startsWith('https://')) throw new Error('PUBLIC_URL в проде — только https');
}
