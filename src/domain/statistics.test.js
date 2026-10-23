import { describe, expect, it } from 'vitest';
import { buildStatistics } from './statistics.js';

const records = [
  { id: 'san', kanji: '散', hanViet: ['TÁN', 'TẢN'] },
  { id: 'gaku', kanji: '学', hanViet: ['HỌC'] },
  { id: 'iku', kanji: '行', hanViet: ['HÀNH', 'HẠNH'] },
];

function attempt({
  id,
  sessionId = 'table-1',
  kanjiId = 'san',
  kanji = '散',
  requiredReadings = ['TÁN', 'TẢN'],
  isCorrect = false,
  createdAt = '2026-10-21T00:00:00.000Z',
  sequence,
} = {}) {
  return {
    id,
    sessionId,
    kanjiId,
    kanji,
    requiredReadings: [...requiredReadings],
    submittedAnswer: isCorrect ? requiredReadings.join('/') : 'TÁN',
    isCorrect,
    mode: 'table',
    createdAt,
    ...(sequence === undefined ? {} : { sequence }),
  };
}

describe('buildStatistics', () => {
  it('counts lifetime attempts once and uses latest checked results for live Kanji', () => {
    const stats = buildStatistics({
      records,
      attempts: [
        attempt({ id: 'a1', isCorrect: false, createdAt: '2026-10-20T00:00:00.000Z', sequence: 0 }),
        attempt({ id: 'a2', isCorrect: true, createdAt: '2026-10-21T00:00:00.000Z', sequence: 1 }),
        attempt({ id: 'a2', isCorrect: true, createdAt: '2026-10-21T00:00:00.000Z', sequence: 1 }),
        attempt({ id: 'a3', kanjiId: 'gaku', kanji: '学', requiredReadings: ['HỌC'], isCorrect: false, createdAt: '2026-10-21T01:00:00.000Z', sequence: 2 }),
        attempt({ id: 'deleted', kanjiId: 'gone', kanji: '生', requiredReadings: ['SINH'], isCorrect: false, createdAt: '2026-10-21T02:00:00.000Z', sequence: 3 }),
        { id: 'legacy', kanjiId: 'san' },
      ],
      now: '2026-10-22T00:00:00.000Z',
    });

    expect(stats.library).toEqual({ total: 3, multiReading: 2 });
    expect(stats.totals).toEqual({ attempts: 4, correct: 1, incorrect: 3, accuracy: 25 });
    expect(stats.latest).toEqual({ correct: 1, incorrect: 1, unanswered: 1, practiced: 2 });
    expect(stats.ignoredAttempts).toBe(1);
    expect(stats.recentKanji[0]).toMatchObject({ id: 'gone', deleted: true, hanViet: ['SINH'] });
    expect(stats.difficultKanji.find(item => item.id === 'gone')).toMatchObject({ deleted: true, incorrect: 1, total: 1, accuracy: 0 });
    expect(stats.history.map(item => item.id)).toEqual(['deleted', 'a3', 'a2', 'a1']);
    expect(stats.history[0].deleted).toBe(true);
    expect(stats.history[1].deleted).toBe(false);
  });

  it('ranks difficulty by incorrect count, then total, then ID', () => {
    const attempts = [
      attempt({ id: 'a', kanjiId: 'san', isCorrect: false, sequence: 0 }),
      attempt({ id: 'b', kanjiId: 'san', isCorrect: false, sequence: 1 }),
      attempt({ id: 'c', kanjiId: 'gaku', kanji: '学', requiredReadings: ['HỌC'], isCorrect: false, sequence: 2 }),
      attempt({ id: 'd', kanjiId: 'gaku', kanji: '学', requiredReadings: ['HỌC'], isCorrect: true, sequence: 3 }),
      attempt({ id: 'e', kanjiId: 'iku', kanji: '行', requiredReadings: ['HÀNH', 'HẠNH'], isCorrect: true, sequence: 4 }),
    ];
    const stats = buildStatistics({ records, attempts });
    expect(stats.difficultKanji.slice(0, 2).map(item => item.id)).toEqual(['san', 'gaku']);
    expect(stats.difficultKanji.find(item => item.id === 'gaku')).toMatchObject({ incorrect: 1, total: 2, accuracy: 50 });
  });

  it('creates a zero-filled local calendar and excludes future calendar days', () => {
    const stats = buildStatistics({
      records,
      attempts: [
        attempt({ id: 'late', createdAt: '2026-03-08T04:30:00.000Z', isCorrect: true }), // Mar 7 in New York
        attempt({ id: 'today', createdAt: '2026-03-08T13:00:00.000Z', isCorrect: false }), // Mar 8 in New York
        attempt({ id: 'future', createdAt: '2026-03-10T00:00:00.000Z', isCorrect: false }),
      ],
      now: '2026-03-08T18:00:00.000Z',
      timeZone: 'America/New_York',
      days: 4,
    });
    expect(stats.activity.map(day => day.date)).toEqual(['2026-03-05', '2026-03-06', '2026-03-07', '2026-03-08']);
    expect(stats.activity.find(day => day.date === '2026-03-07')).toMatchObject({ correct: 1, incorrect: 0, total: 1 });
    expect(stats.activity.find(day => day.date === '2026-03-08')).toMatchObject({ correct: 0, incorrect: 1, total: 1 });
    expect(stats.activity.every(day => day.total >= 0)).toBe(true);
  });

  it('keeps recorded lifetime counts separate from current session draft status', () => {
    const sessions = [{
      id: 'table-1',
      mode: 'table',
      active: true,
      createdAt: '2026-10-21T00:00:00.000Z',
      updatedAt: '2026-10-22T00:00:00.000Z',
      checks: 5,
      items: [
        { id: 'san', answer: 'TÁN/TẢN', checkedAnswer: 'TÁN/TẢN', result: true },
        { id: 'gaku', answer: '', checkedAnswer: null, result: null },
      ],
    }];
    const stats = buildStatistics({ records, attempts: [attempt({ id: 'stored', isCorrect: true })], sessions });
    expect(stats.totals).toMatchObject({ attempts: 1, correct: 1, incorrect: 0, accuracy: 100 });
    expect(stats.recentSessions[0]).toMatchObject({ attempts: 1, correct: 1, incorrect: 0, legacyChecks: 4, current: { total: 2, correct: 1, incorrect: 0, unanswered: 1 } });
  });

  it('does not mutate source arrays or objects', () => {
    const inputRecords = records.map(record => ({ ...record, hanViet: [...record.hanViet] }));
    const inputAttempts = [attempt({ id: 'one', isCorrect: false })];
    const beforeRecords = JSON.stringify(inputRecords);
    const beforeAttempts = JSON.stringify(inputAttempts);
    const stats = buildStatistics({ records: inputRecords, attempts: inputAttempts });
    stats.recentKanji[0].hanViet.push('MUTATED');
    stats.history[0].requiredReadings.push('MUTATED');
    expect(JSON.stringify(inputRecords)).toBe(beforeRecords);
    expect(JSON.stringify(inputAttempts)).toBe(beforeAttempts);
  });
});

