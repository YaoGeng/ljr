// scripts/db/stop.mjs —— 停止 portable PostgreSQL（pg_ctl -m fast：断开会话、正常关库）
import fs from 'node:fs';
import path from 'node:path';
import { log, die, pgBin, run, PG_DATA } from './lib.mjs';

if (!fs.existsSync(path.join(PG_DATA, 'postgresql.conf'))) {
  die(`数据目录不存在：${PG_DATA}（先运行 node scripts/db/start.mjs）`);
}

log('停止 PostgreSQL（fast 模式）…');
run(pgBin('pg_ctl'), ['-D', PG_DATA, '-m', 'fast', 'stop']);
log('PostgreSQL 已停止。');
