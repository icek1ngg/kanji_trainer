import { selectPracticeRecords } from '../domain/practicePreferences.js';
import { readPreferences } from '../data/preferences.js';
import AnswerFeedback from '../components/AnswerFeedback.jsx';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, Check, Eye, EyeOff, LayoutList, LoaderCircle, RefreshCw, RotateCw, Shuffle, TriangleAlert } from 'lucide-react';
import { Link } from 'react-router-dom';
import { createKanjiRepository, openDatabase } from '../data/index.js';
import { createTablePracticeRepository } from '../data/tablePractice.js';
import {
  checkTableAnswer,
  getItemStatus,
  getTableItems,
  getTableStats,
  setTableAnswer,
  shuffleTableSession,
  toggleTableReveal,
} from '../domain/tableSession.js';
import { getReadingCountLabel } from '../domain/readings.js';
import './practice.css';

const FILTERS = [
  { value: 'all', label: 'Tất cả' },
  { value: 'correct', label: 'Đúng' },
  { value: 'incorrect', label: 'Sai' },
  { value: 'unanswered', label: 'Chưa kiểm tra' },
];

// Route changes unmount the page while an IndexedDB write may still be in
// flight. Keep the chain at module scope so the next page instance reads only
// after the previous instance has committed its latest draft.
let sharedSaveQueue = Promise.resolve();
let sharedSaveBlocked = false;

function copySession(session) {
  return { ...session, items: session.items.map(item => ({ ...item, hanViet: [...item.hanViet] })) };
}

function errorMessage(error) {
  if (!error) return 'Không thể lưu phiên học. Vui lòng thử lại.';
  if (error.name === 'PracticeConflictError') return 'Phiên học đã thay đổi ở thẻ khác. Các câu trả lời hiện tại vẫn được giữ lại.';
  if (error.name === 'InvalidRequiredReadingsError') return 'Kanji này có dữ liệu âm Hán Việt không hợp lệ, nên chưa thể chấm câu.';
  if (error.name === 'DataValidationError') return 'Dữ liệu Kanji không hợp lệ. Hãy kiểm tra lại kho Kanji.';
  if (error.message?.includes('IndexedDB')) return 'Không thể mở dữ liệu trên thiết bị. Vui lòng thử lại.';
  return 'Không thể lưu phiên học. Vui lòng thử lại.';
}

function cloneRecords(items) {
  return items.map(item => ({ id: item.id, kanji: item.kanji, hanViet: [...item.hanViet] }));
}

export default function TablePractice() {
  const [preferences] = useState(readPreferences);
  const [session, setSession] = useState(null);
  const [filter, setFilter] = useState('all');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [saveState, setSaveState] = useState('idle');
  const [dialogAction, setDialogAction] = useState(null);
  const [busyAction, setBusyAction] = useState(false);
  const sessionRef = useRef(null);
  const revisionRef = useRef(0);
  const nextRevisionRef = useRef(0);
  const pendingSavesRef = useRef(0);
  const saveErrorRef = useRef(null);
  const conflictRef = useRef(false);
  const actionLockRef = useRef(false);
  const mountedRef = useRef(false);
  const loadTokenRef = useRef(0);
  const dialogRef = useRef(null);
  const previousFocusRef = useRef(null);
  const busyActionRef = useRef(false);
  busyActionRef.current = busyAction;

  const applyLocal = useCallback(next => {
    sessionRef.current = next;
    setSession(next);
  }, []);

  const persist = useCallback((next, expectedRevision = next.revision) => {
    // The revision on a queued snapshot is the revision that the repository
    // expects to replace. Keeping this value on the local snapshot lets rapid
    // keystrokes serialize without overwriting a newer draft.
    const snapshot = copySession({ ...next, revision: expectedRevision });
    const expected = expectedRevision;
    if (sharedSaveBlocked) {
      const blockedError = saveErrorRef.current || new Error('Saving is paused until the latest draft is retried.');
      if (mountedRef.current) setSaveState('error');
      return Promise.reject(blockedError);
    }
    pendingSavesRef.current += 1;
    setSaveState('saving');
    const task = sharedSaveQueue.catch(() => undefined).then(async () => {
      let db;
      try {
        if (sharedSaveBlocked) throw saveErrorRef.current || new Error('Saving is paused until the latest draft is retried.');
        db = await openDatabase();
        const committed = await createTablePracticeRepository(db).save(snapshot, expected);
        revisionRef.current = committed.revision;
        saveErrorRef.current = null;
        if (sessionRef.current?.id === committed.id && sessionRef.current.revision === expected) {
          const latest = { ...sessionRef.current, revision: committed.revision, updatedAt: committed.updatedAt };
          sessionRef.current = latest;
          if (mountedRef.current) setSession(latest);
        }
        return committed;
      } catch (error) {
        sharedSaveBlocked = true;
        saveErrorRef.current = error;
        if (error?.name === 'PracticeConflictError') conflictRef.current = true;
        if (mountedRef.current) {
          setSaveState('error');
          setActionError(errorMessage(error));
        }
        throw error;
      } finally {
        pendingSavesRef.current = Math.max(0, pendingSavesRef.current - 1);
        if (mountedRef.current && pendingSavesRef.current === 0) {
          setSaveState(saveErrorRef.current ? 'error' : 'saved');
        }
        db?.close();
      }
    });
    sharedSaveQueue = task.catch(() => undefined);
    return task;
  }, []);

  const loadSession = useCallback(async () => {
    const token = ++loadTokenRef.current;
    setLoading(true);
    setLoadError('');
    setActionError('');
    let db;
    try {
      await sharedSaveQueue.catch(() => undefined);
      sharedSaveBlocked = false;
      db = await openDatabase();
      const records = await createKanjiRepository(db).list();
      if (!records.length) {
        if (mountedRef.current && token === loadTokenRef.current) {
          applyLocal(null);
          setLoading(false);
        }
        return;
      }
      const repository = createTablePracticeRepository(db);
      const loaded = await repository.loadOrCreate(records, { size: readPreferences().practiceSize });
      if (mountedRef.current && token === loadTokenRef.current) {
        const snapshot = copySession(loaded);
        sessionRef.current = snapshot;
        revisionRef.current = snapshot.revision;
        nextRevisionRef.current = snapshot.revision;
        saveErrorRef.current = null;
        conflictRef.current = false;
        setSession(snapshot);
        setFilter('all');
        setSaveState('saved');
        setLoading(false);
      }
    } catch (error) {
      if (mountedRef.current && token === loadTokenRef.current) {
        setLoadError(errorMessage(error));
        setLoading(false);
      }
    } finally {
      db?.close();
    }
  }, [applyLocal]);

  useEffect(() => {
    if (!dialogAction) return undefined;
    previousFocusRef.current = document.activeElement;
    const dialog = dialogRef.current;
    const focusable = () => [...(dialog?.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled])') || [])];
    focusable()[0]?.focus();
    function handleKeyDown(event) {
      if (event.key === 'Escape') {
        if (!busyActionRef.current) setDialogAction(null);
        event.preventDefault();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusable();
      if (!items.length) {
        event.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    dialog?.addEventListener('keydown', handleKeyDown);
    return () => {
      dialog?.removeEventListener('keydown', handleKeyDown);
      const previous = previousFocusRef.current;
      if (previous?.isConnected) previous.focus();
      previousFocusRef.current = null;
    };
  }, [dialogAction]);

  useEffect(() => {
    mountedRef.current = true;
    loadSession();
    return () => {
      mountedRef.current = false;
      loadTokenRef.current += 1;
    };
  }, [loadSession]);

  const stats = useMemo(() => (session ? getTableStats(session) : {
    total: 0, correct: 0, incorrect: 0, unanswered: 0, checked: 0, progress: 0, checks: 0, correctChecks: 0, incorrectChecks: 0, accuracy: 0,
  }), [session]);
  const visibleItems = useMemo(() => (session ? getTableItems(session, filter) : []), [session, filter]);

  function focusInput(id) {
    const escape = globalThis.CSS?.escape
      ? globalThis.CSS.escape(id)
      : String(id).replace(/(["\\])/g, '\\$1');
    const schedule = window.requestAnimationFrame || (callback => window.setTimeout(callback, 0));
    schedule(() => document.querySelector(`[data-practice-input="${escape}"]`)?.focus());
  }

  function focusNext(id) {
    const index = visibleItems.findIndex(item => item.id === id);
    const next = visibleItems[index + 1];
    if (next) focusInput(next.id);
  }

  function applyMutation(mutator) {
    const current = sessionRef.current;
    if (!current) return null;
    const paused = sharedSaveBlocked;
    const expected = paused ? current.revision : nextRevisionRef.current;
    const mutated = mutator(current);
    const next = { ...mutated, revision: expected };
    if (!paused) nextRevisionRef.current = expected + 1;
    applyLocal(next);
    return { next, expected, paused };
  }

  async function waitForSaves() {
    await sharedSaveQueue;
    if (saveErrorRef.current) throw saveErrorRef.current;
  }

  function updateDraft(id, answer) {
    if (!sessionRef.current || dialogAction || actionLockRef.current) return;
    const change = applyMutation(previous => {
      const next = setTableAnswer(previous, id, answer);
      const item = next.items.find(entry => entry.id === id);
      const previousItem = previous.items.find(entry => entry.id === id);
      // A reveal belongs to the previous draft. Hide it as soon as the user
      // starts editing so the old answer cannot be mistaken for feedback on
      // the new draft.
      if (item && previousItem && item.answer !== previousItem.answer) item.revealed = false;
      return next;
    });
    if (change && !change.paused) void persist(change.next, change.expected).catch(() => undefined);
  }

  async function submitAnswer(id) {
    if (dialogAction || actionLockRef.current) return;
    const current = sessionRef.current;
    const item = current?.items.find(entry => entry.id === id);
    if (!item) return;
    if (item.checkedAnswer !== null && item.checkedAnswer === item.answer && item.result !== null) {
      focusNext(id);
      return;
    }
    try {
      const change = applyMutation(previous => checkTableAnswer(previous, id));
      if (change && !change.paused) await persist(change.next, change.expected);
    } catch (error) {
      setActionError(errorMessage(error));
    }
  }

  function handleInputKeyDown(event, id) {
    if (event.key !== 'Enter' || event.isComposing || event.nativeEvent?.isComposing) return;
    event.preventDefault();
    submitAnswer(id);
  }

  function revealAnswer(id) {
    if (dialogAction || actionLockRef.current) return;
    const change = applyMutation(previous => toggleTableReveal(previous, id));
    if (change && !change.paused) void persist(change.next, change.expected).catch(() => undefined);
  }

  async function shuffle() {
    if (!sessionRef.current || actionLockRef.current) return;
    actionLockRef.current = true;
    try {
      await waitForSaves();
      const change = applyMutation(previous => shuffleTableSession(previous));
      if (change) await persist(change.next, change.expected);
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      actionLockRef.current = false;
    }
  }

  function openAction(action) {
    if (!sessionRef.current || actionLockRef.current) return;
    if (action === 'retry' && !getTableItems(sessionRef.current, 'incorrect').length) {
      setActionError('Chưa có câu sai để luyện lại.');
      return;
    }
    setActionError('');
    setDialogAction(action);
  }

  async function confirmAction() {
    if (!dialogAction || !sessionRef.current || busyAction || actionLockRef.current) return;
    actionLockRef.current = true;
    setBusyAction(true);
    setActionError('');
    try {
      if (dialogAction === 'reload') {
        await sharedSaveQueue.catch(() => undefined);
        setDialogAction(null);
        await loadSession();
        return;
      }
      await waitForSaves();
      let db;
      try {
        db = await openDatabase();
        const records = dialogAction === 'retry'
          ? cloneRecords(getTableItems(sessionRef.current, 'incorrect'))
          : selectPracticeRecords(await createKanjiRepository(db).list(), readPreferences().practiceSize);
        const next = await createTablePracticeRepository(db).startNew(records, sessionRef.current);
        applyLocal(next);
        revisionRef.current = next.revision;
        nextRevisionRef.current = next.revision;
        setFilter('all');
        setSaveState('saved');
        saveErrorRef.current = null;
        conflictRef.current = false;
        setDialogAction(null);
      } finally { db?.close(); }
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setBusyAction(false);
      actionLockRef.current = false;
    }
  }

  function requestReloadAfterConflict() {
    if (!actionLockRef.current) setDialogAction('reload');
  }

  async function retrySave() {
    if (busyAction || actionLockRef.current || conflictRef.current || !sessionRef.current) return;
    actionLockRef.current = true;
    setActionError('');
    try {
      await sharedSaveQueue;
      if (!saveErrorRef.current) return;
      // Rebase the latest local draft on the last known committed revision.
      // This writes the final draft once and avoids replaying failed keystroke
      // saves after an IndexedDB interruption.
      const rebased = { ...sessionRef.current, revision: revisionRef.current };
      sessionRef.current = rebased;
      nextRevisionRef.current = revisionRef.current + 1;
      if (mountedRef.current) setSession(rebased);
      saveErrorRef.current = null;
      sharedSaveBlocked = false;
      await persist(rebased, revisionRef.current);
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      actionLockRef.current = false;
    }
  }

  if (loading) return <section className="practice-page"><div className="practice-state"><LoaderCircle className="practice-spin" size={25} /><p>Đang mở phiên luyện tập…</p></div></section>;
  if (loadError) return <section className="practice-page"><div className="practice-state practice-error"><TriangleAlert size={28} /><h1>Không thể mở phiên học</h1><p>{loadError}</p><button className="button secondary" type="button" onClick={() => loadSession()}><RefreshCw size={16} /> Thử lại</button></div></section>;
  if (!session) return <section className="practice-page"><div className="practice-heading"><p className="eyebrow">LUYỆN TẬP</p><h1>Luyện tập</h1></div><div className="practice-state"><LayoutList size={32} /><h2>Kho Kanji đang trống</h2><p>Thêm Kanji vào kho trước khi bắt đầu luyện tập.</p><Link className="button primary" to="/library">Mở Kho Kanji <ArrowRight size={16} /></Link></div></section>;

  const saveLabel = saveState === 'saving' ? 'Đang lưu…' : saveState === 'error' ? 'Chưa lưu được' : 'Đã lưu trên thiết bị';
  return <section className="practice-page">
    <div className="practice-heading"><div><p className="eyebrow">LUYỆN TẬP</p><h1>Luyện tập</h1><p className="muted">Nhập đầy đủ các âm Hán Việt của từng Kanji. Âm được cập nhật khi mở lại phiên; Kanji mới được thêm bằng cách đặt lại phiên.</p></div><span className="phase-badge">Phiên hiện tại</span></div>
    <div className="practice-toolbar"><div className="practice-progress"><div className="practice-progress-line"><span>Tiến độ phiên</span><strong>{stats.checked}/{stats.total}</strong></div><progress aria-label="Tiến độ phiên" value={stats.progress} max="100" /> </div><div className="practice-actions"><button className="button secondary" type="button" onClick={shuffle}><Shuffle size={16} /> Trộn thứ tự</button><button className="button secondary" type="button" onClick={() => openAction('retry')} disabled={!stats.incorrect}><RotateCw size={16} /> Luyện lại câu sai</button><button className="button secondary" type="button" onClick={() => openAction('reset')}><RefreshCw size={16} /> Đặt lại phiên</button></div></div>
    <div className="practice-meta"><div className="practice-stats"><span><strong>{stats.checked}</strong> đã kiểm tra</span><span className="stat-correct"><strong>{stats.correct}</strong> đúng</span><span className="stat-incorrect"><strong>{stats.incorrect}</strong> sai</span><span><strong>{stats.accuracy}%</strong> chính xác</span><span><strong>{stats.checks}</strong> lượt kiểm tra</span></div><label className="practice-filter">Lọc trạng thái<select aria-label="Lọc trạng thái" value={filter} onChange={event => setFilter(event.target.value)}>{FILTERS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label></div>
    {actionError && <div className="practice-alert" role="alert"><TriangleAlert size={17} /><span>{actionError}</span>{actionError.includes('thay đổi') && <button className="text-button" type="button" onClick={requestReloadAfterConflict}>Tải lại phiên</button>}<button className="icon-button" type="button" aria-label="Đóng thông báo" onClick={() => setActionError('')}><span aria-hidden="true">×</span></button></div>}
    <div className="practice-save-status" role="status" aria-live="polite">{saveState === 'saving' ? <LoaderCircle className="practice-spin" size={14} /> : saveState === 'error' ? <TriangleAlert size={14} /> : <Check size={14} />} <span>{saveLabel}</span>{saveState === 'error' && !conflictRef.current && <button className="text-button" type="button" onClick={retrySave}>Thử lưu lại</button>}</div>
    {visibleItems.length === 0 ? <div className="practice-state practice-filter-empty">{stats.total === 0 ? <><LayoutList size={30} /><h2>Phiên học chưa có Kanji</h2><p>Đặt lại phiên để nạp các Kanji hiện có trong kho. Các Kanji mới chỉ được thêm vào khi bắt đầu phiên mới.</p><button className="button secondary" type="button" onClick={() => openAction('reset')}>Đặt lại phiên</button></> : <><h2>Không có câu trong bộ lọc này</h2><p>Chọn một bộ lọc khác để xem các Kanji trong phiên.</p><button className="button secondary" type="button" onClick={() => setFilter('all')}>Xem tất cả</button></>}</div> : <div className="practice-table-wrap"><div className="practice-table-head"><span>Kanji</span><span>Âm Hán Việt</span><span>Trạng thái</span></div><div className="practice-list">{visibleItems.map(item => { const status = getItemStatus(item); const shown = item.revealed; return <article className={`practice-row status-${status}`} data-kanji={item.kanji} key={item.id}><div className="practice-kanji"><span className="practice-glyph">{item.kanji}</span><span className="practice-count">{getReadingCountLabel(item.hanViet)}</span></div><div className="practice-answer"><input data-practice-input={item.id} aria-label={`Âm Hán Việt cho ${item.kanji}`} value={item.answer} onChange={event => updateDraft(item.id, event.target.value)} onKeyDown={event => handleInputKeyDown(event, item.id)} autoComplete="off" placeholder="Nhập tất cả âm…" /><div className="practice-answer-actions"><button className="text-button" type="button" onClick={() => revealAnswer(item.id)}>{shown ? <><EyeOff size={14} /> Ẩn đáp án {item.kanji}</> : <><Eye size={14} /> Hiện đáp án {item.kanji}</>}</button>{shown && <span className="revealed-answer">{item.hanViet.join(' / ')}</span>}</div></div><div className="practice-result"><AnswerFeedback item={item} mode={preferences.feedback} /><span className="practice-status-label">{status === 'correct' ? 'Đúng' : status === 'incorrect' ? 'Sai' : 'Chưa kiểm tra'}</span><button className="button primary practice-check" type="button" onClick={() => submitAnswer(item.id)} aria-label={`Kiểm tra ${item.kanji}`}>Kiểm tra</button></div></article>; })}</div></div>}
    {dialogAction && <div className="practice-dialog-backdrop"><div ref={dialogRef} className="practice-dialog" role="dialog" aria-label={dialogAction === 'retry' ? 'Luyện lại câu sai' : dialogAction === 'reload' ? 'Tải lại phiên' : 'Đặt lại phiên'} aria-modal="true"><span className="practice-dialog-icon"><RefreshCw size={20} /></span><h2>{dialogAction === 'retry' ? 'Luyện lại câu sai?' : dialogAction === 'reload' ? 'Tải lại phiên?' : 'Đặt lại phiên?'}</h2><p>{dialogAction === 'retry' ? 'Một phiên mới chỉ gồm các Kanji đang sai sẽ được tạo. Phiên hiện tại vẫn được lưu.' : dialogAction === 'reload' ? 'Các bản nháp chưa lưu trên thiết bị sẽ bị bỏ. Tải lại phiên hiện tại từ dữ liệu mới nhất?' : 'Phiên mới sẽ dùng bộ Kanji hiện có trong kho. Các câu trả lời của phiên này vẫn được lưu.'}</p><div className="form-actions"><button className="button secondary" type="button" onClick={() => setDialogAction(null)} disabled={busyAction}>Hủy</button><button className="button primary" type="button" onClick={confirmAction} disabled={busyAction}>{busyAction ? 'Đang tải…' : dialogAction === 'retry' ? 'Xác nhận luyện lại' : dialogAction === 'reload' ? 'Xác nhận tải lại' : 'Xác nhận đặt lại'}</button></div></div></div>}
  </section>;
}
