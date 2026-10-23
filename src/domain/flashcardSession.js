import { normalizeKanjiRecord } from '../data/kanjiRepository.js';
import { validateAnswer } from './readings.js';
import {
  appendPracticeAttempt,
  assertPracticeAttempt,
  cloneAttempt,
} from './history.js';

export const FLASHCARD_SESSION_SCHEMA_VERSION = 1;
export const FLASHCARD_SESSION_MODE = 'flashcard';
export const FLASHCARD_SIZES = Object.freeze(['all', 10, 20, 50, 100]);
export const FLASHCARD_ORDERS = Object.freeze(['sequential', 'random']);

export class FlashcardSessionError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'FlashcardSessionError';
    this.details = details;
  }
}

export class InvalidRequiredReadingsError extends FlashcardSessionError {
  constructor(message = 'The Kanji has an invalid set of required readings.') {
    super(message);
    this.name = 'InvalidRequiredReadingsError';
  }
}

export class InvalidFlashcardSessionError extends FlashcardSessionError {
  constructor(message = 'The saved flashcard practice session is invalid.', details = {}) {
    super(message, details);
    this.name = 'InvalidFlashcardSessionError';
  }
}

export class UnsupportedFlashcardSessionError extends FlashcardSessionError {
  constructor(message = 'The saved practice session uses an unsupported schema.') {
    super(message);
    this.name = 'UnsupportedFlashcardSessionError';
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
    throw new InvalidFlashcardSessionError(`${field} must be a non-empty string.`, { field });
  }
  return value;
}

function assertNumber(value, field, { integer = true } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value) || (integer && !Number.isInteger(value)) || value < 0) {
    throw new InvalidFlashcardSessionError(`${field} must be a non-negative number.`, { field });
  }
  return value;
}

function isValidSize(value) {
  return value === 'all' || (typeof value === 'number' && [10, 20, 50, 100].includes(value));
}

function isValidOrder(value) {
  return value === 'sequential' || value === 'random';
}

function validateItem(item, index) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    throw new InvalidFlashcardSessionError(`Item ${index + 1} is invalid.`);
  }
  assertText(item.id, `items[${index}].id`);
  assertText(item.kanji, `items[${index}].kanji`);
  if (!Array.isArray(item.hanViet) || item.hanViet.length === 0 || item.hanViet.some(value => typeof value !== 'string' || !value.trim())) {
    throw new InvalidFlashcardSessionError(`items[${index}].hanViet is invalid.`);
  }
  if (typeof item.answer !== 'string' || (item.checkedAnswer !== null && typeof item.checkedAnswer !== 'string')) {
    throw new InvalidFlashcardSessionError(`items[${index}] answer fields are invalid.`);
  }
  if ((item.result === null) !== (item.checkedAnswer === null)) {
    throw new InvalidFlashcardSessionError(`items[${index}] checked result fields are inconsistent.`);
  }
  if (item.result !== null && typeof item.result !== 'boolean') {
    throw new InvalidFlashcardSessionError(`items[${index}].result is invalid.`);
  }
  if (typeof item.revealed !== 'boolean') throw new InvalidFlashcardSessionError(`items[${index}].revealed is invalid.`);
  return item;
}

/** Validate a persisted flashcard session without repairing or resetting it. */
export function assertFlashcardSession(session) {
  if (!session || typeof session !== 'object' || Array.isArray(session)) throw new InvalidFlashcardSessionError();
  if (session.mode !== FLASHCARD_SESSION_MODE || session.schemaVersion !== FLASHCARD_SESSION_SCHEMA_VERSION) {
    throw new UnsupportedFlashcardSessionError();
  }
  assertText(session.id, 'id');
  if (typeof session.active !== 'boolean') throw new InvalidFlashcardSessionError('active must be boolean.');
  assertNumber(session.revision, 'revision');
  assertNumber(session.position, 'position');
  if (!isValidSize(session.size)) throw new InvalidFlashcardSessionError('size is invalid.');
  if (!isValidOrder(session.order)) throw new InvalidFlashcardSessionError('order is invalid.');
  assertText(session.createdAt, 'createdAt');
  assertText(session.updatedAt, 'updatedAt');
  if (Number.isNaN(Date.parse(session.createdAt)) || Number.isNaN(Date.parse(session.updatedAt))) throw new InvalidFlashcardSessionError('Session timestamps are invalid.');
  if (!Array.isArray(session.items)) throw new InvalidFlashcardSessionError('items must be an array.');
  if (session.items.length === 0 && session.position !== 0) throw new InvalidFlashcardSessionError('position must be zero for an empty session.');
  if (session.items.length > 0 && session.position >= session.items.length) throw new InvalidFlashcardSessionError('position is outside the session.');
  const ids = new Set();
  session.items.forEach((item, index) => {
    validateItem(item, index);
    if (ids.has(item.id)) throw new InvalidFlashcardSessionError(`Duplicate session item ID '${item.id}'.`);
    ids.add(item.id);
  });
  assertNumber(session.checks, 'checks');
  assertNumber(session.correctChecks, 'correctChecks');
  assertNumber(session.incorrectChecks, 'incorrectChecks');
  if (session.correctChecks + session.incorrectChecks !== session.checks) throw new InvalidFlashcardSessionError('Session check totals are inconsistent.');
  if (session.pendingAttempts !== undefined) {
    if (!Array.isArray(session.pendingAttempts)) throw new InvalidFlashcardSessionError('pendingAttempts must be an array.');
    for (const attempt of session.pendingAttempts) {
      try { assertPracticeAttempt(attempt); } catch (error) {
        throw new InvalidFlashcardSessionError('pendingAttempts contains an invalid attempt.', { cause: error });
      }
      if (attempt.mode !== FLASHCARD_SESSION_MODE || attempt.sessionId !== session.id) {
        throw new InvalidFlashcardSessionError('pendingAttempts contains an attempt for another session or mode.');
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
    try { normalized = normalizeKanjiRecord(record); } catch (error) { throw new InvalidFlashcardSessionError(`Kanji record ${index + 1} is invalid.`, { cause: error }); }
    if (ids.has(normalized.id)) throw new InvalidFlashcardSessionError(`Duplicate Kanji record ID '${normalized.id}'.`);
    ids.add(normalized.id);
    return normalized;
  });
}

function normalizeSize(value) {
  if (value === 'all') return value;
  const numeric = typeof value === 'string' && /^(?:10|20|50|100)$/u.test(value) ? Number(value) : value;
  if (!isValidSize(numeric)) throw new TypeError('size must be one of all, 10, 20, 50, or 100.');
  return numeric;
}

function normalizeOrder(value) {
  if (!isValidOrder(value)) throw new TypeError("order must be 'sequential' or 'random'.");
  return value;
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

function selectRecords(records, size, order, random) {
  const ordered = order === 'random' ? shuffle(records, random) : [...records];
  return size === 'all' ? ordered : ordered.slice(0, Math.min(size, ordered.length));
}

/** Create a flashcard session snapshot from the current library records. */
export function createFlashcardSession(records, {
  size = 'all',
  order = 'sequential',
  id = makeId('flashcard'),
  now,
  random = Math.random,
} = {}) {
  const normalizedRecords = normalizeRecords(records);
  const selectedSize = normalizeSize(size);
  const selectedOrder = normalizeOrder(order);
  const stamp = timestamp(now);
  const session = {
    id: assertText(id, 'id'),
    mode: FLASHCARD_SESSION_MODE,
    schemaVersion: FLASHCARD_SESSION_SCHEMA_VERSION,
    active: true,
    revision: 0,
    position: 0,
    size: selectedSize,
    order: selectedOrder,
    createdAt: stamp,
    updatedAt: stamp,
    items: selectRecords(normalizedRecords, selectedSize, selectedOrder, random).map(record => ({
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
  assertFlashcardSession(session);
  return session;
}

/**
 * Refresh a session against current library data. Existing order and drafts
 * remain stable, deleted records disappear, and new records wait for a new
 * session. The current card follows its id when earlier cards are removed.
 */
export function reconcileFlashcardSession(session, records, { now } = {}) {
  assertFlashcardSession(session);
  const normalizedRecords = normalizeRecords(records);
  const byId = new Map(normalizedRecords.map(record => [record.id, record]));
  const currentId = session.items[session.position]?.id;
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

  const nextPosition = items.length === 0
    ? 0
    : (currentId && items.some(item => item.id === currentId)
      ? items.findIndex(item => item.id === currentId)
      : Math.min(session.position, items.length - 1));
  if (nextPosition !== session.position) changed = true;
  if (!changed) return { session: cloneSession(session), changed: false };

  const next = cloneSession({ ...session, items, position: nextPosition, updatedAt: timestamp(now) });
  assertFlashcardSession(next);
  return { session: next, changed: true };
}

function itemIndex(session, id) {
  assertFlashcardSession(session);
  const index = session.items.findIndex(item => item.id === id);
  if (index < 0) throw new FlashcardSessionError(`Kanji item '${id}' was not found.`, { id });
  return index;
}

/** Update a draft answer without changing the last checked result. */
export function setFlashcardAnswer(session, id, answer) {
  if (typeof answer !== 'string') throw new TypeError('answer must be a string.');
  const index = itemIndex(session, id);
  const next = cloneSession(session);
  next.items[index].answer = answer;
  return next;
}

/** Return the live status of a card's current draft. */
export function getFlashcardStatus(item) {
  if (!item || item.result === null || item.result === undefined || item.checkedAnswer === null || item.checkedAnswer !== item.answer) return 'unanswered';
  return item.result ? 'correct' : 'incorrect';
}

/** Validate one card only after an explicit check action. */
export function checkFlashcardAnswer(session, id, { now, attemptId } = {}) {
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

export function toggleFlashcardReveal(session, id) {
  const index = itemIndex(session, id);
  const next = cloneSession(session);
  next.items[index].revealed = !next.items[index].revealed;
  return next;
}

/** Move to a card index, clamping to the available range. */
export function moveFlashcard(session, position) {
  assertFlashcardSession(session);
  if (typeof position !== 'number' || !Number.isFinite(position) || !Number.isInteger(position)) throw new TypeError('position must be an integer.');
  const next = cloneSession(session);
  next.position = next.items.length === 0 ? 0 : Math.min(Math.max(position, 0), next.items.length - 1);
  return next;
}

export function getFlashcardStats(session) {
  assertFlashcardSession(session);
  const statuses = session.items.map(getFlashcardStatus);
  const total = statuses.length;
  const correct = statuses.filter(status => status === 'correct').length;
  const incorrect = statuses.filter(status => status === 'incorrect').length;
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
    completed: total > 0 && checked === total,
  };
}

export function getFlashcardRetryRecords(session) {
  assertFlashcardSession(session);
  return session.items
    .filter(item => getFlashcardStatus(item) === 'incorrect')
    .map(item => ({ id: item.id, kanji: item.kanji, hanViet: [...item.hanViet] }));
}

export function getFlashcardItems(session) {
  assertFlashcardSession(session);
  return session.items.map(cloneItem);
}

export { cloneItem, cloneSession };
