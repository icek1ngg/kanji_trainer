import { Link } from 'react-router-dom';
import { lazy, Suspense } from 'react';
import {
  Activity,
  BarChart3,
  BookOpen,
  CheckCircle2,
  CircleAlert,
  CircleX,
  Clock3,
  History,
  Layers3,
  ListChecks,
  Target,
} from 'lucide-react';
import { getReadingCountLabel } from '../domain/readings.js';

const ActivityBars = lazy(() => import('./ActivityBars.jsx'));

export const TIME_ZONE = 'Asia/Ho_Chi_Minh';

export const MODE_LABELS = Object.freeze({
  table: 'Bảng',
  flashcard: 'Flashcard',
  wrong: 'Ôn câu sai',
});

function number(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

export function formatPercent(value) {
  const rounded = Math.round(number(value));
  return `${rounded}%`;
}

export function formatDateTime(value, { withTime = true } = {}) {
  if (!value || Number.isNaN(Date.parse(value))) return '—';
  try {
    return new Intl.DateTimeFormat('vi-VN', {
      timeZone: TIME_ZONE,
      dateStyle: 'medium',
      ...(withTime ? { timeStyle: 'short' } : {}),
    }).format(new Date(value));
  } catch {
    return String(value);
  }
}

function countLabel(readings, fallback) {
  if (Array.isArray(readings) && readings.length) return getReadingCountLabel(readings);
  if (Number.isInteger(fallback) && fallback >= 0) return `${fallback} âm`;
  return '—';
}

function metricValue(value) {
  return new Intl.NumberFormat('vi-VN').format(number(value));
}

const METRICS = [
  { key: 'kanji', label: 'Kanji trong kho', description: 'Đang có trong thư viện', icon: BookOpen, tone: 'teal' },
  { key: 'attempts', label: 'Lượt kiểm tra', description: 'Lịch sử cá nhân đã ghi', icon: ListChecks, tone: 'blue' },
  { key: 'correct', label: 'Trả lời đúng', description: 'Đủ tất cả âm yêu cầu', icon: CheckCircle2, tone: 'green' },
  { key: 'incorrect', label: 'Trả lời sai', description: 'Cần củng cố thêm', icon: CircleX, tone: 'rose' },
  { key: 'accuracy', label: 'Độ chính xác', description: 'Trên các lượt đã ghi', icon: Target, tone: 'amber' },
  { key: 'multiReading', label: 'Kanji nhiều âm', description: 'Từ hai âm trở lên', icon: Layers3, tone: 'purple' },
];

export function MetricCards({ stats }) {
  const safe = stats || {};
  const values = {
    kanji: safe.library?.total,
    attempts: safe.totals?.attempts,
    correct: safe.totals?.correct,
    incorrect: safe.totals?.incorrect,
    accuracy: formatPercent(safe.totals?.accuracy),
    multiReading: safe.library?.multiReading,
  };
  return <section className="statistics-metrics" aria-label="Chỉ số tổng quan">
    {METRICS.map(({ key, label, description, icon: Icon, tone }) => <article className={`statistics-metric metric-${tone}`} data-testid={`metric-${key === 'multiReading' ? 'multi-reading' : key}`} key={key}>
      <div className="statistics-metric-icon" aria-hidden="true"><Icon size={18} /></div>
      <div className="statistics-metric-copy"><span>{label}</span><strong>{key === 'accuracy' ? values[key] : metricValue(values[key])}</strong><small>{description}</small></div>
    </article>)}
  </section>;
}

export function ActivityChart({ activity = [], title = 'Hoạt động 14 ngày' }) {
  const rows = Array.isArray(activity) ? activity : [];
  const total = rows.reduce((sum, row) => sum + number(row.total ?? number(row.correct) + number(row.incorrect)), 0);
  return <section className="statistics-panel statistics-activity-panel" aria-labelledby="statistics-activity-title">
    <div className="statistics-panel-heading"><div><p className="eyebrow">NHỊP HỌC</p><h2 id="statistics-activity-title">{title}</h2><p className="statistics-panel-subtitle">Số lượt đúng và sai theo ngày · Giờ Việt Nam</p></div><Activity size={20} aria-hidden="true" /></div>
    {total === 0 ? <div className="statistics-empty statistics-empty-compact"><BarChart3 size={25} /><h3>Chưa có lượt kiểm tra</h3><p>Hoạt động sẽ xuất hiện sau khi bạn kiểm tra một câu trả lời.</p><Link className="button secondary" to="/practice">Bắt đầu luyện tập</Link></div> : <>
      <div className="statistics-chart-wrap" aria-label="Biểu đồ lượt đúng và sai trong 14 ngày"><Suspense fallback={<div className="statistics-chart-loading" role="status">Đang mở biểu đồ…</div>}><ActivityBars data={rows} /></Suspense></div>
      <details className="statistics-data-details"><summary>Xem dữ liệu theo ngày</summary><div className="statistics-data-table-wrap"><table className="statistics-data-table"><thead><tr><th scope="col">Ngày</th><th scope="col">Đúng</th><th scope="col">Sai</th><th scope="col">Tổng</th></tr></thead><tbody>{rows.map(row => <tr key={row.date || row.label}><th scope="row">{row.label}</th><td>{metricValue(row.correct)}</td><td>{metricValue(row.incorrect)}</td><td>{metricValue(row.total ?? number(row.correct) + number(row.incorrect))}</td></tr>)}</tbody></table></div></details>
    </>}
  </section>;
}

function attemptStatus(attempt) {
  if (attempt?.isCorrect === true) return { label: 'Đúng', className: 'status-correct' };
  if (attempt?.isCorrect === false) return { label: 'Sai', className: 'status-incorrect' };
  return { label: 'Chưa kiểm tra', className: 'status-unanswered' };
}

export function RecentKanjiList({ items = [], title = 'Kanji gần đây' }) {
  const rows = Array.isArray(items) ? items.slice(0, 8) : [];
  return <section className="statistics-panel statistics-list-panel" aria-labelledby="statistics-recent-title">
    <div className="statistics-panel-heading"><div><p className="eyebrow">GẦN ĐÂY</p><h2 id="statistics-recent-title">{title}</h2><p className="statistics-panel-subtitle">Kết quả kiểm tra mới nhất của từng Kanji</p></div><Clock3 size={20} aria-hidden="true" /></div>
    {rows.length === 0 ? <div className="statistics-empty"><History size={25} /><h3>Chưa có lịch sử Kanji</h3><p>Luyện tập để xem những chữ bạn vừa kiểm tra.</p><Link className="button secondary" to="/practice">Bắt đầu luyện tập</Link></div> : <div className="statistics-kanji-list">{rows.map(item => {
      const status = attemptStatus(item.latestAttempt);
      return <div className="statistics-kanji-row" key={item.id || item.kanji}>
        <span className="statistics-kanji-glyph" aria-hidden="true">{item.kanji}</span>
        <div className="statistics-kanji-copy"><strong>{item.kanji}</strong><span>{countLabel(item.hanViet, item.latestAttempt?.requiredCount)}{item.deleted ? <em className="deleted-label">Đã xóa khỏi kho</em> : null}</span></div>
        <div className="statistics-kanji-result"><span className={`statistics-status ${status.className}`}>{status.label}</span><time dateTime={item.latestAttempt?.createdAt || item.latestAttempt?.checkedAt}>{formatDateTime(item.latestAttempt?.createdAt || item.latestAttempt?.checkedAt)}</time></div>
      </div>;
    })}</div>}
  </section>;
}

export function DifficultKanjiList({ items = [] }) {
  const rows = Array.isArray(items) ? items.slice(0, 10) : [];
  return <section className="statistics-panel statistics-list-panel" aria-labelledby="statistics-difficult-title">
    <div className="statistics-panel-heading"><div><p className="eyebrow">CẦN CỦNG CỐ</p><h2 id="statistics-difficult-title">Kanji khó nhất</h2><p className="statistics-panel-subtitle">Xếp theo số lượt trả lời sai</p></div><CircleAlert size={20} aria-hidden="true" /></div>
    {rows.length === 0 ? <div className="statistics-empty"><CheckCircle2 size={25} /><h3>Chưa có Kanji cần củng cố</h3><p>Danh sách sẽ xuất hiện khi lịch sử có lượt trả lời sai.</p><Link className="button secondary" to="/practice">Luyện tập ngay</Link></div> : <div className="statistics-difficult-list">{rows.map(item => <div className="statistics-difficult-row" key={item.id || item.kanji}><div className="statistics-difficult-name"><strong>{item.kanji}</strong><span>{countLabel(item.hanViet)}{item.deleted ? <em className="deleted-label">Đã xóa khỏi kho</em> : null}</span></div><div className="statistics-difficult-count"><strong>{metricValue(item.incorrect)}</strong><span>sai / {metricValue(item.total)} lượt</span></div><div className="statistics-difficult-accuracy">{formatPercent(item.accuracy)}</div></div>)}</div>}
  </section>;
}

function sessionCurrentText(current) {
  if (!current || typeof current !== 'object') return '—';
  const total = number(current.total);
  const correct = number(current.correct);
  const incorrect = number(current.incorrect);
  const unanswered = number(current.unanswered);
  return `${metricValue(total)} mục · ${metricValue(correct)} đúng · ${metricValue(incorrect)} sai${unanswered ? ` · ${metricValue(unanswered)} chưa kiểm tra` : ''}`;
}

export function RecentSessions({ sessions = [] }) {
  const rows = Array.isArray(sessions) ? sessions.slice(0, 10) : [];
  return <section className="statistics-panel statistics-sessions-panel" aria-labelledby="statistics-sessions-title">
    <div className="statistics-panel-heading"><div><p className="eyebrow">PHIÊN GẦN ĐÂY</p><h2 id="statistics-sessions-title">Các phiên luyện tập</h2><p className="statistics-panel-subtitle">Lượt đã ghi và trạng thái hiện tại được hiển thị riêng</p></div><ListChecks size={20} aria-hidden="true" /></div>
    {rows.length === 0 ? <div className="statistics-empty"><ListChecks size={25} /><h3>Chưa có phiên luyện tập</h3><p>Phiên sẽ xuất hiện sau khi bạn bắt đầu luyện tập trên thiết bị này.</p><Link className="button secondary" to="/practice">Bắt đầu luyện tập</Link></div> : <div className="statistics-table-wrap"><table className="statistics-table"><caption className="sr-only">Các phiên luyện tập gần đây</caption><thead><tr><th scope="col">Phiên</th><th scope="col">Lượt đã ghi</th><th scope="col">Đúng</th><th scope="col">Sai</th><th scope="col">Độ chính xác</th><th scope="col">Hiện tại</th></tr></thead><tbody>{rows.map(session => {
      const attempts = number(session.attempts);
      const legacy = number(session.legacyChecks);
      return <tr key={session.id}><th scope="row"><strong>{MODE_LABELS[session.mode] || session.mode || 'Phiên học'}</strong><time dateTime={session.updatedAt || session.createdAt}>{formatDateTime(session.updatedAt || session.createdAt)}</time>{session.active ? <span className="active-session-label">Đang mở</span> : null}</th><td>{metricValue(attempts)}{legacy > 0 ? <small className="legacy-note">+ {metricValue(legacy)} lượt cũ không cộng</small> : null}</td><td>{metricValue(session.correct)}</td><td>{metricValue(session.incorrect)}</td><td>{formatPercent(session.accuracy)}</td><td><span className="current-session-summary">{sessionCurrentText(session.current)}</span></td></tr>;
    })}</tbody></table><p className="statistics-table-note">Các lượt kiểm tra cũ của phiên chỉ được giữ để tham khảo; chúng không được cộng lại vào tổng lịch sử cá nhân.</p></div>}
  </section>;
}

export function HistoryTable({ history = [], page = 0, pageSize = 20, onPageChange = () => {} }) {
  const rows = Array.isArray(history) ? history : [];
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  const safePage = Math.min(Math.max(page, 0), totalPages - 1);
  const visible = rows.slice(safePage * pageSize, safePage * pageSize + pageSize);
  return <section className="statistics-panel statistics-history-panel" aria-labelledby="statistics-history-title">
    <div className="statistics-panel-heading"><div><p className="eyebrow">LỊCH SỬ CHI TIẾT</p><h2 id="statistics-history-title">Tất cả lượt kiểm tra</h2><p className="statistics-panel-subtitle">Hiển thị {visible.length ? `${safePage * pageSize + 1}–${safePage * pageSize + visible.length}` : '0'} trong tổng số {metricValue(rows.length)} lượt · Giờ Việt Nam</p></div><History size={20} aria-hidden="true" /></div>
    {rows.length === 0 ? <div className="statistics-empty"><History size={25} /><h3>Chưa có lượt kiểm tra chi tiết</h3><p>Lịch sử sẽ xuất hiện sau khi bạn nhấn Kiểm tra ở một chế độ luyện tập.</p><Link className="button secondary" to="/practice">Bắt đầu luyện tập</Link></div> : <>
      <div className="statistics-table-wrap statistics-history-table-wrap"><table className="statistics-table statistics-history-table"><caption className="sr-only">Lịch sử tất cả lượt kiểm tra</caption><thead><tr><th scope="col">Thời gian</th><th scope="col">Kanji</th><th scope="col">Số âm</th><th scope="col">Âm đã nhập</th><th scope="col">Kết quả</th><th scope="col">Chế độ</th></tr></thead><tbody>{visible.map((attempt, index) => {
        const status = attemptStatus(attempt);
        return <tr key={attempt.id || `${attempt.kanji}-${index}`}><td><time dateTime={attempt.createdAt || attempt.checkedAt}>{formatDateTime(attempt.createdAt || attempt.checkedAt)}</time></td><th scope="row"><strong>{attempt.kanji || '—'}</strong>{attempt.deleted ? <span className="deleted-label">Đã xóa khỏi kho</span> : null}</th><td>{countLabel(attempt.requiredReadings, attempt.requiredCount)}</td><td className="submitted-answer" title={attempt.submittedAnswer}>{attempt.submittedAnswer || '—'}</td><td><span className={`statistics-status ${status.className}`}>{status.label}</span></td><td>{MODE_LABELS[attempt.mode] || attempt.mode || '—'}</td></tr>;
      })}</tbody></table></div>
      <div className="statistics-pagination"><button className="button secondary" type="button" disabled={safePage === 0} onClick={() => onPageChange(safePage - 1)}>Trang trước</button><span aria-live="polite">Trang {safePage + 1} / {totalPages}</span><button className="button secondary" type="button" disabled={safePage >= totalPages - 1} onClick={() => onPageChange(safePage + 1)}>Trang sau</button></div>
    </>}
  </section>;
}

