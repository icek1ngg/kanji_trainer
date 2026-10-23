import { normalizeKanjiRecord } from './kanjiRepository.js';

const SAMPLE_KANJI = Object.freeze([
  { id: 'sample-gaku', kanji: '学', hanViet: ['HỌC'] },
  { id: 'sample-sei', kanji: '生', hanViet: ['SINH'] },
  { id: 'sample-san', kanji: '散', hanViet: ['TÁN', 'TẢN'] },
  { id: 'sample-kou', kanji: '行', hanViet: ['HÀNH', 'HẠNH'] },
]);

/**
 * Explicitly seed the small, documented starter set only when the library is
 * empty. This is never called by database initialization and never overwrites
 * user data.
 */
export async function seedSampleKanji(db) {
  if (!db || typeof db.transaction !== 'function') throw new TypeError('An open IndexedDB database is required.');
  const transaction = db.transaction('kanji', 'readwrite');
  try {
    const existingCount = await transaction.store.count();
    if (existingCount > 0) {
      await transaction.done;
      return { seeded: false, count: 0 };
    }
    const timestamp = new Date().toISOString();
    const records = SAMPLE_KANJI.map(record => normalizeKanjiRecord({ ...record, createdAt: timestamp, updatedAt: timestamp }));
    for (const record of records) await transaction.store.add(record);
    await transaction.done;
    return { seeded: true, count: records.length };
  } catch (error) {
    try { await transaction.done; } catch { /* The transaction already aborted. */ }
    throw error;
  }
}

export { SAMPLE_KANJI };
