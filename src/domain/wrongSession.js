import { normalizeKanjiRecord } from '../data/kanjiRepository.js';
import { validateAnswer } from './readings.js';

/**
 * State for the manually started wrong-answer practice mode.
 *
 * Wrong sessions intentionally mirror the small, serializable shape used by
 * Table Practice. They keep a Kanji snapshot so editing the library does not
 * silently change an unfinished retry, while a reconciliation on load still
 * removes deleted records and invalidates checks for edited readings.
 */
export const WRONG_SESSION_SCHEMA_VERSION = 1;
export const WRONG_SESSION_MODE = 'wrong';

export const WRONG_FILTERS = Object.freeze({
  ALL: 'all',
  CORRECT: 'correct',
  INCORRECT: 'incorrect',
  UNANSWERED: 'unanswered',
});

export class WrongSessionError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'WrongSessionError';
    this.details = details;
  }
}

export class InvalidRequiredReadingsError extends WrongSessionError {
  constructor(message = 'The Kanji has an invalid set of required readings.') {
    super(message);
    this.name = 'InvalidRequiredReadingsError';
  }
}

export class InvalidWrongSessionError extends WrongSessionError {
  constructor(message = 'The saved wrong-answer session is invalid.', details = {}) {
    super(message, details);
    this.name = 'InvalidWrongSessionError';
  }
}

export class UnsupportedWrongSessionError extends WrongSessionError {
  constructor(message = 'The saved practice session uses an unsupported schema.') {
    super(message);
    this.name = 'UnsupportedWrongSessionError';
  }
}

function makeId(prefix) {
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

function assertText(value, field) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new InvalidWrongSessionError(`${field} must be a non-empty string.`, { field });
  }
  return value;
}

function assertNumber(value, field) {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new InvalidWrongSessionError(`${field} must be a non-negative integer.`, { field });
  }
  return value;
}

function cloneItem(item) {
  return {
    id: item.id,
    kanji: item.kanji,
    hanViet: [...item.hanViet],
    answer: item.answer,
    checkedAnswer: item.checkedAnswer,
    result: item.result,
    revealed: item.revealed,
  };
}

function cloneAttempt(attempt) {
  return { ...attempt };
}

function cloneSession(session) {
  return {
    ...session,
    sourceSessionId: session.sourceSessionId ?? null,
    items: session.items.map(cloneItem),
    pendingAttempts: Array.isArray(session.pendingAttempts) ? session.pendingAttempts.map(cloneAttempt) : [],
  };
}

function validateItem(item, index) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    throw new InvalidWrongSessionError(`Item ${index + 1} is invalid.`);
  }
  assertText(item.id, `items[${index}].id`);
  assertText(item.kanji, `items[${index}].kanji`);
  if (!Array.isArray(item.hanViet) || item.hanViet.length === 0 || item.hanViet.some(value => typeof value !== 'string' || !value.trim())) {
    throw new InvalidWrongSessionError(`items[${index}].hanViet is invalid.`);
  }
  if (typeof item.answer !== 'string' || (item.checkedAnswer !== null && typeof item.checkedAnswer !== 'string')) {
    throw new InvalidWrongSessionError(`items[${index}] answer fields are invalid.`);
  }
  if ((item.result === null) !== (item.checkedAnswer === null)) {
    throw new InvalidWrongSessionError(`items[${index}] checked result fields are inconsistent.`);
  }
  if (item.result !== null && typeof item.result !== 'boolean') {
    throw new InvalidWrongSessionError(`items[${index}].result is invalid.`);
  }
  if (typeof item.revealed !== 'boolean') throw new InvalidWrongSessionError(`items[${index}].revealed is invalid.`);
}

function validatePendingAttempt(attempt, index, sessionId) {
  if (!attempt || typeof attempt !== 'object' || Array.isArray(attempt)) {
    throw new InvalidWrongSessionError(`pendingAttempts[${index}] is invalid.`);
  }
  assertText(attempt.id, `pendingAttempts[${index}].id`);
  if (attempt.sessionId !== sessionId) throw new InvalidWrongSessionError(`pendingAttempts[${index}].sessionId is invalid.`);
  if (attempt.mode !== WRONG_SESSION_MODE) throw new InvalidWrongSessionError(`pendingAttempts[${index}].mode is invalid.`);
  assertText(attempt.kanjiId, `pendingAttempts[${index}].kanjiId`);
  assertText(attempt.kanji, `pendingAttempts[${index}].kanji`);
  if (!Array.isArray(attempt.requiredReadings) || attempt.requiredReadings.length === 0
      || attempt.requiredReadings.some(reading => typeof reading !== 'string' || !reading.trim())) {
    throw new InvalidWrongSessionError(`pendingAttempts[${index}].requiredReadings is invalid.`);
  }
  if (typeof attempt.submittedAnswer !== 'string') throw new InvalidWrongSessionError(`pendingAttempts[${index}].submittedAnswer is invalid.`);
  if (typeof attempt.isCorrect !== 'boolean') throw new InvalidWrongSessionError(`pendingAttempts[${index}].isCorrect is invalid.`);
  assertNumber(attempt.requiredCount, `pendingAttempts[${index}].requiredCount`);
  assertText(attempt.createdAt, `pendingAttempts[${index}].createdAt`);
  if (Number.isNaN(Date.parse(attempt.createdAt))) throw new InvalidWrongSessionError(`pendingAttempts[${index}].createdAt is invalid.`);
}

/** Validate a persisted wrong-answer session without mutating it. */
export function assertWrongSession(session) {
  if (!session || typeof session !== 'object' || Array.isArray(session)) throw new InvalidWrongSessionError();
  if (session.mode !== WRONG_SESSION_MODE || session.schemaVersion !== WRONG_SESSION_SCHEMA_VERSION) {
    throw new UnsupportedWrongSessionError();
  }
  assertText(session.id, 'id');
  if (typeof session.active !== 'boolean') throw new InvalidWrongSessionError('active must be boolean.');
  assertNumber(session.revision, 'revision');
  assertText(session.scope ?? 'all', 'scope');
  if (session.sourceSessionId !== undefined && session.sourceSessionId !== null) assertText(session.sourceSessionId, 'sourceSessionId');
  assertText(session.createdAt, 'createdAt');
  assertText(session.updatedAt, 'updatedAt');
  if (Number.isNaN(Date.parse(session.createdAt)) || Number.isNaN(Date.parse(session.updatedAt))) throw new InvalidWrongSessionError('Session timestamps are invalid.');
  if (!Array.isArray(session.items)) throw new InvalidWrongSessionError('items must be an array.');
  const ids = new Set();
  session.items.forEach((item, index) => {
    validateItem(item, index);
    if (ids.has(item.id)) throw new InvalidWrongSessionError(`Duplicate session item ID '${item.id}'.`);
    ids.add(item.id);
  });
  assertNumber(session.checks, 'checks');
  assertNumber(session.correctChecks, 'correctChecks');
  assertNumber(session.incorrectChecks, 'incorrectChecks');
  if (session.correctChecks + session.incorrectChecks !== session.checks) throw new InvalidWrongSessionError('Session check totals are inconsistent.');
  const pendingAttempts = session.pendingAttempts ?? [];
  if (!Array.isArray(pendingAttempts)) throw new InvalidWrongSessionError('pendingAttempts must be an array.');
  const attemptIds = new Set();
  pendingAttempts.forEach((attempt, index) => {
    validatePendingAttempt(attempt, index, session.id);
    if (attemptIds.has(attempt.id)) throw new InvalidWrongSessionError(`Duplicate pending attempt ID '${attempt.id}'.`);
    attemptIds.add(attempt.id);
  });
  return session;
}

function normalizeRecords(records) {
  if (!Array.isArray(records)) throw new TypeError('records must be an array.');
  const ids = new Set();
  return records.map((record, index) => {
    let normalized;
    try { normalized = normalizeKanjiRecord(record); } catch (error) { throw new InvalidWrongSessionError(`Kanji record ${index + 1} is invalid.`, { cause: error }); }
    if (ids.has(normalized.id)) throw new InvalidWrongSessionError(`Duplicate Kanji record ID '${normalized.id}'.`);
    ids.add(normalized.id);
    return normalized;
  });
}

function shuffle(records, random) {
  if (typeof random !== 'function') throw new TypeError('random must be a function.');
  const result = [...records];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const value = Number(random());
    const unit = Number.isFinite(value) ? Math.min(Math.max(value, 0), 0.999999999) : 0;
    const swapIndex = Math.floor(unit * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

/** Create a manual wrong-answer session from the current wrong list. */
export function createWrongSession(records, {
  id = makeId('wrong'),
  now,
  random = Math.random,
  scope = 'all',
  sourceSessionId = null,
} = {}) {
  const normalizedRecords = normalizeRecords(records);
  const stamp = timestamp(now);
  const session = {
    id: assertText(id, 'id'),
    mode: WRONG_SESSION_MODE,
    schemaVersion: WRONG_SESSION_SCHEMA_VERSION,
    active: true,
    revision: 0,
    scope: assertText(scope, 'scope'),
    sourceSessionId: sourceSessionId == null ? null : assertText(sourceSessionId, 'sourceSessionId'),
    createdAt: stamp,
    updatedAt: stamp,
    items: shuffle(normalizedRecords, random).map(record => ({
      id: record.id,
      kanji: record.kanji,
      hanViet: [...record.hanViet],
      answer: '',
      checkedAnswer: null,
      result: null,
      revealed: false,
    })),
    checks: 0,
    correctChecks: 0,
    incorrectChecks: 0,
    pendingAttempts: [],
  };
  assertWrongSession(session);
  return session;
}

/** Refresh an active session against the current library without adding new records. */
export function reconcileWrongSession(session, records, { now } = {}) {
  assertWrongSession(session);
  const normalizedRecords = normalizeRecords(records);
  const byId = new Map(normalizedRecords.map(record => [record.id, record]));
  const items = [];
  let changed = false;
  for (const item of session.items) {
    const record = byId.get(item.id);
    if (!record) { changed = true; continue; }
    const readingsChanged = item.kanji !== record.kanji
      || item.hanViet.length !== record.hanViet.length
      || item.hanViet.some((reading, index) => reading !== record.hanViet[index]);
    if (!readingsChanged) { items.push(cloneItem(item)); continue; }
    changed = true;
    items.push({ ...cloneItem(item), kanji: record.kanji, hanViet: [...record.hanViet], checkedAnswer: null, result: null, revealed: false });
  }
  if (!changed) return { session: cloneSession(session), changed: false };
  const next = cloneSession({ ...session, items, updatedAt: timestamp(now) });
  assertWrongSession(next);
  return { session: next, changed: true };
}

function itemIndex(session, id) {
  assertWrongSession(session);
  const index = session.items.findIndex(item => item.id === id);
  if (index < 0) throw new WrongSessionError(`Kanji item '${id}' was not found.`, { id });
  return index;
}

export function setWrongAnswer(session, id, answer) {
  if (typeof answer !== 'string') throw new TypeError('answer must be a string.');
  const index = itemIndex(session, id);
  const next = cloneSession(session);
  next.items[index].answer = answer;
  return next;
}

export function getWrongStatus(item) {
  if (!item || item.result === null || item.result === undefined || item.checkedAnswer === null || item.checkedAnswer !== item.answer) return WRONG_FILTERS.UNANSWERED;
  return item.result ? WRONG_FILTERS.CORRECT : WRONG_FILTERS.INCORRECT;
}

/** Validate one item after an explicit check and queue one immutable history event. */
export function checkWrongAnswer(session, id, { now } = {}) {
  const index = itemIndex(session, id);
  const current = session.items[index];
  const validation = validateAnswer(current.answer, current.hanViet);
  if (validation.reason === 'invalid_required_readings') throw new InvalidRequiredReadingsError();
  if (current.checkedAnswer === current.answer && current.result !== null) return cloneSession(session);
  const next = cloneSession(session);
  const item = next.items[index];
  item.checkedAnswer = item.answer;
  item.result = validation.isCorrect;
  next.checks += 1;
  if (validation.isCorrect) next.correctChecks += 1;
  else next.incorrectChecks += 1;
  const createdAt = timestamp(now);
  const attemptId = `${next.id}:attempt:${next.checks}`;
  next.pendingAttempts.push({
    id: attemptId,
    sessionId: next.id,
    mode: WRONG_SESSION_MODE,
    scope: next.scope,
    kanjiId: item.id,
    kanji: item.kanji,
    requiredReadings: [...item.hanViet],
    requiredCount: item.hanViet.length,
    submittedAnswer: item.answer,
    isCorrect: validation.isCorrect,
    createdAt,
  });
  assertWrongSession(next);
  return next;
}

export function toggleWrongReveal(session, id) {
  const index = itemIndex(session, id);
  const next = cloneSession(session);
  next.items[index].revealed = !next.items[index].revealed;
  return next;
}

export function shuffleWrongSession(session, random = Math.random) {
  assertWrongSession(session);
  const next = cloneSession(session);
  next.items = shuffle(next.items, random);
  return next;
}

export function getWrongItems(session, filter = WRONG_FILTERS.ALL) {
  assertWrongSession(session);
  if (!Object.values(WRONG_FILTERS).includes(filter)) throw new TypeError(`Unknown wrong-answer filter '${filter}'.`);
  return session.items.filter(item => filter === WRONG_FILTERS.ALL || getWrongStatus(item) === filter).map(cloneItem);
}

export function getWrongStats(session) {
  assertWrongSession(session);
  const statuses = session.items.map(getWrongStatus);
  const total = statuses.length;
  const correct = statuses.filter(status => status === WRONG_FILTERS.CORRECT).length;
  const incorrect = statuses.filter(status => status === WRONG_FILTERS.INCORRECT).length;
  const checked = correct + incorrect;
  return {
    total,
    correct,
    incorrect,
    unanswered: total - checked,
    checked,
    remaining: incorrect + (total - checked),
    progress: total ? Math.round((checked / total) * 100) : 0,
    checks: session.checks,
    correctChecks: session.correctChecks,
    incorrectChecks: session.incorrectChecks,
    accuracy: checked ? Math.round((correct / checked) * 100) : 0,
    completed: total > 0 && checked === total,
  };
}

/** Return records still needing a correct answer for a retry. */
export function getWrongRetryRecords(session) {
  assertWrongSession(session);
  return session.items
    .filter(item => getWrongStatus(item) !== WRONG_FILTERS.CORRECT)
    .map(item => ({ id: item.id, kanji: item.kanji, hanViet: [...item.hanViet] }));
}

export function getRemainingWrongCount(session) {
  return getWrongStats(session).remaining;
}

export { cloneItem, cloneSession };
