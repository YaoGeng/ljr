/**
 * 内联 SVG 图标（M3-W3 T1）：路径数据逐字对照 prototype/index.html IC 细线库
 * （stroke 1.5 / round cap / viewBox 24——原型同款），禁外链图标库（零新依赖红线）。
 * logout 为按同风格自绘（原型无对应词条）。全部 aria-hidden 装饰性用法。
 */
import type { ReactNode } from 'react';

interface IconProps {
  size?: number;
}

function Line({ size = 16, children }: { size?: number; children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export const IconChart = ({ size }: IconProps) => (
  <Line size={size}>
    <path d="M4 20h16.5" />
    <path d="M7 20v-6.4M12 20V7.6M17 20v-9.2" />
  </Line>
);

export const IconBrief = ({ size }: IconProps) => (
  <Line size={size}>
    <rect x="4" y="8" width="16" height="12" rx="2.2" />
    <path d="M9.4 8V6.6A2.4 2.4 0 0 1 11.8 4.2h.4a2.4 2.4 0 0 1 2.4 2.4V8M4 13.2h16" />
  </Line>
);

export const IconAlert = ({ size }: IconProps) => (
  <Line size={size}>
    <path d="M12 4.4 21 19.6H3z" />
    <path d="M12 10.2v3.6M12 16.6v.3" />
  </Line>
);

export const IconBan = ({ size }: IconProps) => (
  <Line size={size}>
    <circle cx="12" cy="12" r="7.8" />
    <path d="m6.6 6.6 10.8 10.8" />
  </Line>
);

export const IconScale = ({ size }: IconProps) => (
  <Line size={size}>
    <path d="M12 5v14.6M9 19.6h6M4.6 8.2h14.8" />
    <path d="m6.8 8.2-2.4 5.2a2.9 2.9 0 0 0 4.8 0zM17.2 8.2l-2.4 5.2a2.9 2.9 0 0 0 4.8 0z" />
  </Line>
);

export const IconRoom = ({ size }: IconProps) => (
  <Line size={size}>
    <path d="M5 20V9.4l7-5 7 5V20h-4.6v-6h-4.8v6z" />
  </Line>
);

export const IconWallet = ({ size }: IconProps) => (
  <Line size={size}>
    <rect x="3.6" y="6.6" width="16.8" height="12.8" rx="2.6" />
    <path d="M14.6 13h5.8" />
    <circle cx="15.4" cy="13" r=".4" />
  </Line>
);

export const IconUsers = ({ size }: IconProps) => (
  <Line size={size}>
    <circle cx="9.2" cy="8.8" r="3.1" />
    <path d="M3.6 19.4c1-2.9 3-4.4 5.6-4.4s4.6 1.5 5.6 4.4" />
    <circle cx="16.8" cy="9.8" r="2.4" />
    <path d="M16.4 14.6c2 .3 3.5 1.6 4.3 4.2" />
  </Line>
);

export const IconFile = ({ size }: IconProps) => (
  <Line size={size}>
    <path d="M13.6 4H7a1.8 1.8 0 0 0-1.8 1.8v12.4A1.8 1.8 0 0 0 7 20h10a1.8 1.8 0 0 0 1.8-1.8V9.2z" />
    <path d="M13.6 4v5.2H18M9.4 13.4h5.2M9.4 16.4h3.6" />
  </Line>
);

export const IconFlag = ({ size }: IconProps) => (
  <Line size={size}>
    <path d="M6 20.4V4.6" />
    <path d="M6 5.4c4.4-2.4 7.6 2 12-.2v8.6c-4.4 2.2-7.6-2.2-12 .2" />
  </Line>
);

export const IconShield = ({ size }: IconProps) => (
  <Line size={size}>
    <path d="M12 4.2 18.8 6.6v5.6c0 4.3-2.9 7.2-6.8 8.2-3.9-1-6.8-3.9-6.8-8.2V6.6z" />
    <path d="m9.2 11.8 2 2 3.6-3.8" />
  </Line>
);

export const IconGear = ({ size }: IconProps) => (
  <Line size={size}>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 3.6v2.6M12 17.8v2.6M3.6 12h2.6M17.8 12h2.6M6.1 6.1l1.9 1.9M16 16l1.9 1.9M17.9 6.1 16 8M8 16l-1.9 1.9" />
  </Line>
);

export const IconUser = ({ size }: IconProps) => (
  <Line size={size}>
    <circle cx="12" cy="8.2" r="3.4" />
    <path d="M5.2 19.6c1.3-3.3 3.8-5 6.8-5s5.5 1.7 6.8 5" />
  </Line>
);

export const IconRefresh = ({ size }: IconProps) => (
  <Line size={size}>
    <path d="M19.8 12a7.8 7.8 0 1 1-2.2-5.4" />
    <path d="M19.8 3.8v3.4h-3.4" />
  </Line>
);

/** 加号（原型 IC 库 plus 词条路径逐字；T5 创建草案按钮） */
export const IconPlus = ({ size }: IconProps) => (
  <Line size={size}>
    <path d="M12 5.2v13.6M5.2 12h13.6" />
  </Line>
);

/** 退出（门+外出箭头，原型细线风格自绘——原型 IC 无 logout 词条） */
export const IconLogout = ({ size }: IconProps) => (
  <Line size={size}>
    <path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3" />
    <path d="M3 12h11" />
    <path d="m10.6 8.6 3.4 3.4-3.4 3.4" />
  </Line>
);

/** 币价签（原型 IC 库 coin 词条路径逐字；T6 改价审批 sidebar——¥ 币+横杠价位线） */
export const IconCoin = ({ size }: IconProps) => (
  <Line size={size}>
    <circle cx="12" cy="12" r="7.8" />
    <path d="m8.8 8.6 3.2 3.7 3.2-3.7M12 12.3V17M9.6 13.2h4.8M9.6 15.2h4.8" />
  </Line>
);
