import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  Download,
  FileJson,
  Info,
  Moon,
  RotateCcw,
  Sun,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { openDatabase } from '../data/index.js';
import { DEFAULT_PREFERENCES, readPreferences, savePreferences } from '../data/preferences.js';
import { exportBackup, resetHistory, resetSessions, restoreBackup } from '../data/backup.js';
import { validateBackup } from '../domain/backup.js';
import { saveText } from '../platform/files.js';
import './settings.css';

const DEFAULT_THEME = 'light';
const PRACTICE_SIZE_OPTIONS = [
  { value: 'all', label: 'Tất cả Kanji' },
  { value: '10', label: '10 Kanji' },
  { value: '20', label: '20 Kanji' },
  { value: '50', label: '50 Kanji' },
  { value: '100', label: '100 Kanji' },
];

const FEEDBACK_OPTIONS = [
  { value: 'detailed', label: 'Chi tiết', description: 'Hiển thị trạng thái và hướng dẫn rõ ràng sau mỗi lần kiểm tra.' },
  { value: 'compact', label: 'Gọn', description: 'Giữ phản hồi ngắn gọn để bạn tập trung vào lượt tiếp theo.' },
];

function normalisePreferences(value) {
  const source = value && typeof value === 'object' ? value : {};
  const size = PRACTICE_SIZE_OPTIONS.some(option => option.value === String(source.practiceSize))
    ? String(source.practiceSize)
    : DEFAULT_PREFERENCES.practiceSize;
  const feedback = FEEDBACK_OPTIONS.some(option => option.value === source.feedback)
    ? source.feedback
    : DEFAULT_PREFERENCES.feedback;
  return { ...DEFAULT_PREFERENCES, ...source, practiceSize: size, feedback };
}

function normaliseTheme(value) {
  return value === 'dark' ? 'dark' : DEFAULT_THEME;
}

function explainError(error, fallback) {
  if (error?.name === 'BackupValidationError' || error?.name === 'DataValidationError') {
    return 'Tệp sao lưu không hợp lệ hoặc không tương thích với phiên bản này.';
  }
  if (error?.name === 'SyntaxError') return 'Không thể đọc tệp JSON. Hãy chọn đúng tệp sao lưu của Kanji Trainer.';
  if (error?.name === 'PreferencesStorageError') return 'Không thể lưu cài đặt trên thiết bị. Hãy kiểm tra quyền lưu trữ rồi thử lại.';
  if (error?.name === 'InvalidStateError' || error?.message?.includes('IndexedDB')) {
    return 'Không thể mở dữ liệu trên thiết bị. Hãy kiểm tra quyền lưu trữ của trình duyệt rồi thử lại.';
  }
  return fallback;
}

function collectionsFromBackup(backup) {
  const source = backup?.data && typeof backup.data === 'object' ? backup.data : backup || {};
  const records = Array.isArray(source.kanji) ? source.kanji : [];
  const sessions = Array.isArray(source.sessions) ? source.sessions : [];
  const attempts = Array.isArray(source.attempts) ? source.attempts : [];
  return { records, sessions, attempts };
}

function settingsFromBackup(backup) {
  const source = backup?.settings && typeof backup.settings === 'object' ? backup.settings : {};
  const preferences = source.practiceSize !== undefined && source.feedback !== undefined
    ? { practiceSize: source.practiceSize, feedback: source.feedback }
    : null;
  const theme = source.theme;
  return {
    preferences: preferences ? normalisePreferences(preferences) : null,
    theme: theme ? normaliseTheme(theme) : null,
  };
}

async function createDownload(backup) {
  const payload = JSON.stringify(backup, null, 2);
  const date = new Date().toISOString().slice(0, 10);
  return saveText(payload, `kanji-trainer-backup-${date}.json`, 'application/json;charset=utf-8');
}

function verifySettingsStorage() {
  try {
    const local = globalThis.localStorage;
    if (!local) return false;
    const key = `kanji-settings-probe-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    local.setItem(key, 'ok');
    local.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

function ConfirmationDialog({ action, busy, dialogRef, onCancel, onConfirm }) {
  if (!action) return null;
  const isRestore = action.type === 'restore';
  return <div className="settings-dialog-backdrop" role="presentation">
    <div ref={dialogRef} className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-dialog-title" aria-describedby="settings-dialog-description" data-testid="settings-confirm-dialog" tabIndex={-1}>
      <div className={`settings-dialog-icon${action.danger ? ' danger' : ''}`} aria-hidden="true">{isRestore ? <Upload size={20} /> : <AlertTriangle size={20} />}</div>
      <h2 id="settings-dialog-title">{action.title}</h2>
      <p id="settings-dialog-description">{action.description}</p>
      {isRestore && action.preview && <dl className="settings-dialog-preview">
        <div><dt>Kho Kanji</dt><dd>{action.preview.records}</dd></div>
        <div><dt>Phiên luyện tập</dt><dd>{action.preview.sessions}</dd></div>
        <div><dt>Lượt kiểm tra</dt><dd>{action.preview.attempts}</dd></div>
      </dl>}
      <div className="settings-dialog-actions">
        <button className="button secondary" type="button" onClick={onCancel} disabled={busy}>Hủy</button>
        <button className={`button ${action.danger ? 'danger' : 'primary'}`} type="button" onClick={onConfirm} disabled={busy} aria-busy={busy || undefined}>
          {busy ? 'Đang xử lý…' : action.confirmLabel}
        </button>
      </div>
    </div>
  </div>;
}

export default function Settings({ theme = DEFAULT_THEME, onThemeChange }) {
  const [preferences, setPreferences] = useState(() => normalisePreferences(DEFAULT_PREFERENCES));
  const [preferencesLoading, setPreferencesLoading] = useState(true);
  const [preferencesStatus, setPreferencesStatus] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmAction, setConfirmAction] = useState(null);
  const [pendingBackup, setPendingBackup] = useState(null);
  const [themeStatus, setThemeStatus] = useState('');
  const fileInputRef = useRef(null);
  const dialogRef = useRef(null);
  const previousFocusRef = useRef(null);
  const fileReadSequence = useRef(0);
  const busyRef = useRef(false);
  const saveSequence = useRef(0);
  const operationSequence = useRef(0);
  busyRef.current = busy;

  useEffect(() => {
    if (!confirmAction) return undefined;
    previousFocusRef.current = document.activeElement;
    const dialog = dialogRef.current;
    const focusable = () => [...(dialog?.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href]') || [])];
    const first = focusable()[0];
    first?.focus();
    function trap(event) {
      if (event.key === 'Escape') {
        if (!busyRef.current) onCloseConfirm();
        event.preventDefault();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusable();
      if (!items.length) {
        event.preventDefault();
        dialog?.focus();
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
    dialog?.addEventListener('keydown', trap);
    return () => {
      dialog?.removeEventListener('keydown', trap);
      if (previousFocusRef.current?.isConnected) previousFocusRef.current.focus();
      previousFocusRef.current = null;
    };
  }, [confirmAction]);

  function onCloseConfirm() {
    if (!busy) setConfirmAction(null);
  }

  useEffect(() => {
    let active = true;
    setPreferencesLoading(true);
    Promise.resolve(readPreferences()).then(value => {
      if (!active) return;
      setPreferences(normalisePreferences(value));
      setError('');
    }).catch(loadError => {
      if (active) setError(explainError(loadError, 'Không thể đọc cài đặt trên thiết bị.'));
    }).finally(() => {
      if (active) setPreferencesLoading(false);
    });
    return () => { active = false; };
  }, []);

  const persistPreferences = useCallback(next => {
    const sequence = saveSequence.current + 1;
    saveSequence.current = sequence;
    setPreferences(next);
    setPreferencesStatus('Đang lưu…');
    setError('');
    Promise.resolve(savePreferences(next)).then(saved => {
      if (saveSequence.current !== sequence) return;
      setPreferences(normalisePreferences(saved || next));
      setPreferencesStatus('Đã lưu cài đặt');
    }).catch(saveError => {
      if (saveSequence.current !== sequence) return;
      setPreferencesStatus('');
      setError(explainError(saveError, 'Không thể lưu cài đặt. Vui lòng thử lại.'));
    });
  }, []);

  function handlePreferenceChange(field, value) {
    persistPreferences({ ...preferences, [field]: value });
  }

  async function applyTheme(nextTheme) {
    const next = normaliseTheme(nextTheme);
    try {
      await onThemeChange?.(next);
      if (!onThemeChange) {
        document.documentElement.dataset.theme = next;
        try {
          if (typeof localStorage === 'undefined') throw new Error('Theme storage is unavailable.');
          localStorage.setItem('kanji-theme', next);
        } catch (storageError) {
          throw Object.assign(storageError, { name: 'PreferencesStorageError' });
        }
      }
      setThemeStatus('Đã lưu giao diện');
      setError('');
      return true;
    } catch (themeError) {
      setThemeStatus('');
      setError(explainError(themeError, 'Không thể đổi giao diện. Vui lòng thử lại.'));
      return false;
    }
  }

  async function handleExport() {
    if (busy || preferencesLoading) return;
    const operation = operationSequence.current + 1;
    operationSequence.current = operation;
    setBusy(true);
    setError('');
    setPreferencesStatus('');
    let db;
    try {
      db = await openDatabase();
      const backup = await exportBackup(db, { ...preferences, theme: normaliseTheme(theme) });
      if (operationSequence.current !== operation) return;
      const result = await createDownload(backup);
      if (result.saved && operationSequence.current === operation) {
        setPreferencesStatus('Đã tải bản sao lưu xuống thiết bị');
      }
    } catch (exportError) {
      if (operationSequence.current === operation) setError(explainError(exportError, 'Không thể tạo bản sao lưu. Vui lòng thử lại.'));
    } finally {
      db?.close();
      if (operationSequence.current === operation) setBusy(false);
    }
  }

  async function handleFileChange(event) {
    const file = event.target.files?.[0];
    const sequence = fileReadSequence.current + 1;
    fileReadSequence.current = sequence;
    setPendingBackup(null);
    setError('');
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      if (fileReadSequence.current !== sequence) return;
      const backup = validateBackup(parsed);
      if (fileReadSequence.current !== sequence) return;
      const preview = collectionsFromBackup(backup);
      if (fileReadSequence.current !== sequence) return;
      setPendingBackup({ fileName: file.name, backup, preview: { records: preview.records.length, sessions: preview.sessions.length, attempts: preview.attempts.length } });
    } catch (fileError) {
      if (fileReadSequence.current !== sequence) return;
      if (fileInputRef.current) fileInputRef.current.value = '';
      setError(explainError(fileError, 'Không thể đọc bản sao lưu. Hãy chọn một tệp JSON hợp lệ.'));
    }
  }

  function clearPendingBackup() {
    fileReadSequence.current += 1;
    setPendingBackup(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  function requestRestore() {
    if (!pendingBackup || busy) return;
    setConfirmAction({
      type: 'restore',
      title: 'Khôi phục bản sao lưu?',
      description: `Dữ liệu hiện tại sẽ được thay thế bằng ${pendingBackup.fileName}. Hãy kiểm tra số lượng bên dưới trước khi tiếp tục.`,
      confirmLabel: 'Khôi phục dữ liệu',
      danger: true,
      preview: pendingBackup.preview,
    });
  }

  function requestReset(type) {
    if (busy) return;
    const history = type === 'history';
    setConfirmAction({
      type: history ? 'reset-history' : 'reset-sessions',
      title: history ? 'Xóa lịch sử học tập?' : 'Đặt lại các phiên luyện tập?',
      description: history
        ? 'Toàn bộ phiên luyện tập và lượt kiểm tra sẽ bị xóa vĩnh viễn. Kho Kanji vẫn được giữ nguyên.'
        : 'Các phiên luyện tập đang lưu sẽ bị xóa. Lịch sử lượt kiểm tra vẫn được giữ lại.',
      confirmLabel: history ? 'Xóa lịch sử' : 'Đặt lại phiên',
      danger: true,
    });
  }

  async function handleConfirm() {
    if (!confirmAction || busy) return;
    const action = confirmAction;
    setBusy(true);
    setError('');
    let db;
    let databaseRestored = false;
    try {
      if (action.type === 'restore' && !verifySettingsStorage()) {
        throw Object.assign(new Error('Settings storage is unavailable.'), { name: 'PreferencesStorageError' });
      }
      db = await openDatabase();
      if (action.type === 'restore') {
        const restored = await restoreBackup(db, pendingBackup.backup);
        databaseRestored = true;
        if (restored?.settingsPersisted === false) {
          throw Object.assign(new Error('The backup data was restored, but settings could not be persisted.'), { name: 'PreferencesStorageError' });
        }
        // Settings are deliberately applied only after the database restore has succeeded.
        const restoredSettings = settingsFromBackup(pendingBackup.backup);
        if (restoredSettings.preferences) {
          setPreferences(normalisePreferences(restoredSettings.preferences));
        }
        if (restoredSettings.theme && !(await applyTheme(restoredSettings.theme))) {
          throw new Error('Theme could not be applied after restore.');
        }
      } else if (action.type === 'reset-history') {
        await resetHistory(db);
      } else {
        await resetSessions(db);
      }
      setConfirmAction(null);
      window.location.reload();
    } catch (operationError) {
      if (action.type === 'restore' && databaseRestored) {
        setConfirmAction(null);
        setError('Dữ liệu đã được khôi phục nhưng không thể lưu đầy đủ cài đặt. Hãy kiểm tra quyền lưu trữ rồi thử lại.');
      } else {
        setError(explainError(operationError, action.type === 'restore' ? 'Không thể khôi phục bản sao lưu. Dữ liệu hiện tại vẫn được giữ nguyên.' : 'Không thể hoàn tất thao tác. Dữ liệu hiện tại vẫn được giữ nguyên.'));
      }
    } finally {
      db?.close();
      setBusy(false);
    }
  }

  const currentTheme = normaliseTheme(theme);
  const selectedFeedback = useMemo(() => FEEDBACK_OPTIONS.find(option => option.value === preferences.feedback), [preferences.feedback]);

  return <section className="settings-page" data-testid="settings-page">
    <div className="page-heading settings-heading">
      <div><p className="eyebrow">KHÔNG GIAN CỦA BẠN</p><h1>Cài đặt</h1><p className="muted">Điều chỉnh cách luyện tập và bảo vệ dữ liệu học tập trên thiết bị này.</p></div>
      <span className="phase-badge">Lưu cục bộ · Không cần mạng</span>
    </div>

    {error && <div className="settings-alert" role="alert"><AlertTriangle size={17} aria-hidden="true" /><span>{error}</span><button className="text-button" type="button" onClick={() => setError('')} aria-label="Đóng thông báo lỗi"><X size={15} /></button></div>}

    <div className="settings-grid">
      <section className="settings-card" aria-labelledby="settings-display-title">
        <div className="settings-card-heading"><div className="settings-card-icon"><Sun size={17} /></div><div><p className="eyebrow">HIỂN THỊ</p><h2 id="settings-display-title">Giao diện</h2></div></div>
        <p className="settings-description">Chọn giao diện phù hợp với không gian học của bạn.</p>
        <div className="settings-theme-options" role="radiogroup" aria-label="Giao diện" data-testid="settings-theme">
          <button className={`settings-choice${currentTheme === 'light' ? ' selected' : ''}`} type="button" role="radio" aria-checked={currentTheme === 'light'} data-testid="settings-theme-light" onClick={() => applyTheme('light')}>
            <Sun size={17} aria-hidden="true" /><span><strong>Sáng</strong><small>Rõ ràng, thoáng mắt</small></span>{currentTheme === 'light' && <Check className="settings-choice-check" size={15} aria-hidden="true" />}
          </button>
          <button className={`settings-choice${currentTheme === 'dark' ? ' selected' : ''}`} type="button" role="radio" aria-checked={currentTheme === 'dark'} data-testid="settings-theme-dark" onClick={() => applyTheme('dark')}>
            <Moon size={17} aria-hidden="true" /><span><strong>Tối</strong><small>Dịu mắt trong buổi tối</small></span>{currentTheme === 'dark' && <Check className="settings-choice-check" size={15} aria-hidden="true" />}
          </button>
        </div>
        {themeStatus && <p className="settings-save-status" role="status"><Check size={14} />{themeStatus}</p>}
      </section>

      <section className="settings-card" aria-labelledby="settings-practice-title">
        <div className="settings-card-heading"><div className="settings-card-icon"><RotateCcw size={17} /></div><div><p className="eyebrow">LUYỆN TẬP</p><h2 id="settings-practice-title">Tùy chọn mặc định</h2></div></div>
        <p className="settings-description">Các phiên mới sẽ bắt đầu với lựa chọn này. Bạn vẫn có thể đổi riêng trong từng phiên.</p>
        <label className="settings-field" htmlFor="settings-practice-size"><span><strong>Số Kanji mặc định</strong><small>Áp dụng cho Bảng luyện tập và Flashcard.</small></span><select id="settings-practice-size" data-testid="settings-practice-size" value={preferences.practiceSize} disabled={preferencesLoading || busy} onChange={event => handlePreferenceChange('practiceSize', event.target.value)}>{PRACTICE_SIZE_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
        <div className="settings-feedback-field"><span className="settings-field-label"><strong>Phản hồi sau khi kiểm tra</strong><small>{selectedFeedback?.description}</small></span><div className="settings-segmented" role="radiogroup" aria-label="Mức độ phản hồi" data-testid="settings-feedback"><label className={preferences.feedback === 'detailed' ? 'selected' : ''}><input type="radio" name="feedback" value="detailed" checked={preferences.feedback === 'detailed'} disabled={preferencesLoading || busy} onChange={event => handlePreferenceChange('feedback', event.target.value)} />Chi tiết</label><label className={preferences.feedback === 'compact' ? 'selected' : ''}><input type="radio" name="feedback" value="compact" checked={preferences.feedback === 'compact'} disabled={preferencesLoading || busy} onChange={event => handlePreferenceChange('feedback', event.target.value)} />Gọn</label></div></div>
        {preferencesStatus && <p className="settings-save-status" role="status"><Check size={14} />{preferencesStatus}</p>}
      </section>
    </div>

    <section className="settings-card settings-data-card" aria-labelledby="settings-data-title">
      <div className="settings-card-heading"><div className="settings-card-icon"><FileJson size={17} /></div><div><p className="eyebrow">DỮ LIỆU CỤC BỘ</p><h2 id="settings-data-title">Sao lưu và khôi phục</h2></div></div>
      <p className="settings-description">Tệp JSON chứa kho Kanji, lịch sử chi tiết, các phiên đang lưu và cài đặt hiện tại. Tệp chỉ được tải xuống hoặc đọc trên thiết bị của bạn.</p>
      <div className="settings-data-actions"><button className="button primary" type="button" data-testid="settings-export" onClick={() => void handleExport()} disabled={busy || preferencesLoading}><Download size={16} />Xuất bản sao lưu</button><label className="button secondary settings-file-button" htmlFor="settings-restore-file"><Upload size={16} />Chọn tệp để khôi phục<input ref={fileInputRef} id="settings-restore-file" data-testid="settings-restore-file" type="file" accept="application/json,.json" onChange={handleFileChange} disabled={busy} /></label></div>
      {pendingBackup && <div className="settings-backup-preview" data-testid="settings-backup-preview" role="region" aria-label="Xem trước bản sao lưu"><div className="settings-backup-preview-heading"><div><strong>{pendingBackup.fileName}</strong><span>Đã kiểm tra tệp · sẵn sàng khôi phục</span></div><button className="icon-button" type="button" onClick={clearPendingBackup} aria-label="Bỏ tệp đã chọn"><X size={16} /></button></div><div className="settings-backup-counts"><span><strong>{pendingBackup.preview.records}</strong> Kanji</span><span><strong>{pendingBackup.preview.sessions}</strong> phiên</span><span><strong>{pendingBackup.preview.attempts}</strong> lượt kiểm tra</span></div><button className="button danger" type="button" data-testid="settings-restore" onClick={requestRestore} disabled={busy}><Upload size={16} />Khôi phục bản sao lưu</button></div>}
      <p className="settings-info"><Info size={15} aria-hidden="true" />Khôi phục sẽ thay thế dữ liệu hiện tại sau khi bạn xác nhận. Hãy giữ một bản sao lưu trước khi thực hiện.</p>
    </section>

    <section className="settings-card settings-danger-card" aria-labelledby="settings-reset-title">
      <div className="settings-card-heading"><div className="settings-card-icon danger"><Trash2 size={17} /></div><div><p className="eyebrow">QUẢN LÝ DỮ LIỆU</p><h2 id="settings-reset-title">Đặt lại dữ liệu</h2></div></div>
      <p className="settings-description">Các thao tác này không thể hoàn tác. Một hộp xác nhận sẽ xuất hiện trước khi dữ liệu bị xóa.</p>
      <div className="settings-reset-list"><div className="settings-reset-row"><div><strong>Đặt lại phiên luyện tập</strong><p>Xóa các phiên đang lưu, giữ nguyên lịch sử lượt kiểm tra và kho Kanji.</p></div><button className="button secondary danger-outline" type="button" data-testid="settings-reset-sessions" onClick={() => requestReset('sessions')} disabled={busy}><RotateCcw size={15} />Đặt lại phiên</button></div><div className="settings-reset-row"><div><strong>Xóa lịch sử học tập</strong><p>Xóa phiên và toàn bộ lượt kiểm tra, giữ nguyên kho Kanji.</p></div><button className="button danger" type="button" data-testid="settings-reset-history" onClick={() => requestReset('history')} disabled={busy}><Trash2 size={15} />Xóa lịch sử</button></div></div>
    </section>

    <ConfirmationDialog action={confirmAction} busy={busy} dialogRef={dialogRef} onCancel={onCloseConfirm} onConfirm={() => void handleConfirm()} />
  </section>;
}

