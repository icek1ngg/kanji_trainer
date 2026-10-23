import {
  assertWrongSession,
  createWrongSession,
  InvalidWrongSessionError,
  reconcileWrongSession,
  WRONG_SESSION_MODE,
  WRONG_SESSION_SCHEMA_VERSION,
  UnsupportedWrongSessionError,
} from '../domain/wrongSession.js';
import { writePendingAttempts } from './attemptHistory.js';

const SESSIONS_STORE = 'sessions';
const ATTEMPTS_STORE = 'attempts';

export class WrongPracticeConflictError extends Error {
  constructor(message = 'The wrong-answer practice session changed in another tab.') {
    super(message);
    this.name = 'WrongPracticeConflictError';
  }
}

function now() {
  return new Date().toISOString();
}

function ensureDb(db) {
  if (!db || typeof db.transaction !== 'function') throw new TypeError('An open IndexedDB database is required.');
}

function cloneItems(items) {
  return items.map(item => ({ ...item, hanViet: [...item.hanViet] }));
}

function cloneSession(session) {
  return {
    ...session,
    sourceSessionId: session.sourceSessionId ?? null,
    items: cloneItems(session.items),
    pendingAttempts: Array.isArray(session.pendingAttempts) ? session.pendingAttempts.map(attempt => ({ ...attempt, requiredReadings: [...attempt.requiredReadings] })) : [],
  };
}

function mergePendingAttempts(...sessions) {
  const merged = [];
  const ids = new Set();
  for (const session of sessions) {
    const pending = Array.isArray(session?.pendingAttempts) ? session.pendingAttempts : [];
    for (const attempt of pending) {
      if (!attempt || ids.has(attempt.id)) continue;
      ids.add(attempt.id);
      merged.push({ ...attempt, requiredReadings: [...attempt.requiredReadings] });
    }
  }
  return merged;
}

function abortAndThrow(transaction, error) {
  try { transaction.abort(); } catch { /* It may already be aborted. */ }
  return transaction.done.catch(() => {}).then(() => { throw error; });
}

function transactionStores(db) {
  return db.transaction([SESSIONS_STORE, ATTEMPTS_STORE], 'readwrite');
}

function store(transaction, name) {
  return transaction.objectStore(name);
}

function activeSession(sessions) {
  const active = sessions.filter(session => session?.active === true && session?.mode === WRONG_SESSION_MODE);
  if (active.length > 1) throw new InvalidWrongSessionError('Multiple active wrong-answer sessions were found.');
  return active[0];
}

function validateActive(session) {
  if (!session || session.active !== true) throw new WrongPracticeConflictError('The active wrong-answer session is no longer available.');
  assertWrongSession(session);
  return session;
}

function assertExpectedRevision(expectedSession, current) {
  if (!expectedSession || typeof expectedSession !== 'object') throw new TypeError('expectedSession is required.');
  assertWrongSession(expectedSession);
  if (!expectedSession.active) throw new WrongPracticeConflictError('Only the active wrong-answer session can be changed.');
  if (!current || current.id !== expectedSession.id || current.revision !== expectedSession.revision || current.restoreToken !== expectedSession.restoreToken) throw new WrongPracticeConflictError();
}

function committedSession(session, revision, pendingAttempts = session.pendingAttempts) {
  const committed = {
    ...session,
    active: true,
    revision,
    updatedAt: now(),
    items: cloneItems(session.items),
    pendingAttempts: Array.isArray(pendingAttempts)
      ? pendingAttempts.map(attempt => ({ ...attempt, requiredReadings: [...attempt.requiredReadings] }))
      : [],
  };
  assertWrongSession(committed);
  return committed;
}

/** Persistence for the manually initiated Wrong Answers session. */
export function createWrongPracticeRepository(db) {
  ensureDb(db);

  return {
    /** Return the active wrong session, or null when the user has not started one. */
    async loadActive(records) {
      const transaction = transactionStores(db);
      try {
        const sessions = await store(transaction, SESSIONS_STORE).getAll();
        const current = activeSession(sessions);
        if (!current) {
          await transaction.done;
          return null;
        }
        if (current.mode !== WRONG_SESSION_MODE || current.schemaVersion !== WRONG_SESSION_SCHEMA_VERSION) throw new UnsupportedWrongSessionError();
        validateActive(current);
        const reconciled = Array.isArray(records) ? reconcileWrongSession(current, records) : { session: cloneSession(current), changed: false };
        const needsCommit = reconciled.changed || (Array.isArray(current.pendingAttempts) && current.pendingAttempts.length > 0);
        if (!needsCommit) {
          await transaction.done;
          return reconciled.session;
        }
        const next = committedSession(reconciled.session, current.revision + 1);
        const drained = await writePendingAttempts(transaction, next);
        await store(transaction, SESSIONS_STORE).put(drained);
        await transaction.done;
        return drained;
      } catch (error) {
        return abortAndThrow(transaction, error);
      }
    },

    /** Save a draft/check and atomically append its pending attempt events. */
    async save(session, expectedRevision = session?.revision) {
      assertWrongSession(session);
      if (!session.active) throw new WrongPracticeConflictError('Only the active wrong-answer session can be saved.');
      if (typeof expectedRevision !== 'number' || !Number.isInteger(expectedRevision) || expectedRevision < 0) throw new TypeError('expectedRevision must be a non-negative integer.');
      if (session.revision !== expectedRevision) throw new WrongPracticeConflictError();
      const transaction = transactionStores(db);
      try {
        const current = await store(transaction, SESSIONS_STORE).get(session.id);
        validateActive(current);
        if (current.revision !== expectedRevision || current.restoreToken !== session.restoreToken) throw new WrongPracticeConflictError();
        const next = committedSession(session, current.revision + 1, session.pendingAttempts);
        const drained = await writePendingAttempts(transaction, next);
        await store(transaction, SESSIONS_STORE).put(drained);
        await transaction.done;
        return drained;
      } catch (error) {
        return abortAndThrow(transaction, error);
      }
    },

    /** Archive the previous wrong session and create a shuffled manual session atomically. */
    async startNew(records, expectedSession = null, options = {}) {
      if (!Array.isArray(records)) throw new TypeError('records must be an array.');
      const transaction = transactionStores(db);
      try {
        const sessionsStore = store(transaction, SESSIONS_STORE);
        const sessions = await sessionsStore.getAll();
        const current = activeSession(sessions);
        if (current) {
          assertExpectedRevision(expectedSession, current);
          validateActive(current);
          // The UI can request a reset immediately after a local check or
          // draft, before that snapshot has reached IndexedDB. Archive the
          // expected snapshot itself (while preserving the canonical
          // creation time) and merge any pending events from both copies.
          const archived = {
            ...cloneSession(expectedSession),
            active: false,
            revision: current.revision + 1,
            createdAt: current.createdAt,
            updatedAt: now(),
            pendingAttempts: mergePendingAttempts(current, expectedSession),
          };
          assertWrongSession(archived);
          const drained = await writePendingAttempts(transaction, archived);
          await sessionsStore.put(drained);
        } else if (expectedSession) {
          throw new WrongPracticeConflictError('The previous wrong-answer session is no longer available.');
        }
        const created = createWrongSession(records, options);
        await sessionsStore.add(created);
        await transaction.done;
        return created;
      } catch (error) {
        return abortAndThrow(transaction, error);
      }
    },

    async listSessions() {
      return db.getAll(SESSIONS_STORE);
    },
  };
}

export { InvalidWrongSessionError, UnsupportedWrongSessionError };

