export const PREFERENCES_STORAGE_KEY = 'kanji-settings';

export const DEFAULT_PREFERENCES = Object.freeze({
  practiceSize: 'all',
  feedback: 'detailed',
});

export const PRACTICE_SIZE_OPTIONS = Object.freeze(['all', '10', '20', '50', '100']);
export const FEEDBACK_OPTIONS = Object.freeze(['detailed', 'compact']);

export class PreferencesValidationError extends Error {
  constructor(message = 'The learning preferences are invalid.', details = {}) {
    super(message);
    this.name = 'PreferencesValidationError';
    this.details = details;
  }
}

export class PreferencesStorageError extends Error {
  constructor(message = 'Learning preferences could not be saved.', details = {}) {
    super(message);
    this.name = 'PreferencesStorageError';
    this.details = details;
  }
}

function clonePreferences(value) {
  return { practiceSize: value.practiceSize, feedback: value.feedback };
}

/** Validate and canonicalize the two user-controlled preference fields. */
export function validatePreferences(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PreferencesValidationError('Preferences must be an object.');
  }
  if (!PRACTICE_SIZE_OPTIONS.includes(value.practiceSize)) {
    throw new PreferencesValidationError('practiceSize must be all, 10, 20, 50, or 100.', { field: 'practiceSize' });
  }
  if (!FEEDBACK_OPTIONS.includes(value.feedback)) {
    throw new PreferencesValidationError('feedback must be detailed or compact.', { field: 'feedback' });
  }
  return clonePreferences(value);
}

function storage() {
  try {
    if (typeof globalThis.localStorage === 'undefined') return null;
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

/**
 * Read preferences without allowing malformed storage to break the app. A
 * missing or corrupted localStorage value is treated as a fresh installation.
 */
export function readPreferences() {
  const local = storage();
  if (!local) return clonePreferences(DEFAULT_PREFERENCES);
  let raw;
  try {
    raw = local.getItem(PREFERENCES_STORAGE_KEY);
  } catch {
    return clonePreferences(DEFAULT_PREFERENCES);
  }
  if (!raw) return clonePreferences(DEFAULT_PREFERENCES);
  try {
    return validatePreferences(JSON.parse(raw));
  } catch {
    return clonePreferences(DEFAULT_PREFERENCES);
  }
}

/** Persist the validated preferences under the dedicated settings key. */
export function savePreferences(value) {
  const preferences = validatePreferences(value);
  const local = storage();
  if (!local) throw new PreferencesStorageError('Local storage is unavailable.');
  try {
    local.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify(preferences));
  } catch (error) {
    throw new PreferencesStorageError('Local storage could not save the preferences.', { cause: error });
  }
  return preferences;
}
