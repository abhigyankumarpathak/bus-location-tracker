import type { PropsWithChildren, ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { StyleProp, TextInputProps, ViewStyle } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

export const theme = {
  bg: '#0B1220',
  surface: '#131D33',
  surfaceAlt: '#1B2942',
  border: '#24334F',
  text: '#F1F5F9',
  muted: '#94A3B8',
  faint: '#64748B',
  accent: '#38BDF8',
  accentText: '#0B1220',
  success: '#34D399',
  warn: '#FBBF24',
  danger: '#F87171',
  bus: '#F97316',
};

export function Screen({
  children,
  scroll = true,
  edges,
}: PropsWithChildren<{ scroll?: boolean; edges?: ('top' | 'bottom')[] }>) {
  // The same screens run on a phone and in a browser (blueprint §7.3 wants the
  // coordinator working at a desk). Without a max width, a laptop stretches
  // every card to 1400px and the whole thing becomes unreadable.
  const content = scroll ? (
    <ScrollView
      contentContainerStyle={[styles.scrollContent, styles.centered]}
      keyboardShouldPersistTaps="handled"
    >
      <View style={styles.column}>{children}</View>
    </ScrollView>
  ) : (
    <View style={styles.flex}>{children}</View>
  );

  return (
    <SafeAreaView style={styles.screen} edges={edges ?? ['top']}>
      {content}
    </SafeAreaView>
  );
}

export function Title({ children, sub }: { children: ReactNode; sub?: string }) {
  return (
    <View style={styles.titleBlock}>
      <Text style={styles.title}>{children}</Text>
      {sub ? <Text style={styles.subtitle}>{sub}</Text> : null}
    </View>
  );
}

export function SectionLabel({ children }: PropsWithChildren) {
  return <Text style={styles.sectionLabel}>{children}</Text>;
}

export function Card({
  children,
  style,
}: PropsWithChildren<{ style?: StyleProp<ViewStyle> }>) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function Button({
  label,
  onPress,
  variant = 'primary',
  disabled,
  loading,
  style,
}: {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  disabled?: boolean;
  loading?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const isDisabled = disabled || loading;
  return (
    <Pressable
      accessibilityRole="button"
      disabled={isDisabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        variant === 'primary' && styles.buttonPrimary,
        variant === 'secondary' && styles.buttonSecondary,
        variant === 'danger' && styles.buttonDanger,
        variant === 'ghost' && styles.buttonGhost,
        pressed && !isDisabled && styles.buttonPressed,
        isDisabled && styles.buttonDisabled,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={variant === 'primary' ? theme.accentText : theme.text} />
      ) : (
        <Text
          style={[
            styles.buttonText,
            variant === 'primary' && styles.buttonTextPrimary,
            variant === 'danger' && styles.buttonTextDanger,
            variant === 'ghost' && styles.buttonTextGhost,
          ]}
        >
          {label}
        </Text>
      )}
    </Pressable>
  );
}

export function Field({
  label,
  ...props
}: TextInputProps & { label: string }) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        placeholderTextColor={theme.faint}
        style={styles.input}
        {...props}
      />
    </View>
  );
}

export function Badge({
  label,
  tone = 'neutral',
}: {
  label: string;
  tone?: 'neutral' | 'success' | 'warn' | 'danger' | 'accent';
}) {
  const tones = {
    neutral: theme.faint,
    success: theme.success,
    warn: theme.warn,
    danger: theme.danger,
    accent: theme.accent,
  };
  return (
    <View style={[styles.badge, { borderColor: tones[tone] }]}>
      <Text style={[styles.badgeText, { color: tones[tone] }]}>{label}</Text>
    </View>
  );
}

export function Row({
  children,
  style,
}: PropsWithChildren<{ style?: StyleProp<ViewStyle> }>) {
  return <View style={[styles.row, style]}>{children}</View>;
}

export function Empty({ children }: PropsWithChildren) {
  return (
    <Card>
      <Text style={styles.empty}>{children}</Text>
    </Card>
  );
}

export function ErrorText({ children }: PropsWithChildren) {
  if (!children) return null;
  return <Text style={styles.error}>{children}</Text>;
}

export function Loading() {
  return (
    <View style={styles.loading}>
      <ActivityIndicator color={theme.accent} size="large" />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  screen: { flex: 1, backgroundColor: theme.bg },
  scrollContent: { padding: 20, paddingBottom: 48 },
  centered: { alignItems: 'center' },
  // Caps the reading width on a laptop while staying full-bleed on a phone.
  column: { width: '100%', maxWidth: 820, gap: 14 },
  titleBlock: { gap: 4, marginBottom: 4 },
  title: { fontSize: 28, fontWeight: '700', color: theme.text },
  subtitle: { fontSize: 15, color: theme.muted },
  sectionLabel: {
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    color: theme.faint,
    marginTop: 10,
  },
  card: {
    backgroundColor: theme.surface,
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: theme.border,
    gap: 10,
  },
  button: {
    paddingVertical: 15,
    paddingHorizontal: 20,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'transparent',
  },
  buttonPrimary: { backgroundColor: theme.accent },
  buttonSecondary: { backgroundColor: theme.surfaceAlt, borderColor: theme.border },
  buttonDanger: { backgroundColor: 'transparent', borderColor: theme.danger },
  buttonGhost: { backgroundColor: 'transparent' },
  buttonPressed: { opacity: 0.72 },
  buttonDisabled: { opacity: 0.45 },
  buttonText: { fontSize: 16, fontWeight: '600', color: theme.text },
  buttonTextPrimary: { color: theme.accentText },
  buttonTextDanger: { color: theme.danger },
  buttonTextGhost: { color: theme.accent },
  field: { gap: 6 },
  fieldLabel: { fontSize: 13, fontWeight: '600', color: theme.muted },
  input: {
    backgroundColor: theme.surfaceAlt,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 13,
    fontSize: 16,
    color: theme.text,
  },
  badge: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 3,
    alignSelf: 'flex-start',
  },
  badgeText: { fontSize: 12, fontWeight: '700' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  empty: { color: theme.faint, fontSize: 14, textAlign: 'center', paddingVertical: 6 },
  error: { color: theme.danger, fontSize: 14 },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.bg },
});
