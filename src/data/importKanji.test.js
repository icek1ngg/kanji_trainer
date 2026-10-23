import 'fake-indexeddb/auto';
import { deleteDB } from 'idb';
import { describe, expect, it } from 'vitest';
import { openDatabase } from './database.js';
import { createKanjiRepository } from './kanjiRepository.js';
import { ImportConflictError, commitKanjiImport } from './importKanji.js';
import { planKanjiImport, snapshotKanji } from '../domain/importPlan.js';

async function fixture() {
  const name = `import-${crypto.randomUUID()}`;
  const db = await openDatabase({ name });
  const repo = createKanjiRepository(db);
  return { name, db, repo };
}

describe('transactional Kanji imports', () => {
  it('adds rows, merges or replaces duplicates, preserves metadata and leaves history intact', async () => {
    const { name, db, repo } = await fixture();
    try {
      const original = await repo.add({ id: 'san', kanji: '散', hanViet: ['TÁN'], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z' });
      await db.add('attempts', { id: 'attempt-1', kanjiId: original.id, correct: false });
      const rows = [{ rowNumber: 2, kanji: '散', hanViet: ['Tản'], errors: [] }, { rowNumber: 3, kanji: '学', hanViet: ['HỌC'], errors: [] }];
      const before = await repo.list();
      const result = await commitKanjiImport(db, rows, 'merge', snapshotKanji(before));
      expect(result).toEqual({ added: 1, merged: 1, replaced: 0, skipped: 0, duplicates: 1 });
      const imported = await repo.list();
      expect(imported.find(record => record.id === 'san')).toMatchObject({ id: 'san', kanji: '散', hanViet: ['TÁN', 'Tản'], createdAt: original.createdAt });
      expect(imported.find(record => record.kanji === '学')).toMatchObject({ hanViet: ['HỌC'] });
      expect(await db.get('attempts', 'attempt-1')).toEqual({ id: 'attempt-1', kanjiId: 'san', correct: false });

      const secondSnapshot = snapshotKanji(imported);
      const replaced = await commitKanjiImport(db, [{ rowNumber: 2, kanji: '散', hanViet: ['TÁN'], errors: [] }], 'replace', secondSnapshot);
      expect(replaced.replaced).toBe(1);
      expect((await repo.get('san')).hanViet).toEqual(['TÁN']);
    } finally { db.close(); await deleteDB(name); }
  });

  it('rejects stale previews without changing the library', async () => {
    const { name, db, repo } = await fixture();
    try {
      const existing = await repo.add({ kanji: '学', hanViet: ['HỌC'] });
      const snapshot = snapshotKanji(await repo.list());
      await repo.update({ ...existing, hanViet: ['HỌC', 'GIA'] });
      await expect(commitKanjiImport(db, [{ rowNumber: 2, kanji: '散', hanViet: ['TÁN'], errors: [] }], 'skip', snapshot)).rejects.toBeInstanceOf(ImportConflictError);
      expect((await repo.list()).map(row => row.kanji)).toEqual(['学']);
      expect((await repo.get(existing.id)).hanViet).toEqual(['HỌC', 'GIA']);
    } finally { db.close(); await deleteDB(name); }
  });

  it('rolls back the entire import when a later write fails', async () => {
    const { name, db, repo } = await fixture();
    try {
      const before = await repo.list();
      const rows = [{ rowNumber: 2, kanji: '散', hanViet: ['TÁN'], errors: [] }, { rowNumber: 3, kanji: '学', hanViet: ['HỌC'], errors: [] }];
      const failingDb = {
        transaction(...args) {
          const tx = db.transaction(...args);
          let adds = 0;
          return {
            store: {
              getAll: () => tx.store.getAll(),
              add(record) { adds += 1; if (adds === 2) throw new Error('late import failure'); return tx.store.add(record); },
              put: record => tx.store.put(record),
            },
            done: tx.done,
            abort: () => tx.abort(),
          };
        },
      };
      await expect(commitKanjiImport(failingDb, rows, 'skip', snapshotKanji(before))).rejects.toThrow('late import failure');
      expect(await repo.list()).toEqual([]);
    } finally { db.close(); await deleteDB(name); }
  });
});
