import { Text } from 'react-native';

/**
 * Emoji tab icons. Deliberately not a vector-icon dependency: the app needs
 * exactly a dozen glyphs, and this avoids shipping an icon font and its
 * loading state for that.
 */
export function TabIcon({ glyph, focused }: { glyph: string; focused: boolean }) {
  return <Text style={{ fontSize: 22, opacity: focused ? 1 : 0.45 }}>{glyph}</Text>;
}
