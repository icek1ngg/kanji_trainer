import { describe, expect, it } from 'vitest';
import {
  appendPracticeAttempt,
  createPracticeAttempt,
  getLatestAttempts,
  getWrongKanji,
} from './history.js';
import { checkTableAnswer, createTableSession, setTableAnswer } from './tableSession.js';
import { checkFlashcardAnswer, createFlashcardSession, setFlashcardAnswer } from './flashcardSession.js';

const tableRecords = [
  { id: 'san', kanji: '散', hanViet: ['TÁN', 'TẢN'] },
  { id: 'gaku', kanji: '学', hanViet: ['HỌC'] },
];

describe('practice attempt history domain', () => {
  it('records one immutable event for each changed explicit check', () => {
    let session = createTableSession(tableRecords, { id: 'table-1', now: '2026-10-22T00:00:00.000Z' });
    session = checkTableAnswer(setTableAnswer(session, 'san', 'TÁN'), 'san', { now: '2026-10-22T00:01:00.000Z', attemptId: 'attempt-1' });
    expect(session.pendingAttempts).toHaveLength(1);
    expect(session.pendingAttempts[0]).toMatchObject({ id: 'attempt-1', sessionId: 'table-1', kanjiId: 'san', isCorrect: false, mode: 'table' });
    const same = checkTableAnswer(session, 'san', { now: '2026-10-22T00:02:00.000Z', attemptId: 'attempt-2' });
    expect(same.pendingAttempts).toHaveLength(1);
    session = checkTableAnswer(setTableAnswer(session, 'san', 'TÁN/TẢN'), 'san', { now: '2026-10-22T00:03:00.000Z', attemptId: 'attempt-2' });
    expect(session.pendingAttempts).toHaveLength(2);
    expect(session.pendingAttempts.map(item => item.id)).toEqual(['attempt-1', 'attempt-2']);
    expect(session.pendingAttempts[0].requiredReadings).toEqual(['TÁN', 'TẢN']);
  });

  it('records flashcard checks with the flashcard mode', () => {
    let session = createFlashcardSession(tableRecords, { id: 'flash-1', now: '2026-10-22T00:00:00.000Z' });
    session = checkFlashcardAnswer(setFlashcardAnswer(session, 'san', 'TÁN/TẢN'), 'san', { now: '2026-10-22T00:01:00.000Z', attemptId: 'flash-attempt' });
    expect(session.pendingAttempts[0]).toMatchObject({ id: 'flash-attempt', isCorrect: true, mode: 'flashcard' });
  });

  it('chooses latest attempts by sequence then deterministic timestamp/id', () => {
    const attempts = [
      { id: 'old', sessionId: 'a', kanjiId: 'san', kanji: '散', requiredReadings: ['TÁN'], submittedAnswer: 'TÁN', isCorrect: true, mode: 'table', createdAt: '2026-10-22T00:00:00.000Z', sequence: 1, checkedAt: '2026-10-22T00:00:03.000Z' },
      { id: 'new', sessionId: 'a', kanjiId: 'san', kanji: '散', requiredReadings: ['TÁN'], submittedAnswer: 'WRONG', isCorrect: false, mode: 'table', createdAt: '2026-10-22T00:00:01.000Z', sequence: 2, checkedAt: '2026-10-22T00:00:03.000Z' },
      { id: 'other', sessionId: 'b', kanjiId: 'san', kanji: '散', requiredReadings: ['TÁN'], submittedAnswer: 'TÁN', isCorrect: true, mode: 'table', createdAt: '2026-10-22T00:00:02.000Z' },
      { id: 'legacy', sessionId: 'a', kanjiId: 'ignored' },
    ];
    expect(getLatestAttempts(attempts).find(item => item.kanjiId === 'san')).toMatchObject({ id: 'new', isCorrect: false });
    expect(getLatestAttempts(attempts, { sessionId: 'b' })).toMatchObject([{ id: 'other' }]);
    expect(getLatestAttempts(attempts, { sessionId: 'a' })).toMatchObject([{ id: 'new' }]);
  });

  it('joins only latest incorrect attempts to live records and excludes deleted Kanji', () => {
    const attempts = [
      createPracticeAttempt({ session: { id: 's', mode: 'wrong' }, item: { id: 'san', kanji: '散', hanViet: ['TÁN'], answer: 'WRONG' }, isCorrect: false, id: 'wrong', now: '2026-10-22T00:00:00.000Z' }),
      createPracticeAttempt({ session: { id: 's', mode: 'wrong' }, item: { id: 'san', kanji: '散', hanViet: ['TÁN'], answer: 'TÁN' }, isCorrect: true, id: 'fixed', now: '2026-10-22T00:01:00.000Z' }),
    ].map((attempt, sequence) => ({ ...attempt, sequence, checkedAt: `2026-10-22T00:00:0${sequence}.000Z` }));
    expect(getWrongKanji(attempts, [{ id: 'san', kanji: '散', hanViet: ['TÁN'] }, { id: 'gone', kanji: '行', hanViet: ['HÀNH'] }])).toEqual([]);
    const wrong = getWrongKanji([{ ...attempts[0], sequence: 3 }], [{ id: 'san', kanji: '散', hanViet: ['TÁN'] }]);
    expect(wrong).toHaveLength(1);
    expect(wrong[0].latestAttempt.id).toBe('wrong');
  });

  it('keeps helper idempotent for a repeated event id', () => {
    const session = createTableSession(tableRecords, { id: 's', now: '2026-10-22T00:00:00.000Z' });
    const item = { ...session.items[0], answer: 'TÁN' };
    const first = appendPracticeAttempt(session, item, false, { id: 'fixed', now: '2026-10-22T00:00:00.000Z' });
    const second = appendPracticeAttempt(first, item, false, { id: 'fixed', now: '2026-10-22T00:05:00.000Z' });
    expect(second.pendingAttempts).toHaveLength(1);
    expect(second.pendingAttempts[0].createdAt).toBe(first.pendingAttempts[0].createdAt);
  });
});

