import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { HealthPage } from './pages/HealthPage';

const container = document.getElementById('root');
if (!container) {
  throw new Error('missing #root container');
}

const page = window.location.pathname === '/health' ? <HealthPage /> : <App />;

createRoot(container).render(<StrictMode>{page}</StrictMode>);
