import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Скрипты деплоя не трогают базу и не ходят в сеть — этому файлу global-setup (test/global-setup.ts)
// не нужен по сути, но vitest.config.ts гоняет его на весь прогон. Спека pilot-deploy просит поэтому
// запускать этот файл с TASKANO_TEST_DB=taskano_test_deploy, если запускается параллельно с другими.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const SET_SECRET = join(REPO_ROOT, 'deploy/bin/set-secret');
const COMPOSE_FILE = join(REPO_ROOT, 'deploy/docker-compose.yml');

function withEnvFile(fn: (envFile: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'taskano-set-secret-'));
  try {
    fn(join(dir, '.env'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function run(args: string[], envFile: string, input?: string) {
  return spawnSync(SET_SECRET, args, {
    input,
    encoding: 'utf8',
    env: { ...process.env, TASKANO_ENV_FILE: envFile },
  });
}

describe('deploy/bin/set-secret', () => {
  it('пишет значение из скрытого ввода в env-файл с правами 600, не печатая его', () => {
    withEnvFile((envFile) => {
      const secret = 'super-secret-value-42';
      const res = run(['TELEGRAM_BOT_TOKEN'], envFile, `${secret}\n`);
      expect(res.status).toBe(0);
      expect(res.stdout).not.toContain(secret);
      expect(res.stderr).not.toContain(secret);
      const content = readFileSync(envFile, 'utf8');
      expect(content).toContain(`TELEGRAM_BOT_TOKEN=${secret}`);
      const mode = statSync(envFile).mode & 0o777;
      expect(mode).toBe(0o600);
    });
  });

  it('замещает значение при повторной записи той же переменной', () => {
    withEnvFile((envFile) => {
      run(['ENCRYPTION_KEY'], envFile, 'first-value\n');
      run(['ENCRYPTION_KEY'], envFile, 'second-value\n');
      const content = readFileSync(envFile, 'utf8');
      expect(content).not.toContain('ENCRYPTION_KEY=first-value');
      expect(content).toContain('ENCRYPTION_KEY=second-value');
      // Ровно одна строка с этим именем — не задвоилась.
      expect(content.match(/^ENCRYPTION_KEY=/gm)).toHaveLength(1);
    });
  });

  it('--generate пишет 64 hex-символа (32 байта), не печатая значение', () => {
    withEnvFile((envFile) => {
      const res = run(['--generate', 'HMAC_SECRET'], envFile);
      expect(res.status).toBe(0);
      const content = readFileSync(envFile, 'utf8');
      const m = content.match(/^HMAC_SECRET=([0-9a-f]+)$/m);
      expect(m).not.toBeNull();
      expect(m![1]).toHaveLength(64);
      expect(res.stdout).not.toContain(m![1]);
      expect(res.stderr).not.toContain(m![1]);
    });
  });

  it('--list печатает только имена заданных переменных', () => {
    withEnvFile((envFile) => {
      run(['--generate', 'HMAC_SECRET'], envFile);
      run(['ENCRYPTION_KEY'], envFile, 'value-1\n');
      const res = run(['--list'], envFile);
      expect(res.status).toBe(0);
      const names = res.stdout.trim().split('\n').filter(Boolean);
      expect(names.sort()).toEqual(['ENCRYPTION_KEY', 'HMAC_SECRET']);
      expect(res.stdout).not.toContain('value-1');
    });
  });

  it('отклоняет имя переменной не по формату ^[A-Z][A-Z0-9_]*$', () => {
    withEnvFile((envFile) => {
      // Имя проверяется ДО первого касания файла — отклонённое имя не создаёт .env вовсе.
      const lower = run(['lower_case'], envFile, 'value\n');
      expect(lower.status).not.toBe(0);
      expect(existsSync(envFile)).toBe(false);

      const hyphen = run(['--generate', 'not-valid'], envFile);
      expect(hyphen.status).not.toBe(0);
      expect(existsSync(envFile)).toBe(false);
    });
  });

  it('--init-db не перезаписывает уже заданные переменные', () => {
    withEnvFile((envFile) => {
      run(['DATABASE_URL'], envFile, 'postgres://already-set\n');
      const res = run(['--init-db'], envFile);
      expect(res.status).toBe(0);
      const content = readFileSync(envFile, 'utf8');
      expect(content).toContain('DATABASE_URL=postgres://already-set');
      expect(content).toMatch(/^DATABASE_APP_URL=postgres:\/\/taskano_app:[0-9a-f]{64}@db:5432\/taskano$/m);
      expect(content).toMatch(/^DATABASE_SYSTEM_URL=postgres:\/\/taskano_system:[0-9a-f]{64}@db:5432\/taskano$/m);
      expect(content).toMatch(/^POSTGRES_PASSWORD=[0-9a-f]{64}$/m);

      // Повторный вызов ничего не меняет — все переменные уже заданы.
      const before = readFileSync(envFile, 'utf8');
      run(['--init-db'], envFile);
      expect(readFileSync(envFile, 'utf8')).toBe(before);
    });
  });
});

describe('deploy/docker-compose.yml', () => {
  it('не публикует порты наружу ни у одного сервиса', () => {
    const yaml = readFileSync(COMPOSE_FILE, 'utf8');
    expect(yaml).not.toMatch(/^\s*ports:/m);
  });

  it('web и worker не получают ключей владельца базы — только migrate (аудит 07.10)', () => {
    const yaml = readFileSync(COMPOSE_FILE, 'utf8');
    const block = (name: string) => yaml.split(/\n  (?=[a-z]+:\n)/).find((b) => b.startsWith(`${name}:`)) ?? '';
    for (const svc of ['web', 'worker']) {
      for (const key of ['DATABASE_URL', 'POSTGRES_PASSWORD', 'APP_DB_PASSWORD', 'SYSTEM_DB_PASSWORD']) {
        expect(block(svc)).toContain(`${key}: ""`);
      }
    }
    expect(block('migrate')).not.toContain('DATABASE_URL: ""');
  });
});
