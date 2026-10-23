// Модели по функциям и прайс USD за 1M токенов — спека translation-and-email. Переопределяется env
// (MODEL_TRANSLATE, MODEL_TRANSLATE_VI, MODEL_PARSE_TASK, GROUP_MODEL), без пересборки.

export type AiFunction = 'translate' | 'translate_vi' | 'parse_task' | 'group_analyze';

export interface ModelPrice { inputPerM: number; outputPerM: number }

const DEFAULT_MODEL = 'claude-haiku-4-5';

// Haiku 4.5: вход 1$, выход 5$ за 1M токенов.
const HAIKU_4_5_PRICE: ModelPrice = { inputPerM: 1, outputPerM: 5 };

const ENV_VAR: Record<AiFunction, string> = {
  translate: 'MODEL_TRANSLATE',
  translate_vi: 'MODEL_TRANSLATE_VI',
  parse_task: 'MODEL_PARSE_TASK',
  group_analyze: 'GROUP_MODEL',       // разбор рабочих групп с изображениями (спека group-intake)
};

export function modelFor(fn: AiFunction): string {
  return process.env[ENV_VAR[fn]] || DEFAULT_MODEL;
}

const PRICES: Record<string, ModelPrice> = {
  [DEFAULT_MODEL]: HAIKU_4_5_PRICE,
};

/** Цена модели; неизвестная (например, задана через env нестандартной моделью) — по цене Haiku 4.5
 *  как разумный дефолт, лишь бы расход не терялся молча. */
export function priceFor(model: string): ModelPrice {
  return PRICES[model] ?? HAIKU_4_5_PRICE;
}
