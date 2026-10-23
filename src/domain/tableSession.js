import { normalizeKanjiRecord } from '../data/kanjiRepository.js';
import { validateAnswer } from './readings.js';
import {
  appendPracticeAttempt,
  assertPracticeAttempt,
  cloneAttempt,
} from './history.js';

export const TABLE_SESSION_SCHEMA_VERSION = 1;
export const TABLE_SESSION_MODE = 'table';

export const TABLE_FILTERS = Object.freeze({
  ALL: 'all',
  CORRECT: 'correct',
  INCORRECT: 'incorrect',
  UNANSWERED: 'unanswered',
});

export class TableSessionError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'TableSessionError';
    this.details = details;
  }
}

export class InvalidRequiredReadingsError extends TableSessionError {
  constructor(message = 'The Kanji has an invalid set of required readings.') {
    super(message);
    this.name = 'InvalidRequiredReadingsError';
  }
}

export class InvalidTableSessionError extends TableSessionError {
  constructor(message = 'The saved table practice session is invalid.') {
    super(message);
    this.name = 'InvalidTableSessionError';
  }
}

export class UnsupportedTableSessionError extends TableSessionError {
  constructor(message = 'The saved practice session uses an unsupported schema.') {
    super(message);
    this.name = 'UnsupportedTableSessionError';
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

function cloneSession(session) {
  return {
    ...session,
    items: session.items.map(cloneItem),
    ...(Array.isArray(session.pendingAttempts)
      ? { pendingAttempts: session.pendingAttempts.map(cloneAttempt) }
      : {}),
  };
}

function assertText(value, field) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new InvalidTableSessionError(`${field} must be a non-empty string.`, { field });
  }
  return value;
}

function assertNumber(value, field, { integer = true } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value) || (integer && !Number.isInteger(value)) || value < 0) {
    throw new InvalidTableSessionError(`${field} must be a non-negative number.`, { field });
  }
  return value;
}

function validateItem(item, index) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    throw new InvalidTableSessionError(`Item ${index + 1} is invalid.`);
  }
  assertText(item.id, `items[${index}].id`);
  assertText(item.kanji, `items[${index}].kanji`);
  if (!Array.isArray(item.hanViet) || item.hanViet.length === 0 || item.hanViet.some(value => typeof value !== 'string' || !value.trim())) {
    throw new InvalidTableSessionError(`items[${index}].hanViet is invalid.`);
  }
  if (typeof item.answer !== 'string' || item.checkedAnswer !== null && typeof item.checkedAnswer !== 'string') {
    throw new InvalidTableSessionError(`items[${index}] answer fields are invalid.`);
  }
  if ((item.result === null) !== (item.checkedAnswer === null)) {
    throw new InvalidTableSessionError(`items[${index}] checked result fields are inconsistent.`);
  }
  if (item.result !== null && typeof item.result !== 'boolean') {
    throw new InvalidTableSessionError(`items[${index}].result is invalid.`);
  }
  if (typeof item.revealed !== 'boolean') throw new InvalidTableSessionError(`items[${index}].revealed is invalid.`);
  return item;
}

/** Validate a persisted session without repairing or resetting it. */
export function assertTableSession(session) {
  if (!session || typeof session !== 'object' || Array.isArray(session)) throw new InvalidTableSessionError();
  if (session.mode !== TABLE_SESSION_MODE || session.schemaVersion !== TABLE_SESSION_SCHEMA_VERSION) {
    throw new UnsupportedTableSessionError();
  }
  assertText(session.id, 'id');
  if (typeof session.active !== 'boolean') throw new InvalidTableSessionError('active must be boolean.');
  assertNumber(session.revision, 'revision');
  assertText(session.createdAt, 'createdAt');
  assertText(session.updatedAt, 'updatedAt');
  if (Number.isNaN(Date.parse(session.createdAt)) || Number.isNaN(Date.parse(session.updatedAt))) throw new InvalidTableSessionError('Session timestamps are invalid.');
  if (!Array.isArray(session.items)) throw new InvalidTableSessionError('items must be an array.');
  const ids = new Set();
  session.items.forEach((item, index) => {
    validateItem(item, index);
    if (ids.has(item.id)) throw new InvalidTableSessionError(`Duplicate session item ID '${item.id}'.`);
    ids.add(item.id);
  });
  assertNumber(session.checks, 'checks');
  assertNumber(session.correctChecks, 'correctChecks');
  assertNumber(session.incorrectChecks, 'incorrectChecks');
  if (session.correctChecks + session.incorrectChecks !== session.checks) throw new InvalidTableSessionError('Session check totals are inconsistent.');
  if (session.pendingAttempts !== undefined) {
    if (!Array.isArray(session.pendingAttempts)) throw new InvalidTableSessionError('pendingAttempts must be an array.');
    for (const attempt of session.pendingAttempts) {
      try { assertPracticeAttempt(attempt); } catch (error) {
        throw new InvalidTableSessionError('pendingAttempts contains an invalid attempt.', { cause: error });
      }
      if (attempt.mode !== TABLE_SESSION_MODE || attempt.sessionId !== session.id) {
        throw new InvalidTableSessionError('pendingAttempts contains an attempt for another session or mode.');
      }
    }
  }
  return session;
}

function normalizeRecords(records) {
  if (!Array.isArray(records)) throw new TypeError('records must be an array.');
  const ids = new Set();
  return records.map((record, index) => {
    let normalized;
    try { normalized = normalizeKanjiRecord(record); } catch (error) { throw new InvalidTableSessionError(`Kanji record ${index + 1} is invalid.`, { cause: error }); }
    if (ids.has(normalized.id)) throw new InvalidTableSessionError(`Duplicate Kanji record ID '${normalized.id}'.`);
    ids.add(normalized.id);
    return normalized;
  });
}

/** Create a local table session snapshot. Kanji edits do not alter its items. */
export function createTableSession(records, { id = makeId('table'), now } = {}) {
  const normalizedRecords = normalizeRecords(records);
  const stamp = timestamp(now);
  const session = {
    id: assertText(id, 'id'),
    mode: TABLE_SESSION_MODE,
    schemaVersion: TABLE_SESSION_SCHEMA_VERSION,
    active: true,
    revision: 0,
    createdAt: stamp,
    updatedAt: stamp,
    items: normalizedRecords.map(record => ({
      id: record.id,
      kanji: record.kanji,
      hanViet: [...record.hanViet],
      answer: '',
      checkedAnswer: null,
      result: null,
      revealed: false,
    })),
    pendingAttempts: [],
    checks: 0,
    correctChecks: 0,
    incorrectChecks: 0,
  };
  assertTableSession(session);
  return session;
}

/**
 * Refresh an active session's item snapshots against the current library.
 * Draft text and item order remain stable. A changed reading set invalidates
 * only that item's previous result; new library entries wait for a reset.
 */
export function reconcileTableSession(session, records, { now } = {}) {
  assertTableSession(session);
  const normalizedRecords = normalizeRecords(records);
  const byId = new Map(normalizedRecords.map(record => [record.id, record]));
  const items = [];
  let changed = false;
  for (const item of session.items) {
    const record = byId.get(item.id);
    if (!record) {
      changed = true;
      continue;
    }
    const readingsChanged = item.kanji !== record.kanji
      || item.hanViet.length !== record.hanViet.length
      || item.hanViet.some((reading, index) => reading !== record.hanViet[index]);
    if (!readingsChanged) {
      items.push(cloneItem(item));
      continue;
    }
    changed = true;
    items.push({
      ...cloneItem(item),
      kanji: record.kanji,
      hanViet: [...record.hanViet],
      checkedAnswer: null,
      result: null,
      revealed: false,
    });
  }
  if (!changed) return { session: cloneSession(session), changed: false };
  const next = cloneSession({ ...session, items, updatedAt: timestamp(now) });
  assertTableSession(next);
  return { session: next, changed: true };
}

function itemIndex(session, id) {
  assertTableSession(session);
  const index = session.items.findIndex(item => item.id === id);
  if (index < 0) throw new TableSessionError(`Kanji item '${id}' was not found.`, { id });
  return index;
}

/** Update a draft answer without changing the last checked result. */
export function setTableAnswer(session, id, answer) {
  if (typeof answer !== 'string') throw new TypeError('answer must be a string.');
  const index = itemIndex(session, id);
  const next = cloneSession(session);
  next.items[index].answer = answer;
  return next;
}

export function getItemStatus(item) {
  if (!item || item.result === null || item.result === undefined || item.checkedAnswer === null || item.checkedAnswer !== item.answer) return TABLE_FILTERS.UNANSWERED;
  return item.result ? TABLE_FILTERS.CORRECT : TABLE_FILTERS.INCORRECT;
}

/** Validate one item only after an explicit check action. */
export function checkTableAnswer(session, id, { now, attemptId } = {}) {
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
  return appendPracticeAttempt(next, item, validation.isCorrect, { now, id: attemptId });
}

export function toggleTableReveal(session, id) {
  const index = itemIndex(session, id);
  const next = cloneSession(session);
  next.items[index].revealed = !next.items[index].revealed;
  return next;
}

export function shuffleTableSession(session, random = Math.random) {
  assertTableSession(session);
  if (typeof random !== 'function') throw new TypeError('random must be a function.');
  const next = cloneSession(session);
  for (let i = next.items.length - 1; i > 0; i -= 1) {
    const value = Number(random());
    const unit = Number.isFinite(value) ? Math.min(Math.max(value, 0), 0.999999999) : 0;
    const j = Math.floor(unit * (i + 1));
    [next.items[i], next.items[j]] = [next.items[j], next.items[i]];
  }
  return next;
}

export function getTableStats(session) {
  assertTableSession(session);
  const statuses = session.items.map(getItemStatus);
  const total = statuses.length;
  const correct = statuses.filter(status => status === TABLE_FILTERS.CORRECT).length;
  const incorrect = statuses.filter(status => status === TABLE_FILTERS.INCORRECT).length;
  const checked = correct + incorrect;
  const unanswered = total - checked;
  return {
    total,
    correct,
    incorrect,
    unanswered,
    checked,
    progress: total ? Math.round((checked / total) * 100) : 0,
    checks: session.checks,
    correctChecks: session.correctChecks,
    incorrectChecks: session.incorrectChecks,
    accuracy: checked ? Math.round((correct / checked) * 100) : 0,
  };
}

export function getTableItems(session, filter = TABLE_FILTERS.ALL) {
  assertTableSession(session);
  if (!Object.values(TABLE_FILTERS).includes(filter)) throw new TypeError(`Unknown table filter '${filter}'.`);
  return session.items.filter(item => filter === TABLE_FILTERS.ALL || getItemStatus(item) === filter).map(cloneItem);
}

export function getRetryRecords(session) {
  return getTableItems(session, TABLE_FILTERS.INCORRECT).map(item => ({ id: item.id, kanji: item.kanji, hanViet: [...item.hanViet] }));
}

export { cloneItem, cloneSession };
