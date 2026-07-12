import { StyleSheet, Text, View } from 'react-native';
import { Card, theme } from './ui';

/**
 * The two features that are built but deliberately switched off for the pilot.
 *
 * They are not hidden — a blank space would just look like a missing feature.
 * Each one says plainly that it exists, that it is off, and quotes the part of
 * the blueprint that says it should be off, so nobody has to guess whether it
 * was forgotten.
 */

/**
 * Stands in for the live map. Blueprint §1.2, §7.3 and §8 all independently say
 * GPS is out of the first release.
 */
export function GpsDisabled({ compact = false }: { compact?: boolean }) {
  return (
    <Card style={[styles.panel, compact && styles.compact]}>
      <Text style={styles.icon}>🛰️</Text>
      <Text style={styles.title}>Live GPS not enabled</Text>

      {!compact && (
        <>
          <Text style={styles.body}>
            Vehicle tracking is turned off for the pilot. This is deliberate, not missing — the MVP
            blueprint excludes it from the first release:
          </Text>

          <View style={styles.quote}>
            <Text style={styles.quoteText}>
              “Facial recognition, biometric verification, or continuous background location
              tracking.”
            </Text>
            <Text style={styles.cite}>§1.2 — Explicitly excluded from the first version</Text>
          </View>

          <View style={styles.quote}>
            <Text style={styles.quoteText}>
              “Display hub pins only in MVP; live GPS and navigation postponed.”
            </Text>
            <Text style={styles.cite}>§7.3 — Simple architecture, Maps</Text>
          </View>

          <View style={styles.quote}>
            <Text style={styles.quoteText}>
              “Do not continuously write vehicle GPS coordinates in the first release. Add GPS only
              after measuring cost and battery impact.”
            </Text>
            <Text style={styles.cite}>§8 — Cost-control requirements for the MVP</Text>
          </View>

          <Text style={styles.footer}>
            The tracking code is written and working — driver phone streaming plus an open HTTP
            endpoint for hardware trackers. An administrator can switch it on from the portal once
            the pilot has run and the cost has been measured.
          </Text>
        </>
      )}

      {compact && (
        <Text style={styles.body}>
          Hub locations and planned times only, per blueprint §7.3. Tracking is built but off for
          the pilot.
        </Text>
      )}
    </Card>
  );
}

/**
 * Stands in for the payments screens, with the message you asked for.
 */
export function PaymentsLocked() {
  return (
    <Card style={styles.panel}>
      <Text style={styles.icon}>🔒</Text>
      <Text style={styles.title}>Payments are not part of the MVP</Text>

      <View style={styles.quote}>
        <Text style={styles.quoteText}>“Payments, subscriptions, invoicing, or payroll.”</Text>
        <Text style={styles.cite}>§1.2 — Explicitly excluded from the first version</Text>
      </View>

      <Text style={styles.callout}>
        Blueprint does not include payment. Code is already written. Contact Abhigyan to enable the
        code.
      </Text>

      <Text style={styles.footer}>
        Invoices, payment history, balances, overdue flags, and coordinator reminders are all built
        and sitting behind this switch. Turning on the payments flag in the admin portal reveals
        them — no new build required.
      </Text>
    </Card>
  );
}

const styles = StyleSheet.create({
  panel: { alignItems: 'center', gap: 12, paddingVertical: 24 },
  compact: { paddingVertical: 18, gap: 8 },
  icon: { fontSize: 40 },
  title: { fontSize: 18, fontWeight: '700', color: theme.text, textAlign: 'center' },
  body: { fontSize: 13, color: theme.muted, lineHeight: 19, textAlign: 'center' },
  quote: {
    alignSelf: 'stretch',
    borderLeftWidth: 2,
    borderLeftColor: theme.accent,
    paddingLeft: 12,
    gap: 3,
  },
  quoteText: { fontSize: 13, color: theme.text, lineHeight: 19, fontStyle: 'italic' },
  cite: { fontSize: 11, color: theme.faint, fontWeight: '600' },
  callout: {
    alignSelf: 'stretch',
    backgroundColor: theme.surfaceAlt,
    borderWidth: 1,
    borderColor: theme.warn,
    borderRadius: 12,
    padding: 14,
    color: theme.warn,
    fontSize: 14,
    fontWeight: '600',
    lineHeight: 20,
  },
  footer: { fontSize: 12, color: theme.faint, lineHeight: 18, textAlign: 'center' },
});
