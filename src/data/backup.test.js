import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { deleteDB } from 'idb';
import { createTableSession } from '../domain/tableSession.js';
import { openDatabase } from './database.js';
import {
  exportBackup,
  resetHistory,
  resetSessions,
  restoreBackup,
} from './backup.js';
import { createTablePracticeRepository, PracticeConflictError } from './tablePractice.js';

const names = new Set();
const originalStorage = globalThis.localStorage;

function fixtureName() {
  const name = `backup-${crypto.randomUUID()}`;
  names.add(name);
  return name;
}

function installStorage() {
  const values = new Map();
  globalThis.localStorage = {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(String(key), String(value)); },
  };
  return values;
}

function record(id = 'san', kanji = '散', hanViet = ['TÁN', 'TẢN']) {
  return { id, kanji, hanViet, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' };
}

function session(id = 'table-1', revision = 0) {
  return { ...createTableSession([record()], { id, now: '2026-10-02T00:00:00.000Z' }), revision };
}

function attempt(id = 'attempt-1', sessionId = 'table-1') {
  return {
    id, sessionId, kanjiId: 'san', kanji: '散', requiredReadings: ['TÁN', 'TẢN'],
    submittedAnswer: 'TÁN/TẢN', isCorrect: true, mode: 'table', createdAt: '2026-10-02T00:01:00.000Z',
  };
}

function backup(overrides = {}) {
  return {
    format: 'kanji-trainer', version: 1, exportedAt: '2026-10-03T00:00:00.000Z',
    kanji: [record()], sessions: [session()], attempts: [attempt()],
    settings: { practiceSize: '20', feedback: 'compact', theme: 'dark' },
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all([...names].map(name => deleteDB(name).catch(() => {})));
  names.clear();
  if (originalStorage === undefined) delete globalThis.localStorage;
  else globalThis.localStorage = originalStorage;
});

describe('versioned IndexedDB backup and reset services', () => {
  it('exports a consistent full snapshot and restores pending sessions and settings', async () => {
    const sourceName = fixtureName();
    const targetName = fixtureName();
    installStorage();
    const source = await openDatabase({ name: sourceName });
    const sourceSession = session();
    sourceSession.pendingAttempts = [{ ...attempt(), id: 'pending-1' }];
    await source.add('kanji', record());
    await source.add('sessions', sourceSession);
    await source.add('attempts', attempt());
    await source.add('attempts', { id: 'legacy-attempt', oldCounter: 3 });
    await source.add('sessions', { id: 'legacy-session', mode: 'legacy', active: false, oldCounter: 3 });
    const exported = await exportBackup(source, { practiceSize: '20', feedback: 'compact', theme: 'dark' });
    expect(exported.settings).toEqual({ practiceSize: '20', feedback: 'compact', theme: 'dark' });
    expect(exported.sessions.find(item => item.id === 'table-1').pendingAttempts).toHaveLength(1);
    const target = await openDatabase({ name: targetName });
    await target.add('kanji', record('old', '学', ['HỌC']));
    const restored = await restoreBackup(target, exported);
    expect(restored.settingsPersisted).toBe(true);
    expect(await target.getAll('kanji')).toEqual(exported.kanji);
    expect(await target.getAll('attempts')).toEqual(exported.attempts);
    const restoredSessions = await target.getAll('sessions');
    expect(restoredSessions).toHaveLength(exported.sessions.length);
    for (const expected of exported.sessions) {
      const actual = restoredSessions.find(item => item.id === expected.id);
      expect(actual).toBeTruthy();
      if (expected.mode === 'table' || expected.mode === 'flashcard' || expected.mode === 'wrong') {
        expect(actual).toEqual({ ...expected, restoreToken: expect.any(String) });
      } else {
        expect(actual).toEqual(expected);
      }
    }
    expect(globalThis.localStorage.getItem('kanji-settings')).toBe('{"practiceSize":"20","feedback":"compact"}');
    expect(globalThis.localStorage.getItem('kanji-theme')).toBe('dark');
    source.close();
    target.close();
  });

  it('validates before writing, leaving the existing stores untouched', async () => {
    const name = fixtureName();
    const db = await openDatabase({ name });
    await db.add('kanji', record('old', '学', ['HỌC']));
    await db.add('sessions', { id: 'old-session', mode: 'legacy', active: false });
    await db.add('attempts', { id: 'old-attempt', note: 'keep' });
    const malformed = backup({ sessions: [{ ...session(), checks: 9 }] });
    await expect(restoreBackup(db, malformed)).rejects.toThrow();
    expect(await db.getAll('kanji')).toEqual([record('old', '学', ['HỌC'])]);
    expect(await db.getAll('sessions')).toEqual([{ id: 'old-session', mode: 'legacy', active: false }]);
    expect(await db.getAll('attempts')).toEqual([{ id: 'old-attempt', note: 'keep' }]);
    db.close();
  });

  it('rolls back the entire restore when a write fails after stores are cleared', async () => {
    const name = fixtureName();
    const db = await openDatabase({ name });
    await db.add('kanji', record('old', '学', ['HỌC']));
    await db.add('sessions', { id: 'old-session', mode: 'legacy', active: false, note: 'keep' });
    await db.add('attempts', { id: 'old-attempt', note: 'keep' });
    const before = {
      kanji: await db.getAll('kanji'),
      sessions: await db.getAll('sessions'),
      attempts: await db.getAll('attempts'),
    };

    const callOriginalTransaction = db.transaction.bind(db);
    let failPut = true;
    db.transaction = function wrappedTransaction(...args) {
      const transaction = callOriginalTransaction(...args);
      const originalObjectStore = transaction.objectStore.bind(transaction);
      transaction.objectStore = nameForStore => {
        const store = originalObjectStore(nameForStore);
        if (nameForStore === 'attempts' && failPut) {
          const originalPut = store.put.bind(store);
          store.put = value => {
            if (failPut) {
              failPut = false;
              // Attach a handler before forcing the enclosing transaction to
              // abort; fake-indexeddb reports the abort asynchronously.
              transaction.done.catch(() => {});
              return Promise.reject(new Error('simulated restore write failure'));
            }
            return originalPut(value);
          };
        }
        return store;
      };
      return transaction;
    };
    try {
      await expect(restoreBackup(db, backup({ kanji: [record()] }))).rejects.toThrow('simulated restore write failure');
    } finally {
      // Let idb's proxy restore its original method wrapper. Assigning the
      // captured wrapper as an own property loses the proxy's `this` mapping.
      delete db.transaction;
    }
    await expect(db.getAll('kanji')).resolves.toEqual(before.kanji);
    await expect(db.getAll('sessions')).resolves.toEqual(before.sessions);
    await expect(db.getAll('attempts')).resolves.toEqual(before.attempts);
    db.close();
  });

  it('fences stale saves when restoring a session with a colliding ID', async () => {
    const name = fixtureName();
    const db = await openDatabase({ name });
    await db.add('sessions', session('table-1', 4));
    const stale = session('table-1', 1);
    await restoreBackup(db, backup({ sessions: [stale] }));
    expect((await db.get('sessions', 'table-1')).revision).toBe(5);
    await expect(createTablePracticeRepository(db).save(stale, 1)).rejects.toBeInstanceOf(PracticeConflictError);
    db.close();
  });

  it('fences a stale save when reset then restore reintroduces the same session ID', async () => {
    const name = fixtureName();
    const db = await openDatabase({ name });
    const stale = session('table-restored', 1);
    await db.add('sessions', stale);
    await resetSessions(db);
    await restoreBackup(db, backup({ sessions: [stale] }));
    const restored = await db.get('sessions', stale.id);
    expect(restored.restoreToken).toEqual(expect.any(String));
    expect(restored.restoreToken).not.toBe(stale.restoreToken);
    await expect(createTablePracticeRepository(db).save(stale, 1)).rejects.toBeInstanceOf(PracticeConflictError);
    db.close();
  });

  it('resets sessions without deleting attempts, then resets history while preserving Kanji', async () => {
    const name = fixtureName();
    const db = await openDatabase({ name });
    await db.add('kanji', record());
    await db.add('sessions', session());
    await db.add('attempts', attempt());
    expect(await resetSessions(db)).toEqual({ sessions: 1 });
    expect(await db.getAll('sessions')).toEqual([]);
    expect(await db.getAll('attempts')).toHaveLength(1);
    await db.add('sessions', session('table-2'));
    expect(await resetHistory(db)).toEqual({ sessions: 1, attempts: 1 });
    expect(await db.getAll('sessions')).toEqual([]);
    expect(await db.getAll('attempts')).toEqual([]);
    expect(await db.getAll('kanji')).toEqual([record()]);
    db.close();
  });
});
