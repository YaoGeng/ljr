/**
 * 骨架占位视图（M3-W1 T1 建/T4 收编/W2 T1 扩）：占位屏统一形态，无任何假业务数据。
 * 两类消费方：①路由回退占位（未登记推栈键——routeFallback=true 附说明卡）；②律师四 tab
 * 占位屏（M3-W2 T2~T6 逐卡填实，routeFallback=false 只出视图名与填实说明）。
 */
import { ScrollView, StyleSheet } from 'react-native';
import { Button, GlassCard, MutedText, ScreenTitle } from '../components/ui';
import { spacing } from '../design/tokens';
import { useNavigation } from '../navigation/router';

export interface PlaceholderScreenProps {
  readonly title: string;
  readonly note: string;
  /** true=未登记路由回退（附「到达本页=路由键未落位」说明卡）；false=登记在册的施工占位 */
  readonly routeFallback?: boolean;
}

/** 占位屏（tab/推栈施工位与未登记路由回退共用形态） */
export function PlaceholderScreen({ title, note, routeFallback = true }: PlaceholderScreenProps) {
  const nav = useNavigation();
  const stackTop = nav.top !== null;
  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.content}
      accessibilityLabel={`${title}占位页`}
    >
      <GlassCard style={styles.card}>
        <ScreenTitle>{title}</ScreenTitle>
        <MutedText>{note}</MutedText>
        {stackTop ? <Button label="返回" variant="ghost" small onPress={nav.pop} /> : null}
      </GlassCard>
      {routeFallback ? (
        <GlassCard style={styles.card}>
          <MutedText>
            本页为路由回退占位：用户端五 tab 视图与已登记推栈页（T2 首页/场次、T3
            报名支付/实名/授权/发团、T4 消息/我的及其推栈页）均已对接 core 真实
            API；到达本页说明路由键未在映射表落位。
          </MutedText>
        </GlassCard>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  content: { padding: spacing.lg, gap: spacing.lg },
  card: { padding: spacing.xl, gap: spacing.md },
});
