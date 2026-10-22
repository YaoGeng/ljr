/**
 * 开团配置（M3-W2 T3 新推栈页，替换占位；对照原型 l-create）：POST /sessions 七键表单
 * （C1 §5 逐字——lawyer_id 取 JWT 不入 body）+ B2 锁错误态承载。
 *
 * 表单（core parseSessionBody 实文）：
 *   - slot_start：时间表 FREE 时段预选经 params.slot_start 带入（上海墙钟拆回日期+时刻
 *     输入），也可手填（'YYYY-MM-DD'+'HH:mm' → toShanghaiIso，slot-input 单源）
 *   - price_mode：per_head|session_total 单选（B3 默认价预填——GET /lawyer/:id/pricing 公开读，
 *     失败不阻断手填）
 *   - unit_price：可选缺省=取 B3 默认价；per_head=每人单价 / session_total=场次总价
 *     （core resolvePrices 语义；total 模式给人均分摊预览=splitTotalPerHead 半分向上同口径）
 *   - capacity：2-50（R-03）；room_mode：text|voice|video 单选（B3 room_modes 首项预填）
 *   - enroll_deadline：可选缺省=开始前 24h（⚠04§8-3）；临期场次（缺省截止已过）core 400
 *     E_ENROLL_DEADLINE_INVALID 要求显式传未来截止——表单按时距提示
 *
 * 错误态映射（error-messages 单源）：409 E_SLOT_TAKEN（B2 占用锁——附「返回时间表」动作）/
 * 409 E_SESSION_DUP_KEY/403 E_RESTRICTED/429 E_RATE_LIMITED（B2 R-03 防御位，B2C 自然流程
 * 不可达如实承载）/400 形态与截止无效。
 * 提交防连点=Button busy/disabled；成功=push sessionDetail（W1 详情页复用，params {id}）。
 *
 * 评审修复环：N-4 未保存离开确认三层接线（pop 拦截→页内确认面板 / web beforeunload /
 * native BackHandler——与价格配置页同形态；dirty 基线=挂载初值∪B3 预填值快照，开团表单无
 * 已存态，用户改动即未保存工作）；N-5 计价模式切换清空价格输入（单价与总价语义不同侧，
 * 保留旧值即语义漂移：600.00 总价切人头价档=每人 600 元）。
 */
import { useEffect, useRef, useState } from 'react';
import { BackHandler, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { ErrorCode } from '@ljr/shared';
import { isAppApiError } from '../api/client';
import { formatMoney, isValidMoney } from '../api/money';
import {
  createSession,
  SESSION_CAPACITY_MAX,
  SESSION_CAPACITY_MIN,
  splitTotalPerHead,
  type CreateSessionInput,
  type PriceMode,
} from '../api/lawyer-sessions';
import { fetchPricing, type CurrentPricingView } from '../api/pricing';
import { priceModeCopy, roomModeCopy } from '../api/session-copy';
import { useResource } from '../api/useResource';
import { useSession } from '../api/useSession';
import { Button, ErrorText, Field, GlassCard, MutedText, ScreenTitle } from '../components/ui';
import { ErrorPanel } from '../components/state-views';
import { colors, fontSize, fontWeight, radius, spacing } from '../design/tokens';
import { formatDate, formatTime } from '../utils/date';
import { installPhysicalBackGuard } from '../utils/leave-guard';
import { isFutureInstant, toShanghaiIso } from '../utils/slot-input';
import { useNavigation } from '../navigation/router';

type RoomMode = 'text' | 'voice' | 'video';
const ROOM_MODE_OPTIONS: readonly RoomMode[] = ['text', 'voice', 'video'];

/** 缺省报名截止=开始前 24h（core config.enrollDeadlineHours 同值；⚠04§8-3） */
const DEFAULT_DEADLINE_HOURS = 24;

const NULL_PRICING: CurrentPricingView = { version: 0, created_at: null, pricing: null };

export function LawyerCreateSessionScreen({
  params,
}: {
  readonly params?: Readonly<Record<string, unknown>>;
}) {
  const nav = useNavigation();
  const me = useSession().me;
  const rawSlot = typeof params?.['slot_start'] === 'string' ? params['slot_start'] : null;

  // ---- B3 默认价预填（公开读；失败=可手填的降级态，不阻断表单） ----
  const pricing = useResource(
    () => (me === null ? Promise.resolve(NULL_PRICING) : fetchPricing(me.id)),
    [me?.id],
  );

  const [slotDate, setSlotDate] = useState(() => (rawSlot !== null ? formatDate(rawSlot) : ''));
  const [slotTime, setSlotTime] = useState(() => (rawSlot !== null ? formatTime(rawSlot) : ''));
  const [priceMode, setPriceMode] = useState<PriceMode>('per_head');
  const [unitPrice, setUnitPrice] = useState('');
  const [capacity, setCapacity] = useState('');
  const [roomMode, setRoomMode] = useState<RoomMode>('text');
  const [deadlineDate, setDeadlineDate] = useState('');
  const [deadlineTime, setDeadlineTime] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);

  /** 离开确认目标（pop=返回/硬件返回拦截→页内确认面板；评审 N-4） */
  const [leaveTarget, setLeaveTarget] = useState<{ readonly kind: 'pop' } | null>(null);

  // ---- 未保存离开确认（评审 N-4）：dirty 基线=挂载初值，B3 预填后以预填值为基线 ----
  const initialRef = useRef<{
    slotDate: string;
    slotTime: string;
    priceMode: PriceMode;
    unitPrice: string;
    capacity: string;
    roomMode: RoomMode;
    deadlineDate: string;
    deadlineTime: string;
  } | null>(null);
  useEffect(() => {
    // 挂载基线（params 预选已并入初值；快照在首帧定格）
    initialRef.current = {
      slotDate,
      slotTime,
      priceMode,
      unitPrice,
      capacity,
      roomMode,
      deadlineDate,
      deadlineTime,
    };
    // 空依赖=首帧一次性定格基线（预填值另行并入 initialRef，见预填 effect）
  }, []);
  const baseline = initialRef.current;
  const dirty =
    baseline !== null &&
    (slotDate !== baseline.slotDate ||
      slotTime !== baseline.slotTime ||
      priceMode !== baseline.priceMode ||
      unitPrice !== baseline.unitPrice ||
      capacity !== baseline.capacity ||
      roomMode !== baseline.roomMode ||
      deadlineDate !== baseline.deadlineDate ||
      deadlineTime !== baseline.deadlineTime);

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

  /** 计价模式切换（评审 N-5）：清空价格——单价/总价不同语义侧，保留旧值即漂移 */
  function switchPriceMode(mode: PriceMode): void {
    if (mode === priceMode) return;
    setPriceMode(mode);
    setUnitPrice('');
  }

  /** 预填一次性（B3 读就绪且表单未被用户改动时注入默认值——对照原型「自动填入默认价格与人数」；
   *  预填值并入 dirty 基线——注入非用户改动不算未保存，评审 N-4） */
  const prefilledRef = useRef(false);
  useEffect(() => {
    if (prefilledRef.current || pricing.state.phase !== 'ready') return;
    prefilledRef.current = true;
    const p = pricing.state.data.pricing;
    if (p === null) return;
    const nextMode: PriceMode = p.per_head !== null ? 'per_head' : 'session_total';
    const nextPrice = p.per_head ?? p.session_total ?? '';
    const nextCapacity = p.group_size !== null ? String(p.group_size) : capacity;
    const nextRoomMode =
      p.room_modes !== null && p.room_modes.length > 0 ? (p.room_modes[0] as RoomMode) : roomMode;
    setPriceMode(nextMode);
    setUnitPrice(nextPrice);
    setCapacity(nextCapacity);
    setRoomMode(nextRoomMode);
    if (initialRef.current !== null) {
      initialRef.current = {
        ...initialRef.current,
        priceMode: nextMode,
        unitPrice: nextPrice,
        capacity: nextCapacity,
        roomMode: nextRoomMode,
      };
    }
  }, [pricing.state]);

  /** 表单本地校验（镜像 core parseSessionBody 值域 + 时序防呆）——返回问题清单 */
  const slotStartIso = toShanghaiIso(slotDate.trim(), slotTime.trim());
  const capacityNum = /^\d+$/.test(capacity.trim()) ? Number(capacity.trim()) : null;
  const priceTrimmed = unitPrice.trim();
  const priceValid = priceTrimmed === '' || isValidMoney(priceTrimmed);
  const issues: string[] = [];
  if (slotStartIso === null) {
    issues.push('开始时间须为 YYYY-MM-DD + HH:mm（上海时间，24 小时制）');
  } else if (!isFutureInstant(slotStartIso)) {
    issues.push('开始时间须晚于当前时刻（不得开已过去的场次）');
  }
  if (capacityNum === null) {
    issues.push(`开团人数须为 ${SESSION_CAPACITY_MIN}-${SESSION_CAPACITY_MAX} 的整数`);
  } else if (capacityNum < SESSION_CAPACITY_MIN || capacityNum > SESSION_CAPACITY_MAX) {
    issues.push(`开团人数须在 ${SESSION_CAPACITY_MIN}-${SESSION_CAPACITY_MAX} 之间（R-03）`);
  }
  if (!priceValid) {
    issues.push(
      priceMode === 'per_head'
        ? '人头价须为两位小数金额（如 99.00）'
        : '场次总价须为两位小数金额（如 650.00）',
    );
  }
  const deadlineFilled = deadlineDate.trim() !== '' || deadlineTime.trim() !== '';
  const deadlineIso = deadlineFilled
    ? toShanghaiIso(deadlineDate.trim(), deadlineTime.trim())
    : null;
  if (deadlineFilled && deadlineIso === null) {
    issues.push('报名截止须同时填写日期与时间（YYYY-MM-DD + HH:mm）');
  } else if (
    deadlineIso !== null &&
    slotStartIso !== null &&
    Date.parse(deadlineIso) >= Date.parse(slotStartIso)
  ) {
    issues.push('报名截止须早于开始时间');
  }
  const formValid = issues.length === 0;

  /** 临期提示：slot 距今 <24h 且未填截止 → core 将 400 E_ENROLL_DEADLINE_INVALID（R-W3-G） */
  const deadlineHint =
    slotStartIso !== null && !deadlineFilled
      ? Date.parse(slotStartIso) - Date.now() < DEFAULT_DEADLINE_HOURS * 60 * 60 * 1000
        ? '距开始不足 24 小时（临期场次）：缺省截止已过，必须手动设置晚于当前且早于开始的报名截止'
        : '缺省 = 开始前 24 小时（⚠ 默认规则待产品确认，可手动调整）'
      : '缺省 = 开始前 24 小时（⚠ 默认规则待产品确认，可手动调整）';

  /** session_total 模式人均分摊预览（splitTotalPerHead=core splitTotalIntoUnit 同口径） */
  const perHeadPreview =
    priceMode === 'session_total' &&
    isValidMoney(priceTrimmed) &&
    capacityNum !== null &&
    capacityNum >= SESSION_CAPACITY_MIN &&
    capacityNum <= SESSION_CAPACITY_MAX
      ? formatMoney(splitTotalPerHead(priceTrimmed, capacityNum))
      : null;

  async function submit(): Promise<void> {
    setError(null);
    setErrorCode(null);
    if (slotStartIso === null || capacityNum === null) return; // formValid 已禁用提交（防御双闸）
    // 可选键条件展开（unit_price 空=缺省取 B3 默认价；deadline 空=core 补开始前 24h）
    const input: CreateSessionInput = {
      slot_start: slotStartIso,
      price_mode: priceMode,
      capacity: capacityNum,
      room_mode: roomMode,
      ...(isValidMoney(priceTrimmed) ? { unit_price: priceTrimmed } : {}),
      ...(deadlineIso !== null ? { enroll_deadline: deadlineIso } : {}),
    };
    setSubmitting(true); // 防连点：busy 态禁用按钮直至应答
    try {
      const s = await createSession(input);
      nav.push({ key: 'sessionDetail', params: { id: s.id } });
    } catch (e) {
      if (isAppApiError(e)) {
        setError(e.message);
        setErrorCode(e.code);
        return;
      }
      setError('操作失败，请稍后重试');
    } finally {
      setSubmitting(false);
    }
  }

  if (!me) {
    return (
      <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
        <GlassCard style={styles.card}>
          <Text style={styles.cardTitle}>登录态缺失</Text>
          <MutedText>请退出后重新登录再开团</MutedText>
        </GlassCard>
      </ScrollView>
    );
  }

  return (
    <View style={styles.screenWrap}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        accessibilityLabel="开团配置"
      >
        <ScreenTitle>开团配置 · B2C</ScreenTitle>
        <MutedText>
          已自动填入默认价格与默认开团人数（本次修改仅对本次开团有效，不改变默认值，R-01）；
          提交即锁定时间段（B2 占用锁，同事务）。
        </MutedText>

        {/* 时间段（时间表 FREE 时段预选带入/手填） */}
        <GlassCard style={styles.card}>
          <Text style={styles.cardTitle}>
            时间段{rawSlot !== null ? '（已从时间表带入，可修改）' : '（手动填写，上海时间）'}
          </Text>
          <View style={styles.duoRow}>
            <Field
              value={slotDate}
              onChangeText={(t) => setSlotDate(t.slice(0, 10))}
              placeholder="YYYY-MM-DD"
              accessibilityLabel="开始日期输入框"
              style={styles.duoField}
            />
            <Field
              value={slotTime}
              onChangeText={(t) => setSlotTime(t.slice(0, 5))}
              placeholder="HH:mm"
              accessibilityLabel="开始时刻输入框"
              style={styles.duoField}
            />
          </View>
          <Text style={styles.cardTitle}>报名截止（可选）</Text>
          <View style={styles.duoRow}>
            <Field
              value={deadlineDate}
              onChangeText={(t) => setDeadlineDate(t.slice(0, 10))}
              placeholder="YYYY-MM-DD"
              accessibilityLabel="截止日期输入框"
              style={styles.duoField}
            />
            <Field
              value={deadlineTime}
              onChangeText={(t) => setDeadlineTime(t.slice(0, 5))}
              placeholder="HH:mm"
              accessibilityLabel="截止时刻输入框"
              style={styles.duoField}
            />
          </View>
          <MutedText>{deadlineHint}</MutedText>
        </GlassCard>

        {/* 计价与价格（unit_price 语义随 price_mode） */}
        <GlassCard style={styles.card}>
          <Text style={styles.cardTitle}>计价方式</Text>
          <View style={styles.modeRow}>
            <ModeCard
              active={priceMode === 'per_head'}
              title={priceModeCopy('per_head')}
              note="每人付固定单价 · 收入=单价×成团人数"
              onPress={() => switchPriceMode('per_head')}
            />
            <ModeCard
              active={priceMode === 'session_total'}
              title={priceModeCopy('session_total')}
              note="用户按 总价÷人数 分摊预付"
              onPress={() => switchPriceMode('session_total')}
            />
          </View>
          <Text style={styles.cardTitle}>
            {priceMode === 'per_head' ? '本次人头价（元/人）' : '本次场次总价（元）'}
          </Text>
          <Field
            value={unitPrice}
            onChangeText={setUnitPrice}
            placeholder={priceMode === 'per_head' ? '99.00' : '650.00'}
            keyboardType="decimal-pad"
            accessibilityLabel={priceMode === 'per_head' ? '本次人头价' : '本次场次总价'}
            invalid={!priceValid}
          />
          <MutedText>
            留空 = 使用默认价格；金额为两位小数字符串。切换计价方式后须重新填写价格（单价与总价
            语义不同）。
            {perHeadPreview !== null ? `人均分摊约 ${perHeadPreview}（半分向上取整到分）。` : ''}
          </MutedText>
          {pricing.state.phase === 'error' ? (
            <View style={styles.pricingFallback}>
              <ErrorPanel error={pricing.state.error} onRetry={pricing.reload} />
              <MutedText>默认价格读取失败——价格可手动填写，提交时服务端将校验。</MutedText>
            </View>
          ) : null}
        </GlassCard>

        {/* 人数与沟通形式 */}
        <GlassCard style={styles.card}>
          <Text style={styles.cardTitle}>本次开团人数（成团即锁人，R-02）</Text>
          <Field
            value={capacity}
            onChangeText={(t) => setCapacity(t.replace(/[^\d]/g, '').slice(0, 2))}
            placeholder={`2-${SESSION_CAPACITY_MAX}`}
            keyboardType="number-pad"
            accessibilityLabel="开团人数输入框"
          />
          <MutedText>
            人数域 {SESSION_CAPACITY_MIN}-{SESSION_CAPACITY_MAX}（R-03）；人数选定后固定不变。
          </MutedText>
          <Text style={styles.cardTitle}>沟通形式（单选，本场房间形式）</Text>
          <View style={styles.chipRow}>
            {ROOM_MODE_OPTIONS.map((m) => {
              const on = roomMode === m;
              const inDefaults =
                pricing.state.phase === 'ready' &&
                pricing.state.data.pricing?.room_modes?.includes(m) === true;
              return (
                <Pressable
                  key={m}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: on }}
                  onPress={() => setRoomMode(m)}
                  style={[styles.chip, on && styles.chipOn]}
                >
                  <Text style={[styles.chipText, on && styles.chipTextOn]}>
                    {roomModeCopy(m)}
                    {inDefaults ? ' ·默认' : ''}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </GlassCard>

        {/* 防呆校验反馈（阻止提交） */}
        {issues.map((issue) => (
          <ErrorText key={issue}>{issue}</ErrorText>
        ))}
        <ErrorText>{error}</ErrorText>
        {errorCode ? <MutedText>code={errorCode}</MutedText> : null}

        {/* B2 锁占用错误 → 返回时间表动作（409 E_SLOT_TAKEN 专属出口） */}
        {errorCode === ErrorCode.SlotTaken ? (
          <Button label="返回时间表选择其他空闲时段" variant="secondary" small onPress={nav.pop} />
        ) : null}

        <Button
          label={submitting ? '创建中' : '创建场次 · 锁定时间段'}
          busy={submitting}
          disabled={!formValid}
          onPress={() => void submit()}
        />
        <MutedText>
          未满员到截止 → 流标 → 全额自动退款（R-03）；同律师同时段仅一个进行中场次（B2 占用锁）。
        </MutedText>
      </ScrollView>

      {/* 未保存离开确认（pop/物理返回→页内面板；评审 N-4）——绝对定位覆盖层（T2 I-4 形态） */}
      {leaveTarget !== null ? (
        <View style={styles.leaveOverlay}>
          <GlassCard style={styles.leaveCard}>
            <Text style={styles.cardTitle}>有未提交的开团信息</Text>
            <MutedText>离开将丢弃已填写的开团配置；可留在此页完成提交，或放弃后返回。</MutedText>
            <View style={styles.leaveBtns}>
              <Button label="继续填写" variant="ghost" small onPress={() => setLeaveTarget(null)} />
              <Button
                label="放弃填写并返回"
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

/** 计价模式选择卡（与价格配置页同形态；激活=主绿描边） */
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

const styles = StyleSheet.create({
  /** 覆盖层宿主（评审 N-4）：离开确认面板绝对定位，不随长列表滚出视口 */
  screenWrap: { flex: 1 },
  scroll: { flex: 1 },
  content: { padding: spacing.lg, gap: spacing.md },
  card: { padding: spacing.lg, gap: spacing.sm },
  cardTitle: { color: colors.ink, fontSize: fontSize.base, fontWeight: fontWeight.semibold },
  duoRow: { flexDirection: 'row', gap: spacing.md },
  duoField: { flex: 1 },
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
  pricingFallback: { gap: spacing.sm },
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
