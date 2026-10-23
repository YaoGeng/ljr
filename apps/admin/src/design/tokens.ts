/**
 * 设计体系 v4.0「人民币双色系 · 玻璃拟态 · 简约」Web admin token 局部副本（M3-W3 T1，W3-7）。
 *
 * 设计源：prototype/index.html :root 变量区（v4.5）+ 根 AGENTS.md「原型约定」。
 * 色值与 prototype 逐字对齐（=apps/app/src/design/tokens.ts 同值副本——expo 树非 workspace
 * 依赖目标，禁跨树 import；后续上移 @ljr/shared=独立卡）。
 * 铁律：橄榄绿主色约 90% 面积；豆沙红 accent 仅极小面积（主按钮/危险态/焦点标记），
 * 严禁大面积铺色；后台无深色模式；全 admin 组件只从本文件取色，禁散写色值。
 *
 * Web 消费形态：applyDesignCssVars() 在入口把色值注入 :root CSS 变量（--ljr-*），
 * global.css 只引用变量不落字面色值——token 单源 + 无首屏闪烁（同步注入先于首帧）。
 */

/** 色板（与 prototype :root 逐值对齐，改值须同步原型与设计决策文档） */
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
  /** 百元纸币豆沙红点缀（铁律：极小面积——主按钮/危险态/焦点条） */
  accent: '#C25E5E',
  /** 豆沙红深阶（按钮按压/文字重色） */
  accentDk: '#B14E4E',
  /** 淡粉（红的浅阶辅助） */
  accentSoft: '#E8C4C4',
  /** 玻璃卡底 */
  glass: 'rgba(255,255,255,0.5)',
  /** 玻璃卡高光（1px 边/顶栏底） */
  glassHi: 'rgba(255,255,255,0.72)',
  /** 点缀卡底（焦点卡一组仅 1 张） */
  accentCard: 'rgba(194,94,94,0.15)',
  /** 分隔线 */
  line: 'rgba(62,92,58,0.12)',
  /** 反白文字（主/次按钮上） */
  onPrimary: '#FFFFFF',
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

/** 圆角标尺（玻璃卡=16/侧栏=20，按钮=12，胶囊=999） */
export const radius = {
  sm: 8,
  md: 10,
  lg: 12,
  card: 16,
  side: 20,
  pill: 999,
} as const;

/** 字号标尺（px；系统无衬线，禁外链字体） */
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

/** 字重档位 */
export const fontWeight = {
  regular: '400',
  medium: '500',
  semibold: '600',
  bold: '700',
} as const;

/** 系统无衬线字体栈（与 prototype --sans 逐字对齐；禁外链字体） */
export const fontFamily =
  '-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans CJK SC",sans-serif';

/** tokens → CSS 变量映射（key=CSS 自定义属性名；applyDesignCssVars 的注入表） */
const CSS_VARS: Readonly<Record<string, string>> = {
  '--ljr-bg': colors.bg,
  '--ljr-primary': colors.primary,
  '--ljr-primary-2': colors.primary2,
  '--ljr-primary-3': colors.primary3,
  '--ljr-ink': colors.ink,
  '--ljr-ink-2': colors.ink2,
  '--ljr-hi': colors.hi,
  '--ljr-accent': colors.accent,
  '--ljr-accent-dk': colors.accentDk,
  '--ljr-accent-soft': colors.accentSoft,
  '--ljr-glass': colors.glass,
  '--ljr-glass-hi': colors.glassHi,
  '--ljr-accent-card': colors.accentCard,
  '--ljr-line': colors.line,
  '--ljr-on-primary': colors.onPrimary,
  '--ljr-font-family': fontFamily,
};

/** 把 token 注入 document :root（入口同步调用一次；非 DOM 环境=bun test 无操作） */
export function applyDesignCssVars(): void {
  if (typeof document === 'undefined') return;
  for (const [name, value] of Object.entries(CSS_VARS)) {
    document.documentElement.style.setProperty(name, value);
  }
}
