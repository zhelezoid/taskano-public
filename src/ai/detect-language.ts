import { franc } from 'franc-min';

// Определение языка текста людей — для source_language и выбора направления перевода.
// Спека translation-and-email: только для достаточно длинного текста (короткие фразы franc угадывает плохо).

const MIN_LENGTH = 20;

export type DetectedLanguage = 'ru' | 'tr' | 'vi' | 'en';

const ISO_MAP: Record<string, DetectedLanguage> = { rus: 'ru', tur: 'tr', vie: 'vi', eng: 'en' };

export function detectLanguage(text: string): DetectedLanguage | null {
  const trimmed = text.trim();
  if (trimmed.length < MIN_LENGTH) return null;
  const code = franc(trimmed, { minLength: MIN_LENGTH });
  return ISO_MAP[code] ?? null;
}
