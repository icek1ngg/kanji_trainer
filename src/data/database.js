import { openDB } from 'idb';

export const DB_NAME = 'kanji-trainer';
export const DB_VERSION = 2;

export const STORE_NAMES = Object.freeze({
  KANJI: 'kanji',
  SESSIONS: 'sessions',
  ATTEMPTS: 'attempts',
});

const INDEX_NAMES = Object.freeze({
  KANJI_BY_VALUE: 'by-kanji',
  SESSION_BY_CREATED: 'by-created-at',
  SESSION_BY_UPDATED: 'by-updated-at',
  ATTEMPT_BY_KANJI: 'by-kanji-id',
  ATTEMPT_BY_SESSION: 'by-session-id',
  ATTEMPT_BY_CREATED: 'by-created-at',
});

function migrate(db, oldVersion) {
  // Every migration is additive. Existing object stores and records are never
  // replaced, which keeps upgrades safe for users with a populated database.
  if (oldVersion < 1) {
    const kanji = db.createObjectStore(STORE_NAMES.KANJI, { keyPath: 'id' });
    kanji.createIndex(INDEX_NAMES.KANJI_BY_VALUE, 'kanji', { unique: true });
  }

  if (oldVersion < 2) {
    const sessions = db.createObjectStore(STORE_NAMES.SESSIONS, { keyPath: 'id' });
    sessions.createIndex(INDEX_NAMES.SESSION_BY_CREATED, 'createdAt');
    sessions.createIndex(INDEX_NAMES.SESSION_BY_UPDATED, 'updatedAt');

    const attempts = db.createObjectStore(STORE_NAMES.ATTEMPTS, { keyPath: 'id' });
    attempts.createIndex(INDEX_NAMES.ATTEMPT_BY_KANJI, 'kanjiId');
    attempts.createIndex(INDEX_NAMES.ATTEMPT_BY_SESSION, 'sessionId');
    attempts.createIndex(INDEX_NAMES.ATTEMPT_BY_CREATED, 'createdAt');
  }
}

/**
 * Open the local database. Passing a custom name is useful for isolated tests
 * and does not change the production database name.
 */
export function openDatabase({
  name = DB_NAME,
  onBlocked,
  onBlocking,
  onTerminated,
} = {}) {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('IndexedDB is not available in this browser.'));
  }

  let connection;
  // The application owns one schema version. Callers cannot accidentally
  // open an unsupported future version without a corresponding migration.
  const opening = openDB(name, DB_VERSION, {
    upgrade(db, oldVersion) {
      migrate(db, oldVersion);
    },
    blocked(currentVersion, blockedVersion) {
      onBlocked?.({ currentVersion, blockedVersion });
    },
    blocking(currentVersion, blockedVersion) {
      // A stale tab must release its connection so a newer schema can finish
      // upgrading. The optional callback is still notified for UI messaging.
      connection?.close();
      onBlocking?.({ currentVersion, blockedVersion });
    },
    terminated(error) {
      onTerminated?.(error);
    },
  });
  return opening.then(db => {
    connection = db;
    return db;
  });
}

export { INDEX_NAMES };
