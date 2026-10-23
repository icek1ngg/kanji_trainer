import { describe, expect, it } from 'vitest';
import {
  InvalidRequiredReadingsError,
  TABLE_FILTERS,
  checkTableAnswer,
  createTableSession,
  getItemStatus,
  getRetryRecords,
  getTableItems,
  getTableStats,
  setTableAnswer,
  shuffleTableSession,
  toggleTableReveal,
} from './tableSession.js';

const records = [
  { id: 'san', kanji: '散', hanViet: ['TÁN', 'TẢN'] },
  { id: 'gaku', kanji: '学', hanViet: ['HỌC'] },
  { id: 'sei', kanji: '生', hanViet: ['SINH'] },
];

function create() {
  return createTableSession(records, { id: 'session-1', now: '2026-10-21T00:00:00.000Z' });
}

describe('table practice session state', () => {
  it('snapshots Kanji and starts neutral without revealing readings', () => {
    const source = records.map(record => ({ ...record, hanViet: [...record.hanViet] }));
    const session = createTableSession(source, { id: 'session-1', now: '2026-10-21T00:00:00.000Z' });
    expect(session).toMatchObject({ id: 'session-1', mode: 'table', schemaVersion: 1, active: true, revision: 0, checks: 0 });
    expect(session.items[0]).toMatchObject({ id: 'san', kanji: '散', answer: '', checkedAnswer: null, result: null, revealed: false });
    expect(session.items[0].hanViet).toEqual(['TÁN', 'TẢN']);
    source[0].hanViet.push('MUTATION');
    expect(session.items[0].hanViet).toEqual(['TÁN', 'TẢN']);
  });

  it('requires all readings for 散 and counts only explicit checks', () => {
    let session = create();
    session = setTableAnswer(session, 'san', 'TÁN');
    session = checkTableAnswer(session, 'san');
    expect(session.items[0].result).toBe(false);
    expect(getItemStatus(session.items[0])).toBe(TABLE_FILTERS.INCORRECT);
    expect(session.checks).toBe(1);
    const same = checkTableAnswer(session, 'san');
    expect(same.checks).toBe(1);
    session = setTableAnswer(session, 'san', 'TẢN/TÁN');
    expect(getItemStatus(session.items[0])).toBe(TABLE_FILTERS.UNANSWERED);
    session = checkTableAnswer(session, 'san');
    expect(session.items[0].result).toBe(true);
    expect(session.checks).toBe(2);
    expect(session.correctChecks).toBe(1);
    expect(session.incorrectChecks).toBe(1);
    expect(checkTableAnswer(setTableAnswer(create(), 'san', 'TÁN/TẢN'), 'san').items[0].result).toBe(true);
  });

  it('accepts all valid separators and order through the shared validator', () => {
    for (const answer of ['TÁN/TẢN', 'TẢN/TÁN', 'tán; tản', 'TẢN｜TÁN']) {
      let session = setTableAnswer(create(), 'san', answer);
      session = checkTableAnswer(session, 'san');
      expect(session.items[0].result).toBe(true);
    }
  });

  it('does not count an invalid stored reading set as a learner error', () => {
    const session = createTableSession([{ id: 'bad', kanji: '散', hanViet: ['TÁN', 'TÁN'] }], { id: 'bad-session', now: '2026-10-21T00:00:00.000Z' });
    const answered = setTableAnswer(session, 'bad', 'TÁN');
    expect(() => checkTableAnswer(answered, 'bad')).toThrow(InvalidRequiredReadingsError);
    expect(session.checks).toBe(0);
  });

  it('supports reveal, filters and retries based on the current checked status', () => {
    let session = create();
    session = checkTableAnswer(setTableAnswer(session, 'san', 'TÁN'), 'san');
    session = checkTableAnswer(setTableAnswer(session, 'gaku', 'HỌC'), 'gaku');
    session = checkTableAnswer(setTableAnswer(session, 'sei', 'WRONG'), 'sei');
    session = toggleTableReveal(session, 'sei');
    expect(session.items.find(item => item.id === 'sei').revealed).toBe(true);
    expect(getTableItems(session, TABLE_FILTERS.CORRECT).map(item => item.id)).toEqual(['gaku']);
    expect(getTableItems(session, TABLE_FILTERS.INCORRECT).map(item => item.id)).toEqual(['san', 'sei']);
    expect(getRetryRecords(session).map(item => item.id)).toEqual(['san', 'sei']);
    session = setTableAnswer(session, 'sei', 'SINH');
    expect(getRetryRecords(session).map(item => item.id)).toEqual(['san']);
    expect(getTableItems(session, TABLE_FILTERS.UNANSWERED).map(item => item.id)).toEqual(['sei']);
  });

  it('reports live progress and lifetime explicit-check counters', () => {
    let session = create();
    expect(getTableStats(session)).toMatchObject({ total: 3, correct: 0, incorrect: 0, unanswered: 3, checked: 0, progress: 0, accuracy: 0, checks: 0 });
    session = checkTableAnswer(setTableAnswer(session, 'gaku', 'HỌC'), 'gaku');
    session = checkTableAnswer(setTableAnswer(session, 'san', 'TÁN'), 'san');
    expect(getTableStats(session)).toMatchObject({ total: 3, correct: 1, incorrect: 1, unanswered: 1, checked: 2, progress: 67, accuracy: 50, checks: 2, correctChecks: 1, incorrectChecks: 1 });
    session = setTableAnswer(session, 'san', 'TÁN/TẢN');
    expect(getTableStats(session)).toMatchObject({ correct: 1, incorrect: 0, unanswered: 2, checked: 1, checks: 2 });
  });

  it('shuffles without losing drafts, results or item identity', () => {
    let session = checkTableAnswer(setTableAnswer(create(), 'gaku', 'HỌC'), 'gaku');
    session = setTableAnswer(session, 'san', 'TÁN');
    const shuffled = shuffleTableSession(session, () => 0);
    expect(shuffled.items.map(item => item.id)).toEqual(['gaku', 'sei', 'san']);
    expect(shuffled.items.find(item => item.id === 'gaku').result).toBe(true);
    expect(shuffled.items.find(item => item.id === 'san').answer).toBe('TÁN');
    expect(session.items.map(item => item.id)).toEqual(['san', 'gaku', 'sei']);
  });
});
