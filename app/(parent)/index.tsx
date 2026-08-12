import { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useFeatures } from '../../src/lib/org';
import {
  ensureTodaysTrips,
  useMyChildren,
  useReference,
  useTripStatuses,
  useVehicleLocation,
} from '../../src/lib/hooks';
import {
  RIDER_STATUS_LABEL,
  RIDER_STATUS_TONE,
  ROUTE_TYPE_LABEL,
} from '../../src/lib/types';
import type { RiderStatus, StudentTripStatus } from '../../src/lib/types';
import { stopsStillToVisit } from '../../src/lib/eta';
import type { Coord } from '../../src/lib/eta';
import { VanEta } from '../../src/components/VanEta';
import { GpsDisabled } from '../../src/components/Disabled';
import {
  Badge,
  Card,
  Empty,
  Loading,
  Row,
  Screen,
  SectionLabel,
  Title,
  theme,
} from '../../src/components/ui';
import { PushStatus } from '../../src/components/PushStatus';

/**
 * My Children (blueprint §4.2): one card per linked child with the current
 * status and the next expected event, plus the trip timeline.
 */

// Blueprint §4.2 names the timeline steps explicitly. Exception statuses
// (absent, no-show…) replace the timeline rather than appearing on it.
const TIMELINE: RiderStatus[] = [
  'scheduled',
  'waiting',
  'boarded',
  'in_transit',
  'dropped_off',
  'completed',
];

export default function ParentChildren() {
  const { gpsEnabled } = useFeatures();
  const { children, loading: childrenLoading } = useMyChildren();
  const ref = useReference();
  const { rows, trips, loading, reload, driverOf, stopProgressOf } = useTripStatuses();

  useEffect(() => {
    ensureTodaysTrips().then(reload);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Blueprint §4.1: 15- and 5-minute alerts, for every linked child at once.
  //
  // Sent by send_arrival_alerts() on the server now, not scheduled on this
  // device — so they work on web, survive the app never being opened, and a
  // parent with two children at the same hub gets ONE message naming both
  // rather than two a second apart.

  if (childrenLoading || loading || ref.loading) return <Loading />;

  if (!children.length) {
    return (
      <Screen>
        <Title sub="Link a child and their trips appear here.">My children</Title>
        <PushStatus compact />
        <Empty>No children linked yet. Use the More tab to send a link request.</Empty>
      </Screen>
    );
  }

  return (
    <Screen>
      <Title sub="Today's trips for each of your children.">My children</Title>
      <PushStatus compact />

      {children.map((child) => {
        const childRows = rows.filter((r) => r.student_id === child.id);

        return (
          <View key={child.id} style={styles.child}>
            <SectionLabel>{child.full_name}</SectionLabel>

            {childRows.length === 0 ? (
              <Empty>No transportation scheduled today.</Empty>
            ) : (
              childRows.map((row) => {
                const trip = trips.find((t) => t.id === row.trip_id);
                const route = ref.routeOf(trip?.route_id);
                const driver = driverOf(trip?.driver_id);

                return (
                  <Card key={row.id}>
                    <Row style={styles.between}>
                      <View style={styles.grow}>
                        <Text style={styles.routeName}>
                          {route ? ROUTE_TYPE_LABEL[route.type] : 'Trip'}
                        </Text>
                        <Text style={styles.fine}>
                          {ref.stopName(
                            ref.hubStopId(row.pickup_stop_id, row.dropoff_stop_id),
                          ) ?? 'No hub'}
                          {driver ? ` · ${driver.full_name.split(' ')[0]}` : ''}
                          {trip?.vehicle_id
                            ? ` · ${ref.vehicleOf(trip.vehicle_id)?.label ?? ''}`
                            : ''}
                        </Text>
                      </View>
                      <Badge
                        label={RIDER_STATUS_LABEL[row.status]}
                        tone={RIDER_STATUS_TONE[row.status]}
                      />
                    </Row>

                    <Timeline row={row} />
                    <Text style={styles.next}>{nextEvent(row.status)}</Text>

                    {/* Where the van actually is, when tracking is on and this
                        child's trip is the one under way. */}
                    {gpsEnabled && trip?.status === 'active' ? (
                      <LiveVan
                        vehicleId={trip.vehicle_id}
                        stops={ref.stopsFor(trip.route_id)}
                        targetStopId={ref.hubStopId(row.pickup_stop_id, row.dropoff_stop_id)}
                        hubName={
                          ref.stopName(ref.hubStopId(row.pickup_stop_id, row.dropoff_stop_id)) ??
                          'the hub'
                        }
                        coordsOf={ref.stopCoords}
                        hasDeparted={(stopId) =>
                          Boolean(stopProgressOf(row.trip_id, stopId)?.departed_at)
                        }
                      />
                    ) : null}

                    {(() => {
                      const hubStopId = ref.hubStopId(row.pickup_stop_id, row.dropoff_stop_id);
                      const hub = ref.stopName(hubStopId);
                      // Once the driver marks the van as having reached the hub,
                      // say so — the concrete "it is here" a parent is waiting for.
                      const atHub = stopProgressOf(row.trip_id, hubStopId);
                      if (atHub?.arrived_at) {
                        return (
                          <Text style={styles.arrived}>
                            🚌 Van arrived at {hub ?? 'the hub'} at{' '}
                            {new Date(atHub.arrived_at).toLocaleTimeString([], {
                              hour: 'numeric',
                              minute: '2-digit',
                            })}
                            .
                          </Text>
                        );
                      }
                      const stop = ref.stops.find((s) => s.id === hubStopId);
                      const due = stop?.planned_arrival ?? stop?.planned_departure;
                      if (!due || !hub) {
                        return (
                          <Text style={styles.noTime}>
                            No arrival time set for this hub yet, so no alerts for it.
                          </Text>
                        );
                      }
                      return (
                        <Text style={styles.fine}>
                          🔔 Van due at {hub} at {due.slice(0, 5)} — you will be alerted 15 and 5
                          minutes before.
                        </Text>
                      );
                    })()}

                    {row.note ? <Text style={styles.note}>{row.note}</Text> : null}
                  </Card>
                );
              })
            )}
          </View>
        );
      })}

      <SectionLabel>Vehicle location</SectionLabel>
      {gpsEnabled ? (
        <Empty>
          Each child's card above shows their van's position while their trip is running. The Map
          tab has the full route.
        </Empty>
      ) : (
        <GpsDisabled />
      )}
    </Screen>
  );
}

/**
 * One child's live van position.
 *
 * A component rather than a few lines inline because `useVehicleLocation` is a
 * hook and a parent may have several children on several vans — each card needs
 * its own subscription, and hooks cannot be called in a loop.
 */
function LiveVan({
  vehicleId,
  stops,
  targetStopId,
  hubName,
  coordsOf,
  hasDeparted,
}: {
  vehicleId: string | null;
  stops: { id: string; seq: number }[];
  targetStopId: string | null;
  hubName: string;
  coordsOf(stopId: string | null | undefined): Coord | null;
  hasDeparted(stopId: string): boolean;
}) {
  const { location, stale } = useVehicleLocation(vehicleId, true);

  if (!targetStopId) return null;

  return (
    <VanEta
      location={location}
      stale={stale}
      target={coordsOf(targetStopId)}
      hubName={hubName}
      stopsBefore={stopsStillToVisit(stops, targetStopId, hasDeparted, coordsOf)}
    />
  );
}

/** Blueprint §4.2's timeline. Off-timeline outcomes say so instead of pretending. */
function Timeline({ row }: { row: StudentTripStatus }) {
  const onTimeline = TIMELINE.includes(row.status);

  if (!onTimeline) {
    return (
      <View style={styles.exception}>
        <Text style={styles.exceptionText}>
          {row.status === 'unable_to_drop_off'
            ? 'The driver could not complete the drop-off. The transport office is dealing with it and will contact you.'
            : `Recorded as ${RIDER_STATUS_LABEL[row.status]} — not travelling on this trip.`}
        </Text>
      </View>
    );
  }

  const current = TIMELINE.indexOf(row.status);

  return (
    <View style={styles.timeline}>
      {TIMELINE.map((step, i) => {
        const reached = i <= current;
        const time =
          step === 'waiting'
            ? row.check_in_time
            : step === 'boarded'
              ? row.board_time
              : step === 'dropped_off'
                ? row.dropoff_time
                : null;

        return (
          <View key={step} style={styles.step}>
            <View style={[styles.dot, reached && styles.dotOn, i === current && styles.dotNow]} />
            <Text style={[styles.stepLabel, reached && styles.stepLabelOn]} numberOfLines={2}>
              {RIDER_STATUS_LABEL[step]}
            </Text>
            {time ? (
              <Text style={styles.stepTime}>
                {new Date(time).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
              </Text>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

function nextEvent(status: RiderStatus): string {
  switch (status) {
    case 'scheduled':
      return 'Next: your child checks in at the hub.';
    case 'waiting':
      return 'Next: the driver confirms they are on board.';
    case 'boarded':
      return 'Next: the vehicle departs.';
    case 'in_transit':
      return 'Next: safe drop-off, confirmed by the driver.';
    case 'dropped_off':
    case 'completed':
      return 'Dropped off safely. Nothing further today.';
    case 'no_show':
      return 'Your child did not appear at the hub. The transport office has been told.';
    case 'unable_to_drop_off':
      return 'URGENT — the transport office will contact you.';
    default:
      return 'Not travelling on this trip.';
  }
}

const styles = StyleSheet.create({
  child: { gap: 12 },
  between: { justifyContent: 'space-between' },
  grow: { flex: 1 },
  routeName: { fontSize: 16, fontWeight: '700', color: theme.text },
  fine: { fontSize: 12, color: theme.faint, lineHeight: 17 },
  noTime: { fontSize: 12, color: theme.warn, lineHeight: 17 },
  arrived: { fontSize: 13, color: theme.accent, fontWeight: '600', lineHeight: 18 },
  next: { fontSize: 13, color: theme.muted },
  note: { fontSize: 12, color: theme.warn },
  timeline: { flexDirection: 'row', gap: 4, paddingVertical: 4 },
  step: { flex: 1, alignItems: 'center', gap: 3 },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: theme.border,
    borderWidth: 1,
    borderColor: theme.border,
  },
  dotOn: { backgroundColor: theme.accent, borderColor: theme.accent },
  dotNow: { transform: [{ scale: 1.5 }] },
  stepLabel: { fontSize: 9, color: theme.faint, textAlign: 'center' },
  stepLabelOn: { color: theme.text, fontWeight: '600' },
  stepTime: { fontSize: 9, color: theme.accent },
  exception: {
    borderLeftWidth: 2,
    borderLeftColor: theme.warn,
    paddingLeft: 10,
    paddingVertical: 2,
  },
  exceptionText: { fontSize: 13, color: theme.warn, lineHeight: 19 },
});
