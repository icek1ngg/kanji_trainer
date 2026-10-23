import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, BookOpen, Check, ChevronDown, Edit3, Plus, RotateCw, Search, Trash2, X } from 'lucide-react';
import { createKanjiRepository, openDatabase } from '../data/index.js';
import { getReadingCountLabel, parseReadings } from '../domain/readings.js';
import { filterAndSortKanji } from '../domain/library.js';
import './library.css';
import LibraryTransfer from './LibraryTransfer.jsx';

const EMPTY_FORM = Object.freeze({ id: null, kanji: '', hanViet: '' });

const SORT_OPTIONS = [
  { value: 'kanji-asc', label: 'Kanji A → Z' },
  { value: 'kanji-desc', label: 'Kanji Z → A' },
  { value: 'reading-asc', label: 'Âm Hán Việt A → Z' },
  { value: 'count-desc', label: 'Nhiều âm trước' },
];

function explainError(error) {
  if (!error) return 'Đã có lỗi xảy ra. Vui lòng thử lại.';
  if (error.name === 'DuplicateKanjiError') return 'Kanji này đã tồn tại trong kho. Hãy kiểm tra ký tự và thử lại.';
  if (error.name === 'DataValidationError') {
    const field = error.details?.field;
    if (field === 'kanji') return 'Vui lòng nhập đúng một ký tự Kanji.';
    if (field?.startsWith('hanViet')) return 'Mỗi âm Hán Việt phải là chữ có dấu hợp lệ.';
    return 'Dữ liệu chưa hợp lệ. Vui lòng kiểm tra lại các trường.';
  }
  if (error.name === 'KanjiNotFoundError') return 'Kanji này không còn tồn tại. Kho đã được tải lại.';
  if (error.message?.includes('IndexedDB') || error.name === 'InvalidStateError') return 'Không thể mở dữ liệu trên thiết bị. Vui lòng thử lại.';
  return 'Không thể lưu thay đổi. Vui lòng thử lại.';
}

function formInitialValue(record) {
  return record ? { id: record.id, kanji: record.kanji, hanViet: record.hanViet.join('/') } : EMPTY_FORM;
}

export default function KanjiLibrary() {
  const [records, setRecords] = useState([]);
  const [transferBusy, setTransferBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState('kanji-asc');
  const [selected, setSelected] = useState(() => new Set());
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [actionError, setActionError] = useState('');
  const actionLock = useRef(false);
  const confirmDialogRef = useRef(null);
  const previousFocusRef = useRef(null);
  const addButtonRef = useRef(null);
  const deletingRef = useRef(false);
  deletingRef.current = deleting;

  const loadRecords = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    let db;
    try {
      db = await openDatabase();
      const repository = createKanjiRepository(db);
      setRecords(await repository.list());
    } catch (error) {
      setLoadError(explainError(error));
    } finally {
      db?.close();
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    (async () => {
      setLoading(true);
      setLoadError('');
      let db;
      try {
        db = await openDatabase();
        const nextRecords = await createKanjiRepository(db).list();
        if (active) setRecords(nextRecords);
      } catch (error) {
        if (active) setLoadError(explainError(error));
      } finally {
        db?.close();
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, []);

  useEffect(() => {
    setSelected(new Set());
  }, [query, sort]);

  useEffect(() => {
    if (!confirmDelete) return undefined;
    const dialog = confirmDialogRef.current;
    const focusable = () => [...dialog.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled])')];
    const first = focusable()[0];
    first?.focus();
    function handleKeyDown(event) {
      if (event.key === 'Escape') {
        if (!deletingRef.current) setConfirmDelete(null);
        event.preventDefault();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusable();
      if (!items.length) {
        event.preventDefault();
        return;
      }
      const firstItem = items[0];
      const lastItem = items[items.length - 1];
      if (event.shiftKey && document.activeElement === firstItem) {
        event.preventDefault();
        lastItem.focus();
      } else if (!event.shiftKey && document.activeElement === lastItem) {
        event.preventDefault();
        firstItem.focus();
      }
    }
    dialog?.addEventListener('keydown', handleKeyDown);
    return () => {
      dialog?.removeEventListener('keydown', handleKeyDown);
      const previous = previousFocusRef.current;
      if (previous?.isConnected) previous.focus();
      else addButtonRef.current?.focus();
      previousFocusRef.current = null;
    };
  }, [confirmDelete]);

  const visibleRecords = useMemo(() => filterAndSortKanji(records, query, sort), [records, query, sort]);
  const selectedVisible = visibleRecords.filter(record => selected.has(record.id));
  const allVisibleSelected = visibleRecords.length > 0 && selectedVisible.length === visibleRecords.length;
  const parsedFormReadings = useMemo(() => parseReadings(form.hanViet), [form.hanViet]);
  const formCount = parsedFormReadings.isValid ? getReadingCountLabel(parsedFormReadings.readings) : '';

  function openAddForm() {
    if (saving || deleting || transferBusy || confirmDelete || formOpen) return;
    setForm(formInitialValue());
    setFormError('');
    setActionError('');
    setFormOpen(true);
  }

  function openEditForm(record) {
    if (saving || deleting || transferBusy || confirmDelete || formOpen) return;
    setForm(formInitialValue(record));
    setFormError('');
    setActionError('');
    setFormOpen(true);
  }

  function closeForm() {
    if (saving || deleting || transferBusy) return;
    setFormOpen(false);
    setFormError('');
  }

  function toggleSelected(id) {
    setSelected(previous => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAllVisible() {
    setSelected(previous => {
      const next = new Set(previous);
      if (allVisibleSelected) visibleRecords.forEach(record => next.delete(record.id));
      else visibleRecords.forEach(record => next.add(record.id));
      return next;
    });
  }

  async function saveForm(event) {
    event.preventDefault();
    if (saving || transferBusy || actionLock.current) return;
    setFormError('');
    setActionError('');
    const kanji = form.kanji.normalize('NFC').trim();
    if (!kanji) {
      setFormError('Vui lòng nhập một ký tự Kanji.');
      return;
    }
    if (!parsedFormReadings.isValid) {
      setFormError('Nhập đầy đủ các âm Hán Việt, ngăn cách bằng /, ; hoặc ｜. Không dùng âm trống hay âm trùng.');
      return;
    }
    actionLock.current = true;
    setSaving(true);
    let db;
    try {
      db = await openDatabase();
      const repository = createKanjiRepository(db);
      const readingsToStore = form.hanViet.split(/[\/;｜]/u).map(reading => reading.normalize('NFC').trim());
      const payload = { kanji, hanViet: readingsToStore };
      if (form.id) await repository.update({ ...payload, id: form.id });
      else await repository.add(payload);
      setFormOpen(false);
      setForm(EMPTY_FORM);
      await loadRecords();
    } catch (error) {
      if (error.name === 'KanjiNotFoundError') {
        setFormOpen(false);
        setForm(EMPTY_FORM);
        setFormError('');
        setActionError('Kanji này không còn tồn tại. Kho đã được tải lại.');
        await loadRecords();
      } else {
        setFormError(explainError(error));
      }
    } finally {
      db?.close();
      actionLock.current = false;
      setSaving(false);
    }
  }

  function requestDelete(ids) {
    if (saving || deleting || transferBusy || confirmDelete || formOpen) return;
    const uniqueIds = [...new Set(ids)];
    const characters = uniqueIds.map(id => records.find(record => record.id === id)?.kanji).filter(Boolean);
    if (uniqueIds.length && characters.length) {
      setActionError('');
      previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setConfirmDelete({ ids: uniqueIds, characters });
    }
  }

  async function confirmDeletion() {
    if (!confirmDelete || actionLock.current) return;
    actionLock.current = true;
    setDeleting(true);
    setActionError('');
    let db;
    try {
      db = await openDatabase();
      const repository = createKanjiRepository(db);
      await repository.removeMany(confirmDelete.ids);
      setSelected(previous => {
        const next = new Set(previous);
        confirmDelete.ids.forEach(id => next.delete(id));
        return next;
      });
      await loadRecords();
      setConfirmDelete(null);
    } catch (error) {
      setActionError(explainError(error));
    } finally {
      db?.close();
      actionLock.current = false;
      setDeleting(false);
    }
  }

  return <div className="library-page">
    <div className="page-heading library-heading">
      <div><p className="eyebrow">BỘ SƯU TẬP CỦA BẠN</p><h1>Kho Kanji</h1><p className="muted">Quản lý Kanji và các âm Hán Việt bạn muốn ghi nhớ.</p></div>
      <div className="heading-actions"><button ref={addButtonRef} className="button primary" type="button" onClick={openAddForm} disabled={saving || deleting || transferBusy || Boolean(confirmDelete) || formOpen}><Plus size={17} /> Thêm Kanji</button></div>
    </div>

    <LibraryTransfer onImported={loadRecords} disabled={saving || deleting || formOpen || Boolean(confirmDelete)} onBusyChange={setTransferBusy} />

    {loadError && <div className="library-alert" role="alert"><AlertCircle size={18} /><span>{loadError}</span><button className="button secondary" type="button" onClick={loadRecords} disabled={saving || deleting || transferBusy || Boolean(confirmDelete)}><RotateCw size={15} /> Thử lại</button></div>}
    {actionError && <div className="library-alert" role="alert"><AlertCircle size={18} /><span>{actionError}</span><button className="icon-button" aria-label="Đóng thông báo" type="button" onClick={() => setActionError('')}><X size={16} /></button></div>}

    {formOpen && <section className="library-form-panel" aria-labelledby="library-form-title">
      <div className="library-form-heading"><div><p className="eyebrow">{form.id ? 'CHỈNH SỬA' : 'THÊM MỚI'}</p><h2 id="library-form-title">{form.id ? 'Chỉnh sửa Kanji' : 'Thêm Kanji vào kho'}</h2></div><button className="icon-button" type="button" onClick={closeForm} aria-label="Đóng biểu mẫu" disabled={saving || deleting || transferBusy}><X size={19} /></button></div>
      <form onSubmit={saveForm} noValidate>
      <div className="library-form-grid"><label>Kanji<input name="kanji" value={form.kanji} onChange={event => setForm(previous => ({ ...previous, kanji: event.target.value }))} autoComplete="off" autoFocus maxLength={4} placeholder="Ví dụ: 散" aria-label="Kanji" aria-describedby="kanji-help" disabled={saving || deleting || transferBusy} /><span id="kanji-help" className="field-hint">Nhập một ký tự Kanji.</span></label><label>Âm Hán Việt<input name="hanViet" value={form.hanViet} onChange={event => setForm(previous => ({ ...previous, hanViet: event.target.value }))} autoComplete="off" placeholder="Ví dụ: TÁN/TẢN" aria-label="Âm Hán Việt" aria-describedby="reading-help reading-count" disabled={saving || deleting || transferBusy} /><span id="reading-help" className="field-hint">Ngăn cách nhiều âm bằng /, ; hoặc ｜.</span>{formCount && <span id="reading-count" className="reading-count-preview"><Check size={14} /> Số âm: {formCount}</span>}</label></div>
        {formError && <p className="form-error" role="alert"><AlertCircle size={16} /> {formError}</p>}
        <div className="form-actions"><button className="button secondary" type="button" onClick={closeForm} disabled={saving || deleting || transferBusy}>Hủy</button><button className="button primary" type="submit" disabled={saving || deleting || transferBusy}>{saving ? 'Đang lưu…' : 'Lưu Kanji'}</button></div>
      </form>
    </section>}

    <section className="library-toolbar" aria-label="Bộ lọc kho Kanji"><label className="library-search"><Search size={17} /><span className="sr-only">Tìm Kanji hoặc âm Hán Việt</span><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Tìm Kanji hoặc âm Hán Việt" aria-label="Tìm Kanji hoặc âm Hán Việt" /></label><label className="library-sort"><span>Sắp xếp</span><span className="select-wrap"><select value={sort} onChange={event => setSort(event.target.value)} aria-label="Sắp xếp"><>{SORT_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</></select><ChevronDown size={16} /></span></label></section>

    <div className="library-summary"><span><strong>{records.length}</strong> Kanji trong kho{query && <> · <strong>{visibleRecords.length}</strong> kết quả</>}</span>{selected.size > 0 && <div className="bulk-actions"><span>Đã chọn {selected.size}</span><button className="button danger" type="button" onClick={() => requestDelete([...selected])} disabled={saving || deleting || transferBusy || Boolean(confirmDelete) || formOpen}><Trash2 size={15} /> Xóa đã chọn</button><button className="text-button" type="button" onClick={() => setSelected(new Set())} disabled={saving || deleting || transferBusy || Boolean(confirmDelete)}>Bỏ chọn</button></div>}</div>

    {loading ? <div className="library-state"><div className="loading-ring" aria-hidden="true" /><p>Đang mở kho Kanji…</p></div> : visibleRecords.length === 0 ? <div className="library-state empty"><span className="empty-icon"><BookOpen size={27} /></span><h2>{records.length === 0 ? 'Kho Kanji đang trống' : 'Không tìm thấy Kanji'}</h2><p>{records.length === 0 ? 'Thêm Kanji đầu tiên để bắt đầu xây dựng bộ sưu tập của bạn.' : 'Thử một từ khóa khác hoặc xóa bộ lọc tìm kiếm.'}</p>{records.length === 0 ? <button className="button primary" type="button" onClick={openAddForm} disabled={saving || deleting || transferBusy || Boolean(confirmDelete) || formOpen}><Plus size={17} /> Thêm Kanji đầu tiên</button> : <button className="button secondary" type="button" onClick={() => setQuery('')} disabled={saving || deleting || transferBusy || Boolean(confirmDelete)}>Xóa tìm kiếm</button>}</div> : <section className="library-table-wrap" aria-label="Danh sách Kanji"><div className="library-table-head"><label className="selection-control"><input type="checkbox" checked={allVisibleSelected} onChange={toggleAllVisible} aria-label="Chọn tất cả kết quả" disabled={saving || deleting || transferBusy || Boolean(confirmDelete) || formOpen} /><span>Chọn tất cả kết quả</span></label><span>{visibleRecords.length} mục</span></div><div className="library-list">{visibleRecords.map(record => <article className={`library-row${selected.has(record.id) ? ' selected' : ''}`} key={record.id}><label className="selection-control row-select"><input type="checkbox" checked={selected.has(record.id)} onChange={() => toggleSelected(record.id)} aria-label={`Chọn ${record.kanji}`} disabled={saving || deleting || transferBusy || Boolean(confirmDelete) || formOpen} /></label><div className="kanji-cell"><span className="kanji-glyph">{record.kanji}</span><span className="reading-count">{getReadingCountLabel(record.hanViet)}</span></div><div className="readings-cell"><span className="readings-label">Âm Hán Việt</span><strong>{record.hanViet.join(' / ')}</strong></div><div className="row-actions"><button className="icon-button" type="button" onClick={() => openEditForm(record)} aria-label={`Sửa ${record.kanji}`} disabled={saving || deleting || transferBusy || Boolean(confirmDelete) || formOpen}><Edit3 size={16} /></button><button className="icon-button danger-icon" type="button" onClick={() => requestDelete([record.id])} aria-label={`Xóa ${record.kanji}`} disabled={saving || deleting || transferBusy || Boolean(confirmDelete) || formOpen}><Trash2 size={16} /></button></div></article>)}</div></section>}

    {confirmDelete && <div className="confirm-backdrop"><section ref={confirmDialogRef} className="confirm-dialog" role="alertdialog" aria-label="Xác nhận xóa" aria-describedby="confirm-delete-description" aria-modal="true"><span className="confirm-icon"><Trash2 size={20} /></span><h2>Xóa {confirmDelete.ids.length > 1 ? `${confirmDelete.ids.length} Kanji` : 'Kanji'}?</h2><p id="confirm-delete-description">Bạn sắp xóa <strong>{confirmDelete.characters.join(', ')}</strong> khỏi kho. Dữ liệu sẽ được xóa khỏi thiết bị.</p><div className="form-actions"><button data-dialog-cancel className="button secondary" type="button" onClick={() => setConfirmDelete(null)} disabled={deleting}>Hủy xóa</button><button className="button danger" type="button" onClick={confirmDeletion} disabled={deleting}>{deleting ? 'Đang xóa…' : 'Xác nhận xóa'}</button></div></section></div>}
  </div>;
}
