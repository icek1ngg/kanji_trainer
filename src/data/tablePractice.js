import {
  assertTableSession,
  createTableSession,
  InvalidTableSessionError,
  reconcileTableSession,
  TABLE_SESSION_MODE,
  TABLE_SESSION_SCHEMA_VERSION,
  UnsupportedTableSessionError,
} from '../domain/tableSession.js';
import { writePendingAttempts, ATTEMPTS_STORE } from './attemptHistory.js';
import { selectPracticeRecords } from '../domain/practicePreferences.js';

const SESSIONS_STORE = 'sessions';
const PRACTICE_STORES = [SESSIONS_STORE, ATTEMPTS_STORE];

export class PracticeConflictError extends Error {
  constructor(message = 'The table practice session changed in another tab.') {
    super(message);
    this.name = 'PracticeConflictError';
  }
}

function now() {
  return new Date().toISOString();
}

function abortAndThrow(transaction, error) {
  try { transaction.abort(); } catch { /* It may already be aborted. */ }
  return transaction.done.catch(() => {}).then(() => { throw error; });
}

function activeSession(sessions) {
  const active = sessions.filter(session => session?.active === true && session?.mode === TABLE_SESSION_MODE);
  if (active.length > 1) throw new InvalidTableSessionError('Multiple active practice sessions were found.');
  return active[0];
}

function validateActive(session) {
  if (!session || session.active !== true) throw new PracticeConflictError('The active practice session is no longer available.');
  assertTableSession(session);
  return session;
}

function ensureDb(db) {
  if (!db || typeof db.transaction !== 'function') throw new TypeError('An open IndexedDB database is required.');
}

function clonePending(attempts) {
  return Array.isArray(attempts) ? attempts.map(attempt => ({ ...attempt, requiredReadings: [...attempt.requiredReadings] })) : [];
}

function mergePending(...sources) {
  const seen = new Set();
  const merged = [];
  for (const source of sources) {
    for (const attempt of clonePending(source)) {
      if (seen.has(attempt.id)) continue;
      seen.add(attempt.id);
      merged.push(attempt);
    }
  }
  return merged;
}

/** Persistence for one resumable Table Practice session. */
export function createTablePracticeRepository(db) {
  ensureDb(db);

  return {
    async loadOrCreate(records, { size = 'all' } = {}) {
      const transaction = db.transaction(PRACTICE_STORES, 'readwrite');
      try {
        const sessionStore = transaction.objectStore(SESSIONS_STORE);
        const sessions = await sessionStore.getAll();
        const current = activeSession(sessions);
        if (current) {
          if (current.mode !== TABLE_SESSION_MODE || current.schemaVersion !== TABLE_SESSION_SCHEMA_VERSION) throw new UnsupportedTableSessionError();
          validateActive(current);
          const reconciled = reconcileTableSession(current, records);
          if (reconciled.changed || (Array.isArray(current.pendingAttempts) && current.pendingAttempts.length)) {
            const saved = {
              ...reconciled.session,
              revision: current.revision + 1,
              updatedAt: now(),
              items: reconciled.session.items.map(item => ({ ...item, hanViet: [...item.hanViet] })),
            };
            const committed = await writePendingAttempts(transaction, saved);
            assertTableSession(committed);
            await sessionStore.put(committed);
            await transaction.done;
            return committed;
          }
          await transaction.done;
          return reconciled.session;
        }
        const created = createTableSession(selectPracticeRecords(records, size));
        await sessionStore.add(created);
        await transaction.done;
        return created;
      } catch (error) {
        return abortAndThrow(transaction, error);
      }
    },

    async save(session, expectedRevision = session?.revision) {
      assertTableSession(session);
      if (!session.active) throw new PracticeConflictError('Only the active practice session can be saved.');
      if (typeof expectedRevision !== 'number' || !Number.isInteger(expectedRevision) || expectedRevision < 0) throw new TypeError('expectedRevision must be a non-negative integer.');
      if (session.revision !== expectedRevision) throw new PracticeConflictError();
      const transaction = db.transaction(PRACTICE_STORES, 'readwrite');
      try {
        const sessionStore = transaction.objectStore(SESSIONS_STORE);
        const current = await sessionStore.get(session.id);
        validateActive(current);
        if (current.revision !== expectedRevision || current.restoreToken !== session.restoreToken) throw new PracticeConflictError();
        const next = {
          ...session,
          active: true,
          revision: current.revision + 1,
          createdAt: current.createdAt,
          updatedAt: now(),
          items: session.items.map(item => ({ ...item, hanViet: [...item.hanViet] })),
        };
        const committed = await writePendingAttempts(transaction, next);
        assertTableSession(committed);
        await sessionStore.put(committed);
        await transaction.done;
        return committed;
      } catch (error) {
        return abortAndThrow(transaction, error);
      }
    },

    async startNew(records, expectedSession) {
      if (!expectedSession || typeof expectedSession !== 'object') throw new TypeError('expectedSession is required.');
      assertTableSession(expectedSession);
      if (!expectedSession.active) throw new PracticeConflictError('Only the active practice session can be reset.');
      const transaction = db.transaction(PRACTICE_STORES, 'readwrite');
      try {
        const sessionStore = transaction.objectStore(SESSIONS_STORE);
        const current = await sessionStore.get(expectedSession.id);
        validateActive(current);
        if (current.revision !== expectedSession.revision || current.restoreToken !== expectedSession.restoreToken) throw new PracticeConflictError();
        const pendingSession = {
          // The caller may have a checked answer that has not reached the
          // queued save yet.  Revision equality proves this snapshot still
          // targets the current row; archive that latest state together with
          // its pending events so counters and answers cannot diverge from
          // history when a reset happens immediately after a check.
          ...expectedSession,
          pendingAttempts: mergePending(current.pendingAttempts, expectedSession.pendingAttempts),
          createdAt: current.createdAt,
        };
        const drained = await writePendingAttempts(transaction, pendingSession);
        const archived = {
          ...drained,
          active: false,
          revision: current.revision + 1,
          updatedAt: now(),
          items: drained.items.map(item => ({ ...item, hanViet: [...item.hanViet] })),
        };
        assertTableSession(archived);
        await sessionStore.put(archived);
        const created = createTableSession(records);
        await sessionStore.add(created);
        await transaction.done;
        return created;
      } catch (error) {
        return abortAndThrow(transaction, error);
      }
    },

    /** List all persisted sessions, including archived and other practice modes. */
    async listSessions() {
      return db.getAll(SESSIONS_STORE);
    },
  };
}

export { InvalidTableSessionError, UnsupportedTableSessionError };
