import 'fake-indexeddb/auto';
import { deleteDB } from 'idb';
import { describe, expect, it } from 'vitest';
import { openDatabase } from './database.js';
import { createWrongPracticeRepository, WrongPracticeConflictError } from './wrongPractice.js';
import { checkWrongAnswer, setWrongAnswer } from '../domain/wrongSession.js';

const records = [
  { id: 'san', kanji: '散', hanViet: ['TÁN', 'TẢN'] },
  { id: 'gaku', kanji: '学', hanViet: ['HỌC'] },
];

async function fixture() {
  const name = `wrong-${crypto.randomUUID()}`;
  const db = await openDatabase({ name });
  return { name, db, repository: createWrongPracticeRepository(db) };
}

describe('persistent wrong-answer practice sessions', () => {
  it('starts only explicitly, saves drafts and drains pending attempts atomically', async () => {
    const { name, db, repository } = await fixture();
    try {
      expect(await repository.loadActive(records)).toBeNull();
      const created = await repository.startNew([records[0]], null, { scope: 'all', random: () => 0, id: 'wrong-1', now: '2026-10-21T00:00:00.000Z' });
      const checked = checkWrongAnswer(setWrongAnswer(created, 'san', 'TÁN'), 'san', { now: '2026-10-21T00:00:01.000Z' });
      const saved = await repository.save(checked, created.revision);
      expect(saved.pendingAttempts).toEqual([]);
      expect((await db.getAll('attempts'))).toHaveLength(1);
      expect(await db.get('attempts', 'wrong-1:attempt:1')).toMatchObject({ mode: 'wrong', kanjiId: 'san', isCorrect: false, requiredReadings: ['TÁN', 'TẢN'] });
      expect((await repository.loadActive(records)).items[0].answer).toBe('TÁN');
    } finally { db.close(); await deleteDB(name); }
  });

  it('rejects stale saves and archives before creating a fresh session', async () => {
    const { name, db, repository } = await fixture();
    try {
      const created = await repository.startNew(records, null, { id: 'wrong-1', random: () => 0, now: '2026-10-21T00:00:00.000Z' });
      const saved = await repository.save({ ...created, items: created.items.map(item => ({ ...item, hanViet: [...item.hanViet], answer: 'draft' })) }, created.revision);
      await expect(repository.save({ ...created, items: created.items.map(item => ({ ...item, hanViet: [...item.hanViet], answer: 'stale' })) }, created.revision)).rejects.toBeInstanceOf(WrongPracticeConflictError);
      const next = await repository.startNew([records[0]], saved, { id: 'wrong-2', random: () => 0, now: '2026-10-21T00:00:02.000Z' });
      expect(next.id).toBe('wrong-2');
      const sessions = await repository.listSessions();
      expect(sessions.find(session => session.id === 'wrong-1').active).toBe(false);
      expect(sessions.find(session => session.id === 'wrong-2').active).toBe(true);
      expect(await db.get('sessions', 'wrong-1')).toMatchObject({ active: false });
    } finally { db.close(); await deleteDB(name); }
  });

  it('does not change table or flashcard sessions', async () => {
    const { name, db, repository } = await fixture();
    try {
      await db.add('sessions', { id: 'table-1', mode: 'table', schemaVersion: 1, active: true, revision: 3 });
      const wrong = await repository.startNew(records, null, { id: 'wrong-1' });
      expect(await db.get('sessions', 'table-1')).toMatchObject({ mode: 'table', active: true, revision: 3 });
      expect(wrong.mode).toBe('wrong');
    } finally { db.close(); await deleteDB(name); }
  });

  it('archives an unsaved checked snapshot and writes its pending attempt once', async () => {
    const { name, db, repository } = await fixture();
    try {
      const created = await repository.startNew([records[0]], null, { id: 'wrong-1', random: () => 0, now: '2026-10-21T00:00:00.000Z' });
      const checked = checkWrongAnswer(setWrongAnswer(created, 'san', 'TÁN'), 'san', { now: '2026-10-21T00:00:01.000Z' });
      const next = await repository.startNew([records[1]], checked, { id: 'wrong-2', random: () => 0, now: '2026-10-21T00:00:02.000Z' });
      expect(next.id).toBe('wrong-2');
      expect(await db.getAll('attempts')).toHaveLength(1);
      expect(await db.get('attempts', 'wrong-1:attempt:1')).toMatchObject({ sessionId: 'wrong-1', mode: 'wrong', isCorrect: false });
      expect(await db.get('sessions', 'wrong-1')).toMatchObject({ active: false, checks: 1, incorrectChecks: 1, items: [{ answer: 'TÁN', result: false }] });
    } finally { db.close(); await deleteDB(name); }
  });
});

