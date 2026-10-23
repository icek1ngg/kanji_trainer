import { describe, expect, it } from 'vitest';
import { createTableSession } from './tableSession.js';
import {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  BackupValidationError,
  validateBackup,
} from './backup.js';

const record = {
  id: 'san',
  kanji: '散',
  hanViet: ['TÁN', 'TẢN'],
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
};

function tableSession(id = 'table-1', revision = 0) {
  return { ...createTableSession([record], { id, now: '2026-10-02T00:00:00.000Z' }), revision };
}

function validBackup(overrides = {}) {
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: '2026-10-03T00:00:00.000Z',
    kanji: [record],
    sessions: [tableSession()],
    attempts: [{
      id: 'attempt-1',
      sessionId: 'table-1',
      kanjiId: 'san',
      kanji: '散',
      requiredReadings: ['TÁN', 'TẢN'],
      submittedAnswer: 'TÁN/TẢN',
      isCorrect: true,
      mode: 'table',
      createdAt: '2026-10-02T00:01:00.000Z',
    }],
    settings: { practiceSize: 'all', feedback: 'detailed', theme: 'light' },
    ...overrides,
  };
}

describe('versioned backup validation', () => {
  it('returns a detached canonical backup and preserves unknown legacy rows and fields', () => {
    const legacyAttempt = { id: 'legacy-attempt', sessionId: 'old', aggregate: 4, nested: { keep: true } };
    const legacySession = { id: 'legacy-session', mode: 'legacy', checks: 4, customField: { keep: true } };
    const input = validBackup({ attempts: [...validBackup().attempts, legacyAttempt], sessions: [...validBackup().sessions, legacySession] });
    const result = validateBackup(input);
    expect(result).toEqual(input);
    expect(result).not.toBe(input);
    expect(result.attempts[1]).not.toBe(legacyAttempt);
    result.attempts[1].nested.keep = false;
    expect(input.attempts[1].nested.keep).toBe(true);
  });

  it('rejects unsupported versions, duplicate IDs, invalid settings and malformed current sessions', () => {
    expect(() => validateBackup(validBackup({ version: 2 }))).toThrow(BackupValidationError);
    expect(() => validateBackup(validBackup({ settings: { practiceSize: '5', feedback: 'detailed', theme: 'light' } }))).toThrow(BackupValidationError);
    expect(() => validateBackup(validBackup({ kanji: [record, record] }))).toThrow(/duplicate/i);
    expect(() => validateBackup(validBackup({ attempts: [validBackup().attempts[0], { ...validBackup().attempts[0] }] }))).toThrow(/duplicate/i);
    expect(() => validateBackup(validBackup({ sessions: [{ ...tableSession(), checks: 2 }] }))).toThrow(BackupValidationError);
  });

  it('requires all three stores and settings before accepting a backup', () => {
    const value = validBackup();
    for (const field of ['kanji', 'sessions', 'attempts', 'settings']) {
      const copy = { ...value };
      delete copy[field];
      expect(() => validateBackup(copy)).toThrow(BackupValidationError);
    }
  });

  it('checks recorded correctness and rejects conflicting pending event IDs', () => {
    const committed = validBackup().attempts[0];
    expect(() => validateBackup(validBackup({ attempts: [{ ...committed, isCorrect: false }] }))).toThrow(/validation result/i);
    const pending = { ...committed, id: 'pending-1' };
    const matching = validBackup({
      sessions: [{ ...tableSession(), pendingAttempts: [{ ...pending }] }],
      attempts: [{ ...pending }],
    });
    expect(validateBackup(matching).sessions[0].pendingAttempts).toHaveLength(1);
    expect(() => validateBackup({
      ...matching,
      attempts: [{ ...pending, submittedAnswer: 'TẢN/TÁN' }],
    })).toThrow(/conflicts/i);
  });

  it('rejects multiple active sessions for one current practice mode', () => {
    expect(() => validateBackup(validBackup({
      sessions: [tableSession('table-1'), tableSession('table-2')],
    }))).toThrow(/multiple active/i);
  });
});
