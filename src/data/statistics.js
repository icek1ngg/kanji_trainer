import { STORE_NAMES } from './database.js';

const SNAPSHOT_STORES = Object.freeze([
  STORE_NAMES.KANJI,
  STORE_NAMES.ATTEMPTS,
  STORE_NAMES.SESSIONS,
]);

function ensureDb(db) {
  if (!db || typeof db.transaction !== 'function') {
    throw new TypeError('An open IndexedDB database is required.');
  }
}

function cloneRecord(record) {
  if (!record || typeof record !== 'object') return record;
  return {
    ...record,
    ...(Array.isArray(record.hanViet) ? { hanViet: [...record.hanViet] } : {}),
  };
}

function cloneAttempt(attempt) {
  if (!attempt || typeof attempt !== 'object') return attempt;
  return {
    ...attempt,
    ...(Array.isArray(attempt.requiredReadings) ? { requiredReadings: [...attempt.requiredReadings] } : {}),
  };
}

function cloneSession(session) {
  if (!session || typeof session !== 'object') return session;
  return {
    ...session,
    ...(Array.isArray(session.items)
      ? { items: session.items.map(item => ({
        ...item,
        ...(Array.isArray(item?.hanViet) ? { hanViet: [...item.hanViet] } : {}),
      })) }
      : {}),
    ...(Array.isArray(session.pendingAttempts)
      ? { pendingAttempts: session.pendingAttempts.map(cloneAttempt) }
      : {}),
  };
}

/**
 * Read the three stores in one readonly IndexedDB transaction.
 *
 * The transaction is intentionally kept open until all requests complete so
 * the dashboard never combines records from different database revisions.
 * Returned values are cloned before leaving the repository and may be safely
 * passed to pure selectors or mutated by a caller without touching IndexedDB.
 */
export async function readStatisticsSnapshot(db) {
  ensureDb(db);
  const transaction = db.transaction(SNAPSHOT_STORES, 'readonly');
  const recordsRequest = transaction.objectStore(STORE_NAMES.KANJI).getAll();
  const attemptsRequest = transaction.objectStore(STORE_NAMES.ATTEMPTS).getAll();
  const sessionsRequest = transaction.objectStore(STORE_NAMES.SESSIONS).getAll();
  const [records, attempts, sessions] = await Promise.all([
    recordsRequest,
    attemptsRequest,
    sessionsRequest,
  ]);
  await transaction.done;
  return {
    records: records.map(cloneRecord),
    attempts: attempts.map(cloneAttempt),
    sessions: sessions.map(cloneSession),
  };
}

/** Small read-only repository used by dashboard/statistics pages. */
export function createStatisticsRepository(db) {
  ensureDb(db);
  return {
    read() {
      return readStatisticsSnapshot(db);
    },
  };
}

export { SNAPSHOT_STORES };

