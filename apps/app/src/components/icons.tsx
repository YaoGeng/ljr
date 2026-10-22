/**
 * 极简几何图标库（M3-W1 T1 决策③）：不引 react-native-svg/图标库，全部用 View 绘制
 * （边框三角/圆/圆角矩形组合），颜色随容器语义传入。正式图标体系后续批次定（登记于
 * docs/plans/M3-W1-设计决策.md）。
 */
import { StyleSheet, View } from 'react-native';

export interface IconProps {
  readonly color: string;
  /** 线性整体尺寸（正方形画布边长，默认 22） */
  readonly size?: number;
}

/** 边框三角（CSS 同款技巧，RN/RN-web 同构） */
function Triangle({ color, width, height }: { color: string; width: number; height: number }) {
  return (
    <View
      style={{
        width: 0,
        height: 0,
        borderLeftWidth: width / 2,
        borderRightWidth: width / 2,
        borderBottomWidth: height,
        borderLeftColor: 'transparent',
        borderRightColor: 'transparent',
        borderBottomColor: color,
      }}
    />
  );
}

/** 首页：屋顶三角 + 圆角房体 + 门洞 */
export function HomeIcon({ color, size = 22 }: IconProps) {
  const t = Math.round(size * 0.36);
  return (
    <View style={[styles.canvas, { width: size, height: size }]}>
      <Triangle color={color} width={size} height={t} />
      <View
        style={{
          width: size * 0.72,
          height: size * 0.5,
          borderWidth: Math.max(1.5, size * 0.08),
          borderColor: color,
          borderRadius: 2,
          borderTopWidth: 0,
          marginTop: -1,
          alignItems: 'center',
          justifyContent: 'flex-end',
        }}
      >
        <View
          style={{
            width: size * 0.18,
            height: size * 0.2,
            backgroundColor: color,
            borderTopLeftRadius: 2,
            borderTopRightRadius: 2,
            marginBottom: -1,
          }}
        />
      </View>
    </View>
  );
}

/** 场次：日历（圆角框 + 顶横条 + 两个位点） */
export function CalendarIcon({ color, size = 22 }: IconProps) {
  const bw = Math.max(1.5, size * 0.08);
  return (
    <View style={[styles.canvas, { width: size, height: size }]}>
      <View
        style={{
          width: size * 0.82,
          height: size * 0.78,
          borderWidth: bw,
          borderColor: color,
          borderRadius: size * 0.18,
        }}
      >
        <View
          style={{
            height: size * 0.2,
            borderBottomWidth: bw,
            borderBottomColor: color,
            flexDirection: 'row',
            justifyContent: 'space-around',
            alignItems: 'flex-end',
            paddingBottom: size * 0.06,
          }}
        >
          <View style={{ width: bw, height: size * 0.14, backgroundColor: color }} />
          <View style={{ width: bw, height: size * 0.14, backgroundColor: color }} />
        </View>
        <View
          style={{
            flexDirection: 'row',
            gap: size * 0.14,
            marginTop: size * 0.1,
            marginLeft: size * 0.16,
          }}
        >
          <View
            style={{
              width: size * 0.1,
              height: size * 0.1,
              borderRadius: size * 0.05,
              backgroundColor: color,
            }}
          />
          <View
            style={{
              width: size * 0.1,
              height: size * 0.1,
              borderRadius: size * 0.05,
              backgroundColor: color,
            }}
          />
        </View>
      </View>
    </View>
  );
}

/** 发团：圆环 + 加号（发布拼团） */
export function PublishIcon({ color, size = 22 }: IconProps) {
  const bw = Math.max(1.5, size * 0.09);
  const plus = Math.max(2, size * 0.1);
  return (
    <View style={[styles.canvas, { width: size, height: size }]}>
      <View
        style={{
          width: size * 0.84,
          height: size * 0.84,
          borderWidth: bw,
          borderColor: color,
          borderRadius: size * 0.42,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: bw + 1 }}>
          <View style={{ width: size * 0.36, height: plus, backgroundColor: color }} />
          <View style={{ width: plus, height: size * 0.36, backgroundColor: color }} />
        </View>
      </View>
    </View>
  );
}

/** 消息：对话气泡（圆角矩形 + 尾巴 + 两点） */
export function ChatIcon({ color, size = 22 }: IconProps) {
  const bw = Math.max(1.5, size * 0.08);
  return (
    <View style={[styles.canvas, { width: size, height: size }]}>
      <View
        style={{
          width: size * 0.86,
          height: size * 0.62,
          borderWidth: bw,
          borderColor: color,
          borderRadius: size * 0.2,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: size * 0.12,
        }}
      >
        <View
          style={{
            width: size * 0.1,
            height: size * 0.1,
            borderRadius: size * 0.05,
            backgroundColor: color,
          }}
        />
        <View
          style={{
            width: size * 0.1,
            height: size * 0.1,
            borderRadius: size * 0.05,
            backgroundColor: color,
          }}
        />
      </View>
      <View
        style={{
          width: size * 0.18,
          height: size * 0.18,
          borderBottomWidth: bw,
          borderRightWidth: bw,
          borderBottomColor: color,
          borderRightColor: color,
          transform: [{ rotate: '45deg' }],
          marginLeft: size * 0.14,
          marginTop: -bw,
          backgroundColor: 'transparent',
        }}
      />
    </View>
  );
}

/** 我的：人形（头圆 + 半圆肩） */
export function UserIcon({ color, size = 22 }: IconProps) {
  return (
    <View style={[styles.canvas, { width: size, height: size }]}>
      <View
        style={{
          width: size * 0.34,
          height: size * 0.34,
          borderRadius: size * 0.17,
          backgroundColor: color,
          alignSelf: 'center',
          marginTop: size * 0.04,
        }}
      />
      <View
        style={{
          width: size * 0.62,
          height: size * 0.3,
          borderTopLeftRadius: size * 0.31,
          borderTopRightRadius: size * 0.31,
          backgroundColor: color,
          alignSelf: 'center',
          marginTop: size * 0.07,
        }}
      />
    </View>
  );
}

/** 工作台：三柱走势条（律师端统计面板，M3-W2 T1） */
export function DashboardIcon({ color, size = 22 }: IconProps) {
  return (
    <View style={[styles.canvas, { width: size, height: size }]}>
      <View
        style={{
          width: size * 0.76,
          height: size * 0.68,
          flexDirection: 'row',
          alignItems: 'flex-end',
          justifyContent: 'space-between',
          borderBottomWidth: Math.max(1.5, size * 0.07),
          borderBottomColor: color,
          paddingBottom: Math.max(1, size * 0.03),
        }}
      >
        <View
          style={{
            width: size * 0.14,
            height: size * 0.34,
            backgroundColor: color,
            borderRadius: 1,
          }}
        />
        <View
          style={{
            width: size * 0.14,
            height: size * 0.52,
            backgroundColor: color,
            borderRadius: 1,
          }}
        />
        <View
          style={{
            width: size * 0.14,
            height: size * 0.66,
            backgroundColor: color,
            borderRadius: 1,
          }}
        />
      </View>
    </View>
  );
}

/** 接单大厅：双人形（多人拼单响应面，M3-W2 T1） */
export function UsersIcon({ color, size = 22 }: IconProps) {
  const head = (d: number, mt: number, ml?: number) => (
    <View
      style={{
        width: d,
        height: d,
        borderRadius: d / 2,
        backgroundColor: color,
        marginTop: mt,
        ...(ml !== undefined ? { marginLeft: ml } : null),
      }}
    />
  );
  return (
    <View style={[styles.canvas, { width: size, height: size }]}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-end' }}>
        {head(size * 0.26, size * 0.04)}
        {head(size * 0.3, size * 0.02, size * 0.06)}
      </View>
      <View
        style={{
          width: size * 0.8,
          height: size * 0.3,
          borderTopLeftRadius: size * 0.4,
          borderTopRightRadius: size * 0.4,
          backgroundColor: color,
          marginTop: size * 0.05,
        }}
      />
    </View>
  );
}

/** 返回：左尖括号（旋转边框方块） */
export function BackIcon({ color, size = 22 }: IconProps) {
  const bw = Math.max(2, size * 0.11);
  return (
    <View style={[styles.canvas, { width: size, height: size }]}>
      <View
        style={{
          width: size * 0.34,
          height: size * 0.34,
          borderTopWidth: bw,
          borderLeftWidth: bw,
          borderTopColor: color,
          borderLeftColor: color,
          transform: [{ rotate: '-45deg' }],
        }}
      />
    </View>
  );
}

/** 退出：门框 + 向右箭头（三角） */
export function LogoutIcon({ color, size = 20 }: IconProps) {
  const bw = Math.max(1.5, size * 0.09);
  return (
    <View style={[styles.canvas, { width: size, height: size, flexDirection: 'row' }]}>
      <View
        style={{
          width: size * 0.55,
          height: size * 0.8,
          borderWidth: bw,
          borderColor: color,
          borderRadius: 2,
          borderRightWidth: 0,
        }}
      />
      <View
        style={{
          flex: 1,
          height: bw,
          backgroundColor: color,
          alignSelf: 'center',
          marginLeft: -1,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'flex-end',
        }}
      >
        <View style={{ transform: [{ rotate: '90deg' }], marginLeft: -bw }}>
          <Triangle color={color} width={size * 0.3} height={size * 0.24} />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  canvas: {
    alignItems: 'center',
    justifyContent: 'center',
  },
});
