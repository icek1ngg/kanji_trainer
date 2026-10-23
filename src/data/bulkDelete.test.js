import 'fake-indexeddb/auto';
import { deleteDB } from 'idb';
import { expect, it } from 'vitest';
import { openDatabase } from './database.js';
import { createKanjiRepository } from './kanjiRepository.js';

it('bulk deletes selected IDs only and preserves history', async () => {
  const name = `bulk-${crypto.randomUUID()}`;
  const db = await openDatabase({ name });
  try {
    const repo = createKanjiRepository(db);
    await repo.add({ id: 'one', kanji: '散', hanViet: ['TÁN', 'TẢN'] });
    await repo.add({ id: 'two', kanji: '学', hanViet: ['HỌC'] });
    await db.add('attempts', { id: 'history', kanjiId: 'one' });
    await expect(repo.removeMany(['one', ' '])).rejects.toThrow();
    expect(await repo.list()).toHaveLength(2);
    // Inject a late request failure after one deletion to verify atomic rollback.
    const failingRepo = createKanjiRepository({ transaction(...args) {
      const tx = db.transaction(...args);
      return {
        store: {
          get: key => tx.store.get(key),
          delete: key => { if (key === 'two') throw new Error('Simulated storage failure'); return tx.store.delete(key); },
        },
        done: tx.done,
        abort: () => tx.abort(),
      };
    } });
    await expect(failingRepo.removeMany(['one', 'two'])).rejects.toThrow('Simulated storage failure');
    expect(await repo.list()).toHaveLength(2);
    expect(await repo.removeMany(['one', 'one', 'missing'])).toBe(1);
    expect((await repo.list()).map(row => row.id)).toEqual(['two']);
    expect(await db.get('attempts', 'history')).toEqual({ id: 'history', kanjiId: 'one' });
  } finally { db.close(); await deleteDB(name); }
});
