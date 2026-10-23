import SettingsPage from './pages/Settings.jsx';
import { useState } from 'react';
import KanjiLibrary from './pages/KanjiLibrary.jsx';
import TablePractice from './pages/TablePractice.jsx';
import Flashcards from './pages/Flashcards.jsx';
import WrongAnswers from './pages/WrongAnswers.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Statistics from './pages/Statistics.jsx';
import { Link, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { BookOpen, ChartNoAxesCombined, CircleCheck, Columns3, House, Layers, Moon, RotateCcw, Settings, Sun } from 'lucide-react';

export const pages = [
  { path: '/', title: 'Tổng quan', icon: House, description: 'Góc học tập âm Hán Việt của bạn.' },
  { path: '/practice', title: 'Luyện tập', icon: Columns3, description: 'Luyện tất cả âm Hán Việt trong một bảng thuận tiện.' },
  { path: '/flashcards', title: 'Flashcard', icon: Layers, description: 'Tập trung vào từng Kanji, theo nhịp học của bạn.' },
  { path: '/wrong-answers', title: 'Ôn câu sai', icon: RotateCcw, description: 'Chủ động luyện lại những Kanji bạn muốn củng cố.' },
  { path: '/library', title: 'Kho Kanji', icon: BookOpen, description: 'Nơi quản lý Kanji và các âm Hán Việt của bạn.' },
  { path: '/statistics', title: 'Thống kê', icon: ChartNoAxesCombined, description: 'Nhìn lại quá trình luyện tập qua dữ liệu thực tế.' },
  { path: '/settings', title: 'Cài đặt', icon: Settings, description: 'Điều chỉnh không gian học tập theo ý bạn.' },
];

export default function App() {
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme || 'light');
  const location = useLocation();
  const page = pages.find(item => item.path === location.pathname);
  function changeTheme(next) {
    setTheme(next);
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('kanji-theme', next); } catch { /* Theme remains usable if storage is unavailable. */ }
  }
  return <div className="app-shell"><a className="skip-link" href="#main-content">Đến nội dung chính</a><aside className="sidebar"><Link className="brand" to="/" aria-label="Kanji Trainer — Tổng quan"><span className="brand-mark" aria-hidden="true">字</span><span><strong className="brand-name">Kanji Trainer</strong><span className="brand-caption">ÂM HÁN VIỆT</span></span></Link><nav className="nav-list" aria-label="Điều hướng chính">{pages.map(({ path, title, icon: Icon }) => <NavLink className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`} key={path} to={path} end={path === '/'}><Icon size={20} /><span>{title}</span></NavLink>)}</nav><div className="sidebar-note"><CircleCheck size={19} /><div><strong>Từng chữ, từng bước</strong><p>Học chậm rãi. Ghi nhớ bền lâu.</p></div></div></aside><div className="main-area"><header className="topbar"><span className="breadcrumb">Không gian của bạn <span aria-hidden="true">/</span> <strong>{page?.title || 'Không tìm thấy'}</strong></span><button className="theme-button" onClick={() => changeTheme(theme === 'dark' ? 'light' : 'dark')} aria-label={theme === 'dark' ? 'Chuyển sang giao diện sáng' : 'Chuyển sang giao diện tối'} aria-pressed={theme === 'dark'}>{theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}<span>{theme === 'dark' ? 'Giao diện sáng' : 'Giao diện tối'}</span></button></header><main id="main-content" className="page-content" tabIndex={-1}><Routes><Route path="/" element={<Dashboard />} />{pages.slice(1).map(item => <Route key={item.path} path={item.path} element={item.path === '/library' ? <KanjiLibrary /> : item.path === '/practice' ? <TablePractice /> : item.path === '/flashcards' ? <Flashcards /> : item.path === '/wrong-answers' ? <WrongAnswers /> : item.path === '/statistics' ? <Statistics /> : <SettingsPage theme={theme} onThemeChange={changeTheme} />} />)}<Route path="*" element={<section className="placeholder-panel"><h1>Không tìm thấy trang</h1><Link className="button primary" to="/">Về tổng quan</Link></section>} /></Routes></main></div></div>;
}
