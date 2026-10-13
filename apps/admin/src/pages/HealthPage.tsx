import { ADMIN_APP_NAME, healthStatus } from '../health';

export function HealthPage() {
  return (
    <main
      style={{ fontFamily: 'system-ui, sans-serif', margin: '0 auto', maxWidth: 720, padding: 24 }}
    >
      <h1>{ADMIN_APP_NAME} — 健康检查</h1>
      <p>
        status: <code>{healthStatus()}</code>
      </p>
    </main>
  );
}
