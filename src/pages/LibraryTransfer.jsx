import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, ArrowDownToLine, Check, FileSpreadsheet, RefreshCw, Upload, X } from 'lucide-react';
import { createKanjiRepository, openDatabase } from '../data/index.js';
import { commitKanjiImport } from '../data/importKanji.js';
import { planKanjiImport } from '../domain/importPlan.js';
import { getReadingCountLabel } from '../domain/readings.js';
import { saveBytes } from '../platform/files.js';
import './transfer.css';

const MAX_FILE_SIZE = 10 * 1024 * 1024;
const ACCEPTED_EXTENSIONS = new Set(['.xlsx', '.csv']);
const EMPTY_SUMMARY = Object.freeze({ added: 0, merged: 0, replaced: 0, skipped: 0, duplicates: 0 });

function extensionOf(name = '') {
  const lower = name.toLocaleLowerCase('en-US');
  const index = lower.lastIndexOf('.');
  return index < 0 ? '' : lower.slice(index);
}

function readableError(error, fallback = 'Không thể xử lý tệp. Vui lòng kiểm tra lại rồi thử lại.') {
  if (!error) return fallback;
  if (typeof error === 'string') return error;
  if (error.name === 'ImportConflictError') return 'Kho Kanji đã thay đổi sau khi bạn xem bản xem trước. Hãy cập nhật bản xem trước rồi xác nhận lại.';
  if (error.name === 'DuplicateKanjiError') return 'Tệp chứa Kanji trùng với dữ liệu hiện có. Chọn cách xử lý Kanji trùng rồi thử lại.';
  if (error.message?.toLocaleLowerCase('en-US').includes('size')) return 'Tệp vượt quá giới hạn 10 MB.';
  return fallback;
}

function errorText(error) {
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') return error.message || error.error || 'Dòng này không hợp lệ.';
  return 'Dòng này không hợp lệ.';
}

function rowReadings(row) {
  if (Array.isArray(row?.hanViet)) return row.hanViet;
  if (typeof row?.hanViet === 'string') return row.hanViet.split(/[\/;｜]/u).map(value => value.trim()).filter(Boolean);
  return [];
}

function summaryOf(value) {
  return { ...EMPTY_SUMMARY, ...(value || {}) };
}

export default function LibraryTransfer({ onImported, disabled = false, onBusyChange }) {
  const [preview, setPreview] = useState(null);
  const [policy, setPolicy] = useState('skip');
  const [plan, setPlan] = useState(null);
  const [confirmation, setConfirmation] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [conflict, setConflict] = useState(false);
  const [inputKey, setInputKey] = useState(0);
  const operationRef = useRef(0);
  const mountedRef = useRef(true);
  const busyRef = useRef(false);
  const fileInputRef = useRef(null);

  useEffect(() => {
    // StrictMode mounts, cleans up, and mounts effects once during development.
    // Reset the lifecycle flag on each setup so a replay cannot strand this
    // panel in its unmounted state.
    mountedRef.current = true;
    return () => {
      operationRef.current += 1;
      mountedRef.current = false;
      if (busyRef.current) {
        busyRef.current = false;
        onBusyChange?.(false);
      }
    };
  }, [onBusyChange]);

  const setOperationBusy = useCallback(value => {
    busyRef.current = value;
    if (mountedRef.current) {
      setBusy(value);
      onBusyChange?.(value);
    }
  }, [onBusyChange]);

  const resetMessages = useCallback(() => {
    setError('');
    setSuccess('');
    setConflict(false);
  }, []);

  const rowsHaveErrors = Boolean(preview?.errors?.length)
    || Boolean(preview?.rows?.some(row => Array.isArray(row.errors) && row.errors.length));
  const canPreview = Boolean(preview?.rows?.length) && !rowsHaveErrors && Boolean(plan);
  const planSummary = useMemo(() => summaryOf(plan?.summary), [plan]);

  const buildPlan = useCallback(async (rows, selectedPolicy, token) => {
    let db;
    try {
      db = await openDatabase();
      const existing = await createKanjiRepository(db).list();
      const nextPlan = planKanjiImport(existing, rows, selectedPolicy);
      if (mountedRef.current && token === operationRef.current) {
        setPlan(nextPlan);
        setConflict(false);
      }
      return nextPlan;
    } catch (nextError) {
      if (mountedRef.current && token === operationRef.current) {
        setPlan(null);
        setError(readableError(nextError, 'Không thể tạo kế hoạch nhập.'));
      }
      return null;
    } finally {
      db?.close();
    }
  }, []);

  const refreshPlan = useCallback(async () => {
    if (!preview?.rows?.length || rowsHaveErrors || disabled) return;
    const token = ++operationRef.current;
    resetMessages();
    setConfirmation(false);
    setOperationBusy(true);
    try {
      await buildPlan(preview.rows, policy, token);
    } finally {
      if (mountedRef.current && token === operationRef.current) setOperationBusy(false);
    }
  }, [buildPlan, disabled, policy, preview, resetMessages, rowsHaveErrors, setOperationBusy]);

  async function onFileChange(event) {
    if (disabled || busyRef.current) return;
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const token = ++operationRef.current;
    resetMessages();
    setPreview(null);
    setPlan(null);
    setPolicy('skip');
    setConfirmation(false);
    setOperationBusy(true);
    try {
      const extension = extensionOf(file.name);
      if (!ACCEPTED_EXTENSIONS.has(extension)) throw new Error('Chỉ hỗ trợ tệp .xlsx hoặc .csv.');
      if (file.size > MAX_FILE_SIZE) throw new Error('Tệp vượt quá giới hạn 10 MB.');
      const { readKanjiFile } = await import('../domain/spreadsheet.js');
      const parsed = await readKanjiFile(await file.arrayBuffer(), file.name);
      if (!mountedRef.current || token !== operationRef.current) return;
      const rows = Array.isArray(parsed?.rows) ? parsed.rows : [];
      const globalErrors = Array.isArray(parsed?.errors) ? parsed.errors : [];
      setPreview({ fileName: file.name, rows, errors: globalErrors });
      if (globalErrors.length || rows.some(row => Array.isArray(row.errors) && row.errors.length) || !rows.length) {
        if (!rows.length && !globalErrors.length) setError('Tệp không có dòng Kanji hợp lệ để nhập.');
        return;
      }
      await buildPlan(rows, 'skip', token);
    } catch (nextError) {
      if (mountedRef.current && token === operationRef.current) {
        setPreview(null);
        setPlan(null);
        setError(readableError(nextError, 'Không thể đọc tệp Excel hoặc CSV.'));
      }
    } finally {
      if (mountedRef.current && token === operationRef.current) setOperationBusy(false);
    }
  }

  async function changePolicy(event) {
    const nextPolicy = event.target.value;
    setPolicy(nextPolicy);
    setConfirmation(false);
    setSuccess('');
    setConflict(false);
    if (!preview?.rows?.length || rowsHaveErrors) return;
    const token = ++operationRef.current;
    setOperationBusy(true);
    try {
      await buildPlan(preview.rows, nextPolicy, token);
    } finally {
      if (mountedRef.current && token === operationRef.current) setOperationBusy(false);
    }
  }

  async function commitImport() {
    if (!canPreview || !confirmation || busy || busyRef.current || disabled || conflict) return;
    const token = ++operationRef.current;
    setOperationBusy(true);
    resetMessages();
    let db;
    try {
      db = await openDatabase();
      const result = await commitKanjiImport(db, preview.rows, policy, plan.snapshot);
      if (!mountedRef.current || token !== operationRef.current) return;
      const importedSummary = summaryOf(result);
      const processedRows = importedSummary.added + importedSummary.merged + importedSummary.replaced + importedSummary.skipped;
      setSuccess(`Đã xử lý ${processedRows} dòng: ${importedSummary.added} thêm, ${importedSummary.merged} gộp, ${importedSummary.replaced} thay thế, ${importedSummary.skipped} bỏ qua.`);
      setPreview(null);
      setPlan(null);
      setConfirmation(false);
      setConflict(false);
      setInputKey(key => key + 1);
      await onImported?.(result);
    } catch (nextError) {
      if (!mountedRef.current || token !== operationRef.current) return;
      if (nextError?.name === 'ImportConflictError') setConflict(true);
      setError(readableError(nextError, 'Không thể nhập dữ liệu. Không có thay đổi nào được lưu.'));
      setConfirmation(false);
    } finally {
      db?.close();
      if (mountedRef.current && token === operationRef.current) setOperationBusy(false);
    }
  }

  async function exportWorkbook(fileName, isTemplate = false) {
    if (busy || busyRef.current || disabled) return;
    const token = ++operationRef.current;
    setOperationBusy(true);
    resetMessages();
    let db;
    try {
      let records = [];
      if (!isTemplate) {
        db = await openDatabase();
        records = await createKanjiRepository(db).list();
      }
      const { serializeKanjiWorkbook } = await import('../domain/spreadsheet.js');
      const bytes = serializeKanjiWorkbook(records);
      const result = await saveBytes(bytes, fileName, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      if (result.saved && mountedRef.current && token === operationRef.current) {
        setSuccess(isTemplate ? 'Đã tải mẫu Excel hai cột.' : `Đã xuất ${records.length} Kanji thành tệp Excel.`);
      }
    } catch (nextError) {
      if (mountedRef.current && token === operationRef.current) setError(readableError(nextError, 'Không thể xuất tệp Excel.'));
    } finally {
      db?.close();
      if (mountedRef.current && token === operationRef.current) setOperationBusy(false);
    }
  }

  const rowCountText = preview ? `${preview.rows.length} dòng trong bản xem trước` : 'Chưa chọn tệp';
  return <section className="transfer-panel" aria-labelledby="transfer-title">
    <div className="transfer-heading">
      <div><p className="eyebrow">DỮ LIỆU NGOẠI TUYẾN</p><h2 id="transfer-title">Nhập và xuất Excel</h2><p className="muted">Tệp luôn có đúng hai cột: <strong>Kanji</strong> và <strong>Âm Hán Việt</strong>.</p></div>
      <div className="transfer-actions"><button className="button secondary" type="button" onClick={() => exportWorkbook('mau-kanji.xlsx', true)} disabled={disabled || busy}><FileSpreadsheet size={16} /> Tải mẫu Excel</button><button className="button secondary" type="button" onClick={() => exportWorkbook('kanji.xlsx')} disabled={disabled || busy}><ArrowDownToLine size={16} /> Xuất Excel</button></div>
    </div>

      <div className="transfer-file-row"><label className="transfer-file-picker" htmlFor="kanji-file-input"><Upload size={17} /><span>Chọn tệp Excel hoặc CSV</span><small>Tối đa 10 MB · .xlsx hoặc .csv</small><input aria-label="Chọn tệp Excel hoặc CSV" key={inputKey} ref={fileInputRef} id="kanji-file-input" type="file" accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={onFileChange} disabled={disabled || busy} /></label><div className="transfer-policy"><label htmlFor="duplicate-policy">Xử lý Kanji trùng</label><select id="duplicate-policy" value={policy} onChange={changePolicy} disabled={disabled || busy || !preview}><option value="skip">Bỏ qua</option><option value="merge">Gộp âm</option><option value="replace">Thay thế</option></select></div></div>

    {error && <div className="transfer-alert" role="alert"><AlertCircle size={17} /><span>{error}</span>{conflict && <button className="button secondary" type="button" onClick={refreshPlan} disabled={busy}><RefreshCw size={15} /> Cập nhật bản xem trước</button>}<button className="transfer-dismiss" type="button" aria-label="Đóng thông báo" onClick={() => setError('')}><X size={15} /></button></div>}
    {success && <div className="transfer-success" role="status"><Check size={17} /><span>{success}</span><button className="transfer-dismiss" type="button" aria-label="Đóng thông báo" onClick={() => setSuccess('')}><X size={15} /></button></div>}

    <div className="transfer-preview-meta"><span><strong>{rowCountText}</strong>{preview?.fileName && <> · {preview.fileName}</>}</span>{preview && <button className="text-button" type="button" onClick={() => { operationRef.current += 1; setPreview(null); setPlan(null); setConfirmation(false); resetMessages(); setInputKey(key => key + 1); }} disabled={busy}>Xóa bản xem trước</button>}</div>
    {preview?.errors?.length > 0 && <div className="transfer-global-errors" role="alert">{preview.errors.map((item, index) => <p key={index}>{errorText(item)}</p>)}</div>}
    {preview && <div className="transfer-preview-wrap"><table className="transfer-preview-table"><caption className="sr-only">Bản xem trước dữ liệu nhập</caption><thead><tr><th scope="col">Dòng</th><th scope="col">Kanji</th><th scope="col">Số âm</th><th scope="col">Âm Hán Việt</th><th scope="col">Kiểm tra</th></tr></thead><tbody>{preview.rows.map(row => { const readings = rowReadings(row); const errors = Array.isArray(row.errors) ? row.errors : []; return <tr className={errors.length ? 'has-error' : ''} key={row.rowNumber}><td>{row.rowNumber}</td><td className="transfer-kanji">{row.kanji || '—'}</td><td>{readings.length ? getReadingCountLabel(readings) : '—'}</td><td>{readings.length ? readings.join(' / ') : '—'}</td><td>{errors.length ? <span className="transfer-row-error">{errors.map(errorText).join(' ')}</span> : <span className="transfer-row-ok"><Check size={14} /> Hợp lệ</span>}</td></tr>; })}</tbody></table></div>}

    {preview && <div className={`transfer-plan${canPreview ? '' : ' transfer-plan-blocked'}`} aria-live="polite"><div className="transfer-plan-copy"><strong>{canPreview ? 'Sẵn sàng nhập' : 'Chưa thể nhập'}</strong><span>{canPreview ? `${planSummary.duplicates} dòng trùng · ${policy === 'skip' ? 'dòng trùng sẽ được bỏ qua' : policy === 'merge' ? 'âm mới sẽ được gộp vào bản ghi hiện có' : 'bản ghi hiện có sẽ được thay thế bằng dữ liệu trong tệp'}` : 'Sửa các lỗi trong bản xem trước trước khi xác nhận.'}</span></div>{canPreview && <div className="transfer-plan-stats"><span><b>{planSummary.added}</b> thêm</span><span><b>{planSummary.merged}</b> gộp</span><span><b>{planSummary.replaced}</b> thay thế</span><span><b>{planSummary.skipped}</b> bỏ qua</span></div>}<label className="transfer-confirm"><input type="checkbox" checked={confirmation} onChange={event => setConfirmation(event.target.checked)} disabled={!canPreview || busy || disabled} /> <span>Tôi xác nhận nhập dữ liệu theo bản xem trước</span></label><button className="button primary" type="button" onClick={commitImport} disabled={!canPreview || !confirmation || busy || disabled || conflict}>Xác nhận nhập</button></div>}
    {!preview && !error && <div className="transfer-empty"><FileSpreadsheet size={22} /><p>Chọn tệp để xem dữ liệu trước khi nhập.</p></div>}
  </section>;
}
