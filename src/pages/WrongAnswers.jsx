import { readPreferences } from '../data/preferences.js';
import AnswerFeedback from '../components/AnswerFeedback.jsx';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, Eye, EyeOff, History, LoaderCircle, RefreshCw, Shuffle, TriangleAlert, X } from 'lucide-react';
import { createKanjiRepository, openDatabase } from '../data/index.js';
import { createAttemptHistoryRepository } from '../data/attemptHistory.js';
import { createWrongPracticeRepository, WrongPracticeConflictError } from '../data/wrongPractice.js';
import { assertPracticeAttempt, compareAttempts, getWrongKanji } from '../domain/history.js';
import {
  checkWrongAnswer,
  getWrongItems,
  getWrongStats,
  getWrongStatus,
  setWrongAnswer,
  shuffleWrongSession,
  toggleWrongReveal,
} from '../domain/wrongSession.js';
import { getReadingCountLabel } from '../domain/readings.js';
import './practice.css';
import './wrongAnswers.css';

// A route can unmount while an IndexedDB save is still in flight. Keeping one
// queue at module scope means a subsequent visit observes the committed draft.
let sharedWrongSaveQueue = Promise.resolve();
let sharedWrongSaveBlocked = false;

const MODE_LABELS = Object.freeze({ table: 'Bảng', flashcard: 'Flashcard', wrong: 'Câu sai' });

function copySession(session) {
  if (!session) return null;
  return {
    ...session,
    sourceSessionId: session.sourceSessionId ?? null,
    items: session.items.map(item => ({ ...item, hanViet: [...item.hanViet] })),
    pendingAttempts: Array.isArray(session.pendingAttempts)
      ? session.pendingAttempts.map(attempt => ({ ...attempt, requiredReadings: [...attempt.requiredReadings] }))
      : [],
  };
}

function cloneRecords(records) {
  return records.map(record => ({ id: record.id, kanji: record.kanji, hanViet: [...record.hanViet] }));
}

function errorMessage(error) {
  if (!error) return 'Không thể lưu phiên học. Vui lòng thử lại.';
  if (error.name === 'WrongPracticeConflictError') return 'Phiên ôn câu sai đã thay đổi ở thẻ khác. Các câu trả lời hiện tại vẫn được giữ lại.';
  if (error.name === 'InvalidRequiredReadingsError') return 'Kanji này có dữ liệu âm Hán Việt không hợp lệ, nên chưa thể chấm câu.';
  if (error.name === 'DataValidationError') return 'Dữ liệu Kanji không hợp lệ. Hãy kiểm tra lại kho Kanji.';
  if (error.message?.includes('IndexedDB')) return 'Không thể mở dữ liệu trên thiết bị. Vui lòng thử lại.';
  return 'Không thể lưu phiên học. Vui lòng thử lại.';
}

function formatDate(value) {
  const parsed = Date.parse(value ?? '');
  if (Number.isNaN(parsed)) return 'Không rõ thời gian';
  return new Intl.DateTimeFormat('vi-VN', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(parsed));
}

function scopeLabel(session, count) {
  if (!session) return 'Phiên không xác định';
  const mode = MODE_LABELS[session.mode] || 'Phiên luyện tập';
  const shortId = typeof session.id === 'string' ? session.id.slice(0, 8) : '';
  return `${mode} · ${formatDate(session.createdAt)} · ${shortId}${count ? ` (${count} lượt)` : ''}`;
}

function statusLabel(status) {
  return status === 'correct' ? 'Đúng' : status === 'incorrect' ? 'Sai' : 'Chưa kiểm tra';
}

function historyRowKey(attempt) {
  return `${attempt.id}-${attempt.sequence ?? ''}`;
}

export default function WrongAnswers() {
  const [records, setRecords] = useState([]);
  const [attempts, setAttempts] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [scope, setScope] = useState('all');
  const [preferences] = useState(readPreferences);
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [saveState, setSaveState] = useState('idle');
  const [dialog, setDialog] = useState(null);
  const [busyAction, setBusyAction] = useState(false);
  const sessionRef = useRef(null);
  const revisionRef = useRef(0);
  const nextRevisionRef = useRef(0);
  const saveErrorRef = useRef(null);
  const pendingSavesRef = useRef(0);
  const mountedRef = useRef(false);
  const actionLockRef = useRef(false);
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

  const refreshHistory = useCallback(async () => {
    let db;
    try {
      db = await openDatabase();
      const history = createAttemptHistoryRepository(db);
      const [nextAttempts, nextSessions] = await Promise.all([history.list(), history.listSessions()]);
      if (mountedRef.current) {
        setAttempts(nextAttempts);
        setSessions(nextSessions);
      }
    } catch (error) {
      if (mountedRef.current) setActionError(errorMessage(error));
    } finally {
      db?.close();
    }
  }, []);

  const loadPage = useCallback(async () => {
    const token = ++loadTokenRef.current;
    setLoading(true);
    setLoadError('');
    setActionError('');
    try {
      await sharedWrongSaveQueue.catch(() => undefined);
      sharedWrongSaveBlocked = false;
      saveErrorRef.current = null;
      let db;
      try {
        db = await openDatabase();
        const kanji = createKanjiRepository(db);
        const history = createAttemptHistoryRepository(db);
        const wrong = createWrongPracticeRepository(db);
        const [nextRecords, nextAttempts, nextSessions] = await Promise.all([
          kanji.list(),
          history.list(),
          history.listSessions(),
        ]);
        const active = await wrong.loadActive(nextRecords);
        if (!mountedRef.current || token !== loadTokenRef.current) return;
        setRecords(nextRecords);
        setAttempts(nextAttempts);
        setSessions(nextSessions);
        applyLocal(active);
        if (active) {
          revisionRef.current = active.revision;
          nextRevisionRef.current = active.revision;
          setSaveState('saved');
        }
        setLoading(false);
      } finally {
        db?.close();
      }
    } catch (error) {
      if (mountedRef.current && token === loadTokenRef.current) {
        setLoadError(errorMessage(error));
        setLoading(false);
      }
    }
  }, [applyLocal]);

  useEffect(() => {
    mountedRef.current = true;
    void loadPage();
    return () => {
      mountedRef.current = false;
      loadTokenRef.current += 1;
    };
  }, [loadPage]);

  const recognizedAttempts = useMemo(() => attempts.filter(attempt => {
    try { assertPracticeAttempt(attempt); return true; } catch { return false; }
  }), [attempts]);
  const sessionById = useMemo(() => new Map(sessions.map(item => [item.id, item])), [sessions]);
  const scopeOptions = useMemo(() => {
    const ids = [...new Set(recognizedAttempts.map(attempt => attempt?.sessionId).filter(Boolean))];
    return ids.map(id => ({ id, label: scopeLabel(sessionById.get(id), recognizedAttempts.filter(attempt => attempt.sessionId === id).length) }));
  }, [recognizedAttempts, sessionById]);

  useEffect(() => {
    if (scope !== 'all' && !scopeOptions.some(option => option.id === scope)) setScope('all');
  }, [scope, scopeOptions]);

  const wrongRecords = useMemo(() => {
    try { return getWrongKanji(recognizedAttempts, records, { sessionId: scope }); } catch { return []; }
  }, [recognizedAttempts, records, scope]);

  const scopedAttemptsAll = useMemo(() => recognizedAttempts
    .filter(attempt => scope === 'all' || attempt.sessionId === scope)
    .sort((left, right) => compareAttempts(right, left)), [recognizedAttempts, scope]);
  const scopedAttemptTotal = scopedAttemptsAll.length;
  const scopedAttempts = scopedAttemptsAll.slice(0, 100);

  const stats = useMemo(() => (session ? getWrongStats(session) : {
    total: 0, correct: 0, incorrect: 0, unanswered: 0, checked: 0, remaining: 0, progress: 0, checks: 0, correctChecks: 0, incorrectChecks: 0, accuracy: 0, completed: false,
  }), [session]);

  const persist = useCallback((next, expectedRevision = next?.revision) => {
    const snapshot = copySession({ ...next, revision: expectedRevision });
    const expected = expectedRevision;
    if (sharedWrongSaveBlocked) {
      const blocked = saveErrorRef.current || new Error('Saving is paused until the latest draft is retried.');
      if (mountedRef.current) setSaveState('error');
      return Promise.reject(blocked);
    }
    pendingSavesRef.current += 1;
    if (mountedRef.current) setSaveState('saving');
    const task = sharedWrongSaveQueue.catch(() => undefined).then(async () => {
      let db;
      try {
        if (sharedWrongSaveBlocked) throw saveErrorRef.current || new Error('Saving is paused until the latest draft is retried.');
        db = await openDatabase();
        const committed = await createWrongPracticeRepository(db).save(snapshot, expected);
        revisionRef.current = committed.revision;
        saveErrorRef.current = null;
        if (sessionRef.current?.id === committed.id && sessionRef.current.revision === expected) {
          applyLocal(committed);
        }
        await refreshHistory();
        return committed;
      } catch (error) {
        sharedWrongSaveBlocked = true;
        saveErrorRef.current = error;
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
    sharedWrongSaveQueue = task.catch(() => undefined);
    return task;
  }, [applyLocal, refreshHistory]);

  function applyMutation(mutator) {
    const current = sessionRef.current;
    if (!current) return null;
    const paused = sharedWrongSaveBlocked;
    const expected = paused ? current.revision : nextRevisionRef.current;
    const mutated = mutator(current);
    const next = { ...mutated, revision: expected };
    if (!paused) nextRevisionRef.current = expected + 1;
    applyLocal(next);
    return { next, expected, paused };
  }

  function updateDraft(id, answer) {
    if (!sessionRef.current || dialog || actionLockRef.current) return;
    const change = applyMutation(previous => {
      const next = setWrongAnswer(previous, id, answer);
      const item = next.items.find(entry => entry.id === id);
      const previousItem = previous.items.find(entry => entry.id === id);
      if (item && previousItem && item.answer !== previousItem.answer) item.revealed = false;
      return next;
    });
    if (change && !change.paused) void persist(change.next, change.expected).catch(() => undefined);
  }

  async function submitAnswer(id) {
    if (dialog || actionLockRef.current) return;
    const current = sessionRef.current;
    const item = current?.items.find(entry => entry.id === id);
    if (!item) return;
    if (item.checkedAnswer !== null && item.checkedAnswer === item.answer && item.result !== null) return;
    try {
      const change = applyMutation(previous => checkWrongAnswer(previous, id));
      if (change && !change.paused) await persist(change.next, change.expected);
    } catch (error) {
      setActionError(errorMessage(error));
    }
  }

  function revealAnswer(id) {
    if (dialog || actionLockRef.current) return;
    const change = applyMutation(previous => toggleWrongReveal(previous, id));
    if (change && !change.paused) void persist(change.next, change.expected).catch(() => undefined);
  }

  async function shuffle() {
    if (!sessionRef.current || dialog || actionLockRef.current) return;
    actionLockRef.current = true;
    try {
      await sharedWrongSaveQueue.catch(() => undefined);
      const change = applyMutation(previous => shuffleWrongSession(previous));
      if (change && !change.paused) await persist(change.next, change.expected);
    } catch (error) { setActionError(errorMessage(error)); }
    finally { actionLockRef.current = false; }
  }

  async function startWrongSession() {
    if (dialog || actionLockRef.current || !wrongRecords.length) return;
    if (sessionRef.current) {
      setDialog('start');
      return;
    }
    await createSession();
  }

  async function createSession() {
    if (actionLockRef.current) return;
    actionLockRef.current = true;
    setBusyAction(true);
    setActionError('');
    try {
      await sharedWrongSaveQueue.catch(() => undefined);
      if (saveErrorRef.current) throw saveErrorRef.current;
      let db;
      try {
        db = await openDatabase();
        const created = await createWrongPracticeRepository(db).startNew(cloneRecords(wrongRecords), sessionRef.current, {
          scope,
          sourceSessionId: scope === 'all' ? null : scope,
        });
        applyLocal(created);
        revisionRef.current = created.revision;
        nextRevisionRef.current = created.revision;
        setSaveState('saved');
        setDialog(null);
        await refreshHistory();
      } finally { db?.close(); }
    } catch (error) { setActionError(errorMessage(error)); }
    finally { setBusyAction(false); actionLockRef.current = false; }
  }

  function requestReload() {
    if (!actionLockRef.current) setDialog('reload');
  }

  async function reloadSession() {
    if (actionLockRef.current) return;
    actionLockRef.current = true;
    setBusyAction(true);
    try {
      await loadPage();
      setDialog(null);
    } finally {
      setBusyAction(false);
      actionLockRef.current = false;
    }
  }

  async function retrySave() {
    if (actionLockRef.current || !saveErrorRef.current || !sessionRef.current) return;
    actionLockRef.current = true;
    try {
      await sharedWrongSaveQueue;
      const rebased = { ...copySession(sessionRef.current), revision: revisionRef.current };
      nextRevisionRef.current = revisionRef.current + 1;
      sharedWrongSaveBlocked = false;
      saveErrorRef.current = null;
      applyLocal(rebased);
      await persist(rebased, revisionRef.current);
    } catch (error) { setActionError(errorMessage(error)); }
    finally { actionLockRef.current = false; }
  }

  function onInputKeyDown(event, id) {
    if (event.key === 'Enter' && !event.isComposing && !event.nativeEvent?.isComposing) {
      event.preventDefault();
      void submitAnswer(id);
    }
  }

  useEffect(() => {
    if (!dialog) return undefined;
    previousFocusRef.current = document.activeElement;
    const node = dialogRef.current;
    const focusable = () => [...(node?.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled])') || [])];
    focusable()[0]?.focus();
    function handleKeyDown(event) {
      if (event.key === 'Escape') {
        if (!busyActionRef.current) setDialog(null);
        event.preventDefault();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusable();
      if (!items.length) { event.preventDefault(); return; }
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
    node?.addEventListener('keydown', handleKeyDown);
    return () => {
      node?.removeEventListener('keydown', handleKeyDown);
      const previous = previousFocusRef.current;
      if (previous?.isConnected) previous.focus();
      previousFocusRef.current = null;
    };
  }, [dialog]);

  if (loading) return <section className="wrong-page"><div className="practice-state"><LoaderCircle className="practice-spin" size={25} /><p>Đang mở lịch sử luyện tập…</p></div></section>;
  if (loadError) return <section className="wrong-page"><div className="practice-state practice-error"><TriangleAlert size={28} /><h1>Không thể mở lịch sử</h1><p>{loadError}</p><button className="button secondary" type="button" onClick={() => void loadPage()}><RefreshCw size={16} /> Thử lại</button></div></section>;

  const scopeDescription = scope === 'all'
    ? 'Tất cả lịch sử: mỗi Kanji được tính theo kết quả kiểm tra mới nhất trong mọi phiên.'
    : 'Phạm vi đã chọn: mỗi Kanji được tính theo kết quả mới nhất trong đúng phiên này. Các câu được sửa đúng ở phiên khác không làm thay đổi phạm vi đã chọn.';
  const saveLabel = saveState === 'saving' ? 'Đang lưu…' : saveState === 'error' ? 'Chưa lưu được' : 'Đã lưu trên thiết bị';

  return <section className="wrong-page">
    <div className="practice-heading wrong-heading"><div><p className="eyebrow">ÔN LUYỆN</p><h1>Ôn câu sai</h1><p className="muted">Chọn phạm vi lịch sử để xem các Kanji có lần kiểm tra mới nhất là sai, rồi bắt đầu một phiên ôn thủ công. Không có lịch ôn tự động.</p></div><span className="phase-badge">Lịch sử cục bộ</span></div>

    <div className="wrong-scope-bar"><label htmlFor="wrong-scope">Phạm vi câu sai<select id="wrong-scope" aria-label="Phạm vi câu sai" value={scope} onChange={event => setScope(event.target.value)} disabled={Boolean(dialog)}><option value="all">Tất cả lịch sử</option>{scopeOptions.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label><p>{scopeDescription}</p></div>

    {actionError && <div className="practice-alert" role="alert"><TriangleAlert size={17} /><span>{actionError}</span>{actionError.includes('thay đổi') && <button className="text-button" type="button" onClick={requestReload}>Tải lại phiên</button>}<button className="icon-button" type="button" aria-label="Đóng thông báo" onClick={() => setActionError('')}><X size={15} /></button></div>}

    {session && <div className="wrong-session-panel">
      <div className="practice-toolbar wrong-toolbar"><div className="practice-progress"><div className="practice-progress-line"><span>{stats.completed ? 'Kết quả ôn câu sai' : 'Tiến độ phiên ôn'}</span><strong>{stats.checked}/{stats.total}</strong></div><progress aria-label="Tiến độ phiên ôn câu sai" value={stats.progress} max="100" /></div><div className="practice-actions"><button className="button secondary" type="button" onClick={() => void shuffle()}><Shuffle size={16} /> Trộn thứ tự</button><button className="button secondary" type="button" onClick={() => void startWrongSession()} disabled={!wrongRecords.length}>Bắt đầu lại ôn câu sai</button></div></div>
      <p className="wrong-active-scope" data-testid="wrong-active-scope">Nguồn phiên ôn: {session.sourceSessionId ? scopeLabel(sessionById.get(session.sourceSessionId)) : 'Tất cả lịch sử'}. Tiến độ và kết quả bên dưới thuộc phiên này; bộ chọn phạm vi chỉ áp dụng cho danh sách nguồn, lịch sử và phiên mới.</p>
      {stats.completed && <div className="wrong-results" role="status"><Check size={20} /><div><h2>Kết quả ôn câu sai</h2><p>{stats.correct}/{stats.total} Kanji đúng · {stats.accuracy}% chính xác · {stats.checks} lượt kiểm tra.</p></div></div>}
      <div className="practice-meta"><div className="practice-stats"><span><strong>{stats.checked}</strong> đã kiểm tra</span><span className="stat-correct"><strong>{stats.correct}</strong> đúng</span><span className="stat-incorrect"><strong>{stats.incorrect}</strong> sai</span><span><strong>{stats.remaining}</strong> còn cần ôn</span><span><strong>{stats.checks}</strong> lượt kiểm tra</span></div><div className="practice-save-status" role="status" aria-live="polite">{saveState === 'saving' ? <LoaderCircle className="practice-spin" size={14} /> : saveState === 'error' ? <TriangleAlert size={14} /> : <Check size={14} />}<span>{saveLabel}</span>{saveState === 'error' && !saveErrorRef.current?.name?.includes('Conflict') && <button className="text-button" type="button" onClick={() => void retrySave()}>Thử lưu lại</button>}</div></div>
      <div className="practice-table-wrap"><div className="practice-table-head"><span>Kanji</span><span>Âm Hán Việt</span><span>Trạng thái</span></div><div className="practice-list">{getWrongItems(session).map(item => { const status = getWrongStatus(item); const revealed = item.revealed; return <article className={`practice-row status-${status}`} data-kanji={item.kanji} key={item.id}><div className="practice-kanji"><span className="practice-glyph">{item.kanji}</span><span className="practice-count">{getReadingCountLabel(item.hanViet)}</span></div><div className="practice-answer"><input aria-label={`Âm Hán Việt cho ${item.kanji}`} value={item.answer} onChange={event => updateDraft(item.id, event.target.value)} onKeyDown={event => onInputKeyDown(event, item.id)} autoComplete="off" placeholder="Nhập tất cả âm…" /><div className="practice-answer-actions"><button className="text-button" type="button" onClick={() => revealAnswer(item.id)}>{revealed ? <><EyeOff size={14} /> Ẩn đáp án {item.kanji}</> : <><Eye size={14} /> Hiện đáp án {item.kanji}</>}</button>{revealed && <span className="revealed-answer">{item.hanViet.join(' / ')}</span>}</div></div><div className="practice-result"><AnswerFeedback item={item} mode={preferences.feedback} /><span className="practice-status-label">{statusLabel(status)}</span><button className="button primary practice-check" type="button" onClick={() => void submitAnswer(item.id)} aria-label={`Kiểm tra ${item.kanji}`}>Kiểm tra</button></div></article>; })}</div></div>
    </div>}

    <section className="wrong-source-panel" aria-labelledby="wrong-source-heading"><div className="wrong-section-heading"><div><p className="eyebrow">DANH SÁCH CẦN ÔN</p><h2 id="wrong-source-heading">Kanji trả lời sai</h2><p>{scopeDescription}</p></div><span className="wrong-count">{wrongRecords.length}</span></div>{wrongRecords.length ? <div className="wrong-source-list">{wrongRecords.map(record => <div className="wrong-source-row" data-kanji={record.kanji} key={record.id}><span className="wrong-source-glyph">{record.kanji}</span><span className="wrong-source-count">{getReadingCountLabel(record.hanViet)}</span><span className="wrong-source-meta">Lần gần nhất: {formatDate(record.latestAttempt?.checkedAt || record.latestAttempt?.createdAt)}</span></div>)}</div> : <div className="wrong-empty"><History size={25} /><h3>Chưa có Kanji trả lời sai</h3><p>Hãy kiểm tra câu trả lời ở Bảng hoặc Flashcard. Các lần kiểm tra được lưu trên thiết bị này.</p></div>}<button className="button primary wrong-start" type="button" onClick={() => void startWrongSession()} disabled={!wrongRecords.length || Boolean(dialog)}>Bắt đầu ôn câu sai</button></section>

    <section className="wrong-history-panel" aria-labelledby="wrong-history-heading"><div className="wrong-section-heading"><div><p className="eyebrow">DỮ LIỆU ĐÃ LƯU</p><h2 id="wrong-history-heading">Lịch sử luyện tập</h2><p>Hiển thị {Math.min(100, scopedAttemptTotal)} trong tổng số {scopedAttemptTotal} lượt kiểm tra ở phạm vi đã chọn. Âm đúng chỉ xuất hiện sau khi bạn yêu cầu hiện đáp án trong phiên ôn.</p></div><span className="wrong-count">{scopedAttemptTotal}</span></div>{scopedAttempts.length ? <div className="wrong-history-list"><div className="wrong-history-head"><span>Thời gian</span><span>Kanji</span><span>Số âm</span><span>Âm đã nhập</span><span>Kết quả</span><span>Chế độ</span></div>{scopedAttempts.map(attempt => <div className="wrong-history-row" key={historyRowKey(attempt)}><time dateTime={attempt.checkedAt || attempt.createdAt}>{formatDate(attempt.checkedAt || attempt.createdAt)}</time><strong>{attempt.kanji}</strong><span>{Array.isArray(attempt.requiredReadings) ? `${attempt.requiredReadings.length} âm` : Number.isInteger(attempt.requiredCount) ? `${attempt.requiredCount} âm` : '—'}</span><span title={attempt.submittedAnswer}>{attempt.submittedAnswer || '—'}</span><span className={attempt.isCorrect ? 'history-correct' : 'history-incorrect'}>{attempt.isCorrect ? 'Đúng' : 'Sai'}</span><span>{MODE_LABELS[attempt.mode] || attempt.mode}</span></div>)}</div> : <div className="wrong-empty wrong-history-empty"><History size={25} /><h3>Chưa có lượt kiểm tra</h3><p>Lịch sử sẽ xuất hiện sau khi bạn nhấn Kiểm tra ở một chế độ luyện tập.</p></div>}</section>

    {dialog && <div className="practice-dialog-backdrop"><div ref={dialogRef} className="practice-dialog" role="dialog" aria-modal="true" aria-label={dialog === 'reload' ? 'Tải lại phiên ôn' : 'Bắt đầu phiên ôn mới'}><span className="practice-dialog-icon"><RefreshCw size={20} /></span><h2>{dialog === 'reload' ? 'Tải lại phiên ôn?' : 'Bắt đầu phiên ôn mới?'}</h2><p>{dialog === 'reload' ? 'Các bản nháp chưa lưu trên thiết bị sẽ bị bỏ. Tải lại phiên ôn hiện tại từ dữ liệu mới nhất?' : 'Phiên ôn hiện tại sẽ được lưu vào lịch sử và một phiên mới sẽ dùng danh sách câu sai hiện tại.'}</p><div className="form-actions"><button className="button secondary" type="button" onClick={() => setDialog(null)} disabled={busyAction}>Hủy</button><button className="button primary" type="button" onClick={() => dialog === 'reload' ? void reloadSession() : void createSession()} disabled={busyAction}>{busyAction ? 'Đang tải…' : dialog === 'reload' ? 'Xác nhận tải lại' : 'Xác nhận bắt đầu'}</button></div></div></div>}
  </section>;
}

