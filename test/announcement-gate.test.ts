import { describe, expect, it } from 'vitest';
import {
  type Announcement, canConfirm, EMPTY_GATE, gateConfirmed, gateCurrent, gateProgress, gateReplace, INITIAL_CHECKED, isBlocking, type GateState,
} from '../app/src/announcement-gate.js';

// Логика заслона объявлений без браузера (спека announcements): очередь, блокировка экрана, OK.

const item = (id: string, at = '2026-09-21T07:00:00.000Z'): Announcement => ({
  id, org_id: 'o', from: 'Олег', agent: null, text: id, translated: false, sent_at: at,
});

describe('заслон объявлений: чистая логика', () => {
  it('галочка вначале снята; OK нажимается только с галочкой и не во время отправки', () => {
    expect(INITIAL_CHECKED).toBe(false);
    expect(canConfirm(INITIAL_CHECKED, false)).toBe(false);
    expect(canConfirm(false, false)).toBe(false);
    expect(canConfirm(true, true)).toBe(false);
    expect(canConfirm(true, false)).toBe(true);
  });

  it('пустая очередь экран не закрывает; есть объявление — закрывает', () => {
    expect(isBlocking(EMPTY_GATE)).toBe(false);
    expect(gateCurrent(EMPTY_GATE)).toBeNull();
    const g = gateReplace(EMPTY_GATE, [item('a')], 'ru');
    expect(isBlocking(g)).toBe(true);
    expect(g.lang).toBe('ru');
  });

  it('по одному, старые первыми (порядок сервера); подтвердили — следующее; счётчик идёт «2 из 3»', () => {
    let g: GateState = gateReplace(EMPTY_GATE, [item('a'), item('b'), item('c')], 'ru');
    expect(gateCurrent(g)!.id).toBe('a');
    expect(gateProgress(g)).toEqual({ position: 1, total: 3 });
    g = gateConfirmed(g, 'a');
    expect(gateCurrent(g)!.id).toBe('b');
    expect(gateProgress(g)).toEqual({ position: 2, total: 3 });
    g = gateConfirmed(g, 'b');
    g = gateConfirmed(g, 'c');
    expect(isBlocking(g)).toBe(false);
    expect(gateProgress(gateReplace(g, [], 'ru'))).toEqual({ position: 1, total: 0 });
  });

  it('свежий список с сервера не теряет счёт, пока пачка не кончилась; язык без указания остаётся', () => {
    let g = gateReplace(EMPTY_GATE, [item('a'), item('b')], 'tr');
    g = gateConfirmed(g, 'a');
    g = gateReplace(g, [item('b'), item('d')]);
    expect(g.lang).toBe('tr');
    expect(gateProgress(g)).toEqual({ position: 2, total: 3 });
  });

  it('объявление, которого для человека нет (404), снимается так же, как подтверждённое; чужой id ничего не меняет', () => {
    const g = gateReplace(EMPTY_GATE, [item('a'), item('b')], 'ru');
    expect(gateCurrent(gateConfirmed(g, 'a'))!.id).toBe('b');
    expect(gateConfirmed(g, 'нет-такого')).toBe(g);
  });
});
