/**
 * Immutable practice-attempt records shared by every practice mode.
 *
 * Attempt records are deliberately kept independent from the session's live
 * counters.  A session carries new records in `pendingAttempts` until its
 * next atomic persistence transaction drains them into the attempts store.
 */

export const PRACTICE_MODES = Object.freeze(['table', 'flashcard', 'wrong']);

export class PracticeAttemptError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'PracticeAttemptError';
    this.details = details;
  }
}

export class InvalidPracticeAttemptError extends PracticeAttemptError {
  constructor(message = 'The practice attempt is invalid.', details = {}) {
    super(message, details);
    this.name = 'InvalidPracticeAttemptError';
  }
}

function makeId(prefix = 'attempt') {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function timestamp(value) {
  const result = typeof value === 'function' ? value() : value ?? new Date().toISOString();
  if (typeof result !== 'string' || !result.trim() || Number.isNaN(Date.parse(result))) {
    throw new TypeError('now must return an ISO timestamp.');
  }
  return result;
}

function text(value, field) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new InvalidPracticeAttemptError(`${field} must be a non-empty string.`, { field });
  }
  return value;
}

function cloneAttempt(attempt) {
  return {
    ...attempt,
    requiredReadings: [...attempt.requiredReadings],
  };
}

/** Validate a newly-created or persisted attempt without changing it. */
export function assertPracticeAttempt(attempt) {
  if (!attempt || typeof attempt !== 'object' || Array.isArray(attempt)) {
    throw new InvalidPracticeAttemptError();
  }
  text(attempt.id, 'id');
  text(attempt.sessionId, 'sessionId');
  text(attempt.kanjiId, 'kanjiId');
  text(attempt.kanji, 'kanji');
  if (!Array.isArray(attempt.requiredReadings) || attempt.requiredReadings.length === 0
      || attempt.requiredReadings.some(reading => typeof reading !== 'string' || !reading.trim())) {
    throw new InvalidPracticeAttemptError('requiredReadings must be a non-empty array of strings.', { field: 'requiredReadings' });
  }
  if (typeof attempt.submittedAnswer !== 'string') {
    throw new InvalidPracticeAttemptError('submittedAnswer must be a string.', { field: 'submittedAnswer' });
  }
  if (typeof attempt.isCorrect !== 'boolean') {
    throw new InvalidPracticeAttemptError('isCorrect must be boolean.', { field: 'isCorrect' });
  }
  if (!PRACTICE_MODES.includes(attempt.mode)) {
    throw new InvalidPracticeAttemptError(`mode must be one of ${PRACTICE_MODES.join(', ')}.`, { field: 'mode' });
  }
  text(attempt.createdAt, 'createdAt');
  if (Number.isNaN(Date.parse(attempt.createdAt))) {
    throw new InvalidPracticeAttemptError('createdAt must be a valid ISO timestamp.', { field: 'createdAt' });
  }
  if (attempt.checkedAt !== undefined) {
    text(attempt.checkedAt, 'checkedAt');
    if (Number.isNaN(Date.parse(attempt.checkedAt))) {
      throw new InvalidPracticeAttemptError('checkedAt must be a valid ISO timestamp.', { field: 'checkedAt' });
    }
  }
  if (attempt.sequence !== undefined
      && (typeof attempt.sequence !== 'number' || !Number.isSafeInteger(attempt.sequence) || attempt.sequence < 0)) {
    throw new InvalidPracticeAttemptError('sequence must be a non-negative safe integer.', { field: 'sequence' });
  }
  return attempt;
}

/**
 * Build an immutable pending attempt from the exact item snapshot that was
 * checked.  `mode` may be overridden by the wrong-answer practice flow.
 */
export function createPracticeAttempt({ session, item, isCorrect, mode, now, id } = {}) {
  if (!session || typeof session !== 'object') throw new TypeError('session is required.');
  if (!item || typeof item !== 'object') throw new TypeError('item is required.');
  if (typeof isCorrect !== 'boolean') throw new TypeError('isCorrect must be boolean.');
  const attempt = {
    id: text(id ?? makeId(), 'id'),
    sessionId: text(session.id, 'sessionId'),
    kanjiId: text(item.id, 'kanjiId'),
    kanji: text(item.kanji, 'kanji'),
    requiredReadings: Array.isArray(item.hanViet) ? [...item.hanViet] : [],
    submittedAnswer: typeof item.answer === 'string' ? item.answer : '',
    isCorrect,
    createdAt: timestamp(now),
    mode: mode ?? session.mode,
  };
  assertPracticeAttempt(attempt);
  return attempt;
}

/** Append a pending attempt while preserving all previous pending records. */
export function appendPracticeAttempt(session, item, isCorrect, options = {}) {
  const attempt = createPracticeAttempt({ session, item, isCorrect, ...options });
  const pending = Array.isArray(session.pendingAttempts) ? session.pendingAttempts : [];
  const nextPending = pending.some(existing => existing?.id === attempt.id)
    ? pending.map(cloneAttempt)
    : [...pending.map(cloneAttempt), attempt];
  return { ...session, pendingAttempts: nextPending };
}

function recognizedAttempt(attempt) {
  try {
    assertPracticeAttempt(attempt);
    return true;
  } catch {
    // The attempts store predates individual history and can contain legacy
    // aggregate or application-specific rows.  Selectors ignore those rows.
    return false;
  }
}

function timeValue(value) {
  const parsed = Date.parse(value ?? '');
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

function sequenceValue(attempt) {
  return Number.isSafeInteger(attempt.sequence) && attempt.sequence >= 0 ? attempt.sequence : null;
}

/** Compare two recognized attempts from oldest to newest deterministically. */
export function compareAttempts(left, right) {
  const leftSequence = sequenceValue(left);
  const rightSequence = sequenceValue(right);
  if (leftSequence !== null || rightSequence !== null) {
    if (leftSequence === null) return -1;
    if (rightSequence === null) return 1;
    if (leftSequence !== rightSequence) return leftSequence - rightSequence;
  }
  const checked = timeValue(left.checkedAt) - timeValue(right.checkedAt);
  if (checked) return checked;
  const created = timeValue(left.createdAt) - timeValue(right.createdAt);
  if (created) return created;
  return String(left.id).localeCompare(String(right.id));
}

function inScope(attempt, sessionId) {
  return sessionId === undefined || sessionId === null || sessionId === 'all' || attempt.sessionId === sessionId;
}

/** Return the most recent recognized attempt for each Kanji in the scope. */
export function getLatestAttempts(attempts, { sessionId = 'all' } = {}) {
  if (!Array.isArray(attempts)) throw new TypeError('attempts must be an array.');
  const latest = new Map();
  for (const candidate of attempts) {
    if (!recognizedAttempt(candidate) || !inScope(candidate, sessionId)) continue;
    const current = latest.get(candidate.kanjiId);
    if (!current || compareAttempts(current, candidate) < 0) latest.set(candidate.kanjiId, candidate);
  }
  return [...latest.values()].sort(compareAttempts).map(cloneAttempt);
}

/**
 * Join latest incorrect attempts to live library records. Deleted Kanji are
 * intentionally omitted; no history row can resurrect a removed record.
 */
export function getWrongKanji(attempts, records, { sessionId = 'all' } = {}) {
  if (!Array.isArray(records)) throw new TypeError('records must be an array.');
  const latest = new Map(getLatestAttempts(attempts, { sessionId }).map(attempt => [attempt.kanjiId, attempt]));
  return records
    .filter(record => record && typeof record.id === 'string')
    .map(record => {
      const latestAttempt = latest.get(record.id);
      if (!latestAttempt || latestAttempt.isCorrect) return null;
      return { ...record, hanViet: Array.isArray(record.hanViet) ? [...record.hanViet] : record.hanViet, latestAttempt };
    })
    .filter(Boolean);
}

export { cloneAttempt };

