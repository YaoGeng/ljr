// scripts/db/reset.mjs —— down 演练（ADR-0002 口径：drop 业务 schema 后整库重放，非逐版本 undo）
// 步骤：DROP 13 个业务 schema（含数据，IF EXISTS 幂等）→ flyway clean（清 flyway 元数据 schema）
//      → flyway migrate（从零重放至最新）。仅限 dev 演练；生产回退=前向修复 + PITR（ADR-0002）。
import { log, ensurePgUp, flyway, psql, BUSINESS_SCHEMAS } from './lib.mjs';

ensurePgUp();

log(`== reset：DROP ${BUSINESS_SCHEMAS.length} 个业务 schema（CASCADE） ==`);
const out = psql(`DROP SCHEMA IF EXISTS ${BUSINESS_SCHEMAS.join(', ')} CASCADE;`);
if (out.trim()) log(out.trim());

log('== flyway clean（清 flyway 元数据 schema，业务表已随上步 drop） ==');
flyway(['clean']);

log('== flyway migrate（整库重放） ==');
flyway(['migrate']);

log('reset 演练完成（down=drop 业务 schema 后整库重放口径）。');
