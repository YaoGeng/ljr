import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { applyDesignCssVars } from './design/tokens';
import { restoreSession } from './api/session';
import { App } from './App';
import { HealthPage } from './pages/HealthPage';
import './styles/global.css';

// 启动序（评审 IMPORTANT-1，顺序是硬约束）：
//   ① restoreSession() 同步先于首渲染——已登录刷新时首帧即 authenticated，深层路由
//      （如 #/lawyers）不被「未登录 → login」重定向丢失、无 LoginPage 闪烁；
//   ② token 注入同步先于首帧（global.css 只引用 --ljr-* 变量，值来自 design/tokens.ts）。
restoreSession();
applyDesignCssVars();

const container = document.getElementById('root');
if (!container) {
  throw new Error('missing #root container');
}

// /health 独立路径（健康检查面，不进登录门/hash 路由）
const page = window.location.pathname === '/health' ? <HealthPage /> : <App />;

createRoot(container).render(<StrictMode>{page}</StrictMode>);
