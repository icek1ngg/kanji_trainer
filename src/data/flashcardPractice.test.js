import 'fake-indexeddb/auto';
import { deleteDB } from 'idb';
import { describe, expect, it } from 'vitest';
import { openDatabase } from './database.js';
import {
  createFlashcardPracticeRepository,
  FlashcardConflictError,
  InvalidFlashcardSessionError,
  UnsupportedFlashcardSessionError,
} from './flashcardPractice.js';
import { checkFlashcardAnswer, setFlashcardAnswer } from '../domain/flashcardSession.js';

const records = [
  { id: 'san', kanji: '散', hanViet: ['TÁN', 'TẢN'] },
  { id: 'gaku', kanji: '学', hanViet: ['HỌC'] },
  { id: 'sei', kanji: '生', hanViet: ['SINH'] },
];

async function fixture() {
  const name = `flashcard-${crypto.randomUUID()}`;
  const db = await openDatabase({ name });
  return { name, db, repository: createFlashcardPracticeRepository(db) };
}

describe('persistent flashcard practice sessions', () => {
  it('creates and reopens the active session with drafts and preferences', async () => {
    const { name, db, repository } = await fixture();
    try {
      const created = await repository.loadOrCreate(records, { size: 10, order: 'random' });
      expect(created.items).toHaveLength(3);
      expect(created).toMatchObject({ mode: 'flashcard', size: 10, order: 'random', revision: 0 });
      const drafted = { ...created, items: created.items.map(item => ({ ...item, hanViet: [...item.hanViet], answer: item.id === created.items[0].id ? 'draft' : '' })) };
      const saved = await repository.save(drafted, created.revision);
      expect(saved.revision).toBe(1);
      const resumed = await repository.loadOrCreate(records, { size: 'all', order: 'sequential' });
      expect(resumed.id).toBe(created.id);
      expect(resumed.size).toBe(10);
      expect(resumed.order).toBe('random');
      expect(resumed.items.find(item => item.answer === 'draft')).toBeTruthy();
    } finally { db.close(); await deleteDB(name); }
  });

  it('rejects stale saves and keeps the current session unchanged', async () => {
    const { name, db, repository } = await fixture();
    try {
      const session = await repository.loadOrCreate(records);
      const first = await repository.save({ ...session, items: session.items.map(item => ({ ...item, hanViet: [...item.hanViet], answer: 'first' })) }, 0);
      await expect(repository.save({ ...session, items: session.items.map(item => ({ ...item, hanViet: [...item.hanViet], answer: 'stale' })) }, 0)).rejects.toBeInstanceOf(FlashcardConflictError);
      expect((await repository.loadOrCreate(records)).items[0].answer).toBe('first');
      expect(first.revision).toBe(1);
    } finally { db.close(); await deleteDB(name); }
  });

  it('persists repeated flashcard checks as immutable attempts without duplicates', async () => {
    const { name, db, repository } = await fixture();
    try {
      const created = await repository.loadOrCreate(records);
      const first = checkFlashcardAnswer(setFlashcardAnswer(created, 'san', 'WRONG'), 'san', { attemptId: 'flash-one', now: '2026-10-22T00:00:00.000Z' });
      const committedFirst = await repository.save({ ...first, revision: created.revision }, created.revision);
      const second = checkFlashcardAnswer(setFlashcardAnswer(first, 'san', 'TÁN/TẢN'), 'san', { attemptId: 'flash-two', now: '2026-10-22T00:01:00.000Z' });
      const committedSecond = await repository.save({ ...second, revision: committedFirst.revision }, committedFirst.revision);
      expect(committedSecond.pendingAttempts).toEqual([]);
      const attempts = await db.getAll('attempts');
      expect(attempts).toHaveLength(2);
      expect(attempts.map(attempt => attempt.mode)).toEqual(['flashcard', 'flashcard']);
      expect(attempts.map(attempt => attempt.sequence)).toEqual([0, 1]);
    } finally { db.close(); await deleteDB(name); }
  });

  it('archives on reset, preserves preferences by default and keeps other stores untouched', async () => {
    const { name, db, repository } = await fixture();
    try {
      const original = await repository.loadOrCreate(records, { size: 10, order: 'random' });
      await db.add('attempts', { id: 'history', sessionId: original.id, kanjiId: 'san' });
      const reset = await repository.startNew([records[0]], original);
      expect(reset.id).not.toBe(original.id);
      expect(reset.items.map(item => item.id)).toEqual(['san']);
      expect(reset).toMatchObject({ size: 10, order: 'random' });
      const sessions = await repository.listSessions();
      expect(sessions).toHaveLength(2);
      expect(sessions.find(session => session.id === original.id).active).toBe(false);
      expect(sessions.find(session => session.id === reset.id).active).toBe(true);
      expect(await db.get('attempts', 'history')).toMatchObject({ sessionId: original.id });
    } finally { db.close(); await deleteDB(name); }
  });

  it('archives the latest checked snapshot when reset races a queued save', async () => {
    const { name, db, repository } = await fixture();
    try {
      const original = await repository.loadOrCreate(records);
      const checked = checkFlashcardAnswer(setFlashcardAnswer(original, 'san', 'WRONG'), 'san', { attemptId: 'flash-reset-attempt', now: '2026-10-22T00:00:00.000Z' });
      const reset = await repository.startNew([records[0]], { ...checked, revision: original.revision });
      expect(reset.id).not.toBe(original.id);
      const archived = (await repository.listSessions()).find(session => session.id === original.id);
      expect(archived).toMatchObject({ active: false, checks: 1, incorrectChecks: 1, pendingAttempts: [] });
      expect(archived.items[0]).toMatchObject({ answer: 'WRONG', checkedAnswer: 'WRONG', result: false });
      expect(await db.get('attempts', 'flash-reset-attempt')).toMatchObject({ isCorrect: false, sessionId: original.id });
    } finally { db.close(); await deleteDB(name); }
  });

  it('rejects stale reset races without archiving the current session', async () => {
    const { name, db, repository } = await fixture();
    try {
      const session = await repository.loadOrCreate(records);
      await repository.save({ ...session, items: session.items.map(item => ({ ...item, hanViet: [...item.hanViet] })) }, 0);
      await expect(repository.startNew(records, session)).rejects.toBeInstanceOf(FlashcardConflictError);
      expect((await repository.loadOrCreate(records)).active).toBe(true);
      expect((await repository.listSessions()).filter(item => item.active && item.mode === 'flashcard')).toHaveLength(1);
    } finally { db.close(); await deleteDB(name); }
  });

  it('rolls back the archive when new-session creation fails after the archive write', async () => {
    const { name, db, repository } = await fixture();
    try {
      const table = { id: 'table-session', mode: 'table', schemaVersion: 1, active: true, revision: 3 };
      await db.add('sessions', table);
      const original = await repository.loadOrCreate(records);
      await db.add('attempts', { id: 'history', sessionId: original.id, kanjiId: 'san' });
      const beforeSessions = await repository.listSessions();
      const beforeAttempts = await db.getAll('attempts');

      // The archive put occurs before createFlashcardSession validates options.
      // A transaction abort must undo that archive and avoid adding a second
      // active session when creation fails late in the reset operation.
      await expect(repository.startNew(records, original, { size: 15 })).rejects.toThrow(TypeError);

      expect(await repository.listSessions()).toEqual(beforeSessions);
      expect(await db.getAll('attempts')).toEqual(beforeAttempts);
      expect(await db.get('sessions', table.id)).toEqual(table);
      expect((await repository.listSessions()).filter(session => session.active && session.mode === 'flashcard')).toEqual([original]);
    } finally { db.close(); await deleteDB(name); }
  });

  it('reconciles edits and deletions on resume without auto-adding records', async () => {
    const { name, db, repository } = await fixture();
    try {
      const created = await repository.loadOrCreate(records);
      const drafted = {
        ...created,
        position: 1,
        items: created.items.map(item => item.id === 'san'
          ? { ...item, hanViet: [...item.hanViet], answer: 'TÁN', checkedAnswer: 'TÁN', result: false, revealed: true }
          : { ...item, hanViet: [...item.hanViet], answer: item.id === 'gaku' ? 'draft' : '' }),
        checks: 1,
        incorrectChecks: 1,
      };
      const saved = await repository.save(drafted, created.revision);
      const resumed = await repository.loadOrCreate([
        { id: 'san', kanji: '散', hanViet: ['TÁN', 'TẢN', 'SAN'] },
        { id: 'gaku', kanji: '学', hanViet: ['HỌC'] },
        { id: 'new', kanji: '新', hanViet: ['TÂN'] },
      ]);
      expect(resumed.id).toBe(created.id);
      expect(resumed.revision).toBe(saved.revision + 1);
      expect(resumed.items.map(item => item.id)).toEqual(['san', 'gaku']);
      expect(resumed.position).toBe(1);
      expect(resumed.items[1].answer).toBe('draft');
      expect(resumed.items[0]).toMatchObject({ hanViet: ['TÁN', 'TẢN', 'SAN'], answer: 'TÁN', checkedAnswer: null, result: null, revealed: false });
    } finally { db.close(); await deleteDB(name); }
  });

  it('does not replace malformed or unsupported active flashcard sessions', async () => {
    const malformedFixture = await fixture();
    try {
      const malformed = { id: 'malformed', mode: 'flashcard', schemaVersion: 1, active: true, revision: 0, createdAt: '2026-10-21T00:00:00.000Z', updatedAt: '2026-10-21T00:00:00.000Z', items: 'not-an-array', position: 0, size: 'all', order: 'sequential', checks: 0, correctChecks: 0, incorrectChecks: 0 };
      await malformedFixture.db.add('sessions', malformed);
      await expect(malformedFixture.repository.loadOrCreate(records)).rejects.toBeInstanceOf(InvalidFlashcardSessionError);
      expect(await malformedFixture.db.get('sessions', 'malformed')).toEqual(malformed);
    } finally { malformedFixture.db.close(); await deleteDB(malformedFixture.name); }

    const unsupportedFixture = await fixture();
    try {
      await unsupportedFixture.db.add('sessions', { id: 'future', mode: 'flashcard', schemaVersion: 99, active: true });
      await expect(unsupportedFixture.repository.loadOrCreate(records)).rejects.toBeInstanceOf(UnsupportedFlashcardSessionError);
      expect(await unsupportedFixture.db.get('sessions', 'future')).toMatchObject({ active: true, schemaVersion: 99 });
    } finally { unsupportedFixture.db.close(); await deleteDB(unsupportedFixture.name); }
  });

  it('leaves table and unrelated active sessions alone', async () => {
    const { name, db, repository } = await fixture();
    try {
      const table = { id: 'table-session', mode: 'table', schemaVersion: 1, active: true, revision: 4 };
      await db.add('sessions', table);
      const flashcard = await repository.loadOrCreate(records);
      expect(flashcard.mode).toBe('flashcard');
      expect(await db.get('sessions', table.id)).toEqual(table);
      expect((await repository.listSessions()).filter(session => session.active)).toHaveLength(2);
    } finally { db.close(); await deleteDB(name); }
  });
});
