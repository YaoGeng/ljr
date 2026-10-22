/**
 * App 根（M3-W1 T1 重写）：启动 → 无 token 进登录页 → 验证码登录成功（session 内存态）
 * → 五 tab 壳。token 持久化后置（W1-5：AsyncStorage 落地可后置，E2E 每用例现登）。
 */
import { StyleSheet, View } from 'react-native';
import { useSession } from './src/api/useSession';
import { colors } from './src/design/tokens';
import { AppShell } from './src/screens/AppShell';
import { LoginScreen } from './src/screens/LoginScreen';

export default function App() {
  return (
    <View style={styles.root}>
      <RootGate />
    </View>
  );
}

/** 会话闸：authenticated → 五 tab 壳；否则登录页（登录成功后 session 翻转自动切壳） */
function RootGate() {
  const session = useSession();
  if (session.status === 'authenticated') {
    return <AppShell />;
  }
  return <LoginScreen />;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
});
