import { DataValidationError, DuplicateKanjiError, KanjiNotFoundError } from './models.js';

const KANJI_STORE = 'kanji';
const ALLOWED_FIELDS = new Set(['id', 'kanji', 'hanViet', 'createdAt', 'updatedAt']);
const HAN_CHARACTER = /^\p{Script=Han}[\uFE00-\uFE0F\u{E0100}-\u{E01EF}]?$/u;

function fail(message, details = {}) {
  throw new DataValidationError(message, details);
}

function normalizeText(value, field) {
  if (typeof value !== 'string') fail(`${field} must be a string.`, { field });
  const normalized = value.normalize('NFC').trim();
  if (!normalized) fail(`${field} cannot be empty.`, { field });
  return normalized;
}

function validateTimestamp(value, field) {
  const normalized = normalizeText(value, field);
  const isoTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
  if (!isoTimestamp.test(normalized) || Number.isNaN(Date.parse(normalized))) {
    fail(`${field} must be a valid ISO timestamp.`, { field });
  }
  return normalized;
}

/** Validate and normalize a canonical Kanji record without changing readings. */
export function normalizeKanjiRecord(input, { requireId = true } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail('Kanji record must be an object.');
  }
  const unknownFields = Object.keys(input).filter(field => !ALLOWED_FIELDS.has(field));
  if (unknownFields.length) fail(`Unknown Kanji fields: ${unknownFields.join(', ')}.`, { fields: unknownFields });

  let id;
  if (input.id !== undefined) id = normalizeText(input.id, 'id');
  else if (requireId) fail('id is required.', { field: 'id' });

  const kanji = normalizeText(input.kanji, 'kanji');
  if (!HAN_CHARACTER.test(kanji)) {
    fail('kanji must contain exactly one Han character, with an optional variation selector.', { field: 'kanji' });
  }

  if (!Array.isArray(input.hanViet) || input.hanViet.length === 0) {
    fail('hanViet must be a non-empty array of strings.', { field: 'hanViet' });
  }
  // Keep every supplied reading, including duplicates. We only normalize NFC
  // and surrounding whitespace; silently deduplicating would lose user data.
  const hanViet = Array.from(input.hanViet, (reading, index) => normalizeText(reading, `hanViet[${index}]`));

  const record = { ...(id ? { id } : {}), kanji, hanViet };
  if (input.createdAt !== undefined) record.createdAt = validateTimestamp(input.createdAt, 'createdAt');
  if (input.updatedAt !== undefined) record.updatedAt = validateTimestamp(input.updatedAt, 'updatedAt');
  return record;
}

function createId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `kanji-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function now() {
  return new Date().toISOString();
}

function isConstraintError(error) {
  return error?.name === 'ConstraintError';
}

async function finishTransaction(transaction) {
  await transaction.done;
}

function mapWriteError(error, record) {
  if (isConstraintError(error)) {
    throw new DuplicateKanjiError('A Kanji record with this ID or character already exists.', {
      id: record.id,
      kanji: record.kanji,
    });
  }
  throw error;
}

/**
 * Create a small persistence service around an open idb database. Methods use
 * one transaction each, so failed writes do not partially alter the library.
 */
export function createKanjiRepository(db) {
  if (!db || typeof db.transaction !== 'function') throw new TypeError('An open IndexedDB database is required.');

  return {
    async removeMany(ids) {
      if (!Array.isArray(ids)) throw new TypeError('ids must be an array.');
      const keys = [...new Set(Array.from(ids, id => normalizeText(id, 'id')))];
      const transaction = db.transaction(KANJI_STORE, 'readwrite');
      try {
        let removed = 0;
        for (const key of keys) {
          if (await transaction.store.get(key)) {
            await transaction.store.delete(key);
            removed += 1;
          }
        }
        await transaction.done;
        return removed;
      } catch (error) {
        // Abort explicitly if a later request fails, preserving earlier records.
        try { transaction.abort(); } catch { /* It may already have aborted. */ }
        try { await transaction.done; } catch { /* Surface the original failure. */ }
        throw error;
      }
    },

    async list() {
      return db.getAll(KANJI_STORE);
    },

    async get(id) {
      const key = normalizeText(id, 'id');
      return db.get(KANJI_STORE, key);
    },

    async add(input) {
      const supplied = input && typeof input === 'object' ? input : {};
      const stamp = now();
      const record = normalizeKanjiRecord({ ...supplied, id: supplied.id ?? createId(), createdAt: supplied.createdAt ?? stamp, updatedAt: supplied.updatedAt ?? stamp });
      const transaction = db.transaction(KANJI_STORE, 'readwrite');
      try {
        await transaction.store.add(record);
        await finishTransaction(transaction);
        return record;
      } catch (error) {
        try { await transaction.done; } catch { /* The transaction already aborted. */ }
        mapWriteError(error, record);
      }
    },

    async update(input) {
      const supplied = input && typeof input === 'object' ? input : {};
      if (supplied.id === undefined) fail('id is required when updating a Kanji record.', { field: 'id' });
      const id = normalizeText(supplied.id, 'id');
      const transaction = db.transaction(KANJI_STORE, 'readwrite');
      try {
        const existing = await transaction.store.get(id);
        if (!existing) throw new KanjiNotFoundError(`Kanji record '${id}' was not found.`, { id });
        // Timestamps describe persistence events, so callers cannot rewrite
        // creation time or submit a stale updatedAt value from an old copy.
        const record = normalizeKanjiRecord({ ...supplied, id, createdAt: existing.createdAt, updatedAt: now() });
        await transaction.store.put(record);
        await finishTransaction(transaction);
        return record;
      } catch (error) {
        try { await transaction.done; } catch { /* The transaction already aborted. */ }
        if (error instanceof KanjiNotFoundError || error instanceof DataValidationError) throw error;
        mapWriteError(error, { ...supplied, id });
      }
    },

    async remove(id) {
      const key = normalizeText(id, 'id');
      const transaction = db.transaction(KANJI_STORE, 'readwrite');
      try {
        const existing = await transaction.store.get(key);
        if (!existing) {
          await finishTransaction(transaction);
          return false;
        }
        await transaction.store.delete(key);
        await finishTransaction(transaction);
        return true;
      } catch (error) {
        try { await transaction.done; } catch { /* The transaction already aborted. */ }
        throw error;
      }
    },
  };
}
