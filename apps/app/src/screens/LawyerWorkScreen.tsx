/**
 * 律师工作台（M3-W2 T2，T1 占位替换；对照原型 l-work）：统计聚合区（四独立请求各自三态，
 * 不造聚合端点）+ AI 辅助降级徽标 + 快捷入口 + 近期场次简列 + 近期结算简版。
 *
 * 数据面（core 实文）：
 *   - GET /lawyer/sessions/stats（C1 四率——M2-W3 T3 起全真值；null=缺数据显 '—'）
 *   - GET /lawyer/attendance-stats（D3 律师准时率）
 *   - GET /lawyer/response-stats（C4 平均确认时长）
 *   - GET /lawyer/settlements（F3 本人结算，新在前——取前 3 行简版）
 *   - GET /agent/health（E1 降级探针：degraded=显式「AI 辅助不可用」条，常驻可见位）
 *   - 近期场次=GET /sessions?lawyer=<me.id>（公开面仅 CREATED——#48-① 同款如实承载+注记）
 *
 * 设计铁律：本屏红点缀仅两处=主按钮（发起开团）+ 四率焦点卡（accentCard 单张）；
 * 其余橄榄绿系。金额一律 formatMoney；比率经 formatRate 单出口。
 */
import { useState, type ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { agentHealthCopy, settlementRefTypeCopy, settlementStatusCopy } from '../api/lawyer-copy';
import {
  fetchAgentHealth,
  fetchAttendanceStats,
  fetchLawyerSettlements,
  fetchResponseStats,
  fetchSessionStats,
  formatRate,
  shanghaiWeekWindow,
} from '../api/lawyer-stats';
import { formatMoney } from '../api/money';
import { fetchSessions, type SessionView } from '../api/sessions';
import { useResource, resourceErrorMessage } from '../api/useResource';
import { useSession } from '../api/useSession';
import { SessionCard } from '../components/session-card';
import { EmptyHint, ErrorPanel, LoadingHint, SectionHeader } from '../components/state-views';
import { Button, GlassCard, MutedText } from '../components/ui';
import { colors, fontSize, fontWeight, radius, spacing } from '../design/tokens';
import { formatDate } from '../utils/date';
import { useNavigation } from '../navigation/router';

/** 卡内紧凑三态（加载=灰点、错误=文案+重试、就绪=children）——六资源各自独立三态用 */
function CompactState({
  phase,
  error,
  onRetry,
  children,
}: {
  readonly phase: 'loading' | 'ready' | 'error';
  readonly error?: unknown;
  readonly onRetry: () => void;
  readonly children: ReactNode;
}) {
  if (phase === 'loading') return <LoadingHint label="统计加载中…" />;
  if (phase === 'error') {
    return (
      <View style={styles.compactError}>
        <Text style={styles.compactErrorText}>{resourceErrorMessage(error)}</Text>
        <Button label="重试" variant="ghost" small onPress={onRetry} />
      </View>
    );
  }
  return <>{children}</>;
}

/** 单个率位（label + formatRate 大数字；null=缺数据 '—'） */
function RateStat({ label, value }: { readonly label: string; readonly value: number | null }) {
  return (
    <View style={styles.rateCell}>
      <Text style={styles.rateValue}>{formatRate(value)}</Text>
      <Text style={styles.rateLabel}>{label}</Text>
    </View>
  );
}

export function LawyerWorkScreen() {
  const nav = useNavigation();
  const me = useSession().me;

  // 统计窗：挂载时定格本周（useState 惰性初始化=组件首次挂载求值，非模块 import 时——修复环 I-2）
  const [week] = useState(() => shanghaiWeekWindow());

  const sessionStats = useResource(() => fetchSessionStats(week), []);
  const attendance = useResource(() => fetchAttendanceStats(week), []);
  const response = useResource(() => fetchResponseStats(week), []);
  const settlements = useResource(() => fetchLawyerSettlements(), []);
  const health = useResource(() => fetchAgentHealth(), []);
  // me 缺失（登录态丢失瞬态）短路不发公开列表请求（对齐 slots 面先例——修复环 I-7）
  const recentSessions = useResource(
    () => (me === null ? Promise.resolve<SessionView[]>([]) : fetchSessions({ lawyer: me.id })),
    [me?.id],
  );

  if (!me) {
    return (
      <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
        <GlassCard style={styles.card}>
          <Text style={styles.identTitle}>登录态缺失</Text>
          <MutedText>请退出后重新登录再使用律师工作台</MutedText>
        </GlassCard>
      </ScrollView>
    );
  }

  const healthReady = health.state.phase === 'ready' ? health.state.data : null;
  const settlementRows =
    settlements.state.phase === 'ready' ? settlements.state.data.slice(0, 3) : [];
  const sessionRows =
    recentSessions.state.phase === 'ready' ? recentSessions.state.data.slice(0, 3) : [];

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.content}
      accessibilityLabel="律师工作台"
    >
      {/* 律师标识行（契约无昵称——T1 triage，以 phone_masked 承载） */}
      <View style={styles.identRow}>
        <View style={styles.seal}>
          <Text style={styles.sealText}>律</Text>
        </View>
        <View style={styles.identTextBlock}>
          <Text style={styles.identTitle}>{me.phone_masked} 律师</Text>
          <MutedText>
            工作台 · 本周 {week.from.slice(5)} ~ {week.to.slice(5)}
          </MutedText>
        </View>
      </View>

      {/* AI 辅助降级徽标（E1 §2 降级显式态常驻可见位：degraded=红条显式不可用） */}
      {health.state.phase === 'ready' && healthReady !== null ? (
        healthReady.status === 'degraded' ? (
          <View style={styles.aiDegradedBar}>
            <Text style={styles.aiDegradedText}>
              {agentHealthCopy(healthReady.status)}——AI 草稿暂不可生成，手动回复不受影响
            </Text>
          </View>
        ) : (
          <View style={styles.aiOkBar}>
            <Text style={styles.aiOkText}>{agentHealthCopy(healthReady.status)}</Text>
          </View>
        )
      ) : health.state.phase === 'error' ? (
        // 探针面失败=状态未知（非「正常」）——中性灰档区分，不误导为可用（修复环 I-5）
        <View style={styles.aiUnknownBar}>
          <Text style={styles.aiUnknownText}>AI 辅助状态未知</Text>
          <Button label="重试" variant="ghost" small onPress={health.reload} />
        </View>
      ) : (
        <View style={styles.aiOkBar}>
          <Text style={styles.aiOkText}>AI 辅助检测中…</Text>
        </View>
      )}

      {/* 主操作（红点缀主按钮，本屏唯一主按钮位） */}
      <Button
        label="发起开团 · 从时间表选时段"
        onPress={() => nav.push({ key: 'lawyerSchedule' })}
      />

      {/* 四率焦点卡（accentCard 单张=本屏唯一红底卡；C1 四率全真值，null 显 '—'） */}
      <GlassCard style={styles.ratesCard}>
        <SectionHeader title="本周场次四率" note={`窗口 ${week.from} ~ ${week.to}（上海日界）`} />
        <CompactState
          phase={sessionStats.state.phase}
          error={sessionStats.state.phase === 'error' ? sessionStats.state.error : undefined}
          onRetry={sessionStats.reload}
        >
          {sessionStats.state.phase === 'ready' ? (
            <View style={styles.rateGrid}>
              <RateStat label="报名率" value={sessionStats.state.data.enroll_rate} />
              <RateStat label="成团率" value={sessionStats.state.data.group_rate} />
              <RateStat label="到场率" value={sessionStats.state.data.attendance_rate} />
              <RateStat label="1对1转化" value={sessionStats.state.data.ooo_rate} />
            </View>
          ) : null}
        </CompactState>
        <Text style={styles.rateFootnote}>「—」=窗口内暂无数据（缺数据语义，非 0%）</Text>
      </GlassCard>

      {/* 出席与响应（D3/C4 聚合源） */}
      <GlassCard style={styles.card}>
        <SectionHeader title="出席与响应" note="准时率=H4 判定口径；确认时长=C4 12h 口径" />
        <CompactState
          phase={attendance.state.phase}
          error={attendance.state.phase === 'error' ? attendance.state.error : undefined}
          onRetry={attendance.reload}
        >
          {attendance.state.phase === 'ready' ? (
            <View style={styles.miniStatRow}>
              <View style={styles.miniStat}>
                <Text style={styles.miniStatValue}>
                  {/* samples=0=空窗（core 不除零回 0）——按「缺数据非 0%」纪律显 —（修复环 I-3） */}
                  {attendance.state.data.samples === 0
                    ? '—'
                    : formatRate(attendance.state.data.punctual_rate)}
                </Text>
                <Text style={styles.miniStatLabel}>律师准时率</Text>
                <Text style={styles.miniStatNote}>{attendance.state.data.samples} 次判定样本</Text>
              </View>
            </View>
          ) : null}
        </CompactState>
        <View style={styles.divider} />
        <CompactState
          phase={response.state.phase}
          error={response.state.phase === 'error' ? response.state.error : undefined}
          onRetry={response.reload}
        >
          {response.state.phase === 'ready' ? (
            <View style={styles.miniStatRow}>
              <View style={styles.miniStat}>
                <Text style={styles.miniStatValue}>
                  {response.state.data.avg_confirm_minutes === null
                    ? '—'
                    : `${Math.round(response.state.data.avg_confirm_minutes)} 分钟`}
                </Text>
                <Text style={styles.miniStatLabel}>平均接单确认时长</Text>
                <Text style={styles.miniStatNote}>
                  {response.state.data.samples.length} 单已确认
                </Text>
              </View>
            </View>
          ) : null}
        </CompactState>
      </GlassCard>

      {/* 近期结算简版（F3 新在前取前 3；完整收入页=M3.5/W3 候选，见计划「不入本批」） */}
      <GlassCard style={styles.card}>
        <SectionHeader title="近期结算" note="场次+1对1 结算净额" />
        <CompactState
          phase={settlements.state.phase}
          error={settlements.state.phase === 'error' ? settlements.state.error : undefined}
          onRetry={settlements.reload}
        >
          {settlements.state.phase === 'ready' ? (
            settlementRows.length === 0 ? (
              <EmptyHint text="暂无结算记录" />
            ) : (
              <View style={styles.settlementList}>
                {settlementRows.map((row) => (
                  <View key={row.id} style={styles.settlementRow}>
                    <View style={styles.settlementTextBlock}>
                      <Text style={styles.settlementTitle}>
                        {settlementRefTypeCopy(row.ref_type)}结算 ·{' '}
                        {settlementStatusCopy(row.status)}
                      </Text>
                      <Text style={styles.settlementNote}>建单 {formatDate(row.created_at)}</Text>
                    </View>
                    <Text style={styles.settlementNet}>{formatMoney(row.net)}</Text>
                  </View>
                ))}
                {settlements.state.data.length > 3 ? (
                  <Text style={styles.settlementMore}>
                    共 {settlements.state.data.length} 笔，完整清单见收入页（后续版本）
                  </Text>
                ) : null}
              </View>
            )
          ) : null}
        </CompactState>
      </GlassCard>

      {/* 快捷入口（T3 起开团/价格配置已落位；接单大厅=tab 切换） */}
      <GlassCard style={styles.card}>
        <SectionHeader title="快捷入口" />
        <View style={styles.quickGrid}>
          <QuickEntry
            label="开团"
            note="C1 七键表单"
            onPress={() => nav.push({ key: 'lawyerCreateSession' })}
          />
          <QuickEntry
            label="时间表"
            note="时段模板"
            onPress={() => nav.push({ key: 'lawyerSchedule' })}
          />
          <QuickEntry
            label="价格配置"
            note="默认+1对1"
            onPress={() => nav.push({ key: 'lawyerPricing' })}
          />
          <QuickEntry label="接单大厅" note="C2B 团" onPress={() => nav.setTab('lawyerHall')} />
        </View>
      </GlassCard>

      {/* 近期场次简列（公开面仅 CREATED——#48-① 同款如实承载+注记） */}
      <SectionHeader title="近期场次" note="报名中（成团后从公开列表消失）" />
      {recentSessions.state.phase === 'loading' ? <LoadingHint /> : null}
      {recentSessions.state.phase === 'error' ? (
        <ErrorPanel error={recentSessions.state.error} onRetry={recentSessions.reload} />
      ) : null}
      {recentSessions.state.phase === 'ready' ? (
        sessionRows.length === 0 ? (
          <EmptyHint text="暂无报名中场次——可从时间表开新团" />
        ) : (
          <View style={styles.sessionList}>
            {sessionRows.map((s) => (
              <SessionCard
                key={s.id}
                session={s}
                onPress={(target) => nav.push({ key: 'sessionDetail', params: { id: target.id } })}
              />
            ))}
          </View>
        )
      ) : null}
    </ScrollView>
  );
}

function QuickEntry({
  label,
  note,
  onPress,
}: {
  readonly label: string;
  readonly note: string;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [styles.quickEntry, pressed && styles.quickPressed]}
    >
      <Text style={styles.quickLabel}>{label}</Text>
      <Text style={styles.quickNote}>{note}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  content: { padding: spacing.lg, gap: spacing.md },
  identRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  seal: {
    width: 40,
    height: 40,
    borderRadius: radius.md,
    backgroundColor: colors.primary2A15,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sealText: { color: colors.primary, fontSize: fontSize.lg, fontWeight: fontWeight.bold },
  identTextBlock: { gap: 2 },
  identTitle: { color: colors.ink, fontSize: fontSize.xl, fontWeight: fontWeight.semibold },
  aiOkBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderRadius: radius.pill,
    backgroundColor: colors.primary2A15,
    paddingHorizontal: spacing.lg,
    paddingVertical: 7,
  },
  aiOkText: { color: colors.primary, fontSize: fontSize.sm, fontWeight: fontWeight.medium },
  /** 状态未知=中性灰档（修复环 I-5）：非绿（非可用）非红（非降级断言）——ink2 灰徽标浅底 */
  aiUnknownBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderRadius: radius.pill,
    backgroundColor: colors.ink2A15,
    paddingHorizontal: spacing.lg,
    paddingVertical: 7,
  },
  aiUnknownText: { color: colors.ink2, fontSize: fontSize.sm, fontWeight: fontWeight.medium },
  aiDegradedBar: {
    borderRadius: radius.md,
    backgroundColor: colors.accentCard,
    borderWidth: 1,
    borderColor: colors.dangerLine,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  aiDegradedText: { color: colors.accentDk, fontSize: fontSize.sm, lineHeight: 18 },
  ratesCard: { padding: spacing.lg, gap: spacing.xs, backgroundColor: colors.accentCard },
  card: { padding: spacing.lg, gap: spacing.xs },
  compactError: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    marginTop: spacing.sm,
  },
  compactErrorText: { color: colors.accentDk, fontSize: fontSize.sm, flexShrink: 1 },
  rateGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.lg,
    marginTop: spacing.sm,
  },
  rateCell: { minWidth: 76, gap: 2 },
  rateValue: { color: colors.ink, fontSize: fontSize.xxxl, fontWeight: fontWeight.bold },
  rateLabel: { color: colors.ink2, fontSize: fontSize.xs },
  rateFootnote: { color: colors.ink2, fontSize: fontSize.xs, marginTop: spacing.xs },
  miniStatRow: { flexDirection: 'row', marginTop: spacing.sm },
  miniStat: { gap: 2 },
  miniStatValue: { color: colors.ink, fontSize: fontSize.xxl, fontWeight: fontWeight.bold },
  miniStatLabel: { color: colors.ink2, fontSize: fontSize.xs },
  miniStatNote: { color: colors.ink2, fontSize: fontSize.xs, opacity: 0.8 },
  divider: { height: 1, backgroundColor: colors.line, marginVertical: spacing.sm },
  settlementList: { gap: spacing.sm, marginTop: spacing.sm },
  settlementRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  settlementTextBlock: { flexShrink: 1, gap: 2 },
  settlementTitle: { color: colors.ink, fontSize: fontSize.base, fontWeight: fontWeight.medium },
  settlementNote: { color: colors.ink2, fontSize: fontSize.xs },
  settlementNet: { color: colors.ink, fontSize: fontSize.lg, fontWeight: fontWeight.semibold },
  settlementMore: { color: colors.ink2, fontSize: fontSize.xs },
  quickGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.sm },
  quickEntry: {
    borderRadius: radius.md,
    backgroundColor: colors.ghostFill,
    borderWidth: 1,
    borderColor: colors.line,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    minWidth: 82,
    alignItems: 'center',
    gap: 2,
  },
  quickPressed: { opacity: 0.75 },
  quickLabel: { color: colors.primary, fontSize: fontSize.base, fontWeight: fontWeight.medium },
  quickNote: { color: colors.ink2, fontSize: fontSize.xs },
  sessionList: { gap: spacing.md },
});
