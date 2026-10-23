import 'fake-indexeddb/auto';
import { deleteDB, openDB } from 'idb';
import { afterEach, describe, expect, it } from 'vitest';
import { DB_VERSION, STORE_NAMES, openDatabase } from './database.js';
import { createKanjiRepository, normalizeKanjiRecord } from './kanjiRepository.js';
import { DataValidationError, DuplicateKanjiError, KanjiNotFoundError } from './models.js';
import { seedSampleKanji } from './sampleData.js';

const names = new Set();
const testName = () => {
  const name = `kanji-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  names.add(name);
  return name;
};

afterEach(async () => {
  await Promise.all([...names].map(name => deleteDB(name).catch(() => {})));
  names.clear();
});

const sample = (overrides = {}) => ({ id: `id-${Math.random().toString(36).slice(2)}`, kanji: '散', hanViet: ['TÁN', 'TẢN'], ...overrides });

describe('Phase 2 IndexedDB model', () => {
  it('creates the versioned schema and persists CRUD records', async () => {
    const name = testName();
    const db = await openDatabase({ name });
    expect(db.version).toBe(DB_VERSION);
    expect([...db.objectStoreNames]).toEqual(expect.arrayContaining(Object.values(STORE_NAMES)));
    const repository = createKanjiRepository(db);
    const created = await repository.add(sample());
    expect(created.createdAt).toEqual(expect.any(String));
    expect(await repository.get(created.id)).toMatchObject({ kanji: '散', hanViet: ['TÁN', 'TẢN'] });
    const updated = await repository.update({ ...created, kanji: '学', hanViet: ['HỌC'] });
    expect(updated.kanji).toBe('学');
    expect(await repository.remove(created.id)).toBe(true);
    expect(await repository.get(created.id)).toBeUndefined();
    db.close();
  });

  it('reopens the same database without losing records', async () => {
    const name = testName();
    const first = await openDatabase({ name });
    const repository = createKanjiRepository(first);
    const created = await repository.add(sample({ kanji: '行', hanViet: ['HÀNH', 'HẠNH'] }));
    first.close();
    const second = await openDatabase({ name });
    expect(await createKanjiRepository(second).get(created.id)).toMatchObject({ kanji: '行' });
    second.close();
  });

  it('rejects duplicate Kanji values and atomically rolls back duplicate updates', async () => {
    const name = testName();
    const db = await openDatabase({ name });
    const repository = createKanjiRepository(db);
    const first = await repository.add(sample({ kanji: '学', hanViet: ['HỌC'] }));
    await expect(repository.add(sample({ kanji: '学', hanViet: ['HỌC'] }))).rejects.toBeInstanceOf(DuplicateKanjiError);
    const second = await repository.add(sample({ kanji: '生', hanViet: ['SINH'] }));
    await expect(repository.update({ ...second, kanji: '学', hanViet: ['HỌC'] })).rejects.toBeInstanceOf(DuplicateKanjiError);
    expect(await repository.get(second.id)).toMatchObject({ kanji: '生', hanViet: ['SINH'] });
    expect(await repository.get(first.id)).toMatchObject({ kanji: '学' });
    db.close();
  });

  it('validates Han characters and readings while preserving duplicates', () => {
    expect(normalizeKanjiRecord(sample({ hanViet: [' TA\u0301N ', 'TÁN'] })).hanViet).toEqual(['TÁN', 'TÁN']);
    expect(normalizeKanjiRecord(sample({ kanji: '𠀀' })).kanji).toBe('𠀀');
    expect(() => normalizeKanjiRecord(sample({ kanji: 'ab' }))).toThrow(DataValidationError);
    expect(() => normalizeKanjiRecord(sample({ kanji: ' ' }))).toThrow(DataValidationError);
    expect(() => normalizeKanjiRecord(sample({ hanViet: [] }))).toThrow(DataValidationError);
    expect(() => normalizeKanjiRecord(sample({ hanViet: [' '] }))).toThrow(DataValidationError);
    expect(() => normalizeKanjiRecord(sample({ hanViet: [42] }))).toThrow(DataValidationError);
    expect(() => normalizeKanjiRecord(sample({ hanViet: Array(1) }))).toThrow(DataValidationError);
    expect(() => normalizeKanjiRecord(sample({ meaning: 'extra' }))).toThrow(DataValidationError);
  });

  it('normalizes IDs for lookup and owns metadata timestamps on update', async () => {
    const name = testName();
    const db = await openDatabase({ name });
    const repository = createKanjiRepository(db);
    const created = await repository.add(sample({ id: 'owned-id', createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z' }));
    await new Promise(resolve => setTimeout(resolve, 2));
    const updated = await repository.update({ ...created, id: ' owned-id ', kanji: '学', hanViet: ['HỌC'], createdAt: '2000-01-01T00:00:00.000Z', updatedAt: '2000-01-01T00:00:00.000Z' });
    expect(updated.id).toBe('owned-id');
    expect(updated.createdAt).toBe('2020-01-01T00:00:00.000Z');
    expect(new Date(updated.updatedAt).getTime()).toBeGreaterThan(new Date(created.updatedAt).getTime());
    db.close();
  });

  it('rejects duplicate IDs independently of duplicate Kanji values', async () => {
    const name = testName();
    const db = await openDatabase({ name });
    const repository = createKanjiRepository(db);
    await repository.add(sample({ id: 'same-id', kanji: '学', hanViet: ['HỌC'] }));
    await expect(repository.add(sample({ id: 'same-id', kanji: '生', hanViet: ['SINH'] }))).rejects.toMatchObject({
      name: 'DuplicateKanjiError',
      details: { id: 'same-id', kanji: '生' },
    });
    expect((await repository.list()).map(record => record.kanji)).toEqual(['学']);
    db.close();
  });

  it('preserves v1 records during the v2 migration', async () => {
    const name = testName();
    const v1 = await openDB(name, 1, { upgrade(db) {
      const store = db.createObjectStore(STORE_NAMES.KANJI, { keyPath: 'id' });
      store.createIndex('by-kanji', 'kanji', { unique: true });
    } });
    await v1.add(STORE_NAMES.KANJI, { id: 'legacy', kanji: '学', hanViet: ['HỌC'] });
    v1.close();
    const db = await openDatabase({ name });
    expect(await createKanjiRepository(db).get('legacy')).toMatchObject({ kanji: '学' });
    expect([...db.objectStoreNames]).toEqual(expect.arrayContaining([STORE_NAMES.SESSIONS, STORE_NAMES.ATTEMPTS]));
    db.close();
  });

  it('rejects opening a database that has moved to a future version', async () => {
    const name = testName();
    const future = await openDB(name, DB_VERSION + 1, { upgrade(db) { db.createObjectStore('future'); } });
    future.close();
    await expect(openDatabase({ name })).rejects.toMatchObject({ name: 'VersionError' });
  });

  it('closes a blocking connection so a schema upgrade can proceed', async () => {
    const name = testName();
    let blockingCalled = false;
    const current = await openDatabase({ name, onBlocking: () => { blockingCalled = true; } });
    const upgraded = await openDB(name, DB_VERSION + 1, { upgrade(db) { db.createObjectStore('future'); } });
    expect(upgraded.version).toBe(DB_VERSION + 1);
    expect(blockingCalled).toBe(true);
    upgraded.close();
    expect(current).toBeTruthy();
  });

  it('reports missing records clearly', async () => {
    const name = testName();
    const db = await openDatabase({ name });
    await expect(createKanjiRepository(db).update(sample({ id: 'missing' }))).rejects.toBeInstanceOf(KanjiNotFoundError);
    db.close();
  });

  it('seeds starter records only through explicit opt-in and never overwrites data', async () => {
    const name = testName();
    const db = await openDatabase({ name });
    expect(await seedSampleKanji(db)).toEqual({ seeded: true, count: 4 });
    expect(await seedSampleKanji(db)).toEqual({ seeded: false, count: 0 });
    const repository = createKanjiRepository(db);
    expect((await repository.list()).map(record => record.kanji)).toEqual(expect.arrayContaining(['学', '生', '散', '行']));
    db.close();
  });

  it('does not seed or alter a pre-existing user library', async () => {
    const name = testName();
    const db = await openDatabase({ name });
    const repository = createKanjiRepository(db);
    const existing = await repository.add(sample({ id: 'user-owned', kanji: '日', hanViet: ['NHẬT'] }));
    expect(await seedSampleKanji(db)).toEqual({ seeded: false, count: 0 });
    expect(await repository.list()).toEqual([existing]);
    db.close();
  });
});
