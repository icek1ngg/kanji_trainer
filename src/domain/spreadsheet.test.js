import { describe, expect, it } from 'vitest';
import {
  SPREADSHEET_HEADERS,
  createKanjiWorkbook,
  readKanjiFile,
  serializeKanjiWorkbook,
} from './spreadsheet.js';
import * as XLSX from 'xlsx';

const records = [
  { id: 'san', kanji: '散', hanViet: ['Tán', 'TẢN'], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
  { id: 'gaku', kanji: '学', hanViet: ['HỌC'], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
];

function workbookBytes(rows, sheetName = 'Kanji') {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), sheetName);
  return XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
}

describe('two-column workbook round trips', () => {
  it('exports exactly the required headers and no metadata columns', () => {
    const workbook = createKanjiWorkbook(records);
    expect(workbook.SheetNames).toEqual(['Kanji']);
    const values = XLSX.utils.sheet_to_json(workbook.Sheets.Kanji, { header: 1, raw: true, defval: '' });
    expect(values).toEqual([SPREADSHEET_HEADERS, ['散', 'Tán/TẢN'], ['学', 'HỌC']]);
    const parsed = readKanjiFile(serializeKanjiWorkbook(records), 'kanji.xlsx');
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows.map(({ kanji, hanViet }) => ({ kanji, hanViet }))).toEqual([
      { kanji: '散', hanViet: ['Tán', 'TẢN'] }, { kanji: '学', hanViet: ['HỌC'] },
    ]);
  });

  it('creates a header-only template and preserves a case-sensitive CSV import', () => {
    const bytes = serializeKanjiWorkbook([]);
    const template = readKanjiFile(bytes, 'mau.xlsx');
    expect(template).toEqual({ rows: [], errors: [] });
    const csv = new TextEncoder().encode('\uFEFFKanji,Âm Hán Việt\n散,tán｜Tản\n学,HỌC\n');
    const parsed = readKanjiFile(csv, 'kanji.csv');
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows[0].hanViet).toEqual(['tán', 'Tản']);
  });
});

describe('preview validation', () => {
  it('reports malformed rows while preserving source row numbers', () => {
    const result = readKanjiFile(workbookBytes([
      ['Kanji', 'Âm Hán Việt'],
      ['散', 'TÁN//TẢN'],
      [],
      ['ab', 'HỌC'],
      ['生', ''],
    ]), 'bad.xlsx');
    expect(result.rows.map(row => row.rowNumber)).toEqual([2, 4, 5]);
    expect(result.rows.every(row => row.errors.length > 0)).toBe(true);
    expect(result.errors.length).toBe(3);
    const extraCells = readKanjiFile(workbookBytes([
      ['Kanji', 'Âm Hán Việt'], ['学', 'HỌC', 'extra'],
    ]), 'extra.xlsx');
    expect(extraCells.rows[0].errors).toHaveLength(1);
    expect(extraCells.errors.join(' ')).toMatch(/nhiều hơn hai/u);
  });

  it.each([
    ['wrong.csv', new TextEncoder().encode('Kanji,Meaning\n散,TÁN')],
    ['wrong.xlsx', workbookBytes([['Kanji', 'Âm Hán Việt', 'Extra'], ['散', 'TÁN', 'x']])],
    ['wrong.txt', new Uint8Array([1, 2, 3])],
  ])('rejects %s with an actionable file error', (filename, bytes) => {
    const result = readKanjiFile(bytes, filename);
    expect(result.rows).toEqual([]);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('rejects formulas, extra populated cells, corrupt files and multiple data sheets', () => {
    const formulaWorkbook = XLSX.utils.book_new();
    const formulaSheet = XLSX.utils.aoa_to_sheet([SPREADSHEET_HEADERS, ['散', 'TÁN']]);
    formulaSheet.B2 = { t: 'n', f: '1+1', v: 2 };
    XLSX.utils.book_append_sheet(formulaWorkbook, formulaSheet, 'Kanji');
    const formula = readKanjiFile(XLSX.write(formulaWorkbook, { bookType: 'xlsx', type: 'array' }), 'formula.xlsx');
    expect(formula.errors.join(' ')).toMatch(/công thức/u);

    const multiple = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(multiple, XLSX.utils.aoa_to_sheet([SPREADSHEET_HEADERS, ['散', 'TÁN']]), 'One');
    XLSX.utils.book_append_sheet(multiple, XLSX.utils.aoa_to_sheet([SPREADSHEET_HEADERS, ['学', 'HỌC']]), 'Two');
    expect(readKanjiFile(XLSX.write(multiple, { bookType: 'xlsx', type: 'array' }), 'many.xlsx').errors.join(' ')).toMatch(/một trang tính/u);
    expect(readKanjiFile(new Uint8Array([0, 1, 2, 3]), 'corrupt.xlsx').rows).toEqual([]);
  });

  it('requires A1 headers and rejects merged cells or formula-only rows', () => {
    const offset = XLSX.utils.book_new();
    const offsetSheet = XLSX.utils.aoa_to_sheet([[], ['Kanji', 'Âm Hán Việt'], ['散', 'TÁN']]);
    XLSX.utils.book_append_sheet(offset, offsetSheet, 'Kanji');
    expect(readKanjiFile(XLSX.write(offset, { bookType: 'xlsx', type: 'array' }), 'offset.xlsx').errors.join(' ')).toMatch(/A1/u);

    const merged = XLSX.utils.book_new();
    const mergedSheet = XLSX.utils.aoa_to_sheet([SPREADSHEET_HEADERS, ['散', 'TÁN']]);
    mergedSheet['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 1 } }];
    XLSX.utils.book_append_sheet(merged, mergedSheet, 'Kanji');
    expect(readKanjiFile(XLSX.write(merged, { bookType: 'xlsx', type: 'array' }), 'merged.xlsx').errors.join(' ')).toMatch(/gộp/u);

    const formulaOnly = XLSX.utils.book_new();
    const formulaSheet = XLSX.utils.aoa_to_sheet([SPREADSHEET_HEADERS, ['散', 'TÁN']]);
    formulaSheet.A3 = { t: 'n', f: '1+1' };
    formulaSheet['!ref'] = 'A1:B3';
    XLSX.utils.book_append_sheet(formulaOnly, formulaSheet, 'Kanji');
    const parsed = readKanjiFile(XLSX.write(formulaOnly, { bookType: 'xlsx', type: 'array' }), 'formula-row.xlsx');
    expect(parsed.rows.at(-1).errors.join(' ')).toMatch(/công thức/u);
  });
});
