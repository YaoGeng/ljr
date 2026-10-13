const APP_NAME = '律聚人 · 运营后台';

export function App() {
  return (
    <main
      style={{ fontFamily: 'system-ui, sans-serif', margin: '0 auto', maxWidth: 720, padding: 24 }}
    >
      <h1>{APP_NAME}</h1>
      <p>骨架占位页（M0-2）。运营后台功能随 H 域模块施工逐步落位。</p>
      <p>
        健康检查页：<a href="/health">/health</a>
      </p>
    </main>
  );
}
