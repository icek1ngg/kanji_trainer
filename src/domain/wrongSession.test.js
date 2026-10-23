import { describe, expect, it } from 'vitest';
import {
  WRONG_FILTERS,
  checkWrongAnswer,
  createWrongSession,
  getWrongRetryRecords,
  getWrongStats,
  getWrongStatus,
  reconcileWrongSession,
  setWrongAnswer,
  shuffleWrongSession,
  toggleWrongReveal,
} from './wrongSession.js';

const records = [
  { id: 'san', kanji: '散', hanViet: ['TÁN', 'TẢN'] },
  { id: 'gaku', kanji: '学', hanViet: ['HỌC'] },
];

function create() {
  return createWrongSession(records, {
    id: 'wrong-1',
    scope: 'all',
    now: '2026-10-21T00:00:00.000Z',
    random: () => 0,
  });
}

describe('wrong-answer practice session state', () => {
  it('creates a shuffled, neutral snapshot with scope metadata', () => {
    const session = create();
    expect(session).toMatchObject({ mode: 'wrong', schemaVersion: 1, scope: 'all', active: true, checks: 0 });
    expect(session.items.map(item => item.id)).toEqual(['gaku', 'san']);
    expect(session.items.every(item => item.result === null && item.revealed === false)).toBe(true);
  });

  it('requires all readings and queues one immutable attempt per changed check', () => {
    let session = create();
    session = setWrongAnswer(session, 'san', 'TÁN');
    session = checkWrongAnswer(session, 'san', { now: '2026-10-21T00:00:01.000Z' });
    expect(session.items.find(item => item.id === 'san').result).toBe(false);
    expect(session.pendingAttempts).toHaveLength(1);
    expect(session.pendingAttempts[0]).toMatchObject({ mode: 'wrong', kanjiId: 'san', isCorrect: false, requiredReadings: ['TÁN', 'TẢN'] });
    expect(checkWrongAnswer(session, 'san').checks).toBe(1);
    session = setWrongAnswer(session, 'san', 'TẢN/TÁN');
    session = checkWrongAnswer(session, 'san', { now: '2026-10-21T00:00:02.000Z' });
    expect(session.items.find(item => item.id === 'san').result).toBe(true);
    expect(session.pendingAttempts).toHaveLength(2);
    expect(getWrongStatus(session.items.find(item => item.id === 'san'))).toBe(WRONG_FILTERS.CORRECT);
  });

  it('supports stats, retry records, reveal and edit reconciliation', () => {
    let session = create();
    session = checkWrongAnswer(setWrongAnswer(session, 'gaku', 'WRONG'), 'gaku');
    expect(getWrongStats(session)).toMatchObject({ total: 2, checked: 1, incorrect: 1, remaining: 2, checks: 1 });
    expect(getWrongRetryRecords(session).map(item => item.id)).toEqual(['gaku', 'san']);
    session = toggleWrongReveal(session, 'gaku');
    expect(session.items.find(item => item.id === 'gaku').revealed).toBe(true);
    const reconciled = reconcileWrongSession(session, [{ id: 'gaku', kanji: '学', hanViet: ['HỌC', 'GAKU'] }]);
    expect(reconciled.changed).toBe(true);
    expect(reconciled.session.items).toHaveLength(1);
    expect(reconciled.session.items[0]).toMatchObject({ hanViet: ['HỌC', 'GAKU'], checkedAnswer: null, result: null, revealed: false });
  });

  it('shuffles without changing drafts or pending attempts', () => {
    let session = setWrongAnswer(create(), 'san', 'draft');
    session = checkWrongAnswer(session, 'san');
    const shuffled = shuffleWrongSession(session, () => 0);
    expect(shuffled.items.find(item => item.id === 'san').answer).toBe('draft');
    expect(shuffled.pendingAttempts).toHaveLength(1);
  });
});

