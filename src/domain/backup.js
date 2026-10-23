import { normalizeKanjiRecord } from '../data/kanjiRepository.js';
import {
  assertPracticeAttempt,
  PRACTICE_MODES,
} from './history.js';
import { validateAnswer } from './readings.js';
import { assertTableSession, TABLE_SESSION_MODE, TABLE_SESSION_SCHEMA_VERSION } from './tableSession.js';
import { assertFlashcardSession, FLASHCARD_SESSION_MODE, FLASHCARD_SESSION_SCHEMA_VERSION } from './flashcardSession.js';
import { assertWrongSession, WRONG_SESSION_MODE, WRONG_SESSION_SCHEMA_VERSION } from './wrongSession.js';

export const BACKUP_FORMAT = 'kanji-trainer';
export const BACKUP_VERSION = 1;
export const BACKUP_THEMES = Object.freeze(['light', 'dark']);
export const BACKUP_PRACTICE_SIZES = Object.freeze(['all', '10', '20', '50', '100']);
export const BACKUP_FEEDBACK_MODES = Object.freeze(['detailed', 'compact']);

/** A malformed or unsupported backup should never reach IndexedDB. */
export class BackupValidationError extends Error {
  constructor(message = 'The backup file is invalid.', details = {}) {
    super(message);
    this.name = 'BackupValidationError';
    this.details = details;
  }
}

function fail(message, details = {}) {
  throw new BackupValidationError(message, details);
}

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function clone(value) {
  try {
    if (typeof globalThis.structuredClone === 'function') return globalThis.structuredClone(value);
    return JSON.parse(JSON.stringify(value));
  } catch (error) {
    fail('Backup data cannot be cloned safely.', { cause: error });
  }
}

function requireText(value, field) {
  if (typeof value !== 'string' || !value.trim()) fail(`${field} must be a non-empty string.`, { field });
  return value;
}

function requireArray(value, field) {
  if (!Array.isArray(value)) fail(`${field} must be an array.`, { field });
  return value;
}

function requireTimestamp(value, field) {
  requireText(value, field);
  if (Number.isNaN(Date.parse(value))) fail(`${field} must be a valid timestamp.`, { field });
  return value;
}

function validateSettings(value) {
  if (!isRecord(value)) fail('settings must be an object.', { field: 'settings' });
  const { practiceSize, feedback, theme } = value;
  if (!BACKUP_PRACTICE_SIZES.includes(practiceSize)) {
    fail('settings.practiceSize is invalid.', { field: 'settings.practiceSize' });
  }
  if (!BACKUP_FEEDBACK_MODES.includes(feedback)) {
    fail('settings.feedback is invalid.', { field: 'settings.feedback' });
  }
  if (!BACKUP_THEMES.includes(theme)) {
    fail('settings.theme is invalid.', { field: 'settings.theme' });
  }
  return { practiceSize, feedback, theme };
}

function uniqueIds(values, field) {
  const ids = new Set();
  values.forEach((value, index) => {
    if (!isRecord(value)) fail(`${field}[${index}] must be an object.`, { field: `${field}[${index}]` });
    requireText(value.id, `${field}[${index}].id`);
    if (ids.has(value.id)) fail(`${field} contains duplicate id '${value.id}'.`, { field, id: value.id });
    ids.add(value.id);
  });
  return ids;
}

function validateKanji(values) {
  requireArray(values, 'kanji');
  const ids = new Set();
  const characters = new Set();
  return values.map((value, index) => {
    if (!isRecord(value)) fail(`kanji[${index}] must be an object.`, { field: `kanji[${index}]` });
    let normalized;
    try {
      normalized = normalizeKanjiRecord(value);
    } catch (error) {
      fail(`kanji[${index}] is invalid.`, { field: `kanji[${index}]`, cause: error });
    }
    if (ids.has(normalized.id)) fail(`kanji contains duplicate id '${normalized.id}'.`, { field: 'kanji', id: normalized.id });
    if (characters.has(normalized.kanji)) fail(`kanji contains duplicate character '${normalized.kanji}'.`, { field: 'kanji', kanji: normalized.kanji });
    ids.add(normalized.id);
    characters.add(normalized.kanji);
    // Keep canonical metadata and any values accepted by normalizeKanjiRecord.
    // Existing records only contain these fields, and retaining the clone means
    // callers never receive a reference into the supplied backup object.
    return clone(normalized);
  });
}

function validatePendingAttemptIds(session, index) {
  if (!Array.isArray(session.pendingAttempts)) return;
  const ids = new Set();
  session.pendingAttempts.forEach((attempt, pendingIndex) => {
    if (!isRecord(attempt) || typeof attempt.id !== 'string' || !attempt.id.trim()) {
      fail(`sessions[${index}].pendingAttempts[${pendingIndex}] has an invalid id.`, {
        field: `sessions[${index}].pendingAttempts[${pendingIndex}].id`,
      });
    }
    if (ids.has(attempt.id)) {
      fail(`sessions[${index}].pendingAttempts contains duplicate id '${attempt.id}'.`, {
        field: `sessions[${index}].pendingAttempts`, id: attempt.id,
      });
    }
    ids.add(attempt.id);
  });
}

function validateSession(session, index) {
  if (!isRecord(session)) fail(`sessions[${index}] must be an object.`, { field: `sessions[${index}]` });
  const mode = session.mode;
  const hasSchemaVersion = Object.prototype.hasOwnProperty.call(session, 'schemaVersion');
  const isLegacyInactive = !hasSchemaVersion && session.active === false;
  // Rows from before individual history may have no mode (or an application
  // specific mode). Preserve them exactly so a backup remains lossless. A
  // current mode with the current schema, however, must pass its complete
  // validator before restore. Early phases also left inactive mode-labelled
  // summary rows without schemaVersion; those are legitimate legacy data and
  // must remain restorable. An active row without a schema is unsafe to resume.
  try {
    if (mode === TABLE_SESSION_MODE && !isLegacyInactive) {
      if (session.schemaVersion !== TABLE_SESSION_SCHEMA_VERSION) throw new Error('unsupported schema');
      assertTableSession(session);
      validatePendingAttemptIds(session, index);
    } else if (mode === FLASHCARD_SESSION_MODE && !isLegacyInactive) {
      if (session.schemaVersion !== FLASHCARD_SESSION_SCHEMA_VERSION) throw new Error('unsupported schema');
      assertFlashcardSession(session);
      validatePendingAttemptIds(session, index);
    } else if (mode === WRONG_SESSION_MODE && !isLegacyInactive) {
      if (session.schemaVersion !== WRONG_SESSION_SCHEMA_VERSION) throw new Error('unsupported schema');
      assertWrongSession(session);
      validatePendingAttemptIds(session, index);
    }
  } catch (error) {
    // A row that explicitly claims a supported practice mode is current data;
    // silently accepting it would let a later resume write corrupted state.
    fail(`sessions[${index}] is invalid.`, { field: `sessions[${index}]`, cause: error });
  }
  return clone(session);
}

function validateAttempts(values) {
  requireArray(values, 'attempts');
  const ids = uniqueIds(values, 'attempts');
  return values.map((value, index) => {
    const mode = value.mode;
    // Unknown/legacy rows are intentionally retained. Recognized individual
    // history rows must satisfy the shared immutable-event validator.
    if (PRACTICE_MODES.includes(mode)) {
      validateRecognizedAttempt(value, `attempts[${index}]`);
    }
    // uniqueIds has already required an IndexedDB-safe key, and this keeps all
    // unknown legacy fields untouched in the returned clone.
    void ids;
    return clone(value);
  });
}

function sameAttemptPayload(left, right) {
  return left?.sessionId === right?.sessionId
    && left?.kanjiId === right?.kanjiId
    && left?.kanji === right?.kanji
    && left?.submittedAnswer === right?.submittedAnswer
    && left?.isCorrect === right?.isCorrect
    && left?.mode === right?.mode
    && left?.createdAt === right?.createdAt
    && JSON.stringify(left?.requiredReadings) === JSON.stringify(right?.requiredReadings);
}

function validateRecognizedAttempt(attempt, field) {
  try {
    assertPracticeAttempt(attempt);
    const validation = validateAnswer(attempt.submittedAnswer, attempt.requiredReadings);
    if (validation.reason === 'invalid_required_readings' || validation.isCorrect !== attempt.isCorrect) {
      fail(`${field} has an incorrect validation result.`, { field });
    }
  } catch (error) {
    if (error instanceof BackupValidationError) throw error;
    fail(`${field} is invalid.`, { field, cause: error });
  }
}

function validatePendingIntegrity(sessions, attempts) {
  const committedById = new Map(attempts.map(attempt => [attempt.id, attempt]));
  const pendingById = new Map();
  sessions.forEach((session, sessionIndex) => {
    if (!Array.isArray(session.pendingAttempts)) return;
    session.pendingAttempts.forEach((pending, pendingIndex) => {
      const field = `sessions[${sessionIndex}].pendingAttempts[${pendingIndex}]`;
      if (PRACTICE_MODES.includes(pending.mode)) validateRecognizedAttempt(pending, field);
      const previousPending = pendingById.get(pending.id);
      if (previousPending && !sameAttemptPayload(previousPending, pending)) {
        fail(`Pending attempt '${pending.id}' is duplicated with different data.`, { field, id: pending.id });
      }
      pendingById.set(pending.id, pending);
      const committed = committedById.get(pending.id);
      if (committed && !sameAttemptPayload(committed, pending)) {
        fail(`Pending attempt '${pending.id}' conflicts with committed history.`, { field, id: pending.id });
      }
    });
  });
}

function validateActiveSessionUniqueness(sessions) {
  for (const mode of [TABLE_SESSION_MODE, FLASHCARD_SESSION_MODE, WRONG_SESSION_MODE]) {
    const active = sessions.filter(session => session.mode === mode && session.schemaVersion !== undefined && session.active === true);
    if (active.length > 1) {
      fail(`sessions contains multiple active '${mode}' sessions.`, { field: 'sessions', mode });
    }
  }
}

/**
 * Validate a versioned backup without writing anything. The returned value is
 * detached from the input and safe to pass to restoreBackup.
 */
export function validateBackup(value) {
  if (!isRecord(value)) fail('Backup must be an object.');
  if (value.format !== BACKUP_FORMAT) fail(`Unsupported backup format '${value.format ?? ''}'.`, { field: 'format' });
  if (value.version !== BACKUP_VERSION) fail(`Unsupported backup version '${value.version ?? ''}'.`, { field: 'version' });
  requireTimestamp(value.exportedAt, 'exportedAt');
  const kanji = validateKanji(value.kanji);
  const sessionsInput = requireArray(value.sessions, 'sessions');
  const sessionIds = uniqueIds(sessionsInput, 'sessions');
  const sessions = sessionsInput.map(validateSession);
  validateActiveSessionUniqueness(sessions);
  const attempts = validateAttempts(value.attempts);
  validatePendingIntegrity(sessions, attempts);
  // Keep the cross-store IDs independent (each IndexedDB store has its own
  // key path). A missing session reference is allowed for deleted/legacy data;
  // history must never disappear just because its archived session is absent.
  void sessionIds;
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: value.exportedAt,
    kanji,
    sessions,
    attempts,
    settings: validateSettings(value.settings),
  };
}

export { clone as cloneBackupValue };
