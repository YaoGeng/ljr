/**
 * 设计体系 v4.0「人民币双色系 · 玻璃拟态 · 简约」RN token 单源（M3-W1 T1）。
 *
 * 设计源：prototype/index.html :root 变量区 + 根 AGENTS.md「原型约定」。
 * 映射与降级决策见 docs/plans/M3-W1-设计决策.md：
 *   - 豆沙红 accent 铁律：仅焦点卡/价格数字/主按钮/危险态极小面积，严禁大面积铺色；
 *   - 玻璃卡：RN 无 backdrop-filter 且不引 expo-blur（W1-3 同款零依赖纪律），
 *     以半透明白 + 1px 半透明白边 + 16px 圆角近似，登记为 dev 期降级；
 *   - 字体=系统无衬线（禁外链字体）；图标=View 几何绘制（禁图标库/svg 依赖）。
 */

/** 色板（与原型 :root 逐值对齐，改值须同步设计决策文档映射表） */
export const colors = {
  /** 米白绿底（全页底色，约 90% 面积的基底） */
  bg: '#F4F6F1',
  /** 橄榄绿主色 */
  primary: '#3E5C3A',
  /** 苔绿 */
  primary2: '#6B8E5A',
  /** 浅灰绿 */
  primary3: '#A8B89B',
  /** 深绿黑文字 */
  ink: '#2C3E28',
  /** 次级文字 */
  ink2: '#7A8B74',
  /** 玻璃高光 */
  hi: '#C9D6C0',
  /** 百元纸币豆沙红点缀（铁律：极小面积） */
  accent: '#C25E5E',
  /** 豆沙红深阶（按钮按压/文字重色） */
  accentDk: '#B14E4E',
  /** 淡粉（红的浅阶辅助） */
  accentSoft: '#E8C4C4',
  /** 玻璃卡底（blur 降级近似） */
  glass: 'rgba(255,255,255,0.5)',
  /** 玻璃卡高光（1px 边/顶栏底） */
  glassHi: 'rgba(255,255,255,0.72)',
  /** 点缀卡底（焦点卡一组仅 1 张） */
  accentCard: 'rgba(194,94,94,0.15)',
  /** 分隔线 */
  line: 'rgba(62,92,58,0.12)',
  /** 反白文字（主/次按钮上） */
  onPrimary: '#FFFFFF',
  /** 危险输入边 */
  dangerLine: 'rgba(194,94,94,0.4)',
  // ---- alpha 变体档（M3-W1 T2 评审 I3 收编：徽标浅底/进度槽底原为组件内散值，
  //      值对齐 prototype 类定义：.pill-g/.pill-n/.prog——改值须同步设计决策文档映射表） ----
  /** 绿徽标浅底（原型 .pill-g：报名中/已成团状态徽标） */
  primary2A15: 'rgba(107,142,90,0.15)',
  /** 灰徽标浅底（原型 .pill-n：终态/中性状态徽标） */
  ink2A15: 'rgba(122,139,116,0.15)',
  /** 进度槽底（原型 .prog 轨道色） */
  ink2A18: 'rgba(122,139,116,0.18)',
  /** 幽灵按钮底（主色 9% alpha 浅底，Button variant=ghost 专用；T6 评审 S3 收编） */
  ghostFill: 'rgba(62,92,58,0.09)',
} as const;

export type ColorToken = keyof typeof colors;

/** 间距标尺（4px 基） */
export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
} as const;

/** 圆角标尺（玻璃卡=16，按钮=12，胶囊=999） */
export const radius = {
  sm: 8,
  md: 10,
  lg: 12,
  card: 16,
  pill: 999,
} as const;

/** 字号标尺（pt；系统无衬线，禁外链字体） */
export const fontSize = {
  xs: 11,
  sm: 12,
  md: 13,
  base: 14,
  lg: 15,
  xl: 17,
  xxl: 20,
  xxxl: 24,
} as const;

export type FontSizeToken = keyof typeof fontSize;

/** 字重档位（RN 用字符串） */
export const fontWeight = {
  regular: '400',
  medium: '500',
  semibold: '600',
  bold: '700',
} as const;

/** 阴影：iOS shadow* + Android elevation（RN-web 会把 shadow* 映射为 CSS 近似，blur 降级登记在案） */
export const shadow = {
  card: {
    shadowColor: colors.primary,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.07,
    shadowRadius: 28,
    elevation: 2,
  },
  primaryButton: {
    shadowColor: colors.accent,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.3,
    shadowRadius: 16,
    elevation: 3,
  },
} as const;

/** 触控目标最小边（可用性下限：主操作 ≥44） */
export const HIT_SLOP_MIN = 44;

export const designTokens = { colors, spacing, radius, fontSize, fontWeight, shadow } as const;
export type DesignTokens = typeof designTokens;
