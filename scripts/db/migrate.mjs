// scripts/db/migrate.mjs —— 迁移 up：flyway migrate（portable 轨入口；docker 轨为
// docker compose run --rm flyway migrate，两者共用 services/core/flyway.conf）
import { log, ensurePgUp, flyway } from './lib.mjs';

ensurePgUp();
log('== flyway migrate ==');
flyway(['migrate']);
