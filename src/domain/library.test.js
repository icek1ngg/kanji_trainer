import { describe, expect, it } from 'vitest';
import { filterAndSortKanji } from './library.js';

const records = Object.freeze([
  Object.freeze({ id: '1', kanji: '散', hanViet: Object.freeze(['TÁN', 'TẢN']) }),
  Object.freeze({ id: '2', kanji: '学', hanViet: Object.freeze(['HỌC']) }),
  Object.freeze({ id: '3', kanji: '生', hanViet: Object.freeze(['SINH']) }),
]);

describe('library search and sorting', () => {
  it('searches character and all readings with case and NFC normalization', () => {
    expect(filterAndSortKanji(records, '散')).toEqual([records[0]]);
    expect(filterAndSortKanji(records, ' tản '.normalize('NFD'))).toEqual([records[0]]);
    expect(filterAndSortKanji(records, 'học')).toEqual([records[1]]);
    expect(filterAndSortKanji(records, 'hoc')).toEqual([]);
  });
  it('sorts predictably without mutating source records', () => {
    const ascending = filterAndSortKanji(records).map(row => row.id);
    expect(filterAndSortKanji(records, '', 'kanji-desc').map(row => row.id)).toEqual([...ascending].reverse());
    expect(filterAndSortKanji(records, '', 'reading-asc').map(row => row.id)).toEqual(['2', '3', '1']);
    expect(filterAndSortKanji(records, '', 'count-desc')[0].id).toBe('1');
    expect(records.map(row => row.id)).toEqual(['1', '2', '3']);
  });
});
