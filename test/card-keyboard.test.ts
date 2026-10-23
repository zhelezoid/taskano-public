import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import './helpers.js';
import { cardKeyboard } from '../src/bot/keyboards.js';
import { decodeTask, type TaskAction } from '../src/bot/callbacks.js';
import { canTransition } from '../src/core/lifecycle.js';
import type { Task, TaskStatus } from '../src/core/types.js';

// Кнопки карточки бота (спеки telegram-bot, «Карточка задачи», и miniapp-task-actions):
// набор по статусу приходит из таблицы переходов ядра. Своя копия таблицы в боте однажды разошлась
// с ядром — у отложенного личного дела клавиатура оказалась пустой, хотя ядро разрешало перенос.
// Ожидаемое считаем прямо по `canTransition`, а не той же функцией, что строит клавиатуру.

const STATUSES: TaskStatus[] = [
  'draft', 'scheduled', 'ready', 'active', 'in_progress', 'blocked', 'waiting_external',
  'submitted', 'rework', 'done', 'declined', 'cancelled', 'waiting', 'resolved',
];

/** Кнопки-переходы; таймер, «Написать», «Оригинал», «Как агент пришёл», фото — не переходы. */
const TRANSITION_BUTTONS: TaskAction[] = ['take', 'stp', 'done', 'pp', 'q', 'u', 'wf', 'dec', 'cancel'];

function task(status: TaskStatus, kind: Task['kind'] = 'action'): Task {
  return { short_id: '12', version: 3, status, kind } as Task;
}

function buttons(status: TaskStatus, opts: { personal: boolean }, kind: Task['kind'] = 'action'): string[] {
  const kb = cardKeyboard('ru', task(status, kind), { translated: false, timerRunning: false, hasRationale: false, ...opts });
  return kb.inline_keyboard.flat()
    .map((b) => ('callback_data' in b ? decodeTask(b.callback_data ?? '')?.action : undefined))
    .filter((a): a is TaskAction => !!a && TRANSITION_BUTTONS.includes(a))
    .sort();
}

/** Что ядро разрешает исполнителю рабочего дела в этом статусе. */
function expectedWork(status: TaskStatus): string[] {
  const out: string[] = [];
  if (canTransition(status, 'take')) out.push('take');
  // «Остановить» — только взятому делу: ядро разрешает `deactivate` и у `active`, но его человек не брал.
  if (status === 'in_progress' && canTransition(status, 'deactivate')) out.push('stp');
  if (canTransition(status, 'submit')) out.push('done');
  if (canTransition(status, 'postpone')) out.push('pp');
  if (canTransition(status, 'question')) out.push('q');
  if (canTransition(status, 'unclear')) out.push('u');
  if (canTransition(status, 'wait_external')) out.push('wf');
  if (canTransition(status, 'decline')) out.push('dec');
  return out.sort();
}

describe('кнопки карточки бота — из таблицы переходов ядра', () => {
  it('рабочее дело: для каждого статуса кнопки ровно те, что разрешает ядро', () => {
    for (const status of STATUSES) {
      expect({ status, buttons: buttons(status, { personal: false }) })
        .toEqual({ status, buttons: expectedWork(status) });
    }
  });

  it('личное пространство: «Завершить» и «Перенести» по ядру плюс «Удалить»', () => {
    for (const status of STATUSES) {
      const expected: string[] = [];
      if (canTransition(status, 'submit')) expected.push('done');
      if (canTransition(status, 'postpone')) expected.push('pp');
      if (canTransition(status, 'cancel')) expected.push('cancel');
      expect({ status, buttons: buttons(status, { personal: true }) })
        .toEqual({ status, buttons: expected.sort() });
    }
  });

  it('отложенное личное дело не тупик: его можно перенести ещё раз или удалить', () => {
    expect(buttons('scheduled', { personal: true })).toEqual(['cancel', 'pp']);
  });

  it('ожидание карточка не сдаёт: его закрывают кнопки списка ожиданий', () => {
    expect(buttons('waiting', { personal: false }, 'waiting')).not.toContain('done');
  });

  it('в клавиатурах бота нет своей таблицы статусов', () => {
    // Литеральный массив статусов в клавиатурах — это и есть вторая копия таблицы переходов.
    const src = readFileSync(new URL('../src/bot/keyboards.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/\[\s*'(draft|scheduled|ready|active|in_progress|blocked|rework|submitted|waiting_external)'/);
  });
});
