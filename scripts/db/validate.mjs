// scripts/db/validate.mjs —— 校验已应用迁移与迁移文件的一致性（CI 口径同此，ADR-0002）
import { log, ensurePgUp, flyway } from './lib.mjs';

ensurePgUp();
log('== flyway validate ==');
flyway(['validate']);
