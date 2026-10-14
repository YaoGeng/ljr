/**
 * E1 实时脱敏层——正则规则集与替换引擎（纯函数，零 IO/确定性：同输入同输出）。
 *
 * R-02（架构 §4.6 合规 R4）：原文（含 PII）不得进 RAG/LLM——本引擎是「脱敏→意图→RAG→LLM→
 * 气泡」管线的第一段，输出 sanitized（唯一可进下游载荷）+ placeholders（占位符→原文映射，
 * 仅律师端还原，与 sanitized 结构分离）。同训练管线同源（架构 §4.6）：规则集/回归集为纯
 * 代码常量，M2 训练管线直接复用（sanitize.rules + sanitize.regression），不落 DB。
 *
 * 规则集形态裁决（控制者允许的最小表裁量，论证见任务报告）：规则集**不建表**——脱敏规则是
 * 合规关键路径（误编辑=R-02 违规），变更必须走代码评审+回归集门槛而非运行时可配；版本锚点=
 * SANITIZE_RULESET_VERSION 常量，随审计行（sanitize_audit.rule_version）留痕。NER 模型 M2 ⚠。
 *
 * 引擎机制（跨规则优先级 + 占位修复防串扰）：按优先级序（证件号→银行卡→电话→姓名→地址）在
 * 原文上收集「认领区间」，后位规则的与已认领区间重叠的命中弃权（先到先得）——占位符替换只做
 * 一遍，避免 [证件号] 等记号被后续规则（如地址后缀“号”）二次吞噬；同文本确定性由固定规则序
 * + matchAll 顺序保证。
 *
 * 覆盖度 ⚠（正则能力边界，报告明示）：姓名=上下文关键词+姓氏边界（无上下文裸名不拦）；证件
 * 号 18 位要求校验位合法、15 位要求出生段合法（校验位不符/日期非法的长数字串按单号放行）；
 * 银行卡要求 Luhn 合法；座机/邮箱/护照等类型未覆盖——均由 M2 NER+词表追加（规则序尾部追加，
 * 不改引擎）。
 */
import { createHash } from 'node:crypto';
import { AppError, ErrorCode } from '@ljr/shared';
import {
  PLACEHOLDER_LABELS,
  type PiiHit,
  type PlaceholderBinding,
  type PiiType,
  type SanitizePureResult,
} from './sanitize.types';

/** 规则集版本（语义化；规则/阈值任何变更必须升版——审计行按此留痕，回归集同批演进） */
export const SANITIZE_RULESET_VERSION = '1.0.0';

// ---------- 算法校验器（证件号校验位 / Luhn / 日历） ----------

const ID18_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2] as const;
const ID18_CHECK_MAP = '10X98765432';

function isLeapYear(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function isValidCalendarDate(y: number, mo: number, d: number): boolean {
  if (!Number.isInteger(y) || mo < 1 || mo > 12 || d < 1) return false;
  const daysInMonth =
    [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1]! + (mo === 2 && isLeapYear(y) ? 1 : 0);
  return d <= daysInMonth;
}

/** GB 11643-1999：17 位本体 + 校验位（含出生段合理性，双门降低长数字单号误杀） */
export function isValidIdCard18(digits: string): boolean {
  if (!/^\d{17}[\dXx]$/.test(digits)) return false;
  const year = Number(digits.slice(6, 10));
  const thisYear = new Date().getUTCFullYear();
  if (year < 1900 || year > thisYear) return false;
  if (!isValidCalendarDate(year, Number(digits.slice(10, 12)), Number(digits.slice(12, 14)))) {
    return false;
  }
  let sum = 0;
  for (let i = 0; i < 17; i++) sum += Number(digits[i]) * ID18_WEIGHTS[i]!;
  return ID18_CHECK_MAP[sum % 11] === digits[17]!.toUpperCase();
}

/** 15 位老身份证：省位 1-8 + 出生段（19yy）日历合法 */
export function isValidIdCard15(digits: string): boolean {
  if (!/^\d{15}$/.test(digits)) return false;
  const province = Number(digits[0]);
  if (province < 1 || province > 8) return false;
  const yy = Number(digits.slice(6, 8));
  return isValidCalendarDate(1900 + yy, Number(digits.slice(8, 10)), Number(digits.slice(10, 12)));
}

/** Luhn（ISO/IEC 7812-1）：银行卡加严门（非 Luhn 长数字单号放行） */
export function isValidLuhn(digits: string): boolean {
  if (!/^\d{2,}$/.test(digits)) return false;
  let sum = 0;
  let doubleIt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (doubleIt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    doubleIt = !doubleIt;
  }
  return sum % 10 === 0;
}

// ---------- 规则集（优先级序=数组序；正样本对应 sanitize.regression） ----------

interface RawHit {
  readonly type: PiiType;
  /** 原文 UTF-16 码元区间 [start, end)（认领/替换用） */
  readonly start: number;
  readonly end: number;
  /** 认领的原文片段（占位符映射值） */
  readonly value: string;
}

interface SanitizeRule {
  readonly type: PiiType;
  readonly regex: RegExp;
  /** 命中组的承载校验（false=弃权不认领）；入参=digits（剥离空格/连字符后的数字串）与 raw */
  readonly validate?: (digits: string, raw: string) => boolean;
}

// 证件号 18 位：可含单个空格分隔；位长 18（17 数字 + 校验位），前后不得再接数字/X（位长门）
const ID18_RE = /(?<![\dXx])\d(?:[ ]?\d){16}[\dXx](?![\dXx])/g;
// 证件号 15 位（老证）：全数字，位长门同上
const ID15_RE = /(?<![\dXx])\d(?:[ ]?\d){14}(?![\dXx])/g;
// 银行卡：13-19 位（可空格/连字符分组），取极大数字串后 Luhn 把门
const BANK_RE = /(?<![\dXx])\d(?:[ -]?\d){12,18}(?![\dXx])/g;
// 手机号：11 位 1[3-9] 号段，可空格/连字符分隔；前后不得再接数字（位长门）
const PHONE_RE = /(?<!\d)1[3-9](?:[-\s]?\d){9}(?!\d)/g;

// 姓名（上下文规则 ⚠）：关键词 + 常见姓氏（复姓优先）+ 1~3 字；尾字若为常见连接词则回退，
// 避免「李慧敏在/王振宇和」吞字。姓氏表=常见单姓 ~120 + 复姓 14，覆盖度 ⚠ 报告明示。
const NAME_KEYWORDS =
  '我叫|叫我|我是|本人是|当事人|申请人|被申请人|被诉人|申诉人|原告|被告|委托人|受托人|联系人|代理人|法定代表人|监护人|律师|员工|同事|朋友|邻居|房东|老板|经理|师傅|儿子|女儿|父亲|母亲|哥哥|弟弟|姐姐|妹妹|丈夫|妻子|爱人|老婆|老公';
const NAME_COMPOUND_SURNAMES =
  '欧阳|司马|上官|诸葛|东方|西门|尉迟|皇甫|长孙|慕容|端木|申屠|令狐|公孙';
const NAME_SINGLE_SURNAMES =
  '[王李张刘陈杨黄赵吴周徐孙马朱胡郭何高林罗郑梁谢宋唐许韩冯邓曹彭曾肖田董袁潘于蒋蔡余杜叶程苏魏吕丁任沈姚卢姜崔钟谭陆汪范金石廖贾夏韦付方白邹孟熊秦邱江尹薛闫段雷侯龙史陶黎贺顾毛郝龚邵万钱严覃武戴莫孔向汤常温康施文柯柴倪凌米谷代桂]';
/** 姓名尾字连接词回退（回退不动语义字，如「李慧敏在/周女士来/王振宇手」→认领到姓名为止） */
const NAME_TRAILING_STOP = '的和与及在了是于要把给让过都很就也还被将来到去打找问说想手号码请帮';
// 姓名认领组=第 1 捕获组（关键词不进占位符）；注意：复姓/单姓两支各自先包 (?:…) 再定量词
//（| 优先级最低，否则量词只绑到复姓表最后一个备选——「欧阳晓薇」会只命中「欧阳」）
const NAME_RE = new RegExp(
  `(?:${NAME_KEYWORDS})[\\s：:]?` +
    `((?:(?:${NAME_COMPOUND_SURNAMES})[\\u4e00-\\u9fa5]{1,2}|${NAME_SINGLE_SURNAMES}[\\u4e00-\\u9fa5]{1,3}))` +
    `(?<![${NAME_TRAILING_STOP}])`,
  'g',
);

// 地址（⚠ 正则口径，报告明示）：行政区段（首字排除常见动词/否定字，避免「不在/住在」卷入）
// + 门牌编号段（数字+号/栋/单元/室…；号需数字前缀，避免「三号/代号」误杀）。
const ADDR_ADMIN_FIRST_EXCLUDE = '不在住到去是从离了没把让和';
const ADDR_ADMIN =
  `(?:(?![${ADDR_ADMIN_FIRST_EXCLUDE}])[\\u4e00-\\u9fa5]){1,9}` +
  '(?:省|自治区|市|区|县|镇|乡|村|街道|大道|路|街|巷|弄|广场|小区|花园|公寓|大厦|苑|湾)';
const ADDR_NUMBERED = '\\d{1,6}(?:-\\d{1,4})?(?:号院|号楼|号|栋|幢|座|单元|室)';
const ADDR_RE = new RegExp(
  `(?:${ADDR_ADMIN}){1,5}(?:${ADDR_NUMBERED}){0,4}|(?:${ADDR_NUMBERED}){1,4}`,
  'g',
);

/** 规则集（优先级序）：证件号(18→15) → 银行卡 → 电话 → 姓名 → 地址 */
const RULES: readonly SanitizeRule[] = [
  { type: 'id_card', regex: ID18_RE, validate: (digits) => isValidIdCard18(digits) },
  { type: 'id_card', regex: ID15_RE, validate: (digits) => isValidIdCard15(digits) },
  { type: 'bank_card', regex: BANK_RE, validate: (digits) => isValidLuhn(digits) },
  { type: 'phone', regex: PHONE_RE },
  { type: 'name', regex: NAME_RE },
  { type: 'address', regex: ADDR_RE },
];

// ---------- 引擎（认领-替换一遍成形） ----------

/** UTF-16 码元偏移 → Unicode 码点偏移（出参口径与 knowledge_chunks.metadata 一致） */
function toCodePointIndex(text: string, utf16Index: number): number {
  return Array.from(text.slice(0, utf16Index)).length;
}

function overlapsClaimed(start: number, end: number, claimed: readonly RawHit[]): boolean {
  return claimed.some((c) => start < c.end && c.start < end);
}

/**
 * 纯脱敏引擎（无 IO/确定性）：同文本恒等同输出。规则按优先级序认领原文区间，后位规则与已
 * 认领区间重叠的命中弃权；占位符按类型以首次出现顺序编号（第 1 次=[姓名]，第 k 次=[姓名k]）。
 */
export function sanitizeText(text: string): SanitizePureResult {
  if (typeof text !== 'string') {
    throw new AppError(ErrorCode.InvalidArgument, `text 须为字符串：${typeof text}`);
  }
  const claimed: RawHit[] = [];
  for (const rule of RULES) {
    rule.regex.lastIndex = 0; // 防御：共享 RegExp 实例的 /g 状态不跨调用残留（确定性）
    for (const m of text.matchAll(rule.regex)) {
      const group = rule.type === 'name' ? m[1] : m[0];
      if (group === undefined || group.length === 0) continue;
      // 姓名规则认领组位于匹配尾部（关键词+可选分隔在前）
      const start = (m.index ?? 0) + (m[0].length - group.length);
      const end = start + group.length;
      if (overlapsClaimed(start, end, claimed)) continue; // 先到先得（跨规则优先级）
      if (rule.validate && !rule.validate(group.replace(/[ -]/g, ''), group)) continue;
      claimed.push({ type: rule.type, start, end, value: group });
    }
  }
  claimed.sort((a, b) => a.start - b.start); // matchAll 顺序稳定，排序仅定全系序（确定性）

  const counters = new Map<PiiType, number>();
  const placeholders: PlaceholderBinding[] = [];
  const hits: PiiHit[] = [];
  let sanitized = '';
  let cursor = 0;
  for (const hit of claimed) {
    sanitized += text.slice(cursor, hit.start);
    const nth = (counters.get(hit.type) ?? 0) + 1;
    counters.set(hit.type, nth);
    const token = `[${PLACEHOLDER_LABELS[hit.type]}${nth > 1 ? String(nth) : ''}]`;
    sanitized += token;
    placeholders.push({ token, type: hit.type, value: hit.value });
    hits.push({
      type: hit.type,
      placeholder: token,
      start: toCodePointIndex(text, hit.start),
      end: toCodePointIndex(text, hit.end),
    });
    cursor = hit.end;
  }
  sanitized += text.slice(cursor);
  return { sanitized, placeholders, hits, ruleVersion: SANITIZE_RULESET_VERSION };
}

/** sha256 hex（UTF-8）——审计摘要口径（原文/脱敏文本共用；原文不落明文） */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}
