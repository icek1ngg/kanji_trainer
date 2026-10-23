import { normalizeReading, parseReadings } from './readings.js';
import { normalizeKanjiRecord } from '../data/kanjiRepository.js';

export const IMPORT_POLICIES = Object.freeze(['skip', 'merge', 'replace']);
const SEPARATOR = /[\/;｜]/u;

function fail(message, details = {}) {
  const error = new Error(message);
  error.name = 'ImportPlanError';
  error.details = details;
  throw error;
}

function readingKey(value) {
  return normalizeReading(value);
}

function stableRecord(record) {
  const normalized = normalizeKanjiRecord(record);
  return {
    id: normalized.id,
    kanji: normalized.kanji,
    hanViet: [...normalized.hanViet],
    ...(normalized.createdAt === undefined ? {} : { createdAt: normalized.createdAt }),
    ...(normalized.updatedAt === undefined ? {} : { updatedAt: normalized.updatedAt }),
  };
}

export function snapshotKanji(records) {
  if (!Array.isArray(records)) throw new TypeError('records must be an array.');
  return JSON.stringify(records.map(stableRecord).sort((a, b) => a.id.localeCompare(b.id)));
}

function validateRow(row, index) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) fail(`Dòng nhập ${index + 1} không hợp lệ.`);
  if (Array.isArray(row.errors) && row.errors.length) fail(`Dòng ${row.rowNumber ?? index + 1} có lỗi và không thể nhập.`);
  const kanji = typeof row.kanji === 'string' ? row.kanji.normalize('NFC').trim() : '';
  const hanViet = Array.isArray(row.hanViet) ? Array.from(row.hanViet, value => typeof value === 'string' ? value.normalize('NFC').trim() : value) : null;
  if (!hanViet) fail(`Dòng ${row.rowNumber ?? index + 1} có danh sách âm không hợp lệ.`);
  if (hanViet.some(reading => typeof reading !== 'string' || SEPARATOR.test(reading))) {
    fail(`Dòng ${row.rowNumber ?? index + 1} có âm chứa dấu phân cách hoặc dữ liệu không hợp lệ.`);
  }
  try {
    normalizeKanjiRecord({ kanji, hanViet }, { requireId: false });
  } catch {
    fail(`Dòng ${row.rowNumber ?? index + 1} có dữ liệu Kanji không hợp lệ.`);
  }
  const parsed = parseReadings(hanViet.join('/'));
  if (!parsed.isValid) fail(`Dòng ${row.rowNumber ?? index + 1} có âm trống, trùng hoặc sai định dạng.`);
  return { rowNumber: row.rowNumber ?? index + 1, kanji, hanViet };
}

function validateExisting(record) {
  const normalized = stableRecord(record);
  if (normalized.hanViet.some(reading => SEPARATOR.test(reading))) {
    fail(`Kanji ${normalized.kanji} có dữ liệu âm hiện tại không hợp lệ; không thể gộp.`);
  }
  const parsed = parseReadings(normalized.hanViet.join('/'));
  if (!parsed.isValid) fail(`Kanji ${normalized.kanji} có dữ liệu âm hiện tại không hợp lệ; không thể gộp.`);
  return normalized;
}

function mergeReadings(existing, incoming) {
  const keys = new Set(existing.map(readingKey));
  const result = [...existing];
  for (const reading of incoming) {
    const key = readingKey(reading);
    if (!keys.has(key)) {
      keys.add(key);
      result.push(reading);
    }
  }
  return result;
}

/**
 * Build a non-mutating preview plan. New records intentionally have no ID;
 * commitKanjiImport creates IDs only after its optimistic snapshot check.
 */
export function planKanjiImport(existingRecords, rows, policy = 'skip') {
  if (!Array.isArray(existingRecords)) throw new TypeError('existingRecords must be an array.');
  if (!Array.isArray(rows)) throw new TypeError('rows must be an array.');
  if (!IMPORT_POLICIES.includes(policy)) fail(`Chính sách nhập không hợp lệ: ${policy}.`);

  const existing = existingRecords.map(validateExisting);
  const byKanji = new Map(existing.map(record => [record.kanji, record]));
  const writesByKanji = new Map();
  const writes = [];
  const summary = { added: 0, merged: 0, replaced: 0, skipped: 0, duplicates: 0 };

  rows.forEach((source, index) => {
    const row = validateRow(source, index);
    const current = byKanji.get(row.kanji);
    if (!current) {
      const added = { kanji: row.kanji, hanViet: [...row.hanViet] };
      byKanji.set(row.kanji, added);
      writesByKanji.set(row.kanji, added);
      writes.push(added);
      summary.added += 1;
      return;
    }

    summary.duplicates += 1;
    if (policy === 'skip') {
      summary.skipped += 1;
      return;
    }
    if (policy === 'merge') {
      const merged = { ...current, hanViet: mergeReadings(current.hanViet, row.hanViet) };
      byKanji.set(row.kanji, merged);
      const pending = writesByKanji.get(row.kanji);
      if (pending) {
        pending.hanViet = [...merged.hanViet];
      } else {
        writesByKanji.set(row.kanji, merged);
        writes.push(merged);
      }
      summary.merged += 1;
      return;
    }
    const replaced = { ...current, hanViet: [...row.hanViet] };
    byKanji.set(row.kanji, replaced);
    const pending = writesByKanji.get(row.kanji);
    if (pending) pending.hanViet = [...replaced.hanViet];
    else {
      writesByKanji.set(row.kanji, replaced);
      writes.push(replaced);
    }
    summary.replaced += 1;
  });

  return { writes: writes.map(record => ({ ...record, hanViet: [...record.hanViet] })), summary, snapshot: snapshotKanji(existingRecords) };
}

export { mergeReadings };
