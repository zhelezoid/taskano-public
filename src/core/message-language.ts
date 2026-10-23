import type { Db } from '../db/pool.js';
import { detectLanguage } from '../ai/detect-language.js';

// Язык реплики к делу (спека translation-and-email). Запоминается при записи: по переведённому
// тексту исходный язык уже не определить, а получатель может читать на другом.
//
// Распознаватель молчит чаще, чем кажется: короткая фраза (до 20 знаков) ему не по зубам, да и
// длинную он иногда относит к соседнему языку и возвращает пусто. Тогда берём язык того, кто пишет:
// человек по умолчанию пишет на своём, и это куда лучшая догадка, чем «язык неизвестен» — при
// неизвестном реплика уходит непереведённой, то есть вьетнамский вопрос приходит русскому как есть.
//
// Реплика агента — на языке компании: агент говорит от её имени.

export async function messageLanguage(
  db: Db, text: string, authorUserId: string | null,
): Promise<string | null> {
  const detected = detectLanguage(text);
  if (detected) return detected;
  if (authorUserId) {
    const r = await db.query('select language from users where id = $1', [authorUserId]);
    return (r.rows[0]?.language as string | undefined) ?? null;
  }
  const org = await db.query(`select language from orgs where id = current_setting('app.org_id')::uuid`);
  return (org.rows[0]?.language as string | undefined) ?? null;
}
