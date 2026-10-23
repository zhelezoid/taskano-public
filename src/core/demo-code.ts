import { createHash, randomInt } from 'node:crypto';

// Постоянный код демо-входа (спека demo-access). Выпуск, нормализация и хэш — в одном месте: код,
// выпущенный не той нормализацией, что сверяет вход, никогда не подходит, и ревьюер упирается в
// «код не подошёл» посреди ревью (ревью диффа). Без импорта ./crypto.js: его читает config/env.ts,
// а crypto.js сам зависит от env — круг.

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const DEMO_CODE_RE = /^TSK-DEMO-[A-Z2-7]{20}$/;

/** Как код вставил человек: пробелы и регистр не важны. */
export const normalizeDemoCode = (input: string): string => input.replace(/\s/g, '').toUpperCase();

/** `TSK-DEMO-` + 20 знаков base32 — сто бит: подбор не нужен ни запором, ни потолком. */
export function generateDemoCode(): string {
  let tail = '';
  for (let i = 0; i < 20; i++) tail += ALPHABET[randomInt(ALPHABET.length)];
  return `TSK-DEMO-${tail}`;
}

export const demoCodeHash = (code: string): string => sha256(normalizeDemoCode(code));

/** Хэш пустой строки: так выглядит хэш, снятый с незаданной переменной, — с ним вход открылся бы пустым кодом. */
export const EMPTY_SHA256 = sha256('');
