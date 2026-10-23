import 'fake-indexeddb/auto';
import { deleteDB } from 'idb';
import { describe, expect, it } from 'vitest';
import { openDatabase } from './database.js';
import {
  createTablePracticeRepository,
  InvalidTableSessionError,
  PracticeConflictError,
  UnsupportedTableSessionError,
} from './tablePractice.js';
import { checkTableAnswer, setTableAnswer } from '../domain/tableSession.js';

const records = [
  { id: 'san', kanji: '散', hanViet: ['TÁN', 'TẢN'] },
  { id: 'gaku', kanji: '学', hanViet: ['HỌC'] },
];

async function fixture() {
  const name = `table-${crypto.randomUUID()}`;
  const db = await openDatabase({ name });
  return { name, db, repository: createTablePracticeRepository(db) };
}

describe('persistent table practice sessions', () => {
  it('creates, resumes drafts and saves with a revision', async () => {
    const { name, db, repository } = await fixture();
    try {
      const created = await repository.loadOrCreate(records);
      expect(created.items).toHaveLength(2);
      const drafted = { ...created, items: created.items.map(item => ({ ...item, hanViet: [...item.hanViet], answer: item.id === 'san' ? 'TÁN' : item.answer })) };
      const saved = await repository.save(drafted, created.revision);
      expect(saved.revision).toBe(1);
      const resumed = await repository.loadOrCreate(records);
      expect(resumed.id).toBe(created.id);
      expect(resumed.items.find(item => item.id === 'san').answer).toBe('TÁN');
    } finally { db.close(); await deleteDB(name); }
  });

  it('rejects stale saves and leaves the current session unchanged', async () => {
    const { name, db, repository } = await fixture();
    try {
      const session = await repository.loadOrCreate(records);
      const first = await repository.save({ ...session, items: session.items.map(item => ({ ...item, hanViet: [...item.hanViet], answer: 'first' })) }, 0);
      await expect(repository.save({ ...session, items: session.items.map(item => ({ ...item, hanViet: [...item.hanViet], answer: 'stale' })) }, 0)).rejects.toBeInstanceOf(PracticeConflictError);
      expect((await repository.loadOrCreate(records)).items[0].answer).toBe('first');
      expect(first.revision).toBe(1);
    } finally { db.close(); await deleteDB(name); }
  });

  it('persists each checked answer once across queued snapshots and rejects stale history writes', async () => {
    const { name, db, repository } = await fixture();
    try {
      const created = await repository.loadOrCreate(records);
      const first = checkTableAnswer(setTableAnswer(created, 'san', 'WRONG'), 'san', { attemptId: 'attempt-one', now: '2026-10-22T00:00:00.000Z' });
      const committedFirst = await repository.save({ ...first, revision: created.revision }, created.revision);
      const second = checkTableAnswer(setTableAnswer(first, 'san', 'TÁN/TẢN'), 'san', { attemptId: 'attempt-two', now: '2026-10-22T00:01:00.000Z' });
      const committedSecond = await repository.save({ ...second, revision: committedFirst.revision }, committedFirst.revision);
      expect(committedSecond.pendingAttempts).toEqual([]);
      expect((await db.getAll('attempts')).map(attempt => attempt.id)).toEqual(['attempt-one', 'attempt-two']);
      await expect(repository.save({ ...second, revision: committedFirst.revision }, committedFirst.revision)).rejects.toBeInstanceOf(PracticeConflictError);
      expect((await db.getAll('attempts')).map(attempt => attempt.id)).toEqual(['attempt-one', 'attempt-two']);
    } finally { db.close(); await deleteDB(name); }
  });

  it('archives on reset and creates a new session without deleting history', async () => {
    const { name, db, repository } = await fixture();
    try {
      const original = await repository.loadOrCreate(records);
      const retryRecords = [records[0]];
      const reset = await repository.startNew(retryRecords, original);
      expect(reset.id).not.toBe(original.id);
      expect(reset.items.map(item => item.id)).toEqual(['san']);
      const sessions = await repository.listSessions();
      expect(sessions).toHaveLength(2);
      expect(sessions.find(session => session.id === original.id).active).toBe(false);
      expect(sessions.find(session => session.id === reset.id).active).toBe(true);
      await db.add('attempts', { id: 'history', sessionId: original.id, kanjiId: 'san' });
      expect(await db.get('attempts', 'history')).toMatchObject({ sessionId: original.id });
    } finally { db.close(); await deleteDB(name); }
  });

  it('archives the latest checked snapshot when reset races a queued save', async () => {
    const { name, db, repository } = await fixture();
    try {
      const original = await repository.loadOrCreate(records);
      const checked = checkTableAnswer(setTableAnswer(original, 'san', 'WRONG'), 'san', { attemptId: 'reset-attempt', now: '2026-10-22T00:00:00.000Z' });
      const reset = await repository.startNew([records[0]], { ...checked, revision: original.revision });
      expect(reset.id).not.toBe(original.id);
      const archived = (await repository.listSessions()).find(session => session.id === original.id);
      expect(archived).toMatchObject({ active: false, checks: 1, incorrectChecks: 1, pendingAttempts: [] });
      expect(archived.items[0]).toMatchObject({ answer: 'WRONG', checkedAnswer: 'WRONG', result: false });
      expect(await db.get('attempts', 'reset-attempt')).toMatchObject({ isCorrect: false, sessionId: original.id });
    } finally { db.close(); await deleteDB(name); }
  });

  it('rejects reset races and does not archive the current session', async () => {
    const { name, db, repository } = await fixture();
    try {
      const session = await repository.loadOrCreate(records);
      await repository.save({ ...session, items: session.items.map(item => ({ ...item, hanViet: [...item.hanViet] })) }, 0);
      await expect(repository.startNew(records, session)).rejects.toBeInstanceOf(PracticeConflictError);
      expect((await repository.loadOrCreate(records)).active).toBe(true);
      expect((await repository.listSessions()).filter(item => item.active)).toHaveLength(1);
    } finally { db.close(); await deleteDB(name); }
  });

  it('does not replace an active session with new library records', async () => {
    const { name, db, repository } = await fixture();
    try {
      const session = await repository.loadOrCreate(records);
      const resumed = await repository.loadOrCreate([{ id: 'other', kanji: '行', hanViet: ['HÀNH'] }]);
      expect(resumed.id).toBe(session.id);
      expect(resumed.items).toEqual([]);
      expect(resumed.revision).toBe(session.revision + 1);
    } finally { db.close(); await deleteDB(name); }
  });

  it('reconciles edited readings on resume while preserving drafts and session membership', async () => {
    const { name, db, repository } = await fixture();
    try {
      const created = await repository.loadOrCreate(records);
      const saved = await repository.save({
        ...created,
        items: created.items.map(item => item.id === 'san'
          ? { ...item, hanViet: [...item.hanViet], answer: 'TÁN', checkedAnswer: 'TÁN', result: false, revealed: true }
          : { ...item, hanViet: [...item.hanViet] }),
        checks: 1,
        incorrectChecks: 1,
      }, created.revision);

      const resumed = await repository.loadOrCreate([
        { id: 'san', kanji: '散', hanViet: ['TÁN', 'TẢN', 'SAN'] },
        { id: 'new', kanji: '新', hanViet: ['TÂN'] },
      ]);

      expect(resumed.id).toBe(created.id);
      expect(resumed.revision).toBe(saved.revision + 1);
      expect(resumed.items.map(item => item.id)).toEqual(['san']);
      expect(resumed.items[0]).toMatchObject({
        kanji: '散',
        hanViet: ['TÁN', 'TẢN', 'SAN'],
        answer: 'TÁN',
        checkedAnswer: null,
        result: null,
        revealed: false,
      });
      expect(resumed.checks).toBe(saved.checks);
      expect(resumed.incorrectChecks).toBe(saved.incorrectChecks);
    } finally { db.close(); await deleteDB(name); }
  });

  it('rejects malformed or unsupported active sessions without silently resetting them', async () => {
    const malformedFixture = await fixture();
    try {
      const malformed = {
        id: 'malformed',
        mode: 'table',
        schemaVersion: 1,
        active: true,
        revision: 0,
        createdAt: '2026-10-21T00:00:00.000Z',
        updatedAt: '2026-10-21T00:00:00.000Z',
        items: 'not-an-array',
        checks: 0,
        correctChecks: 0,
        incorrectChecks: 0,
      };
      await malformedFixture.db.add('sessions', malformed);
      await expect(malformedFixture.repository.loadOrCreate(records)).rejects.toBeInstanceOf(InvalidTableSessionError);
      expect(await malformedFixture.db.get('sessions', 'malformed')).toEqual(malformed);
    } finally { malformedFixture.db.close(); await deleteDB(malformedFixture.name); }

    const unsupportedFixture = await fixture();
    try {
      await unsupportedFixture.db.add('sessions', { id: 'future', mode: 'table', schemaVersion: 99, active: true });
      await expect(unsupportedFixture.repository.loadOrCreate(records)).rejects.toBeInstanceOf(UnsupportedTableSessionError);
      expect(await unsupportedFixture.db.get('sessions', 'future')).toMatchObject({ active: true, schemaVersion: 99 });
    } finally { unsupportedFixture.db.close(); await deleteDB(unsupportedFixture.name); }
  });

  it('ignores active sessions belonging to another practice mode', async () => {
    const { name, db, repository } = await fixture();
    try {
      const flashcard = { id: 'flashcard-session', mode: 'flashcard', schemaVersion: 1, active: true, revision: 4 };
      await db.add('sessions', flashcard);
      const table = await repository.loadOrCreate(records);
      expect(table.mode).toBe('table');
      expect(table.items.map(item => item.id)).toEqual(['san', 'gaku']);
      expect(await db.get('sessions', flashcard.id)).toEqual(flashcard);
      expect((await repository.listSessions()).filter(session => session.active)).toHaveLength(2);
    } finally { db.close(); await deleteDB(name); }
  });
});
