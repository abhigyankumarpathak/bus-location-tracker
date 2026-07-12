import { StatusBar } from 'expo-status-bar';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

export default function App() {
  const [taps, setTaps] = useState(0);

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.container}>
        <View style={styles.content}>
          <Text style={styles.emoji}>🚌</Text>
          <Text style={styles.title}>Hello, world!</Text>
          <Text style={styles.subtitle}>Bus Tracker is up and running.</Text>

          <Pressable
            style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
            onPress={() => setTaps((n) => n + 1)}
          >
            <Text style={styles.buttonText}>
              {taps === 0 ? 'Tap me' : `Tapped ${taps}×`}
            </Text>
          </Pressable>

          <Text style={styles.hint}>Edit App.tsx and save — it reloads instantly.</Text>
        </View>
        <StatusBar style="auto" />
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0B1220',
  },
  content: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    gap: 12,
  },
  emoji: {
    fontSize: 72,
  },
  title: {
    fontSize: 32,
    fontWeight: '700',
    color: '#FFFFFF',
  },
  subtitle: {
    fontSize: 16,
    color: '#94A3B8',
  },
  button: {
    marginTop: 20,
    paddingVertical: 14,
    paddingHorizontal: 28,
    borderRadius: 999,
    backgroundColor: '#38BDF8',
  },
  buttonPressed: {
    opacity: 0.7,
  },
  buttonText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#0B1220',
  },
  hint: {
    marginTop: 28,
    fontSize: 13,
    color: '#64748B',
  },
});
