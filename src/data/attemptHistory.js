import {
  assertPracticeAttempt,
  cloneAttempt,
  compareAttempts,
  getLatestAttempts,
  InvalidPracticeAttemptError,
} from '../domain/history.js';
import { validateAnswer } from '../domain/readings.js';

const ATTEMPTS_STORE = 'attempts';
const SESSIONS_STORE = 'sessions';

function ensureDb(db) {
  if (!db || typeof db.transaction !== 'function' || typeof db.getAll !== 'function') {
    throw new TypeError('An open IndexedDB database is required.');
  }
}

function getObjectStore(transaction, name) {
  if (!transaction) {
    throw new TypeError('A multi-store IndexedDB transaction is required.');
  }
  if (typeof transaction.objectStore === 'function') return transaction.objectStore(name);
  if (name === ATTEMPTS_STORE && transaction.store) return transaction.store;
  throw new TypeError('A multi-store IndexedDB transaction is required.');
}

function now() {
  return new Date().toISOString();
}

function samePayload(left, right) {
  return left.sessionId === right.sessionId
    && left.kanjiId === right.kanjiId
    && left.kanji === right.kanji
    && left.submittedAnswer === right.submittedAnswer
    && left.isCorrect === right.isCorrect
    && left.mode === right.mode
    && left.createdAt === right.createdAt
    && JSON.stringify(left.requiredReadings) === JSON.stringify(right.requiredReadings);
}

/**
 * Atomically drain pending attempts into the attempts store.
 *
 * The helper never mutates the supplied session.  It returns a session copy
 * with an empty pending queue so callers can put that copy into the sessions
 * store in the same readwrite transaction.  Existing IDs are retained as the
 * source of truth, making queued retries idempotent.
 */
export async function writePendingAttempts(transaction, session, { checkedAt = now() } = {}) {
  if (!session || typeof session !== 'object') throw new TypeError('session is required.');
  const pending = Array.isArray(session.pendingAttempts) ? session.pendingAttempts : [];
  const store = getObjectStore(transaction, ATTEMPTS_STORE);
  if (!pending.length) return { ...session, pendingAttempts: [] };

  for (const candidate of pending) {
    assertPracticeAttempt(candidate);
    if (candidate.sessionId !== session.id || candidate.mode !== session.mode) {
      throw new InvalidPracticeAttemptError('A pending practice attempt belongs to another session or mode.');
    }
    const validation = validateAnswer(candidate.submittedAnswer, candidate.requiredReadings);
    if (validation.reason === 'invalid_required_readings') {
      throw new InvalidPracticeAttemptError('A pending practice attempt has invalid required readings.');
    }
    if (validation.isCorrect !== candidate.isCorrect) {
      throw new InvalidPracticeAttemptError('A pending practice attempt has an incorrect validation result.');
    }
  }

  const existing = await store.getAll();
  const existingIds = new Set(existing.map(attempt => attempt?.id).filter(id => typeof id === 'string'));
  const existingById = new Map(existing.filter(attempt => typeof attempt?.id === 'string').map(attempt => [attempt.id, attempt]));
  let nextSequence = existing.reduce((maximum, attempt) => {
    const value = attempt?.sequence;
    return Number.isSafeInteger(value) && value >= 0 ? Math.max(maximum, value) : maximum;
  }, -1) + 1;
  const pendingIds = new Map();
  // Resolve every duplicate before issuing the first add request.  This
  // keeps the helper safe even when a caller elects to finish the transaction
  // after catching an error; repository callers still wrap it atomically.
  for (const candidate of pending) {
    if (existingIds.has(candidate.id)) {
      if (!samePayload(existingById.get(candidate.id), candidate)) throw new InvalidPracticeAttemptError(`Attempt '${candidate.id}' already exists with different data.`);
      continue;
    }
    if (pendingIds.has(candidate.id)) {
      if (!samePayload(pendingIds.get(candidate.id), candidate)) throw new InvalidPracticeAttemptError(`Pending attempt '${candidate.id}' is duplicated with different data.`);
      continue;
    }
    pendingIds.set(candidate.id, candidate);
  }
  pendingIds.clear();
  for (const candidate of pending) {
    if (existingIds.has(candidate.id) || pendingIds.has(candidate.id)) continue;
    const committed = {
      ...cloneAttempt(candidate),
      sequence: nextSequence,
      checkedAt,
    };
    // Add a unique key only after validating the complete event.  Any
    // IndexedDB error aborts the caller's encompassing transaction.
    await store.add(committed);
    pendingIds.set(candidate.id, candidate);
    nextSequence += 1;
  }
  return { ...session, pendingAttempts: [] };
}

/** List persisted individual attempts, optionally scoped to one session. */
export async function listAttemptHistory(db, { sessionId = 'all' } = {}) {
  ensureDb(db);
  const attempts = await db.getAll(ATTEMPTS_STORE);
  const result = attempts
    .filter(attempt => sessionId === 'all' || sessionId === undefined || sessionId === null || attempt?.sessionId === sessionId)
    .map(attempt => ({ ...attempt, ...(Array.isArray(attempt?.requiredReadings) ? { requiredReadings: [...attempt.requiredReadings] } : {}) }));
  return result.sort((left, right) => {
    const leftValid = (() => { try { assertPracticeAttempt(left); return true; } catch { return false; } })();
    const rightValid = (() => { try { assertPracticeAttempt(right); return true; } catch { return false; } })();
    if (leftValid && rightValid) return compareAttempts(left, right);
    if (leftValid) return -1;
    if (rightValid) return 1;
    return String(left?.id ?? '').localeCompare(String(right?.id ?? ''));
  });
}

/**
 * Small read-only history service.  The optional scope is useful for a
 * practice-session results view while the default exposes all history.
 */
export function createAttemptHistoryRepository(db, { sessionId = 'all' } = {}) {
  ensureDb(db);
  return {
    list() {
      return listAttemptHistory(db, { sessionId });
    },
    async listSessions() {
      const sessions = await db.getAll(SESSIONS_STORE);
      if (sessionId === 'all' || sessionId === undefined || sessionId === null) return sessions;
      return sessions.filter(session => session?.id === sessionId);
    },
    async latest() {
      return getLatestAttempts(await listAttemptHistory(db, { sessionId }), { sessionId });
    },
  };
}

export { ATTEMPTS_STORE, SESSIONS_STORE };
export { getLatestAttempts, getWrongKanji, createPracticeAttempt, appendPracticeAttempt } from '../domain/history.js';

