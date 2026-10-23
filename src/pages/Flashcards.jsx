import { readPreferences } from '../data/preferences.js';
import AnswerFeedback from '../components/AnswerFeedback.jsx';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Eye,
  EyeOff,
  Layers,
  LoaderCircle,
  RefreshCw,
  RotateCw,
  TriangleAlert,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { createKanjiRepository, openDatabase } from '../data/index.js';
import { createFlashcardPracticeRepository } from '../data/flashcardPractice.js';
import {
  checkFlashcardAnswer,
  getFlashcardRetryRecords,
  getFlashcardStats,
  getFlashcardStatus,
  moveFlashcard,
  setFlashcardAnswer,
  toggleFlashcardReveal,
} from '../domain/flashcardSession.js';
import { getReadingCountLabel } from '../domain/readings.js';
import './flashcards.css';

const SIZE_OPTIONS = [
  { value: 'all', label: 'Tất cả' },
  { value: '10', label: '10' },
  { value: '20', label: '20' },
  { value: '50', label: '50' },
  { value: '100', label: '100' },
];

const ORDER_OPTIONS = [
  { value: 'sequential', label: 'Tuần tự' },
  { value: 'random', label: 'Ngẫu nhiên' },
];

// A page can be unmounted while an IndexedDB write is in flight. Keeping the
// chain at module scope lets the next page instance wait for that write before
// it loads a session or starts another one.
let sharedFlashcardSaveQueue = Promise.resolve();
let sharedFlashcardSaveBlocked = false;
let sharedFlashcardSaveError = null;

function copySession(session) {
  if (!session) return null;
  return {
    ...session,
    items: Array.isArray(session?.items)
      ? session.items.map(item => ({ ...item, hanViet: [...item.hanViet] }))
      : [],
  };
}

function cloneRecords(items) {
  return items.map(item => ({ id: item.id, kanji: item.kanji, hanViet: [...item.hanViet] }));
}

function errorMessage(error) {
  if (!error) return 'Không thể lưu phiên Flashcard. Vui lòng thử lại.';
  if (error.name === 'FlashcardConflictError') {
    return 'Phiên Flashcard đã thay đổi ở thẻ khác. Các bản nháp hiện tại vẫn được giữ lại.';
  }
  if (error.name === 'InvalidRequiredReadingsError') {
    return 'Kanji này có dữ liệu âm Hán Việt không hợp lệ, nên chưa thể chấm câu.';
  }
  if (error.name === 'DataValidationError') return 'Dữ liệu Kanji không hợp lệ. Hãy kiểm tra lại kho Kanji.';
  if (error.message?.includes('IndexedDB')) return 'Không thể mở dữ liệu trên thiết bị. Vui lòng thử lại.';
  return 'Không thể lưu phiên Flashcard. Vui lòng thử lại.';
}

function sizeLabel(value) {
  const option = SIZE_OPTIONS.find(item => item.value === String(value));
  if (option?.value === 'all') return option.label;
  return option ? `${option.label} thẻ` : `${value} thẻ`;
}

function orderLabel(value) {
  return ORDER_OPTIONS.find(item => item.value === value)?.label || value;
}

export default function Flashcards() {
  const [preferences] = useState(readPreferences);
  const [session, setSession] = useState(null);
  const [pendingSize, setPendingSize] = useState('all');
  const [pendingOrder, setPendingOrder] = useState('sequential');
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
    const snapshot = copySession(next);
    sessionRef.current = snapshot;
    setSession(snapshot);
  }, []);

  const persist = useCallback((next, expectedRevision = next.revision) => {
    const snapshot = copySession({ ...next, revision: expectedRevision });
    const expected = expectedRevision;
    if (sharedFlashcardSaveBlocked) {
      const blockedError = sharedFlashcardSaveError || new Error('Saving is paused until the latest draft is retried.');
      if (mountedRef.current) setSaveState('error');
      return Promise.reject(blockedError);
    }

    pendingSavesRef.current += 1;
    if (mountedRef.current) setSaveState('saving');
    const task = sharedFlashcardSaveQueue.catch(() => undefined).then(async () => {
      let db;
      try {
        if (sharedFlashcardSaveBlocked) throw sharedFlashcardSaveError || new Error('Saving is paused until the latest draft is retried.');
        db = await openDatabase();
        const committed = await createFlashcardPracticeRepository(db).save(snapshot, expected);
        revisionRef.current = committed.revision;
        sharedFlashcardSaveError = null;
        saveErrorRef.current = null;
        if (sessionRef.current?.id === committed.id && sessionRef.current.revision === expected) {
          const latest = { ...sessionRef.current, revision: committed.revision, updatedAt: committed.updatedAt };
          sessionRef.current = latest;
          if (mountedRef.current) setSession(latest);
        }
        return committed;
      } catch (error) {
        sharedFlashcardSaveBlocked = true;
        sharedFlashcardSaveError = error;
        saveErrorRef.current = error;
        if (error?.name === 'FlashcardConflictError') conflictRef.current = true;
        if (mountedRef.current) {
          setSaveState('error');
          setActionError(errorMessage(error));
        }
        throw error;
      } finally {
        pendingSavesRef.current = Math.max(0, pendingSavesRef.current - 1);
        if (mountedRef.current && pendingSavesRef.current === 0) {
          setSaveState(sharedFlashcardSaveError ? 'error' : 'saved');
        }
        db?.close();
      }
    });
    sharedFlashcardSaveQueue = task.catch(() => undefined);
    return task;
  }, []);

  const loadSession = useCallback(async () => {
    const token = ++loadTokenRef.current;
    setLoading(true);
    setLoadError('');
    setActionError('');
    let db;
    try {
      await sharedFlashcardSaveQueue.catch(() => undefined);
      db = await openDatabase();
      const records = await createKanjiRepository(db).list();
      if (!records.length) {
        sharedFlashcardSaveBlocked = false;
        sharedFlashcardSaveError = null;
        saveErrorRef.current = null;
        conflictRef.current = false;
        if (mountedRef.current && token === loadTokenRef.current) {
          applyLocal(null);
          setSaveState('idle');
          setLoading(false);
        }
        return;
      }
      const loaded = await createFlashcardPracticeRepository(db).loadOrCreate(records, {
        size: readPreferences().practiceSize === 'all' ? 'all' : Number(readPreferences().practiceSize),
        order: 'sequential',
      });
      sharedFlashcardSaveBlocked = false;
      sharedFlashcardSaveError = null;
      if (mountedRef.current && token === loadTokenRef.current) {
        const snapshot = copySession(loaded);
        sessionRef.current = snapshot;
        revisionRef.current = snapshot.revision;
        nextRevisionRef.current = snapshot.revision;
        saveErrorRef.current = null;
        conflictRef.current = false;
        setSession(snapshot);
        const preferredSize = readPreferences().practiceSize;
        setPendingSize(preferredSize !== (snapshot.defaultPracticeSize ?? 'all')
          ? preferredSize : String(snapshot.size ?? 'all'));
        setPendingOrder(snapshot.order || 'sequential');
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

  const stats = useMemo(() => (session ? getFlashcardStats(session) : {
    total: 0,
    correct: 0,
    incorrect: 0,
    unanswered: 0,
    checked: 0,
    progress: 0,
    checks: 0,
    correctChecks: 0,
    incorrectChecks: 0,
    accuracy: 0,
    completed: false,
  }), [session]);
  const currentItem = session?.items?.[session.position] || null;

  function applyMutation(mutator) {
    const current = sessionRef.current;
    if (!current) return null;
    const paused = sharedFlashcardSaveBlocked;
    const expected = paused ? current.revision : nextRevisionRef.current;
    const mutated = mutator(current);
    const next = { ...mutated, revision: expected };
    if (!paused) nextRevisionRef.current = expected + 1;
    applyLocal(next);
    return { next, expected, paused };
  }

  async function waitForSaves() {
    await sharedFlashcardSaveQueue;
    if (sharedFlashcardSaveError) throw sharedFlashcardSaveError;
  }

  function updateDraft(id, answer) {
    if (!sessionRef.current || dialogAction || actionLockRef.current) return;
    const change = applyMutation(previous => {
      const next = setFlashcardAnswer(previous, id, answer);
      const item = next.items.find(entry => entry.id === id);
      const previousItem = previous.items.find(entry => entry.id === id);
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
    if (item.checkedAnswer !== null && item.checkedAnswer === item.answer && item.result !== null) return;
    try {
      const change = applyMutation(previous => checkFlashcardAnswer(previous, id));
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
    const change = applyMutation(previous => toggleFlashcardReveal(previous, id));
    if (change && !change.paused) void persist(change.next, change.expected).catch(() => undefined);
  }

  async function changePosition(position) {
    if (!sessionRef.current || actionLockRef.current || dialogAction) return;
    try {
      // Navigation is a local transition, just like typing. Queue its snapshot
      // without locking an input that is still visible and editable.
      const change = applyMutation(previous => moveFlashcard(previous, position));
      if (change && !change.paused) {
        await persist(change.next, change.expected);
      }
    } catch (error) {
      setActionError(errorMessage(error));
    }
  }

  function openAction(action) {
    if (!sessionRef.current || actionLockRef.current) return;
    if (action === 'retry' && !stats.incorrect) {
      setActionError('Chưa có thẻ sai để luyện lại.');
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
        await sharedFlashcardSaveQueue.catch(() => undefined);
        setDialogAction(null);
        await loadSession();
        return;
      }
      await waitForSaves();
      let db;
      try {
        db = await openDatabase();
        const records = dialogAction === 'retry'
          ? cloneRecords(getFlashcardRetryRecords(sessionRef.current))
          : await createKanjiRepository(db).list();
        const next = await createFlashcardPracticeRepository(db).startNew(records, sessionRef.current, {
          size: dialogAction === 'retry' ? 'all' : pendingSize,
          order: pendingOrder,
        });
        applyLocal(next);
        revisionRef.current = next.revision;
        nextRevisionRef.current = next.revision;
        setPendingSize(String(next.size ?? pendingSize));
        setPendingOrder(next.order || pendingOrder);
        setSaveState('saved');
        saveErrorRef.current = null;
        conflictRef.current = false;
        sharedFlashcardSaveBlocked = false;
        sharedFlashcardSaveError = null;
        setDialogAction(null);
      } finally {
        db?.close();
      }
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
      await sharedFlashcardSaveQueue;
      if (!sharedFlashcardSaveError) return;
      const rebased = { ...sessionRef.current, revision: revisionRef.current };
      sessionRef.current = rebased;
      nextRevisionRef.current = revisionRef.current + 1;
      if (mountedRef.current) setSession(copySession(rebased));
      saveErrorRef.current = null;
      sharedFlashcardSaveError = null;
      sharedFlashcardSaveBlocked = false;
      await persist(rebased, revisionRef.current);
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      actionLockRef.current = false;
    }
  }

  if (loading) {
    return <section className="flashcards-page"><div className="flashcards-state"><LoaderCircle className="flashcards-spin" size={26} /><p>Đang mở phiên Flashcard…</p></div></section>;
  }
  if (loadError) {
    return <section className="flashcards-page"><div className="flashcards-state flashcards-error"><TriangleAlert size={28} /><h1>Không thể mở Flashcard</h1><p>{loadError}</p><button className="button secondary" type="button" onClick={() => loadSession()}><RefreshCw size={16} /> Thử lại</button></div></section>;
  }
  if (!session) {
    return <section className="flashcards-page"><div className="flashcards-heading"><div><p className="eyebrow">FLASHCARD</p><h1>Flashcard</h1></div></div><div className="flashcards-state"><Layers size={32} /><h2>Kho Kanji đang trống</h2><p>Thêm Kanji vào kho trước khi bắt đầu học Flashcard.</p><Link className="button primary" to="/library">Mở Kho Kanji <ArrowRight size={16} /></Link></div></section>;
  }

  const saveLabel = saveState === 'saving' ? 'Đang lưu…' : saveState === 'error' ? 'Chưa lưu được' : saveState === 'saved' ? 'Đã lưu trên thiết bị' : '';
  const status = currentItem ? getFlashcardStatus(currentItem) : 'unanswered';
  const actualPosition = session.items.length ? Math.min(Math.max(session.position, 0), session.items.length - 1) : 0;
  const isFirst = actualPosition <= 0;
  const isLast = actualPosition >= session.items.length - 1;

  return <section className="flashcards-page">
    <div className="flashcards-heading">
      <div><p className="eyebrow">FLASHCARD</p><h1>Flashcard</h1><p className="muted">Tập trung vào từng Kanji. Kiểm tra đủ âm Hán Việt rồi chuyển sang thẻ kế tiếp khi bạn sẵn sàng.</p></div>
      <span className="phase-badge">Phiên hiện tại</span>
    </div>

    <div className="flashcards-toolbar">
      <div className="flashcards-progress"><div className="flashcards-progress-line"><span>Tiến độ Flashcard</span><strong>{stats.checked}/{stats.total}</strong></div><progress aria-label="Tiến độ Flashcard" value={stats.progress} max="100" /></div>
      <div className="flashcards-actions"><button className="button secondary" type="button" onClick={() => openAction('retry')} disabled={!stats.incorrect || busyAction}><RotateCw size={16} /> Luyện lại thẻ sai</button><button className="button secondary" type="button" onClick={() => openAction('new')} disabled={busyAction}><RefreshCw size={16} /> Bắt đầu phiên mới</button></div>
    </div>

    <div className="flashcards-config">
      <div className="flashcards-config-fields">
        <label>Số thẻ<select aria-label="Số thẻ" value={pendingSize} onChange={event => setPendingSize(event.target.value)} disabled={busyAction}>{SIZE_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
        <label>Thứ tự<select aria-label="Thứ tự" value={pendingOrder} onChange={event => setPendingOrder(event.target.value)} disabled={busyAction}>{ORDER_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
      </div>
      <div className="flashcards-current-config"><span>Phiên hiện tại</span><strong>{sizeLabel(session.size)} · {orderLabel(session.order)}</strong></div>
    </div>

    {actionError && <div className="flashcards-alert" role="alert"><TriangleAlert size={17} /><span>{actionError}</span>{actionError.includes('thay đổi') && <button className="text-button" type="button" onClick={requestReloadAfterConflict}>Tải lại phiên</button>}<button className="icon-button" type="button" aria-label="Đóng thông báo" onClick={() => setActionError('')}><span aria-hidden="true">×</span></button></div>}
    {saveLabel && <div className="flashcards-save-status" role="status" aria-live="polite">{saveState === 'saving' ? <LoaderCircle className="flashcards-spin" size={14} /> : saveState === 'error' ? <TriangleAlert size={14} /> : <Check size={14} />}<span>{saveLabel}</span>{saveState === 'error' && !conflictRef.current && <button className="text-button" type="button" onClick={retrySave}>Thử lưu lại</button>}</div>}
    <div className="flashcards-session-stats" aria-label="Thống kê phiên"><span><strong>{stats.checked}</strong> đã kiểm tra</span><span className="stat-correct"><strong>{stats.correct}</strong> đúng</span><span className="stat-incorrect"><strong>{stats.incorrect}</strong> sai</span><span><strong>{stats.unanswered}</strong> chưa kiểm tra</span><span><strong>{stats.accuracy}%</strong> chính xác</span><span><strong>{stats.checks}</strong> lượt kiểm tra</span></div>

    {currentItem ? <>
      <article className={`flashcard-card status-${status}`} data-kanji={currentItem.kanji}>
        <div className="flashcard-card-top"><span className="flashcard-position">Thẻ {actualPosition + 1} / {session.items.length}</span><span className={`flashcard-status status-label-${status}`}>{status === 'correct' ? 'Đúng' : status === 'incorrect' ? 'Sai' : 'Chưa kiểm tra'}</span></div>
        <div className="flashcard-kanji" aria-label={`Kanji ${currentItem.kanji}`}><span className="flashcard-glyph">{currentItem.kanji}</span><span className="flashcard-count">{getReadingCountLabel(currentItem.hanViet)}</span></div>
        <div className="flashcard-answer"><label className="sr-only" htmlFor={`flashcard-answer-${currentItem.id}`}>Âm Hán Việt cho {currentItem.kanji}</label><input id={`flashcard-answer-${currentItem.id}`} aria-label={`Âm Hán Việt cho ${currentItem.kanji}`} value={currentItem.answer} onChange={event => updateDraft(currentItem.id, event.target.value)} onKeyDown={event => handleInputKeyDown(event, currentItem.id)} autoComplete="off" placeholder="Nhập tất cả âm…" />
          <div className="flashcard-answer-actions"><button className="text-button" type="button" onClick={() => revealAnswer(currentItem.id)}>{currentItem.revealed ? <><EyeOff size={15} /> Ẩn đáp án</> : <><Eye size={15} /> Hiện đáp án</>}</button>{currentItem.revealed && <span className="flashcard-revealed-answer">{currentItem.hanViet.join(' / ')}</span>}</div>
        </div>
        <AnswerFeedback item={currentItem} mode={preferences.feedback} /><div className="flashcard-check-row"><button className="button primary flashcard-check" type="button" onClick={() => submitAnswer(currentItem.id)}>Kiểm tra</button></div>
        <div className="flashcard-navigation"><button className="button secondary" type="button" onClick={() => changePosition(actualPosition - 1)} disabled={isFirst || busyAction}><ArrowLeft size={16} /> Thẻ trước</button><span aria-live="polite">Thẻ {actualPosition + 1} / {session.items.length}</span><button className="button secondary" type="button" onClick={() => changePosition(actualPosition + 1)} disabled={isLast || busyAction}>Thẻ tiếp theo <ArrowRight size={16} /></button></div>
      </article>
      {stats.completed && <section className="flashcards-results" aria-live="polite"><div><p className="eyebrow">PHIÊN ĐÃ HOÀN TẤT</p><h2>Kết quả phiên</h2></div><div className="flashcards-stat-grid"><span><strong>{stats.correct}</strong><small>Đúng</small></span><span><strong>{stats.incorrect}</strong><small>Sai</small></span><span><strong>{stats.accuracy}%</strong><small>Chính xác</small></span><span><strong>{stats.checks}</strong><small>Lượt kiểm tra</small></span></div></section>}
    </> : <div className="flashcards-state flashcards-empty-session"><Layers size={30} /><h2>Phiên học chưa có thẻ</h2><p>Nạp các Kanji hiện có trong kho bằng một phiên mới.</p><button className="button primary" type="button" onClick={() => openAction('new')}>Bắt đầu phiên mới</button></div>}

    {dialogAction && <div className="flashcards-dialog-backdrop"><div ref={dialogRef} className="flashcards-dialog" role="dialog" aria-label={dialogAction === 'retry' ? 'Luyện lại thẻ sai' : dialogAction === 'reload' ? 'Tải lại phiên' : 'Bắt đầu phiên mới'} aria-modal="true"><span className="flashcards-dialog-icon"><RefreshCw size={20} /></span><h2>{dialogAction === 'retry' ? 'Luyện lại thẻ sai?' : dialogAction === 'reload' ? 'Tải lại phiên?' : 'Bắt đầu phiên mới?'}</h2><p>{dialogAction === 'retry' ? 'Một phiên mới chỉ gồm các thẻ đang sai sẽ được tạo. Phiên hiện tại vẫn được lưu.' : dialogAction === 'reload' ? 'Các bản nháp chưa lưu trên thiết bị sẽ bị bỏ. Tải lại phiên hiện tại từ dữ liệu mới nhất?' : 'Một phiên mới sẽ dùng bộ Kanji hiện có trong kho và lựa chọn đang chờ.'}</p><div className="form-actions"><button className="button secondary" type="button" onClick={() => setDialogAction(null)} disabled={busyAction}>Hủy</button><button className="button primary" type="button" onClick={confirmAction} disabled={busyAction}>{busyAction ? 'Đang tải…' : dialogAction === 'retry' ? 'Xác nhận luyện lại' : dialogAction === 'reload' ? 'Xác nhận tải lại' : 'Xác nhận bắt đầu'}</button></div></div></div>}
  </section>;
}
