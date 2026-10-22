/**
 * 场次管理（M3-W2 T5，tab 屏替换 T1 占位；对照原型 l-sess）：律师公开场次列表 + 按 ID
 * 直达看板双入口。
 *
 *   ① 列表=GET /sessions?lawyer={me.id}（公开面）——⚠#48-① 同款如实承载：core 公开列表
 *      仅返回 CREATED（报名中）场次，成团（FULL 起）即移出公开列表，无律师全态列表面
 *      （W2-4 决策：缺口登记 triage 不扩面）。屏顶注记如实告知 + 卡片可点进看板；
 *   ② 按 ID 直达=场次号输入 → GET /sessions/{id}（详情任意态可达——看板承载）→
 *      push lawyerBoard；开团成功回执（T3）与接单转化（T4）产生的场次从该口直达；
 *   ③ 列表端点无分页面（§5 查询键仅 specialty/city/lawyer/from/to）——全量渲染，
 *      底部注记如实说明。
 *
 * 卡片信息层级对照原型 l-sess（状态徽标/开场时间/价格模式/人数进度/看板入口）；
 * 金额经 formatMoney 单一出口；状态徽标=session-copy 映射表单源。
 */
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { formatMoney } from '../api/money';
import { fetchSessions, type SessionView } from '../api/sessions';
import { priceModeCopy, roomModeCopy, sessionStatusCopy, specialtyCopy } from '../api/session-copy';
import { useResource } from '../api/useResource';
import { useSession } from '../api/useSession';
import { SessionStatusBadge } from '../components/session-card';
import { EmptyHint, ErrorPanel, LoadingHint, SectionHeader } from '../components/state-views';
import { Button, ErrorText, Field, GlassCard, MutedText } from '../components/ui';
import { colors, fontSize, fontWeight, radius, spacing } from '../design/tokens';
import { useNavigation } from '../navigation/router';
import { formatDateTime } from '../utils/date';

/** 直达输入的本地校验：正整数（core parse-positive-int 镜像） */
function parseDirectId(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

export function LawyerSessionsScreen() {
  const nav = useNavigation();
  const me = useSession().me;
  const [directInput, setDirectInput] = useState('');
  const [directError, setDirectError] = useState<string | null>(null);

  // me 就绪前短路空数组（修复环 I-4：不发必 400 的 lawyer=-1 请求——T2 I-7 先例）；
  // me null 时下方提前 return 登录态缺失卡，列表态不会被消费
  const list = useResource(
    () => (me === null ? Promise.resolve<SessionView[]>([]) : fetchSessions({ lawyer: me.id })),
    [me?.id],
  );

  if (!me) {
    return (
      <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
        <GlassCard style={styles.card}>
          <Text style={styles.missingTitle}>登录态缺失</Text>
          <MutedText>请退出后重新登录再使用场次管理</MutedText>
        </GlassCard>
      </ScrollView>
    );
  }

  function submitDirect(): void {
    const id = parseDirectId(directInput);
    if (id === null) {
      setDirectError('请输入正整数场次号（开团回执或转化回执中的场次 #）');
      return;
    }
    setDirectError(null);
    nav.push({ key: 'lawyerBoard', params: { id } });
  }

  const rows = list.state.phase === 'ready' ? list.state.data : [];

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.content}
      accessibilityLabel="场次管理"
    >
      {/* 屏顶注记：#48-① 公开列表仅 CREATED 的如实承载（W2-4：缺口登记不扩面） */}
      <GlassCard style={styles.noteCard}>
        <Text style={styles.noteTitle}>列表说明 · 报名中场次</Text>
        <MutedText>
          公开列表仅显示「报名中（CREATED）」的场次——成团后场次即从公开列表移出，可从开团
          成功回执、接单转化回执进入，或用下方「按 ID 直达」查看任意状态的场次（看板详情
          任意态可达）。律师全态场次列表接口暂未开放（缺口已登记平台侧）。
        </MutedText>
      </GlassCard>

      {/* 按 ID 直达（#48-① 缺口下的诚实承载：GET /sessions/:id 任意态） */}
      <GlassCard style={styles.card}>
        <Text style={styles.directTitle}>按 ID 直达场次看板</Text>
        <MutedText>输入场次号查看任意状态场次（含已成团/进行中/已结束）的看板</MutedText>
        <View style={styles.directRow}>
          <Field
            accessibilityLabel="场次号输入"
            placeholder="如 43"
            keyboardType="number-pad"
            value={directInput}
            onChangeText={(t) => {
              setDirectInput(t);
              setDirectError(null);
            }}
            onSubmitEditing={submitDirect}
            style={styles.directField}
            invalid={directError !== null}
          />
          <Button label="直达看板" variant="secondary" small onPress={submitDirect} />
        </View>
        <ErrorText>{directError ?? ''}</ErrorText>
      </GlassCard>

      <SectionHeader
        title="我的场次 · 报名中"
        note={`公开面按律师过滤（lawyer=${me.id}）；全量返回无分页`}
        actionLabel="刷新"
        onAction={list.reload}
      />
      {list.state.phase === 'loading' ? <LoadingHint label="场次列表加载中…" /> : null}
      {list.state.phase === 'error' ? (
        <ErrorPanel error={list.state.error} onRetry={list.reload} />
      ) : null}
      {list.state.phase === 'ready' ? (
        rows.length === 0 ? (
          <EmptyHint text="暂无报名中的场次——从时间表开新团后，场次将出现在这里；成团场次请按 ID 直达" />
        ) : (
          <View style={styles.list}>
            {rows.map((s) => (
              <SessionRow key={s.id} session={s} />
            ))}
          </View>
        )
      ) : null}

      <MutedText>
        列表为公开报名面（仅报名中态）；报名截止未满员将流标并全额自动退款。场次内的出席/
        公告/消息聚合见场次看板。
      </MutedText>
    </ScrollView>
  );
}

/** 列表卡（原型 l-sess 行对照：徽标+时间+价格模式+人数进度+看板入口；整卡可点） */
function SessionRow({ session: s }: { readonly session: SessionView }) {
  const nav = useNavigation();
  function openBoard(): void {
    nav.push({ key: 'lawyerBoard', params: { id: s.id } });
  }
  const pct = Math.min(100, (s.joined / s.capacity) * 100);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`场次 ${formatDateTime(s.slot_start)} ${sessionStatusCopy(s.status).label}，打开看板`}
      onPress={openBoard}
      style={({ pressed }) => [styles.cardPress, pressed && styles.cardPressed]}
    >
      <GlassCard style={styles.card}>
        <View style={styles.tagRow}>
          <View style={styles.tagGroup}>
            <Text style={styles.tagPrimary}>{specialtyCopy(s.specialty)}</Text>
            <Text style={styles.tag}>{s.city}</Text>
            <Text style={styles.tag}>{roomModeCopy(s.room_mode)}</Text>
          </View>
          <SessionStatusBadge status={s.status} />
        </View>
        <Text style={styles.headline}>{formatDateTime(s.slot_start)} 开场</Text>
        <Text style={styles.meta}>
          {`场次 #${s.id} · ${priceModeCopy(s.price_mode)} ${
            s.price_mode === 'per_head'
              ? `${formatMoney(s.unit_price)}/人`
              : `总价 ${formatMoney(s.session_total)}`
          } · 报名截止 ${formatDateTime(s.enroll_deadline, { weekday: false })}`}
        </Text>
        <View style={styles.progressTextRow}>
          <Text style={styles.progressText}>
            已报 {s.joined}/{s.capacity} 人 · 还差 {Math.max(0, s.capacity - s.joined)} 人成团
          </Text>
        </View>
        <View style={styles.progressTrack}>
          <View style={[styles.progressFill, { width: `${pct}%` }]} />
        </View>
        <Button label="场次看板 / 报名进度" variant="secondary" small onPress={openBoard} />
      </GlassCard>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  content: { padding: spacing.lg, gap: spacing.sm },
  list: { gap: spacing.md },
  noteCard: { padding: spacing.lg, gap: spacing.xs },
  noteTitle: { color: colors.ink, fontSize: fontSize.base, fontWeight: fontWeight.semibold },
  card: { padding: spacing.lg, gap: spacing.sm },
  missingTitle: { color: colors.ink, fontSize: fontSize.xl, fontWeight: fontWeight.semibold },
  directTitle: { color: colors.ink, fontSize: fontSize.base, fontWeight: fontWeight.semibold },
  directRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  directField: { flex: 1 },
  cardPress: { borderRadius: radius.card },
  cardPressed: { opacity: 0.88, transform: [{ scale: 0.99 }] },
  tagRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  tagGroup: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexShrink: 1 },
  tagPrimary: { color: colors.primary, fontSize: fontSize.sm, fontWeight: fontWeight.semibold },
  tag: { color: colors.ink2, fontSize: fontSize.sm },
  headline: { color: colors.ink, fontSize: fontSize.lg, fontWeight: fontWeight.semibold },
  meta: { color: colors.ink2, fontSize: fontSize.sm },
  progressTextRow: { flexDirection: 'row', justifyContent: 'space-between' },
  progressText: { color: colors.ink2, fontSize: fontSize.xs },
  progressTrack: {
    height: 6,
    borderRadius: radius.pill,
    backgroundColor: colors.ink2A18,
    overflow: 'hidden',
  },
  progressFill: { height: 6, borderRadius: radius.pill, backgroundColor: colors.primary2 },
});
