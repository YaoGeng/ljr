/**
 * 价格配置（M3-W2 T3 新推栈页，替换占位；对照原型 l-price）：默认价格与 1对1 配置
 * （B3 读/PUT 全量新配置/版本历史）+ 改价申请子面（C6 申请/记录/24h 撤销）。
 *
 * 契约（core pricing.controller / price-change.controller 实文）：
 *   - GET  /lawyer/:id/pricing（本人 id=/me 会话态取）→ {version, created_at, pricing|null}
 *   - PUT  /lawyer/pricing 全量新配置（幂等键=lawyer+base_version；409 E_CONFLICT=别处已改；
 *     409 E_IN_GROUP_CHANGE=R-04 在团转 C6——页面以「提交改价申请」动作承接）
 *   - GET  /lawyer/:id/pricing/history 版本列表（新在前）
 *   - POST /lawyer/pricing/change 改价申请（体 {new_version_draft}；出参
 *         {result: EFFECTED|PENDING_APPROVAL, history_id, new_version}）
 *   - GET  /pricing/histories?lawyer_id= 我的改价记录（状态徽标=C6 §5 三态词汇）
 *   - POST /pricing/change/:id/revoke 24h 撤销（R-04 不扣信用；409 E_PAST_24H 超窗如实承载）
 *
 * 表单校验（utils/pricing-edit 防呆层，core normalizePricingWrite 值域镜像）：R-01 二选一、
 * R-02 1对1 区间（文字 50-300/次、语音视频 100-500/15min 边界内收外拒）、smallint 成对护栏；
 * 金额全程字符串形态（moneyToCents 整数分，禁 float）。
 * 保存=整表提交 + 未保存离开确认（T2 三层形态：pop 拦截/beforeunload/BackHandler——复用
 * leave-guard 注入件）；dirty 常驻保存条。
 * 设计铁律：红点缀仅=主按钮（保存）+ 改价记录否决/撤销危险徽标小面积；价格数字红点缀位
 * （splitMoney 不展开——本页金额为输入态，展示用 formatMoney 单一出口）。
 */
import { useCallback, useEffect, useState } from 'react';
import { BackHandler, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { ErrorCode } from '@ljr/shared';
import {
  priceChangeDirectionCopy,
  priceChangeResultCopy,
  type PriceChangeTone,
} from '../api/lawyer-copy';
import {
  fetchPriceHistories,
  fetchPricing,
  fetchPricingHistory,
  putPricing,
  requestPriceChange,
  revokePriceChange,
  type CurrentPricingView,
  type PriceHistoryView,
  type PricingRoomMode,
} from '../api/pricing';
import { formatPercent } from '../api/lawyer-stats';
import { formatMoney } from '../api/money';
import { roomModeCopy } from '../api/session-copy';
import { isAppApiError } from '../api/client';
import { useResource } from '../api/useResource';
import { useSession } from '../api/useSession';
import { Button, ErrorText, Field, GlassCard, MutedText } from '../components/ui';
import { EmptyHint, ErrorPanel, LoadingHint, SectionHeader } from '../components/state-views';
import { colors, fontSize, fontWeight, radius, spacing } from '../design/tokens';
import { formatDate } from '../utils/date';
import { installPhysicalBackGuard } from '../utils/leave-guard';
import {
  isDirtyPricing,
  pricingDraftFromForm,
  pricingFormFromView,
  validatePricingForm,
  type PricingFormState,
} from '../utils/pricing-edit';
import { useNavigation } from '../navigation/router';

/** 离开确认目标（pop=返回拦截；本页无 push 出口——改价/撤销均页内完成） */
type LeaveTarget = { readonly kind: 'pop' };

/** C6 R-04 撤销窗（24h；客户端预判展示，服务端权威校验） */
const REVOKE_WINDOW_MS = 24 * 60 * 60 * 1000;

const ROOM_MODE_OPTIONS: readonly PricingRoomMode[] = ['text', 'voice', 'video'];

export function LawyerPricingScreen() {
  const nav = useNavigation();
  const me = useSession().me;
  const lawyerId = me?.id ?? null;

  // ---- B3 当前配置读（手写三态——PUT 成功响应直接回填，同时间表页先例） ----
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<unknown>(null);
  const [view, setView] = useState<CurrentPricingView | null>(null);
  const [form, setForm] = useState<PricingFormState | null>(null);

  // C6 改价记录 tick（申请/撤销后重拉）
  const [changesTick, setChangesTick] = useState(0);

  const load = useCallback(async () => {
    if (lawyerId === null) return;
    setPhase('loading');
    try {
      const v = await fetchPricing(lawyerId);
      setView(v);
      setForm(pricingFormFromView(v));
      setSaveError(null);
      setSaveConflict(false);
      setSavedNote(null);
      setInGroupBlocked(false);
      setPhase('ready');
    } catch (e) {
      setError(e);
      setPhase('error');
    }
  }, [lawyerId]);
  useEffect(() => {
    void load();
  }, [load]);

  // B3 版本历史（保存后随 version 变化重拉）
  const history = useResource(
    () => (lawyerId === null ? Promise.resolve([]) : fetchPricingHistory(lawyerId)),
    [lawyerId, view?.version],
  );

  // C6 改价记录
  const changes = useResource(
    () =>
      lawyerId === null ? Promise.resolve([] as PriceHistoryView[]) : fetchPriceHistories(lawyerId),
    [lawyerId, changesTick],
  );

  // ---- 保存（PUT）与改价申请（POST change） ----
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveConflict, setSaveConflict] = useState(false);
  const [savedNote, setSavedNote] = useState<string | null>(null);
  /** PUT 被 409 E_IN_GROUP_CHANGE 拒（R-04）→ 出示「提交改价申请」承接动作 */
  const [inGroupBlocked, setInGroupBlocked] = useState(false);
  const [changeRequesting, setChangeRequesting] = useState(false);
  const [changeNote, setChangeNote] = useState<string | null>(null);
  const [changeError, setChangeError] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<number | null>(null);
  const [revokeNote, setRevokeNote] = useState<string | null>(null);

  const dirty = form !== null && view !== null && isDirtyPricing(form, view);
  const issues = form === null ? [] : validatePricingForm(form);
  const formValid = issues.length === 0;

  async function save(): Promise<void> {
    if (form === null || view === null) return;
    setSaving(true);
    setSaveError(null);
    setSaveConflict(false);
    setSavedNote(null);
    setInGroupBlocked(false);
    try {
      const next = await putPricing(pricingDraftFromForm(form, view.version));
      setView(next);
      setForm(pricingFormFromView(next));
      setSavedNote(`已保存 · 版本 ${next.version}`);
    } catch (e) {
      const conflict = isAppApiError(e) && e.code === ErrorCode.Conflict;
      const inGroup = isAppApiError(e) && e.code === ErrorCode.InGroupChange;
      setSaveConflict(conflict);
      setInGroupBlocked(inGroup);
      const diag =
        isAppApiError(e) && (conflict || inGroup) && e.serverMessage
          ? `（${e.serverMessage}）`
          : '';
      setSaveError((isAppApiError(e) ? e.message : '保存失败，请稍后重试') + diag);
    } finally {
      setSaving(false);
    }
  }

  /** R-04 承接：在团直改被拒 → 同草案走 C6 引擎（三档判定在服务端） */
  async function submitChangeRequest(): Promise<void> {
    if (form === null || view === null) return;
    setChangeRequesting(true);
    setChangeError(null);
    setChangeNote(null);
    try {
      const r = await requestPriceChange(pricingDraftFromForm(form, view.version));
      setChangeNote(
        r.result === 'EFFECTED'
          ? `改价已生效（新版本 v${r.new_version}，记录 #${r.history_id}）`
          : `改价已提交平台审批（记录 #${r.history_id}）——审批通过后生效并发放补偿`,
      );
      setInGroupBlocked(false);
      setChangesTick((t) => t + 1);
      await load(); // EFFECTED 档版本已落——重取视图（base_version 同步刷新）
    } catch (e) {
      const diag = isAppApiError(e) && e.serverMessage ? `（${e.serverMessage}）` : '';
      setChangeError((isAppApiError(e) ? e.message : '提交失败，请稍后重试') + diag);
    } finally {
      setChangeRequesting(false);
    }
  }

  /** C6 R-04 撤销（24h 内恢复上一版本，不扣信用） */
  async function revoke(id: number): Promise<void> {
    setRevokingId(id);
    setRevokeNote(null);
    try {
      const r = await revokePriceChange(id);
      setRevokeNote(`已撤销 · 默认价格恢复至 v${r.restored_version}（不扣信用）`);
      setChangesTick((t) => t + 1);
      await load(); // 撤销=B3 落恢复版本——重取视图
    } catch (e) {
      setRevokeNote(isAppApiError(e) ? e.message : '撤销失败，请稍后重试');
    } finally {
      setRevokingId(null);
    }
  }

  // ---- 未保存离开确认（T2 三层形态复用） ----
  const [leaveTarget, setLeaveTarget] = useState<LeaveTarget | null>(null);

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

  useEffect(() => {
    if (!dirty) return undefined;
    return installPhysicalBackGuard({
      intercept: () => {
        if (Platform.OS !== 'web') {
          setLeaveTarget({ kind: 'pop' });
        }
        return true;
      },
      windowTarget: Platform.OS === 'web' ? window : null,
      backHandler: Platform.OS === 'web' ? null : BackHandler,
    });
  }, [dirty]);

  function updateForm(patch: Partial<PricingFormState>): void {
    setForm((prev) => (prev === null ? prev : { ...prev, ...patch }));
    setSavedNote(null);
    setInGroupBlocked(false);
  }

  function toggleRoomMode(mode: PricingRoomMode): void {
    if (form === null) return;
    updateForm({
      roomModes: form.roomModes.includes(mode)
        ? form.roomModes.filter((m) => m !== mode)
        : [...form.roomModes, mode],
    });
  }

  if (lawyerId === null) {
    return (
      <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
        <GlassCard style={styles.card}>
          <Text style={styles.title}>登录态缺失</Text>
          <MutedText>请退出后重新登录再管理价格配置</MutedText>
        </GlassCard>
      </ScrollView>
    );
  }

  return (
    <View style={styles.screenWrap}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        accessibilityLabel="价格配置"
      >
        {/* 在团改价规则（对照原型 l-price notice：C6 三档矩阵） */}
        <GlassCard style={styles.card}>
          <SectionHeader
            title="改价规则（C6 三档）"
            note="有进行中拼团/场次时，默认价格修改走改价引擎"
          />
          <MutedText>
            涨价 → 生效（已报名用户按快照价不受影响，信用 -5）；降价 ≤10% → 平台审批 + 积分补偿
            （信用 -15）；降价 {'>'}10% → 平台审批 + 积分 + 优惠券（信用 -30，停接 3 天）。改价 24h
            内可撤销（不扣信用）。无进行中团时直改即生效（本页保存）。
          </MutedText>
        </GlassCard>

        {phase === 'loading' ? <LoadingHint label="价格配置加载中…" /> : null}
        {phase === 'error' ? <ErrorPanel error={error} onRetry={() => void load()} /> : null}

        {phase === 'ready' && form !== null && view !== null ? (
          <>
            {/* 默认价格（B3）：版本徽标 + 计价模式二选一 + 可空列 */}
            <GlassCard style={styles.card}>
              <View style={styles.headRow}>
                <Text style={styles.title}>默认价格</Text>
                <Text style={styles.versionBadge}>
                  {view.version > 0 ? `v${view.version} · 生效中` : '尚未配置'}
                </Text>
              </View>
              <View style={styles.modeRow}>
                <ModeCard
                  active={form.priceMode === 'per_head'}
                  title="人头价"
                  note="用户付固定单价 · 收入=单价×成团人数"
                  onPress={() => updateForm({ priceMode: 'per_head' })}
                />
                <ModeCard
                  active={form.priceMode === 'session_total'}
                  title="场次总价"
                  note="用户按 总价÷人数 分摊 · C2B 同口径"
                  onPress={() => updateForm({ priceMode: 'session_total' })}
                />
              </View>
              {form.priceMode === 'per_head' ? (
                <LabeledField
                  label="默认人头价（元/人）"
                  value={form.perHead}
                  onChangeText={(t) => updateForm({ perHead: t })}
                  placeholder="99.00"
                  keyboardType="decimal-pad"
                />
              ) : (
                <LabeledField
                  label="默认场次总价（元）"
                  value={form.sessionTotal}
                  onChangeText={(t) => updateForm({ sessionTotal: t })}
                  placeholder="650.00"
                  keyboardType="decimal-pad"
                />
              )}
              <View style={styles.duoRow}>
                <LabeledField
                  label="开团固定人数（可选）"
                  value={form.groupSize}
                  onChangeText={(t) =>
                    updateForm({ groupSize: t.replace(/[^\d]/g, '').slice(0, 5) })
                  }
                  placeholder="5"
                  keyboardType="number-pad"
                  style={styles.duoField}
                />
                <View style={styles.duoField}>
                  <Text style={styles.fieldLabel}>接受拼团范围（可选）</Text>
                  <View style={styles.duoInner}>
                    <Field
                      value={form.acceptMin}
                      onChangeText={(t) =>
                        updateForm({ acceptMin: t.replace(/[^\d]/g, '').slice(0, 5) })
                      }
                      placeholder="最低"
                      keyboardType="number-pad"
                      accessibilityLabel="接受拼团最低人数"
                      style={styles.smallInput}
                    />
                    <Text style={styles.rangeDash}>—</Text>
                    <Field
                      value={form.acceptMax}
                      onChangeText={(t) =>
                        updateForm({ acceptMax: t.replace(/[^\d]/g, '').slice(0, 5) })
                      }
                      placeholder="最高"
                      keyboardType="number-pad"
                      accessibilityLabel="接受拼团最高人数"
                      style={styles.smallInput}
                    />
                  </View>
                </View>
              </View>
              <Text style={styles.fieldLabel}>房间沟通形式（可多选，供用户端展示）</Text>
              <View style={styles.chipRow}>
                {ROOM_MODE_OPTIONS.map((m) => {
                  const on = form.roomModes.includes(m);
                  return (
                    <Pressable
                      key={m}
                      accessibilityRole="checkbox"
                      accessibilityState={{ checked: on }}
                      onPress={() => toggleRoomMode(m)}
                      style={[styles.chip, on && styles.chipOn]}
                    >
                      <Text style={[styles.chipText, on && styles.chipTextOn]}>
                        {roomModeCopy(m)}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </GlassCard>

            {/* 1对1 价格矩阵（B3 独立分区；R-02 区间） */}
            <GlassCard style={styles.card}>
              <SectionHeader
                title="1对1 服务价格"
                note="文字 50-300 元/次 · 语音/视频 100-500 元/15min（R-02）"
              />
              <LabeledField
                label="文字（元/次）"
                value={form.oooText}
                onChangeText={(t) => updateForm({ oooText: t })}
                placeholder="150.00"
                keyboardType="decimal-pad"
                invalid={form.oooText.trim() !== '' && !/^\d+\.\d{2}$/.test(form.oooText.trim())}
              />
              <View style={styles.duoRow}>
                <LabeledField
                  label="语音（元/15min）"
                  value={form.oooVoice}
                  onChangeText={(t) => updateForm({ oooVoice: t })}
                  placeholder="200.00"
                  keyboardType="decimal-pad"
                  style={styles.duoField}
                />
                <LabeledField
                  label="视频（元/15min）"
                  value={form.oooVideo}
                  onChangeText={(t) => updateForm({ oooVideo: t })}
                  placeholder="300.00"
                  keyboardType="decimal-pad"
                  style={styles.duoField}
                />
              </View>
              <MutedText>
                三通道全量必填；预付全额、实结多退少补（D6）；保存即生成新版本。
              </MutedText>
            </GlassCard>

            {/* 防呆校验反馈（阻止保存；评审 N-3：dirty 门控——clean 态首屏不亮红，
                未配置律师进入即 4 条空值问题的噪音态消除；保存按钮 disabled 不受门控影响） */}
            {dirty ? issues.map((issue) => <ErrorText key={issue}>{issue}</ErrorText>) : null}

            {/* 保存条（dirty 常驻；版本态注记） */}
            <View style={styles.saveBar}>
              <View style={styles.saveBarTextBlock}>
                {savedNote ? (
                  <Text style={styles.savedNote}>{savedNote}</Text>
                ) : (
                  <Text style={[styles.saveBarNote, dirty && styles.saveBarNoteDirty]}>
                    {dirty
                      ? '有未保存的修改（整表提交为新版本，旧版本不可变）'
                      : view.version > 0
                        ? `已与服务端同步 · 版本 ${view.version}`
                        : '尚未配置价格——填写后保存生成 v1'}
                  </Text>
                )}
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

            {/* R-04 承接：在团直改被拒 → 同草案走 C6 改价申请 */}
            {inGroupBlocked ? (
              <GlassCard style={styles.changeActionCard}>
                <Text style={styles.changeActionTitle}>在团改价须走改价申请</Text>
                <MutedText>
                  当前有进行中的拼团/场次（R-04）：直改被拒。可将当前配置作为改价申请提交——
                  引擎按三档判定（涨价即生效、降价进审批），已报名用户按快照价不受影响。
                </MutedText>
                {changeNote ? <Text style={styles.savedNote}>{changeNote}</Text> : null}
                {changeError ? <ErrorText>{changeError}</ErrorText> : null}
                <Button
                  label={changeRequesting ? '提交中' : '提交改价申请'}
                  variant="primary"
                  small
                  busy={changeRequesting}
                  disabled={changeRequesting || !formValid}
                  onPress={() => void submitChangeRequest()}
                />
              </GlassCard>
            ) : null}

            {/* C6 改价记录（我的申请列表；状态徽标=§5 三态词汇） */}
            <GlassCard style={styles.card}>
              <SectionHeader title="改价记录" note="30 天窗口 ≤3 次（超限进审批）；24h 内可撤销" />
              {changes.state.phase === 'loading' ? <LoadingHint /> : null}
              {changes.state.phase === 'error' ? (
                <ErrorPanel error={changes.state.error} onRetry={changes.reload} />
              ) : null}
              {changes.state.phase === 'ready' ? (
                changes.state.data.length === 0 ? (
                  <EmptyHint text="暂无改价记录" />
                ) : (
                  <View style={styles.changeList}>
                    {revokeNote ? <Text style={styles.savedNote}>{revokeNote}</Text> : null}
                    {changes.state.data.map((row) => (
                      <ChangeRow
                        key={row.history_id}
                        row={row}
                        revoking={revokingId === row.history_id}
                        onRevoke={() => void revoke(row.history_id)}
                      />
                    ))}
                  </View>
                )
              ) : null}
            </GlassCard>

            {/* B3 版本历史（新在前；R-03 版本不可变） */}
            <GlassCard style={styles.card}>
              <SectionHeader title="价格版本记录" note="版本不可变 · 修改只影响后续新场次/新拼团" />
              {history.state.phase === 'loading' ? <LoadingHint /> : null}
              {history.state.phase === 'error' ? (
                <ErrorPanel error={history.state.error} onRetry={history.reload} />
              ) : null}
              {history.state.phase === 'ready' ? (
                history.state.data.length === 0 ? (
                  <EmptyHint text="暂无版本（保存后生成 v1）" />
                ) : (
                  <View style={styles.versionList}>
                    {history.state.data.map((item) => (
                      <View key={item.version} style={styles.versionRow}>
                        <View style={styles.versionTextBlock}>
                          <Text style={styles.versionTitle}>
                            v{item.version}
                            {item.version === view.version ? ' · 生效中' : ''}
                          </Text>
                          <Text style={styles.versionNote}>
                            {formatDate(item.created_at)} ·{' '}
                            {item.pricing.per_head !== null
                              ? `人头价 ${formatMoney(item.pricing.per_head)}`
                              : `总价 ${formatMoney(item.pricing.session_total ?? '0.00')}`}
                            {item.pricing.group_size !== null
                              ? ` · ${item.pricing.group_size} 人`
                              : ''}
                            {item.pricing.accept_min !== null
                              ? ` · 拼团 ${item.pricing.accept_min}-${item.pricing.accept_max}`
                              : ''}
                          </Text>
                        </View>
                      </View>
                    ))}
                  </View>
                )
              ) : null}
            </GlassCard>
          </>
        ) : null}
      </ScrollView>

      {/* 未保存离开确认（pop/物理返回→页内面板）——绝对定位覆盖层（T2 I-4 形态） */}
      {leaveTarget !== null ? (
        <View style={styles.leaveOverlay}>
          <GlassCard style={styles.leaveCard}>
            <Text style={styles.title}>有未保存的修改</Text>
            <MutedText>离开将丢弃未保存的价格配置修改；可先「保存全部」再返回。</MutedText>
            <View style={styles.leaveBtns}>
              <Button label="继续编辑" variant="ghost" small onPress={() => setLeaveTarget(null)} />
              <Button
                label="放弃修改并返回"
                variant="secondary"
                small
                onPress={() => {
                  nav.setPopGuard(null);
                  nav.pop();
                }}
              />
            </View>
          </GlassCard>
        </View>
      ) : null}
    </View>
  );
}

/** 计价模式选择卡（对照原型 .rc 单选卡；激活=主绿描边） */
function ModeCard({
  active,
  title,
  note,
  onPress,
}: {
  readonly active: boolean;
  readonly title: string;
  readonly note: string;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={[styles.modeCard, active && styles.modeCardOn]}
    >
      <Text style={[styles.modeTitle, active && styles.modeTitleOn]}>{title}</Text>
      <Text style={styles.modeNote}>{note}</Text>
    </Pressable>
  );
}

/** 带标签的输入行（label 在上；invalid 红描边=危险态点缀） */
function LabeledField({
  label,
  value,
  onChangeText,
  placeholder,
  keyboardType,
  invalid,
  style,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChangeText: (t: string) => void;
  readonly placeholder?: string;
  readonly keyboardType?: 'default' | 'number-pad' | 'decimal-pad';
  readonly invalid?: boolean;
  readonly style?: object;
}) {
  return (
    <View style={[styles.fieldBlock, style]}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <Field
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        keyboardType={keyboardType}
        invalid={invalid}
        accessibilityLabel={label}
      />
    </View>
  );
}

/** 改价记录行：方向+幅度 / 结果徽标 / 信用档 / 撤销动作 */
function ChangeRow({
  row,
  revoking,
  onRevoke,
}: {
  readonly row: PriceHistoryView;
  readonly revoking: boolean;
  readonly onRevoke: () => void;
}) {
  const copy = priceChangeResultCopy(row.result);
  const revoked = row.revoked_at !== null;
  const withinWindow =
    row.result === 'EFFECTED' &&
    !revoked &&
    Date.now() - Date.parse(row.created_at) < REVOKE_WINDOW_MS;
  return (
    <View style={styles.changeRow}>
      <View style={styles.changeTextBlock}>
        <View style={styles.changeHeadRow}>
          <Text style={styles.changeTitle}>
            {/* change_pct 已是百分数值（numeric(6,3)，4.615=4.615%）——经 formatPercent
                出口（评审 I-1：formatRate 会误放大百倍） */}
            {priceChangeDirectionCopy(row.direction)} {formatPercent(Number(row.change_pct))}
            {row.has_active_group ? ' · 在团' : ' · 不在团'}
          </Text>
          <ChangeBadge
            label={revoked ? '已撤销' : copy.label}
            tone={revoked ? 'finished' : copy.tone}
          />
        </View>
        <Text style={styles.changeNote}>
          v{row.old_version} → v{row.new_version} ·{' '}
          {row.credit_penalty === 0 ? '无信用影响' : `信用 ${row.credit_penalty}`} ·{' '}
          {formatDate(row.created_at)}
          {row.approval_source === 'MANUAL' ? ' · 人工审批' : ''}
        </Text>
      </View>
      {withinWindow ? (
        <Button
          label={revoking ? '撤销中' : '撤销'}
          variant="ghost"
          small
          busy={revoking}
          onPress={onRevoke}
        />
      ) : null}
    </View>
  );
}

function ChangeBadge({ label, tone }: { readonly label: string; readonly tone: PriceChangeTone }) {
  const style =
    tone === 'grouped'
      ? styles.badgeGrouped
      : tone === 'open'
        ? styles.badgeOpen
        : tone === 'failed'
          ? styles.badgeFailed
          : styles.badgeFinished;
  const textStyle =
    tone === 'failed'
      ? styles.badgeTextDanger
      : tone === 'finished'
        ? styles.badgeTextMuted
        : styles.badgeText;
  return (
    <View style={[styles.badge, style]}>
      <Text style={textStyle}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screenWrap: { flex: 1 },
  scroll: { flex: 1 },
  content: { padding: spacing.lg, gap: spacing.md },
  card: { padding: spacing.lg, gap: spacing.sm },
  title: { color: colors.ink, fontSize: fontSize.lg, fontWeight: fontWeight.semibold },
  headRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  versionBadge: {
    color: colors.primary,
    fontSize: fontSize.xs,
    fontWeight: fontWeight.medium,
    backgroundColor: colors.primary2A15,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: 3,
    overflow: 'hidden',
  },
  modeRow: { flexDirection: 'row', gap: spacing.sm },
  modeCard: {
    flex: 1,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: 'rgba(255,255,255,0.55)', // 玻璃面变体（原型 chip 底，降级口径档）
    padding: spacing.md,
    gap: 2,
  },
  modeCardOn: { borderColor: colors.primary, backgroundColor: colors.primary2A15 },
  modeTitle: { color: colors.ink, fontSize: fontSize.base, fontWeight: fontWeight.medium },
  modeTitleOn: { color: colors.primary },
  modeNote: { color: colors.ink2, fontSize: fontSize.xs, lineHeight: 15 },
  fieldBlock: { gap: 4 },
  fieldLabel: { color: colors.ink2, fontSize: fontSize.sm },
  duoRow: { flexDirection: 'row', gap: spacing.md },
  duoField: { flex: 1 },
  duoInner: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  smallInput: { minHeight: 46, paddingHorizontal: spacing.md, fontSize: fontSize.base },
  rangeDash: { color: colors.ink2 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    paddingHorizontal: spacing.md,
    paddingVertical: 5,
    borderRadius: radius.pill,
    backgroundColor: colors.primary2A15,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  chipOn: { borderColor: colors.primary },
  chipText: { color: colors.ink, fontSize: fontSize.sm },
  chipTextOn: { color: colors.primary, fontWeight: fontWeight.semibold },
  saveBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  saveBarTextBlock: { flexShrink: 1, gap: 2 },
  saveBarNote: { color: colors.ink2, fontSize: fontSize.sm },
  saveBarNoteDirty: { color: colors.ink, fontWeight: fontWeight.medium },
  savedNote: { color: colors.primary, fontSize: fontSize.sm, fontWeight: fontWeight.medium },
  saveErrorRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, flexWrap: 'wrap' },
  changeActionCard: {
    padding: spacing.lg,
    gap: spacing.sm,
    backgroundColor: colors.accentCard, // 红点缀焦点卡（本页唯一红底卡=R-04 承接动作位）
    borderColor: colors.dangerLine,
  },
  changeActionTitle: {
    color: colors.accentDk,
    fontSize: fontSize.base,
    fontWeight: fontWeight.semibold,
  },
  changeList: { gap: spacing.sm, marginTop: spacing.xs },
  changeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
    paddingBottom: spacing.sm,
  },
  changeTextBlock: { flexShrink: 1, gap: 2 },
  changeHeadRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  changeTitle: { color: colors.ink, fontSize: fontSize.base, fontWeight: fontWeight.medium },
  changeNote: { color: colors.ink2, fontSize: fontSize.xs },
  badge: {
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: 3,
    overflow: 'hidden',
  },
  badgeGrouped: { backgroundColor: colors.primary2A15 },
  badgeOpen: { backgroundColor: colors.primary2A15 },
  badgeFailed: { backgroundColor: colors.accentCard }, // 否决=危险态点缀（小面积徽标位）
  badgeFinished: { backgroundColor: colors.ink2A15 },
  badgeText: { color: colors.primary, fontSize: fontSize.xs, fontWeight: fontWeight.medium },
  badgeTextDanger: { color: colors.accentDk, fontSize: fontSize.xs, fontWeight: fontWeight.medium },
  badgeTextMuted: { color: colors.ink2, fontSize: fontSize.xs },
  versionList: { gap: spacing.xs, marginTop: spacing.xs },
  versionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
    paddingBottom: spacing.xs,
  },
  versionTextBlock: { flexShrink: 1, gap: 2 },
  versionTitle: { color: colors.ink, fontSize: fontSize.base, fontWeight: fontWeight.medium },
  versionNote: { color: colors.ink2, fontSize: fontSize.xs },
  /** 覆盖层（T2 I-4 形态）：米白绿底半透遮罩 + 居中面板 */
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
