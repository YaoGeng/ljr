/**
 * 时间表管理（M3-W2 T2 新推栈页；对照原型 l-sched）：周视图（B1 slots 状态视图）+
 * 可约时段模板编辑（B1 schedule 读/PUT 全量替换）。
 *
 * 契约（core time-table.controller 实文）：
 *   - GET /lawyer/:id/schedule → {version, templates}（本人 id=/me 会话态取，禁硬编码）
 *   - PUT /lawyer/schedule 全量替换（幂等键=lawyer+version；409 E_CONFLICT=别处已改→提示拉取最新）
 *   - GET /lawyer/:id/slots?from=&to= → 状态视图（FREE/PENDING_PAYMENT/LOCKED/OCCUPIED）
 *
 * 交互（对照 l-sched）：周视图翻周（±4 周护栏内）+ 过去时段置灰不可选 + 点未来空闲时段
 * → 推开团页（T3 占位，params.slot_start 预选）。模板行=星期点选轮换/时刻输入/时长三档
 * 循环/启停/移除，新增行经表单校验；保存=整表提交。表单校验（utils/slot-input 防呆层，
 * core normalizeTemplate 无此二检）：时刻形态/跨天（start+duration>24:00）/同日重叠。
 *
 * 未保存离开确认（dirty 时三层拦截，修复环 I-1 补物理返回）：①页内返回（pop）经 router
 * setPopGuard（裁决=shouldInterceptPop 纯函数）；②推开团页（push）同受确认（推栈页切走
 * 即卸载，本地编辑态不保真）；③物理返回——web beforeunload（浏览器原生确认弹窗）/
 * native BackHandler 硬件返回（弹出页内确认面板并吞默认退出），经 utils/leave-guard
 * 依赖注入件安装、卸载/确认后清理。页内确认面板为覆盖层（长列表视口内可见，修复环 I-4）。
 * tab 切换的 pop-to-root 不拦（以保存条常驻「未保存」提示承载）。
 * 周视图反映已保存模板（R-01：模板变更不影响已排期场次——孤儿活跃锁仍入视图）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BackHandler, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { ErrorCode } from '@ljr/shared';
import { slotStatusCopy, weekdayCopy } from '../api/lawyer-copy';
import { shiftWeekWindow, shanghaiWeekWindow } from '../api/lawyer-stats';
import {
  fetchSchedule,
  fetchSlots,
  replaceSchedule,
  type ScheduleView,
  type SlotDuration,
  type SlotView,
} from '../api/schedule';
import { isAppApiError } from '../api/client';
import { useResource } from '../api/useResource';
import { useSession } from '../api/useSession';
import { Button, ErrorText, Field, GlassCard, MutedText } from '../components/ui';
import { EmptyHint, ErrorPanel, LoadingHint, SectionHeader } from '../components/state-views';
import { colors, fontSize, fontWeight, radius, spacing } from '../design/tokens';
import { formatDate, formatTime } from '../utils/date';
import { installPhysicalBackGuard } from '../utils/leave-guard';
import { isDirtySchedule, type ScheduleEditRow } from '../utils/schedule-edit';
import {
  findTemplateOverlaps,
  isFutureInstant,
  isValidTimeInput,
  templateCrossesMidnight,
  templatesOverlap,
} from '../utils/slot-input';
import { useNavigation, type StackRoute } from '../navigation/router';

/** 编辑行（localId=React key——全量替换后服务端 id 全变，不可作 key；dirty 判定在 utils/schedule-edit） */
type WorkingRow = ScheduleEditRow;

/** 离开确认目标（pop=返回键拦截；push=点空闲时段开团跳转拦截） */
type LeaveTarget = { readonly kind: 'pop' } | { readonly kind: 'push'; readonly route: StackRoute };

const DURATION_CYCLE: readonly SlotDuration[] = [60, 90, 120];

export function LawyerScheduleScreen() {
  const nav = useNavigation();
  const me = useSession().me;
  const lawyerId = me?.id ?? null;

  // 本周窗：挂载时定格（useState 惰性初始化=组件首次挂载求值，非模块 import 时——修复环 I-2）
  const [currentWeek] = useState(() => shanghaiWeekWindow());

  // ---- B1 模板读（手写三态：PUT 成功响应直接回填，不经 useResource 重放） ----
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<unknown>(null);
  const [view, setView] = useState<ScheduleView | null>(null);
  const [rows, setRows] = useState<WorkingRow[] | null>(null);
  const localIdRef = useRef(1);

  const load = useCallback(async () => {
    if (lawyerId === null) return;
    setPhase('loading');
    try {
      const v = await fetchSchedule(lawyerId);
      setView(v);
      setRows(
        v.templates.map((t) => ({
          localId: localIdRef.current++,
          weekday: t.weekday,
          startTime: t.start_time.slice(0, 5),
          duration: t.duration_small,
          enabled: t.enabled,
        })),
      );
      setSaveError(null);
      setSaveConflict(false);
      setSavedNote(null);
      setPhase('ready');
    } catch (e) {
      setError(e);
      setPhase('error');
    }
  }, [lawyerId]);
  useEffect(() => {
    void load();
  }, [load]);

  // ---- 周视图（B1 slots 状态视图；窗口=本周 ±N 周） ----
  const [weekOffset, setWeekOffset] = useState(0);
  const weekWindow = useMemo(
    () => shiftWeekWindow(currentWeek, weekOffset),
    [currentWeek, weekOffset],
  );
  const slots = useResource(
    () =>
      lawyerId === null
        ? Promise.resolve([] as SlotView[])
        : fetchSlots(lawyerId, weekWindow.from, weekWindow.to),
    [lawyerId, weekWindow.from, weekWindow.to],
  );

  // ---- 编辑与保存 ----
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveConflict, setSaveConflict] = useState(false);
  const [savedNote, setSavedNote] = useState<string | null>(null);
  const [leaveTarget, setLeaveTarget] = useState<LeaveTarget | null>(null);

  const dirty = rows !== null && view !== null && isDirtySchedule(rows, view);

  // 表单校验（防呆层）：行时刻形态 + 跨天 + 同日重叠
  const currentRows = rows ?? [];
  const invalidTimeRows = currentRows.filter((r) => !isValidTimeInput(r.startTime));
  const overlapPairs = findTemplateOverlaps(
    currentRows.map((r) => ({
      weekday: r.weekday,
      start_time: r.startTime,
      duration_small: r.duration,
    })),
  );
  const midnightRows = currentRows
    .map((r, i) => (templateCrossesMidnight(r.startTime, r.duration) ? i : -1))
    .filter((i) => i >= 0);
  const formValid =
    invalidTimeRows.length === 0 && overlapPairs.length === 0 && midnightRows.length === 0;

  async function save(): Promise<void> {
    if (rows === null || view === null) return;
    setSaving(true);
    setSaveError(null);
    setSaveConflict(false);
    setSavedNote(null);
    try {
      const next = await replaceSchedule({
        version: view.version,
        templates: rows.map((r) => ({
          weekday: r.weekday,
          start_time: r.startTime,
          duration_small: r.duration,
          enabled: r.enabled,
        })),
      });
      setView(next); // 全量替换响应=新视图（version+1）
      setRows(
        next.templates.map((t) => ({
          localId: localIdRef.current++,
          weekday: t.weekday,
          startTime: t.start_time.slice(0, 5),
          duration: t.duration_small,
          enabled: t.enabled,
        })),
      );
      setSavedNote(`已保存 · 版本 ${next.version}`);
    } catch (e) {
      const conflict = isAppApiError(e) && e.code === ErrorCode.Conflict;
      setSaveConflict(conflict);
      // 409 时追加服务端诊断（版本差对用户可见——修复环 I-6）
      const diag = conflict && isAppApiError(e) && e.serverMessage ? `（${e.serverMessage}）` : '';
      setSaveError((isAppApiError(e) ? e.message : '保存失败，请稍后重试') + diag);
    } finally {
      setSaving(false);
    }
  }

  // 未保存离开确认·层①：dirty 时拦截页内返回（pop）——确认面板统一承载 pop/push 两向离开
  useEffect(() => {
    if (dirty) {
      nav.setPopGuard(() => {
        setLeaveTarget({ kind: 'pop' });
        return true;
      });
    } else {
      nav.setPopGuard(null);
    }
    return () => {
      nav.setPopGuard(null);
    };
  }, [dirty, nav]);

  // 未保存离开确认·层③（修复环 I-1）：物理返回——web beforeunload（浏览器原生确认）/
  // native BackHandler（弹出页内确认面板并吞默认退出）；clean/卸载即清理（leave-guard
  // 返回的 release 经 effect cleanup 调用，RN-web 的 BackHandler 桩恒不触达）。
  useEffect(() => {
    if (!dirty) return undefined;
    return installPhysicalBackGuard({
      intercept: () => {
        if (Platform.OS !== 'web') {
          setLeaveTarget({ kind: 'pop' }); // native：页内确认面板（beforeunload 无此时机）
        }
        return true;
      },
      windowTarget: Platform.OS === 'web' ? window : null,
      backHandler: Platform.OS === 'web' ? null : BackHandler,
    });
  }, [dirty]);

  /** 点空闲时段：clean 直跳开团页；dirty 先确认（推栈切走即卸载，编辑态不保真） */
  function openCreateFromSlot(slotStart: string): void {
    const route: StackRoute = { key: 'lawyerCreateSession', params: { slot_start: slotStart } };
    if (!dirty) {
      nav.push(route);
      return;
    }
    setLeaveTarget({ kind: 'push', route });
  }

  function continueLeave(): void {
    const target = leaveTarget;
    if (target === null) return;
    nav.setPopGuard(null); // 撤防（丢弃确认）后再执行离开
    if (target.kind === 'pop') {
      nav.pop();
    } else {
      nav.push(target.route);
    }
  }

  function updateRow(localId: number, patch: Partial<Omit<WorkingRow, 'localId'>>): void {
    setRows((prev) => (prev ?? []).map((r) => (r.localId === localId ? { ...r, ...patch } : r)));
    setSavedNote(null);
  }

  function removeRow(localId: number): void {
    setRows((prev) => (prev ?? []).filter((r) => r.localId !== localId));
    setSavedNote(null);
  }

  // ---- 新增表单 ----
  const [addWeekday, setAddWeekday] = useState(1);
  const [addTime, setAddTime] = useState('');
  const [addDuration, setAddDuration] = useState<SlotDuration>(90);
  const [addError, setAddError] = useState<string | null>(null);

  function addTemplate(): void {
    const time = addTime.trim();
    if (!isValidTimeInput(time)) {
      setAddError('时刻须为 HH:MM 形态（如 19:00）');
      return;
    }
    if (templateCrossesMidnight(time, addDuration)) {
      setAddError(`${time} + ${addDuration} 分钟将跨天——请调整开始时刻或时长`);
      return;
    }
    const conflict = currentRows.find(
      (r) =>
        r.weekday === addWeekday &&
        templatesOverlap(
          { weekday: r.weekday, start_time: r.startTime, duration_small: r.duration },
          { weekday: addWeekday, start_time: time, duration_small: addDuration },
        ),
    );
    if (conflict) {
      setAddError(
        `与 ${weekdayCopy(conflict.weekday)} ${conflict.startTime}（${conflict.duration} 分钟）重叠——同一时段不可多段`,
      );
      return;
    }
    setRows((prev) => [
      ...(prev ?? []),
      {
        localId: localIdRef.current++,
        weekday: addWeekday,
        startTime: time,
        duration: addDuration,
        enabled: true,
      },
    ]);
    setAddTime('');
    setAddError(null);
    setSavedNote(null);
  }

  // 周视图列序（周一..周日）与按日分组
  const days = useMemo(() => {
    const start = Date.parse(`${weekWindow.from}T00:00:00Z`);
    return Array.from({ length: 7 }, (_, i) => {
      const iso = new Date(start + i * 86_400_000).toISOString().slice(0, 10);
      return { date: iso, label: weekdayCopy((i + 1) % 7) };
    });
  }, [weekWindow.from]);

  const slotsByDay = useMemo(() => {
    const byDay = new Map<string, SlotView[]>();
    if (slots.state.phase === 'ready') {
      for (const slot of slots.state.data) {
        const key = formatDate(slot.slot_start);
        const list = byDay.get(key) ?? [];
        list.push(slot);
        byDay.set(key, list);
      }
      for (const list of byDay.values()) {
        list.sort((a, b) => a.slot_start.localeCompare(b.slot_start));
      }
    }
    return byDay;
  }, [slots.state]);

  if (lawyerId === null) {
    return (
      <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
        <GlassCard style={styles.card}>
          <Text style={styles.title}>登录态缺失</Text>
          <MutedText>请退出后重新登录再管理时间表</MutedText>
        </GlassCard>
      </ScrollView>
    );
  }

  return (
    <View style={styles.screenWrap}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        accessibilityLabel="时间表管理"
      >
        {/* 周视图（B1 slots 状态视图——反映已保存模板 + B2 活跃锁实况） */}
        <GlassCard style={styles.card}>
          <View style={styles.weekNavRow}>
            <Text style={styles.title}>
              {weekWindow.from.slice(5)} ~ {weekWindow.to.slice(5)}
            </Text>
            <View style={styles.weekNavBtns}>
              <Button
                label="上一周"
                variant="ghost"
                small
                disabled={weekOffset <= -4}
                onPress={() => setWeekOffset((w) => w - 1)}
              />
              <Button
                label={weekOffset === 0 ? '本周' : '回本周'}
                variant="ghost"
                small
                disabled={weekOffset === 0}
                onPress={() => setWeekOffset(0)}
              />
              <Button
                label="下一周"
                variant="ghost"
                small
                disabled={weekOffset >= 4}
                onPress={() => setWeekOffset((w) => w + 1)}
              />
            </View>
          </View>
          <View style={styles.legendRow}>
            <SlotLegendChip tone="free" label="空闲 可开团" />
            <SlotLegendChip tone="lock" label="锁定 待支付/待确认" />
            <SlotLegendChip tone="busy" label="占用 已排期" />
          </View>
          {slots.state.phase === 'loading' ? <LoadingHint /> : null}
          {slots.state.phase === 'error' ? (
            <ErrorPanel error={slots.state.error} onRetry={slots.reload} />
          ) : null}
          {slots.state.phase === 'ready' ? (
            slots.state.data.length === 0 ? (
              <EmptyHint text="本周无可用时段——请在下方添加可约时段模板" />
            ) : (
              <View style={styles.dayList}>
                {days.map(({ date, label }) => {
                  const daySlots = slotsByDay.get(date) ?? [];
                  return (
                    <View key={date} style={styles.dayRow}>
                      <Text style={styles.dayLabel}>
                        {label} {date.slice(5)}
                      </Text>
                      <View style={styles.dayChips}>
                        {daySlots.length === 0 ? (
                          <Text style={styles.dayEmpty}>—</Text>
                        ) : (
                          daySlots.map((slot) => (
                            <SlotChip
                              key={slot.slot_start}
                              slotStart={slot.slot_start}
                              status={slot.status}
                              onPress={
                                slot.status === 'FREE' && isFutureInstant(slot.slot_start)
                                  ? () => openCreateFromSlot(slot.slot_start)
                                  : undefined
                              }
                            />
                          ))
                        )}
                      </View>
                    </View>
                  );
                })}
              </View>
            )
          ) : null}
          <MutedText>
            点未来空闲时段发起开团 · 提交即锁定该时间段（B2 占用锁）
            {dirty ? '；周视图反映已保存模板，保存后即为最新' : ''}
          </MutedText>
        </GlassCard>

        {/* 模板编辑（B1：按周重复模板 CRUD——保存=整表提交全量替换） */}
        <GlassCard style={styles.card}>
          <SectionHeader
            title="可约时段模板"
            note="按周重复 · 模板变更不影响已排期场次（R-01）· 保存=整表提交"
          />
          {phase === 'loading' ? <LoadingHint /> : null}
          {phase === 'error' ? <ErrorPanel error={error} onRetry={() => void load()} /> : null}
          {phase === 'ready' && rows !== null ? (
            <>
              {rows.length === 0 ? (
                <EmptyHint text="尚未配置可约时段——用下方表单添加第一段" />
              ) : (
                <View style={styles.tplList}>
                  {rows.map((r) => (
                    <View key={r.localId} style={styles.tplRow}>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`星期 ${weekdayCopy(r.weekday)}，点按轮换`}
                        onPress={() => updateRow(r.localId, { weekday: (r.weekday + 1) % 7 })}
                        style={styles.tplWeekday}
                      >
                        <Text style={styles.tplWeekdayText}>{weekdayCopy(r.weekday)}</Text>
                      </Pressable>
                      <Field
                        value={r.startTime}
                        onChangeText={(t) => updateRow(r.localId, { startTime: t })}
                        invalid={!isValidTimeInput(r.startTime)}
                        style={styles.tplTimeInput}
                        maxLength={5}
                        keyboardType="numbers-and-punctuation"
                        accessibilityLabel="开始时刻"
                      />
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`时长 ${r.duration} 分钟，点按切换`}
                        onPress={() =>
                          updateRow(r.localId, {
                            duration: DURATION_CYCLE[(DURATION_CYCLE.indexOf(r.duration) + 1) % 3]!,
                          })
                        }
                        style={styles.tplDuration}
                      >
                        <Text style={styles.tplDurationText}>{r.duration} 分钟</Text>
                      </Pressable>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={r.enabled ? '已启用，点按停用' : '已停用，点按启用'}
                        onPress={() => updateRow(r.localId, { enabled: !r.enabled })}
                        style={[styles.tplToggle, !r.enabled && styles.tplToggleOff]}
                      >
                        <Text style={[styles.tplToggleText, !r.enabled && styles.tplToggleTextOff]}>
                          {r.enabled ? '启用' : '停用'}
                        </Text>
                      </Pressable>
                      <Button
                        label="移除"
                        variant="ghost"
                        small
                        onPress={() => removeRow(r.localId)}
                      />
                    </View>
                  ))}
                </View>
              )}

              {/* 校验反馈（防呆层：时刻形态/跨天/重叠——列出问题行并阻止保存） */}
              {invalidTimeRows.length > 0 ? (
                <ErrorText>{`${invalidTimeRows.length} 行开始时刻须为 HH:MM 形态（如 19:00）`}</ErrorText>
              ) : null}
              {midnightRows.map((i) => (
                <ErrorText key={`mid-${i}`}>
                  {`${weekdayCopy(currentRows[i]!.weekday)} ${currentRows[i]!.startTime} + ${currentRows[i]!.duration} 分钟跨天——单段不跨 24:00`}
                </ErrorText>
              ))}
              {overlapPairs.map(([i, j]) => (
                <ErrorText key={`ovl-${i}-${j}`}>
                  {`${weekdayCopy(currentRows[i]!.weekday)} ${currentRows[i]!.startTime} 与 ${currentRows[j]!.startTime} 时段重叠——同一时段不可多段`}
                </ErrorText>
              ))}

              {/* 新增表单 */}
              <View style={styles.addForm}>
                <View style={styles.weekdayChips}>
                  {[1, 2, 3, 4, 5, 6, 0].map((wd) => (
                    <Pressable
                      key={wd}
                      accessibilityRole="button"
                      accessibilityState={{ selected: addWeekday === wd }}
                      onPress={() => setAddWeekday(wd)}
                      style={[styles.weekdayChip, addWeekday === wd && styles.weekdayChipOn]}
                    >
                      <Text
                        style={[
                          styles.weekdayChipText,
                          addWeekday === wd && styles.weekdayChipTextOn,
                        ]}
                      >
                        {weekdayCopy(wd).slice(1)}
                      </Text>
                    </Pressable>
                  ))}
                </View>
                <View style={styles.addRow}>
                  <Field
                    value={addTime}
                    onChangeText={setAddTime}
                    placeholder="19:00"
                    style={styles.addTimeInput}
                    maxLength={5}
                    keyboardType="numbers-and-punctuation"
                    accessibilityLabel="新增开始时刻"
                  />
                  {DURATION_CYCLE.map((d) => (
                    <Pressable
                      key={d}
                      accessibilityRole="button"
                      accessibilityState={{ selected: addDuration === d }}
                      onPress={() => setAddDuration(d)}
                      style={[styles.durationChip, addDuration === d && styles.durationChipOn]}
                    >
                      <Text
                        style={[
                          styles.durationChipText,
                          addDuration === d && styles.durationChipTextOn,
                        ]}
                      >
                        {d} 分钟
                      </Text>
                    </Pressable>
                  ))}
                  <Button label="添加" variant="secondary" small onPress={addTemplate} />
                </View>
                <ErrorText>{addError}</ErrorText>
              </View>

              {/* 保存条（dirty=常驻可见；已保存/版本态注记） */}
              <View style={styles.saveBar}>
                <View style={styles.saveBarTextBlock}>
                  {savedNote ? (
                    <Text style={styles.savedNote}>{savedNote}</Text>
                  ) : (
                    <Text style={[styles.saveBarNote, dirty && styles.saveBarNoteDirty]}>
                      {dirty
                        ? '有未保存的修改（整表提交，离开前请保存）'
                        : `已与服务端同步 · 版本 ${view?.version ?? '—'}`}
                    </Text>
                  )}
                  <Text style={styles.versionNote}>{rows.length} 段模板</Text>
                </View>
                {dirty ? (
                  <Button
                    label={saving ? '保存中' : '保存全部'}
                    variant="primary"
                    small
                    busy={saving}
                    disabled={saving || !formValid}
                    onPress={() => void save()}
                  />
                ) : null}
              </View>
              {saveError ? (
                <View style={styles.saveErrorRow}>
                  <ErrorText>{saveError}</ErrorText>
                  {saveConflict ? (
                    <Button
                      label="拉取最新（放弃本地修改）"
                      variant="ghost"
                      small
                      onPress={() => void load()}
                    />
                  ) : null}
                </View>
              ) : null}
            </>
          ) : null}
        </GlassCard>
      </ScrollView>

      {/* 未保存离开确认（pop 拦截/推开团页/硬件返回时的页内面板）——绝对定位覆盖层，
          长列表下不依赖滚动位置恒在视口内（修复环 I-4） */}
      {leaveTarget !== null ? (
        <View style={styles.leaveOverlay}>
          <GlassCard style={styles.leaveCard}>
            <Text style={styles.title}>有未保存的修改</Text>
            <MutedText>
              {leaveTarget.kind === 'pop'
                ? '离开将丢弃未保存的时段模板修改；可先「保存全部」再返回。'
                : '前往开团将丢弃未保存的时段模板修改；可先「保存全部」再继续。'}
            </MutedText>
            <View style={styles.leaveBtns}>
              <Button label="继续编辑" variant="ghost" small onPress={() => setLeaveTarget(null)} />
              <Button
                label={leaveTarget.kind === 'pop' ? '放弃修改并返回' : '放弃修改并继续'}
                variant="secondary"
                small
                onPress={continueLeave}
              />
            </View>
          </GlassCard>
        </View>
      ) : null}
    </View>
  );
}

function SlotLegendChip({
  tone,
  label,
}: {
  readonly tone: 'free' | 'lock' | 'busy';
  readonly label: string;
}) {
  const s =
    tone === 'free'
      ? { bg: colors.primary2A15, fg: colors.primary }
      : tone === 'lock'
        ? { bg: colors.accentCard, fg: colors.accentDk }
        : { bg: colors.primary, fg: colors.onPrimary };
  return (
    <View style={[styles.legendChip, { backgroundColor: s.bg }]}>
      <Text style={{ color: s.fg, fontSize: fontSize.xs }}>{label}</Text>
    </View>
  );
}

function SlotChip({
  slotStart,
  status,
  onPress,
}: {
  readonly slotStart: string;
  readonly status: string;
  readonly onPress?: () => void;
}) {
  const { label, tone } = slotStatusCopy(status);
  const past = !isFutureInstant(slotStart);
  const pressable = onPress !== undefined;
  const chipStyle =
    tone === 'free'
      ? styles.chipFree
      : tone === 'lock'
        ? styles.chipLock
        : tone === 'busy'
          ? styles.chipBusy
          : styles.chipIdle;
  const textStyle =
    tone === 'free'
      ? styles.chipFreeText
      : tone === 'lock'
        ? styles.chipLockText
        : tone === 'busy'
          ? styles.chipBusyText
          : styles.chipIdleText;
  const body = (
    <View
      style={[styles.chip, chipStyle, past && styles.chipPast, pressable && styles.chipPressable]}
    >
      <Text style={[textStyle, past && styles.chipPastText]}>{formatTime(slotStart)}</Text>
      <Text style={[textStyle, past && styles.chipPastText]} numberOfLines={1}>
        {past && tone === 'free' ? '已过期' : label}
      </Text>
    </View>
  );
  if (!pressable) return body;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${formatTime(slotStart)} ${label}，发起开团`}
      onPress={onPress}
    >
      {body}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  /** 覆盖层宿主（修复环 I-4：离开确认面板绝对定位，不随长列表滚出视口） */
  screenWrap: { flex: 1 },
  scroll: { flex: 1 },
  content: { padding: spacing.lg, gap: spacing.md },
  card: { padding: spacing.lg, gap: spacing.sm },
  title: { color: colors.ink, fontSize: fontSize.lg, fontWeight: fontWeight.semibold },
  weekNavRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  weekNavBtns: { flexDirection: 'row', gap: spacing.xs },
  legendRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginVertical: spacing.xs,
  },
  legendChip: { borderRadius: radius.pill, paddingHorizontal: spacing.md, paddingVertical: 3 },
  dayList: { gap: spacing.xs },
  dayRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
    paddingVertical: 6,
  },
  dayLabel: { color: colors.ink, fontSize: fontSize.sm, fontWeight: fontWeight.medium, width: 74 },
  dayChips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, flexShrink: 1 },
  dayEmpty: { color: colors.ink2, fontSize: fontSize.sm, paddingVertical: 6 },
  chip: {
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: 5,
    gap: 1,
    minWidth: 64,
    alignItems: 'center',
  },
  chipPressable: { borderWidth: 1, borderColor: colors.primary2 },
  chipFree: { backgroundColor: colors.primary2A15 },
  chipFreeText: { color: colors.primary, fontSize: fontSize.xs, fontWeight: fontWeight.medium },
  chipLock: { backgroundColor: colors.accentCard },
  chipLockText: { color: colors.accentDk, fontSize: fontSize.xs, fontWeight: fontWeight.medium },
  chipBusy: { backgroundColor: colors.primary },
  chipBusyText: { color: colors.onPrimary, fontSize: fontSize.xs, fontWeight: fontWeight.medium },
  chipIdle: { backgroundColor: colors.ink2A15 },
  chipIdleText: { color: colors.ink2, fontSize: fontSize.xs },
  chipPast: { opacity: 0.45 },
  chipPastText: { fontWeight: fontWeight.regular },
  tplList: { gap: spacing.xs },
  tplRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
    paddingBottom: spacing.xs,
    flexWrap: 'wrap',
  },
  tplWeekday: {
    borderRadius: radius.pill,
    backgroundColor: colors.primary2A15,
    paddingHorizontal: spacing.md,
    paddingVertical: 4,
  },
  tplWeekdayText: { color: colors.primary, fontSize: fontSize.sm, fontWeight: fontWeight.medium },
  tplTimeInput: {
    minHeight: 36,
    width: 82,
    paddingHorizontal: spacing.md,
    fontSize: fontSize.base,
  },
  tplDuration: {
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
    paddingHorizontal: spacing.md,
    paddingVertical: 5,
  },
  tplDurationText: { color: colors.ink, fontSize: fontSize.sm, fontWeight: fontWeight.medium },
  tplToggle: {
    borderRadius: radius.pill,
    backgroundColor: colors.primary2A15,
    paddingHorizontal: spacing.md,
    paddingVertical: 4,
  },
  tplToggleOff: { backgroundColor: colors.ink2A15 },
  tplToggleText: { color: colors.primary, fontSize: fontSize.xs, fontWeight: fontWeight.medium },
  tplToggleTextOff: { color: colors.ink2 },
  addForm: { gap: spacing.sm, marginTop: spacing.sm },
  weekdayChips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  weekdayChip: {
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: 'rgba(255,255,255,0.55)', // 玻璃面变体（原型 chip 底，降级口径档）
    paddingHorizontal: spacing.md,
    paddingVertical: 4,
  },
  weekdayChipOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  weekdayChipText: { color: colors.ink2, fontSize: fontSize.sm },
  weekdayChipTextOn: { color: colors.onPrimary, fontWeight: fontWeight.medium },
  addRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' },
  addTimeInput: { minHeight: 38, width: 88, paddingHorizontal: spacing.md },
  durationChip: {
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: 'rgba(255,255,255,0.55)', // 玻璃面变体（原型 chip 底，降级口径档）
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
  },
  durationChipOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  durationChipText: { color: colors.ink2, fontSize: fontSize.sm },
  durationChipTextOn: { color: colors.onPrimary, fontWeight: fontWeight.medium },
  saveBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    marginTop: spacing.xs,
  },
  saveBarTextBlock: { flexShrink: 1, gap: 2 },
  saveBarNote: { color: colors.ink2, fontSize: fontSize.sm },
  saveBarNoteDirty: { color: colors.ink, fontWeight: fontWeight.medium },
  savedNote: { color: colors.primary, fontSize: fontSize.sm, fontWeight: fontWeight.medium },
  versionNote: { color: colors.ink2, fontSize: fontSize.xs },
  saveErrorRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, flexWrap: 'wrap' },
  /** 覆盖层（修复环 I-4）：米白绿底半透遮罩（colors.bg 同值 alpha 档，浅色不破「全页无深色」）+ 居中面板 */
  leaveOverlay: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    backgroundColor: 'rgba(244,246,241,0.72)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
  },
  leaveCard: {
    padding: spacing.lg,
    gap: spacing.sm,
    borderColor: colors.dangerLine,
    width: '100%',
    maxWidth: 330,
  },
  leaveBtns: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' },
});
