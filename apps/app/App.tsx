import { StyleSheet, Text, View } from 'react-native';
import { APP_NAME } from './src/app-info';

export default function App() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>{APP_NAME}</Text>
      <Text style={styles.subtitle}>劳动仲裁 · 法律服务平台（骨架占位 M0-2）</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#ffffff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    fontSize: 24,
    fontWeight: '600',
  },
  subtitle: {
    marginTop: 8,
    fontSize: 14,
    color: '#666666',
  },
});
