/**
 * 骨架占位视图（M3-W1 T1 建/T4 收编）：未登记推栈键的统一回退占位（T4 后五 tab 已全落位，
 * 无 tab 占位消费方；仅未登记路由回退复用本形态），无任何假业务数据。
 */
import { ScrollView, StyleSheet } from 'react-native';
import { Button, GlassCard, MutedText, ScreenTitle } from '../components/ui';
import { spacing } from '../design/tokens';
import { useNavigation } from '../navigation/router';

/** 未登记路由回退占位（T4 后无 tab 消费方；防散建第二张路由表的兜底形态） */
export function PlaceholderScreen({ title, note }: { title: string; note: string }) {
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
      <GlassCard style={styles.card}>
        <MutedText>
          本页为路由回退占位：五 tab 视图与已登记推栈页（T2 首页/场次、T3 报名支付/实名/授权/发团、
          T4 消息/我的及其推栈页）均已对接 core 真实 API；到达本页说明路由键未在映射表落位。
        </MutedText>
      </GlassCard>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  content: { padding: spacing.lg, gap: spacing.lg },
  card: { padding: spacing.xl, gap: spacing.md },
});
