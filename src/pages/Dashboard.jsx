import { ArrowRight, RefreshCw, TriangleAlert } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useStatistics } from '../hooks/useStatistics.js';
import {
  ActivityChart,
  DifficultKanjiList,
  MetricCards,
  RecentKanjiList,
} from '../components/StatisticsViews.jsx';
import './statistics.css';

function StatisticsError({ error, onRetry }) {
  void error;
  return <div className="statistics-error" role="alert"><TriangleAlert size={18} aria-hidden="true" /><div className="statistics-error-copy"><strong>Không thể đọc số liệu trên thiết bị này</strong><span>Kiểm tra quyền lưu trữ của trình duyệt rồi thử lại.</span><button className="text-button" type="button" onClick={() => void onRetry()}>Thử lại</button></div></div>;
}

function LoadingState() {
  return <section className="statistics-loading" aria-live="polite"><span className="loading-ring" aria-hidden="true" /><p>Đang đọc số liệu cục bộ…</p></section>;
}

export default function Dashboard() {
  const { stats, loading, refreshing, error, refresh } = useStatistics();

  if (loading && !stats) return <section className="dashboard-page"><LoadingState /></section>;
  if (!stats) return <section className="dashboard-page"><div className="page-heading"><div><p className="eyebrow">TỔNG QUAN</p><h1>Tổng quan</h1><p className="muted">Số liệu học tập được giữ trên thiết bị của bạn.</p></div></div><StatisticsError error={error} onRetry={refresh} /></section>;

  return <section className="dashboard-page">
    <div className="page-heading">
      <div className="statistics-heading-copy"><p className="eyebrow">TỔNG QUAN</p><h1>Tổng quan</h1><p className="muted">Nhìn lại bộ Kanji và những lượt luyện tập đã ghi · Giờ Việt Nam.</p></div>
      <div className="statistics-heading-actions"><button className={`button secondary${refreshing ? ' statistics-refreshing' : ''}`} type="button" onClick={() => void refresh()} disabled={refreshing}><RefreshCw size={16} className={refreshing ? 'statistics-spin-icon' : ''} /> {refreshing ? 'Đang làm mới…' : 'Làm mới số liệu'}</button><Link className="button primary" data-testid="quick-start-practice" to="/practice">Bắt đầu luyện tập <ArrowRight size={16} /></Link></div>
    </div>
    {error && <StatisticsError error={error} onRetry={refresh} />}
    <MetricCards stats={stats} />
    <div className="statistics-grid"><ActivityChart activity={stats.activity} /><RecentKanjiList items={stats.recentKanji} /></div>
    <DifficultKanjiList items={stats.difficultKanji} />
  </section>;
}

