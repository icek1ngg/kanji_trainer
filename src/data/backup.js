import { DB_NAME, STORE_NAMES, openDatabase } from './database.js';
import {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  BackupValidationError,
  cloneBackupValue,
  validateBackup,
} from '../domain/backup.js';
import {
  DEFAULT_PREFERENCES,
  readPreferences,
  savePreferences,
  validatePreferences,
} from './preferences.js';

const ALL_STORES = Object.freeze([
  STORE_NAMES.KANJI,
  STORE_NAMES.SESSIONS,
  STORE_NAMES.ATTEMPTS,
]);

const CURRENT_SESSION_MODES = new Set(['table', 'flashcard', 'wrong']);

function makeRestoreToken() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `restore-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function isCurrentSession(session) {
  return CURRENT_SESSION_MODES.has(session?.mode) && session?.schemaVersion === 1;
}

function ensureDb(db) {
  if (!db || typeof db.transaction !== 'function') {
    throw new TypeError('An open IndexedDB database is required.');
  }
}

function readTheme() {
  let stored;
  try { stored = globalThis.localStorage?.getItem('kanji-theme'); } catch { /* fall through */ }
  if (stored === 'light' || stored === 'dark') return stored;
  const datasetTheme = typeof document !== 'undefined' ? document.documentElement?.dataset?.theme : undefined;
  return datasetTheme === 'dark' ? 'dark' : 'light';
}

function exportSettings(settings) {
  const supplied = settings && typeof settings === 'object' ? settings : {};
  const preferences = validatePreferences({
    practiceSize: supplied.practiceSize ?? readPreferences().practiceSize ?? DEFAULT_PREFERENCES.practiceSize,
    feedback: supplied.feedback ?? readPreferences().feedback ?? DEFAULT_PREFERENCES.feedback,
  });
  const theme = supplied.theme ?? readTheme();
  if (theme !== 'light' && theme !== 'dark') {
    throw new BackupValidationError('settings.theme is invalid.', { field: 'settings.theme' });
  }
  return { ...preferences, theme };
}

async function readAll(db) {
  const transaction = db.transaction(ALL_STORES, 'readonly');
  const requests = ALL_STORES.map(name => transaction.objectStore(name).getAll());
  try {
    const [kanji, sessions, attempts] = await Promise.all(requests);
    await transaction.done;
    return { kanji, sessions, attempts };
  } catch (error) {
    try { transaction.abort(); } catch { /* already finished */ }
    try { await transaction.done; } catch { /* preserve original error */ }
    throw error;
  }
}

/** Read all three stores in one consistent readonly transaction. */
export async function exportBackup(db, settings) {
  ensureDb(db);
  const snapshot = await readAll(db);
  const candidate = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    ...snapshot,
    settings: exportSettings(settings),
  };
  // Validate the generated snapshot as a final guard against exporting a
  // malformed current session that could not be safely resumed after restore.
  return validateBackup(candidate);
}

async function abortAndThrow(transaction, error) {
  try { transaction.abort(); } catch { /* already aborted */ }
  try { await transaction.done; } catch { /* preserve original error */ }
  throw error;
}

function persistRestoredSettings(settings) {
  // IndexedDB and localStorage cannot share a transaction. The database write
  // is the authoritative atomic operation; settings are persisted immediately
  // after it succeeds and failures leave the restored data intact for retry.
  let preferencesPersisted = false;
  let themePersisted = false;
  try { savePreferences(settings); preferencesPersisted = true; } catch { /* unavailable storage is allowed */ }
  try {
    if (typeof globalThis.localStorage !== 'undefined') {
      globalThis.localStorage.setItem('kanji-theme', settings.theme);
      themePersisted = true;
    }
  } catch { /* theme remains usable */ }
  return preferencesPersisted && themePersisted;
}

/** Replace all app stores atomically after validating the entire backup. */
export async function restoreBackup(db, backup) {
  ensureDb(db);
  const validated = validateBackup(backup);
  const transaction = db.transaction(ALL_STORES, 'readwrite');
  let restoredSessions = validated.sessions;
  try {
    // Read the existing session revisions before clearing the stores. A tab
    // that still holds an old draft must not be able to save over a restored
    // session merely because the backup happened to contain the same revision.
    // Advancing a colliding revision fences that stale writer while leaving
    // every other session field and pending attempt untouched.
    const existingSessions = await transaction.objectStore(STORE_NAMES.SESSIONS).getAll();
    const existingRevisionById = new Map(existingSessions
      .filter(session => typeof session?.id === 'string' && Number.isSafeInteger(session?.revision) && session.revision >= 0)
      .map(session => [session.id, session.revision]));
    const sessions = validated.sessions.map(session => {
      const currentRevision = existingRevisionById.get(session.id);
      if (currentRevision === undefined || !Number.isSafeInteger(session.revision) || session.revision < 0) {
        const restored = cloneBackupValue(session);
        if (isCurrentSession(restored)) restored.restoreToken = makeRestoreToken();
        return restored;
      }
      const restored = {
        ...cloneBackupValue(session),
        revision: Math.max(session.revision, currentRevision + 1),
      };
      if (isCurrentSession(restored)) restored.restoreToken = makeRestoreToken();
      return restored;
    });
    restoredSessions = sessions;
    for (const name of ALL_STORES) await transaction.objectStore(name).clear();
    for (const record of validated.kanji) await transaction.objectStore(STORE_NAMES.KANJI).put(cloneBackupValue(record));
    for (const session of sessions) await transaction.objectStore(STORE_NAMES.SESSIONS).put(session);
    for (const attempt of validated.attempts) await transaction.objectStore(STORE_NAMES.ATTEMPTS).put(cloneBackupValue(attempt));
    await transaction.done;
  } catch (error) {
    return abortAndThrow(transaction, error);
  }
  const settingsPersisted = persistRestoredSettings(validated.settings);
  return {
    ...validated,
    sessions: restoredSessions.map(cloneBackupValue),
    settingsPersisted,
  };
}

/** Clear resumable sessions while retaining immutable attempt history. */
export async function resetSessions(db) {
  ensureDb(db);
  const transaction = db.transaction(STORE_NAMES.SESSIONS, 'readwrite');
  try {
    const store = transaction.objectStore(STORE_NAMES.SESSIONS);
    const before = await store.count();
    await store.clear();
    await transaction.done;
    return { sessions: before };
  } catch (error) {
    return abortAndThrow(transaction, error);
  }
}

/** Clear history and its session snapshots without touching the Kanji library. */
export async function resetHistory(db) {
  ensureDb(db);
  const transaction = db.transaction([STORE_NAMES.SESSIONS, STORE_NAMES.ATTEMPTS], 'readwrite');
  try {
    const sessionsStore = transaction.objectStore(STORE_NAMES.SESSIONS);
    const attemptsStore = transaction.objectStore(STORE_NAMES.ATTEMPTS);
    const [sessions, attempts] = await Promise.all([sessionsStore.count(), attemptsStore.count()]);
    await sessionsStore.clear();
    await attemptsStore.clear();
    await transaction.done;
    return { sessions, attempts };
  } catch (error) {
    return abortAndThrow(transaction, error);
  }
}

export { ALL_STORES, DB_NAME };
