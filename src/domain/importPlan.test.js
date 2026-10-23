import { describe, expect, it } from 'vitest';
import { IMPORT_POLICIES, planKanjiImport, snapshotKanji } from './importPlan.js';

const existing = [
  { id: 'san', kanji: '散', hanViet: ['TÁN'], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z' },
  { id: 'gaku', kanji: '学', hanViet: ['HỌC'], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z' },
];
const rows = [
  { rowNumber: 2, kanji: '散', hanViet: ['Tản'], errors: [] },
  { rowNumber: 3, kanji: '生', hanViet: ['sinh'], errors: [] },
  { rowNumber: 4, kanji: '生', hanViet: ['SINH', 'SỐNG'], errors: [] },
];

describe('import preview policies', () => {
  it('skip leaves duplicates out and adds only first new row', () => {
    const plan = planKanjiImport(existing, rows, 'skip');
    expect(plan.summary).toEqual({ added: 1, merged: 0, replaced: 0, skipped: 2, duplicates: 2 });
    expect(plan.writes.map(record => ({ kanji: record.kanji, hanViet: record.hanViet }))).toEqual([{ kanji: '生', hanViet: ['sinh'] }]);
  });

  it('merge unions case/NFC-equivalent readings while preserving first spelling', () => {
    const plan = planKanjiImport(existing, rows, 'merge');
    expect(plan.summary).toEqual({ added: 1, merged: 2, replaced: 0, skipped: 0, duplicates: 2 });
    expect(plan.writes.find(record => record.kanji === '散')).toMatchObject({ id: 'san', hanViet: ['TÁN', 'Tản'] });
    expect(plan.writes.find(record => record.kanji === '生')).toMatchObject({ hanViet: ['sinh', 'SỐNG'] });
    expect(plan.writes.find(record => record.kanji === '生').createdAt).toBeUndefined();
  });

  it('replace lets the last row win and retains existing metadata', () => {
    const plan = planKanjiImport(existing, rows, 'replace');
    expect(plan.summary).toEqual({ added: 1, merged: 0, replaced: 2, skipped: 0, duplicates: 2 });
    expect(plan.writes.find(record => record.kanji === '散')).toMatchObject({ id: 'san', hanViet: ['Tản'] });
    expect(plan.writes.find(record => record.kanji === 'san')).toBeUndefined();
    expect(plan.writes.find(record => record.kanji === '散').createdAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('does not mutate existing or rows, and snapshots are stable by ID', () => {
    const beforeExisting = JSON.stringify(existing);
    const beforeRows = JSON.stringify(rows);
    const plan = planKanjiImport(existing, rows, 'merge');
    expect(JSON.stringify(existing)).toBe(beforeExisting);
    expect(JSON.stringify(rows)).toBe(beforeRows);
    expect(plan.snapshot).toBe(snapshotKanji([...existing].reverse()));
  });

  it('rejects invalid policy, errored rows and malformed existing data', () => {
    expect(IMPORT_POLICIES).toEqual(['skip', 'merge', 'replace']);
    expect(() => planKanjiImport(existing, rows, 'overwrite')).toThrow();
    expect(() => planKanjiImport(existing, [{ rowNumber: 2, kanji: '散', hanViet: ['TÁN'], errors: ['bad'] }])).toThrow();
    expect(() => planKanjiImport(existing, [{ rowNumber: 2, kanji: '散', hanViet: ['TÁN/TẢN'], errors: [] }])).toThrow();
    expect(() => planKanjiImport([{ ...existing[0], hanViet: ['TÁN/ TẢN'] }], [], 'merge')).toThrow();
  });
});
