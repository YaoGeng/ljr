/**
 * E1 实时脱敏层——PII 回归集（常量文件，独立存放）。
 *
 * 用途（施工规格 docs/modules/E-AI辅助/E1-Agent草稿气泡管线.md §9「PII 词表全命中/漏杀回归
 * 集」+ §10 验收①「PII 回归集 0 漏杀」）：
 *   - 本批：sanitize.rules.spec / sanitize.spec 消费，作为 TDD 事实源（RED→GREEN）；
 *   - M2：训练管线与实时脱敏「同源」的复用锚点（架构 §4.6 合规 R4）——回归集随规则集
 *     （sanitize.rules）同步演进，两处消费同一常量，禁止各写一份。
 *
 * 样例值全部为按算法构造的虚构数据（身份证校验位/Luhn 由算法生成，不指向任何真实个人）。
 *
 * 正样本口径（控制者裁决）：每类 ≥3 变体=标准格式 / 带空格分隔 / 文本夹杂；expect 为按类型
 * 的命中数精确断言（超杀/漏杀都算失败）；values 为必须被替换的原文片段（0 漏杀断言）。
 * 负样本口径：普通劳动仲裁咨询文本 + 形似 PII 的干扰串（非号段手机位长/非 Luhn 长数字单号/
 * 校验位不符的 18 位串/日期非法的 15 位串）——零命中不误杀。
 */
import type { PiiType } from './sanitize.types';

export interface SanitizeRegressionCase {
  readonly name: string;
  readonly text: string;
  /** 按类型的期望命中数（精确相等：多杀/漏杀均失败） */
  readonly expect: Readonly<Partial<Record<PiiType, number>>>;
  /** 必须被占位符替换的原文片段（每个值不得残留在 sanitized 中） */
  readonly values: readonly string[];
}

/** 正样本：PII 全命中 0 漏杀（§10 验收①） */
export const SANITIZE_REGRESSION_POSITIVE: readonly SanitizeRegressionCase[] = [
  // ---- 证件号（id_card）----
  {
    name: '证件号·标准格式（18 位，校验位 X）',
    text: '11010519491231002X',
    expect: { id_card: 1 },
    values: ['11010519491231002X'],
  },
  {
    name: '证件号·带空格分隔（18 位；跨规则优先级：不得被再切出电话/银行卡）',
    text: '440301 19900307 751X',
    expect: { id_card: 1 },
    values: ['440301 19900307 751X'],
  },
  {
    name: '证件号·文本夹杂（15 位老证）',
    text: '他身份证110105491231002上的信息有误。',
    expect: { id_card: 1 },
    values: ['110105491231002'],
  },
  // ---- 电话（phone）----
  {
    name: '电话·标准格式',
    text: '13800138000',
    expect: { phone: 1 },
    values: ['13800138000'],
  },
  {
    name: '电话·带空格分隔',
    text: '手机号138 0013 8000收不到验证码',
    expect: { phone: 1 },
    values: ['138 0013 8000'],
  },
  {
    name: '电话·连字符+文本夹杂',
    text: '打我电话186-1155-6677说明情况',
    expect: { phone: 1 },
    values: ['186-1155-6677'],
  },
  // ---- 银行卡（bank_card）----
  {
    name: '银行卡·标准格式（16 位，Luhn 合法）',
    text: '6222020200112230',
    expect: { bank_card: 1 },
    values: ['6222020200112230'],
  },
  {
    name: '银行卡·空格分组+文本夹杂',
    text: '工资卡6217 0000 1001 2348被法院冻结了',
    expect: { bank_card: 1 },
    values: ['6217 0000 1001 2348'],
  },
  {
    name: '银行卡·19 位对公卡文本夹杂',
    text: '卡号6222600260001072444是公司账户',
    expect: { bank_card: 1 },
    values: ['6222600260001072444'],
  },
  // ---- 姓名（name，上下文规则 ⚠ 覆盖度见报告）----
  {
    name: '姓名·我叫+常见姓',
    text: '我叫王振宇，公司拖欠工资。',
    expect: { name: 1 },
    values: ['王振宇'],
  },
  {
    name: '姓名·当事人+尾随连接词回退',
    text: '当事人李慧敏在2024年3月入职。',
    expect: { name: 1 },
    values: ['李慧敏'],
  },
  {
    name: '姓名·复姓边界',
    text: '当事人欧阳晓薇的仲裁请求如下',
    expect: { name: 1 },
    values: ['欧阳晓薇'],
  },
  // ---- 地址（address）----
  {
    name: '地址·行政区划+门牌',
    text: '我在北京市朝阳区建国路88号上班。',
    expect: { address: 1 },
    values: ['北京市朝阳区建国路88号'],
  },
  {
    name: '地址·一文两址',
    text: '公司地址是上海市浦东新区世纪大道100号，仲裁委在海淀区。',
    expect: { address: 2 },
    values: ['上海市浦东新区世纪大道100号', '海淀区'],
  },
  {
    name: '地址·纯门牌编号',
    text: '他住在2号楼3单元，物业不修电梯。',
    expect: { address: 1 },
    values: ['2号楼3单元'],
  },
  // ---- 混合（一文本五类型同时命中）----
  {
    name: '混合·五类型一次脱敏',
    text: '我叫张伟，身份证11010519491231002X，电话13912345678，住在北京市海淀区中关村大街1号，工资卡6222020200112230被拖欠工资的事牵连。',
    expect: { name: 1, id_card: 1, phone: 1, address: 1, bank_card: 1 },
    values: [
      '张伟',
      '11010519491231002X',
      '13912345678',
      '北京市海淀区中关村大街1号',
      '6222020200112230',
    ],
  },
];

/** 负样本：普通咨询文本 + 形似 PII 的干扰串——零命中不误杀 */
export const SANITIZE_REGRESSION_NEGATIVE: readonly string[] = [
  '公司拖欠三个月工资，没有签劳动合同，怎么申请劳动仲裁？',
  '试用期被辞退还不给补偿，我能要求赔偿金吗？',
  '工号3024567890123，公司不给查考勤记录。', // 13 位非 Luhn 数字串 → 非银行卡
  '订单号202403150001234这块有争议。', // 15 位：日期段非法（非老身份证）且非 Luhn
  '12345678901这个号码是空号吗？', // 11 位但非 1[3-9] 号段
  '138001380001是诈骗电话吧？', // 12 位：位长越界，前后望断言拦截
  '社保断缴两个月，补缴需要什么材料？',
  '公司让我签放弃社保的承诺书，合法吗？',
  '加班到晚上10点，打车花了23块5，能报销吗？',
];

/**
 * 已知边界（R17 评审裁定，Task 7 fix-1）：**连续数字串内嵌 PII——现状 0 命中整串放行**。
 *
 * 用户手滑多打/少空格使 PII 与相邻数字粘连成长数字串是高频现实场景；位长前后望的设计对此
 * 放行（与负样本「138001380001 位长越界」同一机制口径）。此节用例**钉住现行为**：未来引擎
 * 改动若使本节转红（开始命中），必须有意识改判并同步升版规则集+更新本节与报告 ⚠ 清单——
 * 过杀兜底（长串内提取手机/证号）R17 已裁决属口径变更，M2 NER 承担，规则引擎不实施。
 * M2 范围划定锚点：漏报=漏堵，NER 规划按 m2Path 列覆盖（评审 Important-1 披露要求）。
 */
export interface SanitizeKnownBoundaryCase {
  readonly name: string;
  readonly text: string;
  /** 现状放行的引擎机制口径 */
  readonly boundary: string;
  /** M2 NER 覆盖路径（范围划定披露） */
  readonly m2Path: string;
}

export const SANITIZE_REGRESSION_KNOWN_BOUNDARY: readonly SanitizeKnownBoundaryCase[] = [
  {
    name: '手机号后粘数字成 15 位串（手滑多打，高频）：前 11 位为真实号段',
    text: '手机138001380001234留错了',
    boundary:
      '前后望位长门：11 位号段被 15 位连续数字串吞没；ID15 出生段非法（月=00）、Luhn 不合均弃权 → 现状 0 命中整串放行（评审实测同）',
    m2Path: 'M2 NER 长数字串分位候选提取+上下文打分（串内手机号识别），规则序尾部追加不改引擎',
  },
  {
    name: '有效证号后多打一位（手滑多打，高频）：11010519491231002X 本身校验位合法',
    text: '身份证11010519491231002X4',
    boundary:
      'ID18 后望 (?![\\dXx]) 见数字 → 位长门失败弃权（回溯不救）；其余规则位长不足 → 现状 0 命中整串放行（评审实测同）',
    m2Path: '同上：M2 NER 长串内证号候选（滑窗+校验位容错）覆盖',
  },
];
