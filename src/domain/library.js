import { normalizeReading } from './readings.js';

const collator = new Intl.Collator('vi', { numeric: true });

/** Search preserves accents; sorting never mutates the caller's array. */
export function filterAndSortKanji(records, query = '', sort = 'kanji-asc') {
  const needle = normalizeReading(query);
  const result = records.filter(record => normalizeReading(record.kanji).includes(needle)
    || record.hanViet.some(reading => normalizeReading(reading).includes(needle)));
  const byKanji = (a, b) => collator.compare(a.kanji, b.kanji) || collator.compare(a.id, b.id);
  return result.sort((a, b) => {
    if (sort === 'kanji-desc') return -byKanji(a, b);
    if (sort === 'reading-asc') return collator.compare(a.hanViet.join('/'), b.hanViet.join('/')) || byKanji(a, b);
    if (sort === 'count-desc') return b.hanViet.length - a.hanViet.length || byKanji(a, b);
    return byKanji(a, b);
  });
}
