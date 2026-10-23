import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_PREFERENCES,
  PREFERENCES_STORAGE_KEY,
  PreferencesStorageError,
  PreferencesValidationError,
  readPreferences,
  savePreferences,
} from './preferences.js';

const originalStorage = globalThis.localStorage;

function installStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  globalThis.localStorage = {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(String(key), String(value)); },
    removeItem(key) { values.delete(String(key)); },
  };
  return values;
}

afterEach(() => {
  if (originalStorage === undefined) delete globalThis.localStorage;
  else globalThis.localStorage = originalStorage;
});

describe('local learning preferences', () => {
  it('reads defaults when storage is missing or malformed', () => {
    delete globalThis.localStorage;
    expect(readPreferences()).toEqual(DEFAULT_PREFERENCES);
    installStorage({ [PREFERENCES_STORAGE_KEY]: '{"practiceSize":"bad"}' });
    expect(readPreferences()).toEqual(DEFAULT_PREFERENCES);
  });

  it('validates and saves string practice sizes and feedback mode', () => {
    const values = installStorage();
    expect(savePreferences({ practiceSize: '20', feedback: 'compact' })).toEqual({ practiceSize: '20', feedback: 'compact' });
    expect(values.get(PREFERENCES_STORAGE_KEY)).toBe('{"practiceSize":"20","feedback":"compact"}');
    expect(readPreferences()).toEqual({ practiceSize: '20', feedback: 'compact' });
    expect(() => savePreferences({ practiceSize: 20, feedback: 'compact' })).toThrow(PreferencesValidationError);
    expect(() => savePreferences({ practiceSize: 'all', feedback: 'verbose' })).toThrow(PreferencesValidationError);
  });

  it('reports unavailable storage for writes without changing the defaults contract', () => {
    delete globalThis.localStorage;
    expect(() => savePreferences({ ...DEFAULT_PREFERENCES })).toThrow(PreferencesStorageError);
    expect(readPreferences()).toEqual(DEFAULT_PREFERENCES);
  });
});
