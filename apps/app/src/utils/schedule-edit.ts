/**
 * 时间表编辑态判定（M3-W2 T2 修复环：自 LawyerScheduleScreen 抽出的纯函数，
 * bun test 直测）：编辑行集 vs 服务端模板集做**多重集**比较（顺序无关——新增行
 * 追加在尾部、PUT 全量替换响应行序=服务端排序，简单按下标比会误报 dirty）。
 * 服务端 start_time 出站归一 'HH:MM:SS'，编辑态 'HH:MM'——比较前截短对齐。
 */
import type { ScheduleView, SlotDuration } from '../api/schedule';

/** 编辑行形态（localId=React key——全量替换后服务端 id 全变，不参与 dirty 比较） */
export interface ScheduleEditRow {
  readonly localId: number;
  weekday: number;
  startTime: string; // 'HH:MM' 编辑形态
  duration: SlotDuration;
  enabled: boolean;
}

function rowKey(r: {
  weekday: number;
  startTime: string;
  duration: number;
  enabled: boolean;
}): string {
  return `${r.weekday}|${r.startTime}|${r.duration}|${r.enabled ? 1 : 0}`;
}

/** dirty 判定：编辑集与视图模板集按键多重集不相等 → true */
export function isDirtySchedule(rows: readonly ScheduleEditRow[], view: ScheduleView): boolean {
  const a = rows.map(rowKey).sort().join(';');
  const b = view.templates
    .map((t) =>
      rowKey({
        weekday: t.weekday,
        startTime: t.start_time.slice(0, 5),
        duration: t.duration_small,
        enabled: t.enabled,
      }),
    )
    .sort()
    .join(';');
  return a !== b;
}
