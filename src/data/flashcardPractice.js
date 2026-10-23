import {
  assertFlashcardSession,
  createFlashcardSession,
  FLASHCARD_SESSION_MODE,
  FLASHCARD_SESSION_SCHEMA_VERSION,
  InvalidFlashcardSessionError,
  reconcileFlashcardSession,
  UnsupportedFlashcardSessionError,
} from '../domain/flashcardSession.js';
import { writePendingAttempts, ATTEMPTS_STORE } from './attemptHistory.js';
import { readPreferences } from './preferences.js';

const SESSIONS_STORE = 'sessions';
const PRACTICE_STORES = [SESSIONS_STORE, ATTEMPTS_STORE];

export class FlashcardConflictError extends Error {
  constructor(message = 'The flashcard practice session changed in another tab.') {
    super(message);
    this.name = 'FlashcardConflictError';
  }
}

function now() {
  return new Date().toISOString();
}

function cloneItems(items) {
  return items.map(item => ({ ...item, hanViet: [...item.hanViet] }));
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

function abortAndThrow(transaction, error) {
  try { transaction.abort(); } catch { /* It may already be aborted. */ }
  return transaction.done.catch(() => {}).then(() => { throw error; });
}

function activeSession(sessions) {
  const active = sessions.filter(session => session?.active === true && session?.mode === FLASHCARD_SESSION_MODE);
  if (active.length > 1) throw new InvalidFlashcardSessionError('Multiple active flashcard sessions were found.');
  return active[0];
}

function validateActive(session) {
  if (!session || session.active !== true) throw new FlashcardConflictError('The active flashcard practice session is no longer available.');
  assertFlashcardSession(session);
  return session;
}

function ensureDb(db) {
  if (!db || typeof db.transaction !== 'function') throw new TypeError('An open IndexedDB database is required.');
}

/** Persistence for one resumable Flashcard Practice session. */
export function createFlashcardPracticeRepository(db) {
  ensureDb(db);

  return {
    async loadOrCreate(records, options = {}) {
      const transaction = db.transaction(PRACTICE_STORES, 'readwrite');
      try {
        const sessionStore = transaction.objectStore(SESSIONS_STORE);
        const sessions = await sessionStore.getAll();
        const current = activeSession(sessions);
        if (current) {
          if (current.mode !== FLASHCARD_SESSION_MODE || current.schemaVersion !== FLASHCARD_SESSION_SCHEMA_VERSION) throw new UnsupportedFlashcardSessionError();
          validateActive(current);
          const reconciled = reconcileFlashcardSession(current, records);
          if (reconciled.changed || (Array.isArray(current.pendingAttempts) && current.pendingAttempts.length)) {
            const saved = {
              ...reconciled.session,
              revision: current.revision + 1,
              updatedAt: now(),
              items: cloneItems(reconciled.session.items),
            };
            const committed = await writePendingAttempts(transaction, saved);
            assertFlashcardSession(committed);
            await sessionStore.put(committed);
            await transaction.done;
            return committed;
          }
          await transaction.done;
          return reconciled.session;
        }
        const created = { ...createFlashcardSession(records, options), defaultPracticeSize: readPreferences().practiceSize };
        await sessionStore.add(created);
        await transaction.done;
        return created;
      } catch (error) {
        return abortAndThrow(transaction, error);
      }
    },

    async save(session, expectedRevision = session?.revision) {
      assertFlashcardSession(session);
      if (!session.active) throw new FlashcardConflictError('Only the active flashcard practice session can be saved.');
      if (typeof expectedRevision !== 'number' || !Number.isInteger(expectedRevision) || expectedRevision < 0) throw new TypeError('expectedRevision must be a non-negative integer.');
      if (session.revision !== expectedRevision) throw new FlashcardConflictError();
      const transaction = db.transaction(PRACTICE_STORES, 'readwrite');
      try {
        const sessionStore = transaction.objectStore(SESSIONS_STORE);
        const current = await sessionStore.get(session.id);
        validateActive(current);
        if (current.revision !== expectedRevision || current.restoreToken !== session.restoreToken) throw new FlashcardConflictError();
        const next = {
          ...session,
          active: true,
          revision: current.revision + 1,
          createdAt: current.createdAt,
          updatedAt: now(),
          items: cloneItems(session.items),
        };
        const committed = await writePendingAttempts(transaction, next);
        assertFlashcardSession(committed);
        await sessionStore.put(committed);
        await transaction.done;
        return committed;
      } catch (error) {
        return abortAndThrow(transaction, error);
      }
    },

    async startNew(records, expectedSession, options = {}) {
      if (!expectedSession || typeof expectedSession !== 'object') throw new TypeError('expectedSession is required.');
      assertFlashcardSession(expectedSession);
      if (!expectedSession.active) throw new FlashcardConflictError('Only the active flashcard practice session can be reset.');
      const transaction = db.transaction(PRACTICE_STORES, 'readwrite');
      try {
        const sessionStore = transaction.objectStore(SESSIONS_STORE);
        const current = await sessionStore.get(expectedSession.id);
        validateActive(current);
        if (current.revision !== expectedSession.revision || current.restoreToken !== expectedSession.restoreToken) throw new FlashcardConflictError();
        const pendingSession = {
          // Revision equality means this is still the active row, while the
          // supplied snapshot may contain a check not flushed by the save
          // queue yet.  Archive that latest state with its pending events.
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
          items: cloneItems(drained.items),
        };
        assertFlashcardSession(archived);
        await sessionStore.put(archived);
        const created = createFlashcardSession(records, {
          size: expectedSession.size,
          order: expectedSession.order,
          ...options,
        });
        created.defaultPracticeSize = readPreferences().practiceSize;
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

export { InvalidFlashcardSessionError, UnsupportedFlashcardSessionError };
