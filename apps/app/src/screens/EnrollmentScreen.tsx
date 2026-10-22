/**
 * 报名支付流（M3-W1 T3，接管 T2 报名占位位，路由键 enrollmentPlaceholder 不动）：
 * 详情 CTA → 报名确认（金额明细+积分抵扣可选入口[默认 0]）→ POST /sessions/{id}/enroll →
 * dev 支付模拟器（EXPO_PUBLIC_DEV_PAY_SIM=1 才出现——#40 直接成功口径的 dev 路径：
 * 点支付即回调 PAID→relay 成团）→ 成功态（已成团/待成团，按详情刷新）→ 跳我的报名占位。
 *
 * 错误三态：402 E_REALNAME_REQUIRED → 引导去实名页（推栈 realname）；403/409 → 映射文案展示。
 * 生产形态=M5-6b 通道拉起换装：模拟器关闭时展示「支付单已创建·通道接入中」注记态。
 * 金额展示全部经 money 单一出口；状态文案经 trade-copy/session-copy 映射表。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { ErrorCode } from '@ljr/shared';
import { isAppApiError } from '../api/client';
import { isDevPaySimEnabled, simulatePaySuccess } from '../api/dev-pay-sim';
import { enrollInSession, type EnrollResult } from '../api/enrollments';
import { formatMoney } from '../api/money';
import { fetchSessionDetail, type SessionDetailView } from '../api/sessions';
import { ENROLL_ACCEPTED_PENDING, enrollOutcomeCopy, payOrderStatusCopy } from '../api/trade-copy';
import { useResource } from '../api/useResource';
import { SessionPrice } from '../components/session-card';
import { ErrorPanel, LoadingHint } from '../components/state-views';
import { Button, ErrorText, Field, GlassCard, MutedText } from '../components/ui';
import { colors, fontSize, fontWeight, spacing } from '../design/tokens';
import { useNavigation } from '../navigation/router';
import { formatDateTime, formatDateTimeFull } from '../utils/date';

/** 支付后成团确认轮询：core relay 1s 轮询，留余量（10 次 × 700ms） */
const GROUP_CONFIRM_POLL_TIMES = 10;
const GROUP_CONFIRM_POLL_INTERVAL_MS = 700;

type Phase =
  | { readonly kind: 'form' }
  | { readonly kind: 'submitting' }
  | { readonly kind: 'ordered'; readonly result: EnrollResult; readonly paid: boolean }
  | { readonly kind: 'paying'; readonly result: EnrollResult }
  | {
      readonly kind: 'done';
      readonly result: EnrollResult;
      /** null=成团确认轮询全部失败（评审 I4 降级收口：不翻失败态，展示「已受理·确认中」） */
      readonly session: SessionDetailView | null;
    }
  | {
      readonly kind: 'error';
      readonly message: string;
      readonly code: string | null;
      readonly realnameRequired: boolean;
    };

export function EnrollmentScreen({
  params,
}: {
  readonly params?: Readonly<Record<string, unknown>>;
}) {
  const nav = useNavigation();
  const rawId = params?.['sessionId'];
  const id = typeof rawId === 'number' && Number.isInteger(rawId) && rawId > 0 ? rawId : null;
  const { state, reload } = useResource(
    () => (id === null ? Promise.reject(new Error('缺少场次参数')) : fetchSessionDetail(id)),
    [id],
  );
  const [points, setPoints] = useState('0');
  const [phase, setPhase] = useState<Phase>({ kind: 'form' });
  const devSim = isDevPaySimEnabled();

  // 离开本页或重装时丢弃迟到轮询（alive 守卫）
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  /**
   * 支付后成团确认轮询（评审 I4）：轮询中的网络/接口错误单独吞掉（瞬时抖动下一轮再试），
   * 全部失败返回 null——调用方降级为「支付已受理·成团确认中」收口，绝不并入报名失败分支
   * （钱已扣而页面报「报名未完成」是资金流最误导形态）。
   */
  const waitGroupConfirm = useCallback(
    async (sessionId: number, before: SessionDetailView): Promise<SessionDetailView | null> => {
      const probe = async (): Promise<SessionDetailView | null> => {
        try {
          return await fetchSessionDetail(sessionId);
        } catch {
          return null; // 瞬时失败：本轮放弃，由调用侧决定重试或降级
        }
      };
      for (let i = 0; i < GROUP_CONFIRM_POLL_TIMES; i += 1) {
        await new Promise((r) => setTimeout(r, GROUP_CONFIRM_POLL_INTERVAL_MS));
        if (!alive.current) return null;
        const after = await probe();
        if (after && (after.joined > before.joined || after.status !== 'CREATED')) return after;
      }
      return probe();
    },
    [],
  );

  async function handleEnroll(session: SessionDetailView): Promise<void> {
    const pointsToUse = points.trim() === '' ? 0 : Number(points);
    if (!Number.isInteger(pointsToUse) || pointsToUse < 0) {
      setPhase({
        kind: 'error',
        message: '积分数额须为非负整数',
        code: null,
        realnameRequired: false,
      });
      return;
    }
    setPhase({ kind: 'submitting' });
    try {
      const result = await enrollInSession(session.id, pointsToUse);
      if (!devSim) {
        // 生产注记态：支付单已创建，通道拉起=M5-6b 换装（不造支付成功的假象）
        setPhase({ kind: 'ordered', result, paid: false });
        return;
      }
      setPhase({ kind: 'paying', result });
      await simulatePaySuccess(result.payment_order.id, result.pay_params.channel);
      const after = await waitGroupConfirm(session.id, session);
      if (!alive.current) return;
      setPhase({ kind: 'done', result, session: after });
    } catch (e) {
      if (!alive.current) return;
      if (isAppApiError(e)) {
        setPhase({
          kind: 'error',
          message: e.message,
          code: e.code,
          realnameRequired: e.code === ErrorCode.RealnameRequired,
        });
        return;
      }
      setPhase({
        kind: 'error',
        message: e instanceof Error ? e.message : '操作失败，请稍后重试',
        code: null,
        realnameRequired: false,
      });
    }
  }

  if (state.phase === 'loading') {
    return <LoadingHint label="报名信息加载中…" />;
  }
  if (state.phase === 'error') {
    return (
      <View style={styles.errorWrap}>
        <ErrorPanel error={state.error} onRetry={reload} />
        <Button label="返回" variant="ghost" small onPress={nav.pop} />
      </View>
    );
  }

  const s = state.data;
  const enrollable = s.status === 'CREATED' && s.remaining > 0;

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.content}
      accessibilityLabel="报名支付页"
    >
      <GlassCard style={styles.card}>
        <Text style={styles.cardTitle}>报名确认</Text>
        <View style={styles.row}>
          <Text style={styles.rowLabel}>场次</Text>
          <Text style={styles.rowValue}>
            {formatDateTime(s.slot_start)} 开场 · {s.city}
          </Text>
        </View>
        <View style={styles.row}>
          <Text style={styles.rowLabel}>报名截止</Text>
          <Text style={styles.rowValue}>{formatDateTimeFull(s.enroll_deadline)}</Text>
        </View>
        <View style={styles.divider} />
        <View style={styles.row}>
          <Text style={styles.rowLabel}>每人份（价格快照）</Text>
          <SessionPrice unitPrice={s.unit_price} />
        </View>
        <View style={styles.pointsBlock}>
          <Text style={styles.rowLabel}>积分抵扣（可选，默认 0）</Text>
          <View style={styles.pointsRow}>
            <Field
              value={points}
              onChangeText={(t) => setPoints(t.replace(/[^\d]/g, '').slice(0, 7))}
              keyboardType="number-pad"
              accessibilityLabel="积分抵扣输入框"
              style={styles.pointsField}
            />
            <MutedText>积分</MutedText>
          </View>
          <MutedText>100 积分=1 元，单次至多抵扣应付金额的 50%；不抵扣可保持 0。</MutedText>
        </View>
        {!enrollable ? (
          <ErrorText>
            {s.status === 'CREATED' && s.remaining === 0
              ? '该场次已满员，暂不可报名。'
              : '当前状态不可报名，请返回场次详情查看。'}
          </ErrorText>
        ) : null}
      </GlassCard>

      {phase.kind === 'error' ? (
        <GlassCard style={styles.card}>
          <Text style={styles.errorTitle}>报名未完成</Text>
          <ErrorText>{phase.message}</ErrorText>
          {phase.code ? <MutedText>code={phase.code}</MutedText> : null}
          {phase.realnameRequired ? (
            <Button
              label="去完成实名认证"
              onPress={() => nav.push({ key: 'realname', params: { returnSessionId: s.id } })}
            />
          ) : (
            <Button
              label="返回修改"
              variant="ghost"
              small
              onPress={() => setPhase({ kind: 'form' })}
            />
          )}
        </GlassCard>
      ) : null}

      {(phase.kind === 'ordered' || phase.kind === 'paying') && phase.result ? (
        <GlassCard style={styles.card}>
          <Text style={styles.cardTitle}>
            {phase.kind === 'paying' ? '模拟支付处理中…' : '支付单已创建'}
          </Text>
          <View style={styles.row}>
            <Text style={styles.rowLabel}>订单号</Text>
            <Text style={styles.rowValue}>#{phase.result.payment_order.id}</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.rowLabel}>应付现金</Text>
            <Text style={styles.priceText}>
              {formatMoney(phase.result.payment_order.cash_amount)}
            </Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.rowLabel}>积分抵扣</Text>
            <Text style={styles.rowValue}>
              {phase.result.payment_order.points_amount > 0
                ? `${phase.result.payment_order.points_amount} 积分`
                : '未使用'}
            </Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.rowLabel}>订单状态</Text>
            <Text style={styles.rowValue}>
              {payOrderStatusCopy(phase.result.payment_order.status).label}
            </Text>
          </View>
          {phase.kind === 'ordered' ? (
            /* 评审 S7：用户可见文案中性化（env 配方在任务报告 §五，不进 UI 文案） */
            <MutedText>支付通道即将开放：报名订单已创建并保留，开放后将可完成支付。</MutedText>
          ) : (
            <MutedText>回调已受理，正在确认成团状态（约 1-2 秒）…</MutedText>
          )}
        </GlassCard>
      ) : null}

      {phase.kind === 'done' && phase.result ? (
        <GlassCard style={styles.successCard}>
          {phase.session !== null ? (
            <>
              <Text style={styles.successTitle}>
                {enrollOutcomeCopy(phase.session.status).title}
              </Text>
              <MutedText>{enrollOutcomeCopy(phase.session.status).note}</MutedText>
            </>
          ) : (
            /* 评审 I4 降级收口：支付回调已受理，仅成团确认刷新失败——不翻失败态 */
            <>
              <Text style={styles.successTitle}>{ENROLL_ACCEPTED_PENDING.title}</Text>
              <MutedText>{ENROLL_ACCEPTED_PENDING.note}</MutedText>
            </>
          )}
          <View style={styles.divider} />
          <View style={styles.row}>
            <Text style={styles.rowLabel}>实付</Text>
            <Text style={styles.priceText}>{formatMoney(phase.result.enrollment.paid_amount)}</Text>
          </View>
          {phase.session !== null ? (
            <View style={styles.row}>
              <Text style={styles.rowLabel}>场次进度</Text>
              <Text style={styles.rowValue}>
                已报 {phase.session.joined}/{phase.session.capacity}
              </Text>
            </View>
          ) : null}
          <View style={styles.btnColumn}>
            <Button label="查看我的报名（我的 tab）" onPress={() => nav.setTab('me')} />
            <Button
              label="AI 训练数据授权（独立设置）"
              variant="ghost"
              small
              onPress={() => nav.push({ key: 'trainingConsent' })}
            />
          </View>
        </GlassCard>
      ) : null}

      {phase.kind === 'form' || phase.kind === 'submitting' ? (
        <Button
          label={devSim ? '确认报名并支付（dev 模拟）' : '提交报名'}
          busy={phase.kind === 'submitting'}
          disabled={!enrollable}
          onPress={() => void handleEnroll(s)}
        />
      ) : null}

      <Pressable accessibilityRole="link" onPress={nav.pop} style={styles.backLink}>
        <Text style={styles.backLinkText}>返回场次详情</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  content: { padding: spacing.lg, gap: spacing.md },
  card: { padding: spacing.lg, gap: spacing.md },
  cardTitle: { color: colors.ink, fontSize: fontSize.lg, fontWeight: fontWeight.semibold },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: spacing.md,
  },
  rowLabel: { color: colors.ink2, fontSize: fontSize.base },
  rowValue: { color: colors.ink, fontSize: fontSize.base, fontWeight: fontWeight.medium },
  priceText: { color: colors.accentDk, fontSize: fontSize.xxl, fontWeight: fontWeight.bold },
  divider: { height: 1, backgroundColor: colors.line },
  pointsBlock: { gap: spacing.xs },
  pointsRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  pointsField: { flex: 1, minHeight: 40 },
  errorTitle: { color: colors.ink, fontSize: fontSize.lg, fontWeight: fontWeight.semibold },
  successCard: {
    padding: spacing.lg,
    gap: spacing.md,
    backgroundColor: colors.accentCard, // 红点缀焦点卡（一组仅 1 张）
    borderColor: colors.dangerLine,
  },
  successTitle: { color: colors.accentDk, fontSize: fontSize.xl, fontWeight: fontWeight.bold },
  btnColumn: { gap: spacing.sm, marginTop: spacing.xs },
  errorWrap: { flex: 1, padding: spacing.lg, gap: spacing.md, justifyContent: 'center' },
  backLink: { alignItems: 'center', paddingVertical: spacing.md },
  backLinkText: { color: colors.primary, fontSize: fontSize.md },
});
