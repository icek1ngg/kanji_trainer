import * as XLSX from 'xlsx';
import { normalizeKanjiRecord } from '../data/kanjiRepository.js';
import { parseReadings } from './readings.js';

export const SPREADSHEET_HEADERS = Object.freeze(['Kanji', 'Âm Hán Việt']);
const HEADER_BOM = /^\uFEFF/u;
const HAN_CHARACTER = /^\p{Script=Han}[\uFE00-\uFE0F\u{E0100}-\u{E01EF}]?$/u;
const SEPARATOR_SPLIT = /[\/;｜]/u;

function cleanCell(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value.normalize('NFC').replace(HEADER_BOM, '').trim();
  return String(value).normalize('NFC').trim();
}

function fileExtension(filename) {
  if (typeof filename !== 'string') return '';
  const match = filename.toLowerCase().match(/\.([a-z0-9]+)$/u);
  return match?.[1] ?? '';
}

function isBlankRow(row) {
  return !row.some(cell => cleanCell(cell) !== '');
}

function nonEmptySheet(sheet) {
  const range = sheet?.['!ref'];
  if (!range) return false;
  const decoded = XLSX.utils.decode_range(range);
  for (let row = decoded.s.r; row <= decoded.e.r; row += 1) {
    for (let column = decoded.s.c; column <= decoded.e.c; column += 1) {
      const cell = rowCell(sheet, row, column);
      if (cell?.f || cleanCell(cell?.v) !== '') return true;
    }
  }
  return false;
}

function rowCell(sheet, rowIndex, column) {
  const address = XLSX.utils.encode_cell({ r: rowIndex, c: column });
  return sheet[address];
}

function hasFormula(sheet, rowIndex, column) {
  return Boolean(rowCell(sheet, rowIndex, column)?.f);
}

function parseRawReadings(value) {
  const text = cleanCell(value);
  const parsed = parseReadings(text);
  if (!parsed.isValid) return { readings: [], error: parsed.reason };
  // parseReadings validates normalized values. Keep the supplied case and
  // diacritics in the stored representation, with NFC and outer trim only.
  return { readings: text.split(SEPARATOR_SPLIT).map(reading => reading.normalize('NFC').trim()), error: null };
}

function rowErrorMessage(rowNumber, message) {
  return `Dòng ${rowNumber}: ${message}`;
}

/**
 * Read a local .xlsx or .csv file into a preview model. No row is written here.
 * Invalid rows are retained with errors so callers can explain the preview.
 */
export function readKanjiFile(buffer, filename = '') {
  const extension = fileExtension(filename);
  if (!['xlsx', 'csv'].includes(extension)) {
    return { rows: [], errors: ['Chỉ hỗ trợ tệp .xlsx hoặc .csv.'] };
  }
  if (!(buffer instanceof ArrayBuffer || ArrayBuffer.isView(buffer))) {
    return { rows: [], errors: ['Dữ liệu tệp không hợp lệ.'] };
  }

  let workbook;
  try {
    const bytes = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    if (extension === 'csv') {
      let text;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch { return { rows: [], errors: ['Tệp CSV không dùng mã hóa UTF-8 hợp lệ.'] }; }
      workbook = XLSX.read(text, { type: 'string', raw: true, cellFormula: true, cellNF: true });
    } else {
      workbook = XLSX.read(bytes, { type: 'array', raw: true, cellFormula: true, cellNF: true });
    }
  } catch {
    return { rows: [], errors: ['Không thể đọc tệp. Tệp có thể bị hỏng hoặc không đúng định dạng.'] };
  }

  const nonEmptySheets = workbook.SheetNames.filter(name => nonEmptySheet(workbook.Sheets[name]));
  if (nonEmptySheets.length !== 1) {
    return { rows: [], errors: [nonEmptySheets.length === 0 ? 'Tệp không có dữ liệu.' : 'Tệp chỉ được chứa một trang tính có dữ liệu.'] };
  }
  const sheet = workbook.Sheets[nonEmptySheets[0]];
  const range = XLSX.utils.decode_range(sheet['!ref']);
  if (range.s.r !== 0 || range.s.c !== 0) {
    return { rows: [], errors: ['Dòng tiêu đề phải bắt đầu tại ô A1.'] };
  }
  if (!rowCell(sheet, 0, 0) || !rowCell(sheet, 0, 1)) {
    return { rows: [], errors: ['Dòng tiêu đề phải bắt đầu tại ô A1.'] };
  }
  const hasAmbiguousMerge = (sheet['!merges'] ?? []).some(merge => (
    merge.s.r <= range.e.r && merge.e.r >= range.s.r && merge.s.c <= range.e.c && merge.e.c >= range.s.c
  ));
  if (hasAmbiguousMerge) return { rows: [], errors: ['Không hỗ trợ ô gộp trong vùng dữ liệu.'] };

  const headerCells = [rowCell(sheet, 0, 0), rowCell(sheet, 0, 1)];
  const headers = headerCells.map(cell => cleanCell(cell?.v));
  const extraHeaderCells = [];
  for (let column = 2; column <= range.e.c; column += 1) {
    const cell = rowCell(sheet, 0, column);
    if (cell?.f || cleanCell(cell?.v) !== '') extraHeaderCells.push(cell);
  }
  if (isBlankRow(headers) || extraHeaderCells.length || headers[0] !== SPREADSHEET_HEADERS[0] || headers[1] !== SPREADSHEET_HEADERS[1]) {
    return { rows: [], errors: [`Tiêu đề phải đúng hai cột: ${SPREADSHEET_HEADERS.join(' và ')}.`] };
  }
  if (hasFormula(sheet, 0, 0) || hasFormula(sheet, 0, 1) || extraHeaderCells.length) {
    return { rows: [], errors: ['Không hỗ trợ công thức trong tệp nhập.'] };
  }

  const rows = [];
  const errors = [];
  for (let index = 1; index <= range.e.r; index += 1) {
    const sourceCells = Array.from({ length: range.e.c + 1 }, (_, column) => rowCell(sheet, index, column));
    const hasFormulaInRow = sourceCells.some(cell => Boolean(cell?.f));
    const isRowBlank = sourceCells.every(cell => !cell?.f && cleanCell(cell?.v) === '');
    if (isRowBlank) continue;
    const rowNumber = index + 1;
    const rowErrors = [];
    const hasExtraData = sourceCells.slice(2).some(cell => cell?.f || cleanCell(cell?.v) !== '');
    if (hasExtraData) rowErrors.push(rowErrorMessage(rowNumber, 'Dòng có nhiều hơn hai ô dữ liệu.'));
    if (hasFormulaInRow) rowErrors.push(rowErrorMessage(rowNumber, 'Không hỗ trợ công thức trong tệp nhập.'));
    const kanji = cleanCell(sourceCells[0]?.v);
    const rawReading = cleanCell(sourceCells[1]?.v);
    if (!kanji) rowErrors.push(rowErrorMessage(rowNumber, 'Thiếu Kanji.'));
    else if (!HAN_CHARACTER.test(kanji)) rowErrors.push(rowErrorMessage(rowNumber, 'Kanji phải là đúng một ký tự Hán.'));
    if (!rawReading) rowErrors.push(rowErrorMessage(rowNumber, 'Thiếu âm Hán Việt.'));
    const readingResult = rawReading ? parseRawReadings(rawReading) : { readings: [], error: 'empty_input' };
    if (rawReading && readingResult.error) rowErrors.push(rowErrorMessage(rowNumber, 'Âm Hán Việt trống, trùng hoặc sai định dạng.'));
    // Reuse the canonical record validator for the shape while keeping the
    // reading syntax checks above explicit and user-facing.
    if (!rowErrors.length) {
      try { normalizeKanjiRecord({ kanji, hanViet: readingResult.readings }, { requireId: false }); }
      catch { rowErrors.push(rowErrorMessage(rowNumber, 'Dữ liệu Kanji không hợp lệ.')); }
    }
    rows.push({ rowNumber, kanji, hanViet: readingResult.readings, errors: rowErrors });
    errors.push(...rowErrors);
  }
  return { rows, errors };
}

/** Create a one-sheet workbook containing exactly the two required columns. */
export function createKanjiWorkbook(records = []) {
  if (!Array.isArray(records)) throw new TypeError('records must be an array.');
  const rows = [SPREADSHEET_HEADERS];
  for (const record of records) {
    const normalized = normalizeKanjiRecord(record, { requireId: false });
    rows.push([normalized.kanji, normalized.hanViet.join('/')]);
  }
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  sheet['!cols'] = [{ wch: 10 }, { wch: 32 }];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, 'Kanji');
  return workbook;
}

export function serializeKanjiWorkbook(records = []) {
  const workbook = createKanjiWorkbook(records);
  const bytes = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
  return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
}

