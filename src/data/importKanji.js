import { normalizeKanjiRecord } from './kanjiRepository.js';
import { IMPORT_POLICIES, planKanjiImport, snapshotKanji } from '../domain/importPlan.js';

const KANJI_STORE = 'kanji';

export class ImportConflictError extends Error {
  constructor(message = 'Kho Kanji đã thay đổi sau khi xem trước tệp nhập.') {
    super(message);
    this.name = 'ImportConflictError';
  }
}

function newId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `kanji-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function now() {
  return new Date().toISOString();
}

function abortAndRethrow(transaction, error) {
  try { transaction.abort(); } catch { /* Already aborted or committed. */ }
  return transaction.done.catch(() => {}).then(() => { throw error; });
}

/**
 * Commit a preview atomically after checking that the library has not changed.
 * Only the kanji store is touched; sessions and attempts remain untouched.
 */
export async function commitKanjiImport(db, rows, policy = 'skip', expectedSnapshot) {
  if (!db || typeof db.transaction !== 'function') throw new TypeError('An open IndexedDB database is required.');
  if (!IMPORT_POLICIES.includes(policy)) throw new Error(`Chính sách nhập không hợp lệ: ${policy}.`);
  if (typeof expectedSnapshot !== 'string') throw new TypeError('expectedSnapshot is required.');

  const transaction = db.transaction(KANJI_STORE, 'readwrite');
  try {
    const existing = await transaction.store.getAll();
    if (snapshotKanji(existing) !== expectedSnapshot) throw new ImportConflictError();
    const plan = planKanjiImport(existing, rows, policy);
    const stamp = now();
    for (const planned of plan.writes) {
      if (planned.id) {
        const current = existing.find(record => record.id === planned.id);
        if (!current) throw new ImportConflictError();
        const record = normalizeKanjiRecord({
          ...planned,
          id: current.id,
          createdAt: current.createdAt,
          updatedAt: stamp,
        });
        await transaction.store.put(record);
      } else {
        const record = normalizeKanjiRecord({
          ...planned,
          id: newId(),
          createdAt: stamp,
          updatedAt: stamp,
        });
        await transaction.store.add(record);
      }
    }
    await transaction.done;
    return plan.summary;
  } catch (error) {
    return abortAndRethrow(transaction, error);
  }
}
