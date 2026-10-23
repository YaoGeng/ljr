import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    // dev 联调反代（M3-W3 T1）：'/auth'|'/admin'|'/pricing' 前缀 → 本地 core（PORT=3000，
    // config/dev/app.env）。只影响 vite dev；build/E2E 轨不受影响（E2E=构建期注入
    // VITE_API_BASE 绝对值 + 自有静态宿反代，W3-1）。
    proxy: {
      '/auth': 'http://127.0.0.1:3000',
      '/admin': 'http://127.0.0.1:3000',
      '/pricing': 'http://127.0.0.1:3000',
    },
  },
});
