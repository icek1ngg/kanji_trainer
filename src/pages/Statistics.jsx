import { RefreshCw, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useStatistics } from '../hooks/useStatistics.js';
import {
  ActivityChart,
  DifficultKanjiList,
  HistoryTable,
  MetricCards,
  RecentKanjiList,
  RecentSessions,
} from '../components/StatisticsViews.jsx';
import './statistics.css';

function StatisticsError({ error, onRetry }) {
  void error;
  return <div className="statistics-error" role="alert"><TriangleAlert size={18} aria-hidden="true" /><div className="statistics-error-copy"><strong>Không thể đọc số liệu trên thiết bị này</strong><span>Kiểm tra quyền lưu trữ của trình duyệt rồi thử lại.</span><button className="text-button" type="button" onClick={() => void onRetry()}>Thử lại</button></div></div>;
}

function LoadingState() {
  return <section className="statistics-loading" aria-live="polite"><span className="loading-ring" aria-hidden="true" /><p>Đang đọc số liệu cục bộ…</p></section>;
}

export default function Statistics() {
  const { stats, loading, refreshing, error, refresh, lastUpdated } = useStatistics();
  const [historyPage, setHistoryPage] = useState(0);

  if (loading && !stats) return <section className="statistics-page"><LoadingState /></section>;
  if (!stats) return <section className="statistics-page"><div className="page-heading"><div className="statistics-heading-copy"><p className="eyebrow">DỮ LIỆU HỌC TẬP</p><h1>Thống kê</h1><p className="muted">Số liệu được đọc trực tiếp từ bộ nhớ cục bộ.</p></div></div><StatisticsError error={error} onRetry={refresh} /></section>;

  const latest = stats.latest || {};
  const libraryTotal = Number.isFinite(Number(stats.library?.total)) ? Number(stats.library.total) : 0;
  const latestPracticed = Number.isFinite(Number(latest.practiced)) ? Number(latest.practiced) : Number(latest.correct || 0) + Number(latest.incorrect || 0);
  return <section className="statistics-page">
    <div className="page-heading">
      <div className="statistics-heading-copy"><p className="eyebrow">DỮ LIỆU HỌC TẬP</p><h1>Thống kê</h1><p className="muted">Các con số giúp bạn nhìn rõ nhịp học của mình · Giờ Việt Nam.</p></div>
      <div className="statistics-heading-actions"><button className={`button secondary${refreshing ? ' statistics-refreshing' : ''}`} type="button" onClick={() => void refresh()} disabled={refreshing}><RefreshCw size={16} /> {refreshing ? 'Đang làm mới…' : 'Làm mới số liệu'}</button></div>
    </div>
    {error && <StatisticsError error={error} onRetry={refresh} />}
    <MetricCards stats={stats} />
    <p className="statistics-recorded-note">Chỉ tính các lượt kiểm tra có bản ghi chi tiết; tổng phiên cũ không được cộng vào số liệu.</p>

    <section className="statistics-panel latest-status-panel" aria-labelledby="latest-status-title"><div className="statistics-panel-heading"><div><p className="eyebrow">TRẠNG THÁI HIỆN TẠI</p><h2 id="latest-status-title">Kho Kanji và lịch sử được tách riêng</h2><p className="statistics-panel-subtitle">Trạng thái dưới đây tính theo thư viện hiện tại và lượt kiểm tra mới nhất của từng Kanji.</p></div></div><div className="latest-status-grid"><div className="latest-status-item"><span>Kanji đang có trong kho</span><strong>{libraryTotal}</strong><small>Thư viện hiện tại</small></div><div className="latest-status-item"><span>Đã có lượt kiểm tra mới nhất</span><strong>{latestPracticed}</strong><small>Không tính bản nháp chưa kiểm tra</small></div><div className="latest-status-item latest-correct"><span>Đúng gần nhất</span><strong>{Number(latest.correct || 0)}</strong><small>Trên Kanji đang có lịch sử</small></div><div className="latest-status-item latest-incorrect"><span>Sai gần nhất</span><strong>{Number(latest.incorrect || 0)}</strong><small>Có thể luyện lại ở Ôn câu sai</small></div><div className="latest-status-item"><span>Chưa có lịch sử</span><strong>{Number(latest.unanswered || 0)}</strong><small>Chưa từng kiểm tra hoặc chưa có lượt</small></div></div></section>

    <div className="statistics-grid"><ActivityChart activity={stats.activity} title="Hoạt động 14 ngày" /><RecentKanjiList items={stats.recentKanji} title="Kanji gần đây" /></div>
    <DifficultKanjiList items={stats.difficultKanji} />
    <RecentSessions sessions={stats.recentSessions} />
    <HistoryTable history={stats.history} page={historyPage} onPageChange={setHistoryPage} />
    {lastUpdated && <p className="statistics-last-updated">Cập nhật lúc {new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', dateStyle: 'medium', timeStyle: 'short' }).format(lastUpdated)} · Giờ Việt Nam</p>}
    <p className="statistics-footnote">Chỉ tính các lượt kiểm tra có bản ghi chi tiết. Tổng phiên cũ không được cộng vào số liệu. Bạn có thể tiếp tục luyện tập ở <Link to="/practice">Bảng</Link> hoặc <Link to="/flashcards">Flashcard</Link>.</p>
  </section>;
}

