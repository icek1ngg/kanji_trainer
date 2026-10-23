import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { deleteDB } from 'idb';
import { openDatabase } from './database.js';
import { createStatisticsRepository, readStatisticsSnapshot } from './statistics.js';

const names = new Set();
const fixture = async () => {
  const name = `statistics-${crypto.randomUUID()}`;
  names.add(name);
  return { name, db: await openDatabase({ name }) };
};

afterEach(async () => {
  await Promise.all([...names].map(name => deleteDB(name).catch(() => {})));
  names.clear();
});

describe('statistics snapshot persistence', () => {
  it('reads records, attempts and sessions atomically without writing', async () => {
    const { name, db } = await fixture();
    try {
      const record = { id: 'san', kanji: '散', hanViet: ['TÁN', 'TẢN'] };
      const attempt = {
        id: 'attempt-1', sessionId: 'session-1', kanjiId: 'san', kanji: '散',
        requiredReadings: ['TÁN', 'TẢN'], submittedAnswer: 'TÁN', isCorrect: false,
        mode: 'table', createdAt: '2026-10-22T01:00:00.000Z',
      };
      const session = {
        id: 'session-1', mode: 'table', active: true, items: [],
        createdAt: '2026-10-22T00:00:00.000Z', updatedAt: '2026-10-22T01:00:00.000Z',
      };
      await db.add('kanji', record);
      await db.add('attempts', attempt);
      await db.add('sessions', session);
      const before = {
        records: await db.getAll('kanji'),
        attempts: await db.getAll('attempts'),
        sessions: await db.getAll('sessions'),
      };
      const snapshot = await readStatisticsSnapshot(db);
      expect(snapshot).toEqual(before);
      snapshot.records[0].hanViet.push('MUTATED');
      snapshot.attempts[0].requiredReadings.push('MUTATED');
      expect(await db.get('kanji', 'san')).toEqual(record);
      expect(await db.get('attempts', 'attempt-1')).toEqual(attempt);
      expect(await db.get('sessions', 'session-1')).toEqual(session);
      expect(await createStatisticsRepository(db).read()).toMatchObject({ records: [record], attempts: [attempt], sessions: [session] });
    } finally {
      db.close();
      await deleteDB(name);
      names.delete(name);
    }
  });

  it('requires a database connection', async () => {
    await expect(readStatisticsSnapshot(null)).rejects.toThrow(/IndexedDB database/);
    expect(() => createStatisticsRepository(null)).toThrow(/IndexedDB database/);
  });
});

