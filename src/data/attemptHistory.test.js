import 'fake-indexeddb/auto';
import { deleteDB } from 'idb';
import { describe, expect, it } from 'vitest';
import { openDatabase } from './database.js';
import { createAttemptHistoryRepository, listAttemptHistory, writePendingAttempts } from './attemptHistory.js';
import { createTableSession, setTableAnswer, checkTableAnswer } from '../domain/tableSession.js';

async function fixture() {
  const name = `history-${crypto.randomUUID()}`;
  const db = await openDatabase({ name });
  return { name, db };
}

const records = [{ id: 'san', kanji: '散', hanViet: ['TÁN', 'TẢN'] }];

describe('individual attempt history persistence', () => {
  it('drains pending attempts atomically with a cleared session queue and deduplicates retries', async () => {
    const { name, db } = await fixture();
    try {
      const session = checkTableAnswer(
        setTableAnswer(createTableSession(records, { id: 'session', now: '2026-10-22T00:00:00.000Z' }), 'san', 'WRONG'),
        'san',
        { attemptId: 'attempt-1', now: '2026-10-22T00:01:00.000Z' },
      );
      const tx = db.transaction(['sessions', 'attempts'], 'readwrite');
      const cleared = await writePendingAttempts(tx, session);
      await tx.objectStore('sessions').add(cleared);
      await tx.done;
      expect(cleared.pendingAttempts).toEqual([]);
      expect(await db.getAll('attempts')).toHaveLength(1);

      const retryTx = db.transaction(['sessions', 'attempts'], 'readwrite');
      const retryCleared = await writePendingAttempts(retryTx, session);
      await retryTx.done;
      expect(retryCleared.pendingAttempts).toEqual([]);
      expect(await db.getAll('attempts')).toHaveLength(1);
      expect((await db.getAll('attempts'))[0]).toMatchObject({ sequence: 0, checkedAt: expect.any(String) });
    } finally { db.close(); await deleteDB(name); }
  });

  it('does not write absent queues, and lists legacy rows without inventing attempts', async () => {
    const { name, db } = await fixture();
    try {
      await db.add('attempts', { id: 'legacy', sessionId: 'session', kanjiId: 'san' });
      const session = createTableSession(records, { id: 'session', now: '2026-10-22T00:00:00.000Z' });
      const tx = db.transaction(['sessions', 'attempts'], 'readwrite');
      const cleared = await writePendingAttempts(tx, session);
      await tx.done;
      expect(cleared.pendingAttempts).toEqual([]);
      expect(await listAttemptHistory(db)).toHaveLength(1);
      expect(await createAttemptHistoryRepository(db).listSessions()).toEqual([]);
    } finally { db.close(); await deleteDB(name); }
  });

  it('revalidates correctness before writing and allows transaction rollback', async () => {
    const { name, db } = await fixture();
    try {
      const session = checkTableAnswer(
        setTableAnswer(createTableSession(records, { id: 'session', now: '2026-10-22T00:00:00.000Z' }), 'san', 'WRONG'),
        'san',
        { attemptId: 'attempt-1', now: '2026-10-22T00:01:00.000Z' },
      );
      const forged = { ...session, pendingAttempts: [{ ...session.pendingAttempts[0], isCorrect: true }] };
      const tx = db.transaction(['sessions', 'attempts'], 'readwrite');
      await expect(writePendingAttempts(tx, forged)).rejects.toThrow(/validation result/i);
      try { tx.abort(); } catch { /* transaction may already be aborted */ }
      await tx.done.catch(() => {});
      expect(await db.getAll('attempts')).toEqual([]);
    } finally { db.close(); await deleteDB(name); }
  });

  it('rolls back an inserted attempt when the encompassing session transaction aborts', async () => {
    const { name, db } = await fixture();
    try {
      const session = checkTableAnswer(
        setTableAnswer(createTableSession(records, { id: 'session', now: '2026-10-22T00:00:00.000Z' }), 'san', 'WRONG'),
        'san',
        { attemptId: 'attempt-rollback', now: '2026-10-22T00:01:00.000Z' },
      );
      const tx = db.transaction(['sessions', 'attempts'], 'readwrite');
      await writePendingAttempts(tx, session);
      tx.abort();
      await tx.done.catch(() => {});
      expect(await db.getAll('attempts')).toEqual([]);
      expect(await db.get('sessions', session.id)).toBeUndefined();
    } finally { db.close(); await deleteDB(name); }
  });
});

