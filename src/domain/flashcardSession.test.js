import { describe, expect, it } from 'vitest';
import {
  InvalidRequiredReadingsError,
  checkFlashcardAnswer,
  createFlashcardSession,
  getFlashcardRetryRecords,
  getFlashcardStats,
  getFlashcardStatus,
  moveFlashcard,
  reconcileFlashcardSession,
  setFlashcardAnswer,
  toggleFlashcardReveal,
} from './flashcardSession.js';

const records = [
  { id: 'san', kanji: '散', hanViet: ['TÁN', 'TẢN'] },
  { id: 'gaku', kanji: '学', hanViet: ['HỌC'] },
  { id: 'sei', kanji: '生', hanViet: ['SINH'] },
];

const largeRecords = Array.from({ length: 120 }, (_, index) => ({
  id: `large-${index}`,
  kanji: String.fromCodePoint(0x4e00 + index),
  hanViet: ['DOC'],
}));

function create(options = {}) {
  return createFlashcardSession(records, {
    id: 'flashcard-1',
    now: '2026-10-21T00:00:00.000Z',
    ...options,
  });
}

describe('flashcard practice session state', () => {
  it('creates an immutable, neutral session with size and order preferences', () => {
    const source = records.map(record => ({ ...record, hanViet: [...record.hanViet] }));
    const session = createFlashcardSession(source, { id: 'flashcard-1', size: 10, now: '2026-10-21T00:00:00.000Z' });
    expect(session).toMatchObject({ mode: 'flashcard', schemaVersion: 1, active: true, revision: 0, position: 0, size: 10, order: 'sequential', checks: 0 });
    expect(session.items[0]).toMatchObject({ id: 'san', kanji: '散', answer: '', checkedAnswer: null, result: null, revealed: false });
    source[0].hanViet.push('MUTATION');
    expect(session.items[0].hanViet).toEqual(['TÁN', 'TẢN']);
  });

  it('caps selected size and shuffles before slicing without duplicates', () => {
    const many = largeRecords.map(record => ({ ...record, hanViet: [...record.hanViet] }));
    const session = createFlashcardSession(many, { size: 10, order: 'random', random: () => 0, id: 'random', now: '2026-10-21T00:00:00.000Z' });
    expect(session.items).toHaveLength(10);
    expect(new Set(session.items.map(item => item.id)).size).toBe(10);
    expect(session.items.map(item => item.id)).not.toEqual(many.slice(0, 10).map(item => item.id));
    expect(createFlashcardSession(records, { size: 100, id: 'all', now: '2026-10-21T00:00:00.000Z' }).items).toHaveLength(3);
  });

  it.each([
    [10, 10],
    [20, 20],
    [50, 50],
    [100, 100],
    ['all', 120],
  ])('creates exactly %s cards for the supported session size', (size, expectedCount) => {
    const input = largeRecords.map(record => ({ ...record, hanViet: [...record.hanViet] }));
    const before = input.map(record => ({ ...record, hanViet: [...record.hanViet] }));
    const session = createFlashcardSession(input, {
      size,
      order: 'sequential',
      id: `size-${size}`,
      now: '2026-10-21T00:00:00.000Z',
    });
    expect(session.items).toHaveLength(expectedCount);
    expect(session.size).toBe(size);
    expect(session.order).toBe('sequential');
    expect(input).toEqual(before);
  });

  it('rejects unsupported size and order options', () => {
    expect(() => create({ size: 5 })).toThrow(TypeError);
    expect(() => create({ size: '15' })).toThrow(TypeError);
    expect(() => create({ order: 'shuffle' })).toThrow(TypeError);
  });

  it('requires every reading in either order and does not double-count idempotent checks', () => {
    let session = setFlashcardAnswer(create(), 'san', 'TÁN');
    session = checkFlashcardAnswer(session, 'san');
    expect(session.items[0].result).toBe(false);
    expect(getFlashcardStatus(session.items[0])).toBe('incorrect');
    expect(session.checks).toBe(1);
    expect(checkFlashcardAnswer(session, 'san').checks).toBe(1);
    session = setFlashcardAnswer(session, 'san', 'TẢN/TÁN');
    expect(getFlashcardStatus(session.items[0])).toBe('unanswered');
    session = checkFlashcardAnswer(session, 'san');
    expect(session.items[0].result).toBe(true);
    expect(session.correctChecks).toBe(1);
    expect(session.incorrectChecks).toBe(1);
  });

  it('accepts NFC and separators while rejecting invalid required readings', () => {
    let session = createFlashcardSession([{ id: 'nfc', kanji: '散', hanViet: ['TÁN', 'TẢN'] }], { id: 'nfc-session', now: '2026-10-21T00:00:00.000Z' });
    session = checkFlashcardAnswer(setFlashcardAnswer(session, 'nfc', 'tán; tản'), 'nfc');
    expect(session.items[0].result).toBe(true);
    const invalid = createFlashcardSession([{ id: 'bad', kanji: '散', hanViet: ['TÁN', 'TÁN'] }], { id: 'bad-session', now: '2026-10-21T00:00:00.000Z' });
    expect(() => checkFlashcardAnswer(setFlashcardAnswer(invalid, 'bad', 'TÁN'), 'bad')).toThrow(InvalidRequiredReadingsError);
  });

  it('supports reveal, clamped navigation, live stats and retries', () => {
    let session = create();
    session = checkFlashcardAnswer(setFlashcardAnswer(session, 'san', 'TÁN/TẢN'), 'san');
    session = checkFlashcardAnswer(setFlashcardAnswer(session, 'gaku', 'WRONG'), 'gaku');
    session = toggleFlashcardReveal(session, 'gaku');
    expect(session.items[1].revealed).toBe(true);
    expect(getFlashcardRetryRecords(session).map(item => item.id)).toEqual(['gaku']);
    expect(getFlashcardStats(session)).toMatchObject({ total: 3, correct: 1, incorrect: 1, unanswered: 1, checked: 2, progress: 67, checks: 2, correctChecks: 1, incorrectChecks: 1, accuracy: 50, completed: false });
    expect(moveFlashcard(session, -2).position).toBe(0);
    expect(moveFlashcard(session, 99).position).toBe(2);
    session = setFlashcardAnswer(session, 'gaku', 'HỌC');
    expect(getFlashcardRetryRecords(session)).toEqual([]);
    session = checkFlashcardAnswer(session, 'gaku');
    expect(getFlashcardStats(session).completed).toBe(false);
    session = checkFlashcardAnswer(setFlashcardAnswer(session, 'sei', 'SINH'), 'sei');
    expect(getFlashcardStats(session).completed).toBe(true);
  });

  it('reconciles edits and deletions while preserving order, drafts and current card', () => {
    let session = create();
    session = setFlashcardAnswer(session, 'gaku', 'draft');
    session = moveFlashcard(session, 1);
    session = checkFlashcardAnswer(setFlashcardAnswer(session, 'san', 'TÁN/TẢN'), 'san');
    session = toggleFlashcardReveal(session, 'san');
    const { session: reconciled, changed } = reconcileFlashcardSession(session, [
      { id: 'san', kanji: '散', hanViet: ['TÁN', 'TẢN', 'SAN'] },
      { id: 'gaku', kanji: '学', hanViet: ['HỌC'] },
      { id: 'new', kanji: '新', hanViet: ['TÂN'] },
    ], { now: '2026-10-21T01:00:00.000Z' });
    expect(changed).toBe(true);
    expect(reconciled.items.map(item => item.id)).toEqual(['san', 'gaku']);
    expect(reconciled.position).toBe(1);
    expect(reconciled.items[1].answer).toBe('draft');
    expect(reconciled.items[0]).toMatchObject({ hanViet: ['TÁN', 'TẢN', 'SAN'], checkedAnswer: null, result: null, revealed: false });
  });
});
