import { AsyncLocalStorage } from 'node:async_hooks';
import Anthropic from '@anthropic-ai/sdk';
import { env } from '../config/env.js';
import { priceFor } from '../config/models.js';
import type { Db } from '../db/pool.js';

// Тонкая обёртка вызова модели с учётом расхода в ai_usage (спека translation-and-email). Вызывается
// внутри withOrg — расход пишется в текущую организацию через current_setting('app.org_id').

/** truncated — модель упёрлась в maxTokens и оборвала ответ на полуслове. */
export interface LlmResult { text: string; inputTokens: number; outputTokens: number; truncated?: boolean }

/** Изображение для модели (спека group-intake): уже очищенный JPEG с диска, base64. */
export interface LlmImage { mediaType: 'image/jpeg'; base64: string }

export interface LlmArgs { model: string; system?: string; prompt: string; maxTokens?: number; images?: LlmImage[] }
export type LlmFn = (args: LlmArgs) => Promise<LlmResult>;

let client: Anthropic | undefined;
let testLlm: LlmFn | undefined;

/** Подмена вызова модели в тестах — без сети и без ключа. */
export function setLlmForTests(fn: LlmFn | undefined): void {
  testLlm = fn;
}

async function callAnthropic(args: LlmArgs): Promise<LlmResult> {
  if (!env.anthropicApiKey) throw new Error('ANTHROPIC_API_KEY не задан — вызов модели невозможен');
  client ??= new Anthropic({ apiKey: env.anthropicApiKey });
  // Изображения — блоками перед текстом (рекомендация документации vision: картинки раньше вопроса).
  const content: Anthropic.ContentBlockParam[] = [
    ...(args.images ?? []).map((img): Anthropic.ImageBlockParam => ({
      type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.base64 },
    })),
    { type: 'text', text: args.prompt },
  ];
  const res = await client.messages.create({
    model: args.model,
    max_tokens: args.maxTokens ?? 1024,
    system: args.system,
    messages: [{ role: 'user', content: args.images?.length ? content : args.prompt }],
  });
  const text = res.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('');
  return {
    text, inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens,
    truncated: res.stop_reason === 'max_tokens',
  };
}

/** Только вызов модели, без записи расхода. Для долгих вызовов (с изображениями) вне транзакции:
 *  роль приложения рвёт соединение, простаивающее в транзакции дольше 60 с (migrate.ts). Расход
 *  затем пишется recordLlmUsage — в той же организации. */
export async function invokeLlm(args: LlmArgs): Promise<LlmResult> {
  return (testLlm ?? callAnthropic)(args);
}

export async function recordLlmUsage(db: Db, fn: string, model: string, result: LlmResult): Promise<void> {
  const price = priceFor(model);
  const usd = (result.inputTokens * price.inputPerM + result.outputTokens * price.outputPerM) / 1_000_000;
  await db.query(
    `insert into ai_usage(org_id, fn, model, input_tokens, output_tokens, usd)
     values (current_setting('app.org_id')::uuid, $1, $2, $3, $4, $5)`,
    [fn, model, result.inputTokens, result.outputTokens, usd],
  );
}

// Счёт вызовов модели в пределах одного запроса (спека translation-prefetch): по нему журнал
// открытия карточки отличает «ответили из кэша» (0) от «ждали модель» (N).
const llmCounter = new AsyncLocalStorage<{ calls: number }>();

/** Выполнить `fn` и сказать, сколько раз за это время (включая вложенные асинхронные вызовы) звали `callLlm`. */
export async function countLlmCalls<T>(fn: () => Promise<T>): Promise<{ result: T; calls: number }> {
  const counter = { calls: 0 };
  const result = await llmCounter.run(counter, fn);
  return { result, calls: counter.calls };
}

/** Отметить вызов модели в счётчике запроса — для путей, что зовут invokeLlm сами (перевод вне транзакции). */
export function noteLlmCall(): void {
  const counter = llmCounter.getStore();
  if (counter) counter.calls++;
}

/** Вызов модели + запись расхода в ai_usage. `fn` — имя функции (ключ прайса/учёта, не обязательно
 *  совпадает с ключом конфига моделей, если модель уже выбрана вызывающим кодом). */
export async function callLlm(db: Db, fn: string, args: LlmArgs): Promise<LlmResult> {
  noteLlmCall();
  const result = await invokeLlm(args);
  await recordLlmUsage(db, fn, args.model, result);
  return result;
}
