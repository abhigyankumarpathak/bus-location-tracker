export type Role = 'student' | 'parent' | 'driver' | 'coordinator' | 'admin';
export type AccountStatus = 'pending' | 'active' | 'suspended';
export type RouteType = 'morning' | 'afternoon' | 'club' | 'emergency';
export type TripStatus = 'scheduled' | 'active' | 'completed' | 'cancelled';

/**
 * Blueprint §2.2. The critical distinction: `waiting` is the most a STUDENT can
 * ever set — it means "I am at the hub", not "I am on the bus". Only a driver
 * sets `boarded` and `dropped_off`, and that is the official record.
 */
export type RiderStatus =
  | 'scheduled'
  | 'waiting'
  | 'boarded'
  | 'in_transit'
  | 'dropped_off'
  | 'completed'
  | 'absent'
  | 'parent_pickup'
  | 'no_show'
  | 'unable_to_drop_off';

export type ChangeKind =
  | 'absent'
  | 'parent_pickup'
  | 'club_attending'
  | 'club_cancelled'
  | 'not_attending';

export type ApprovalStatus = 'auto_approved' | 'pending' | 'approved' | 'rejected';
export type IncidentKind = 'delay' | 'breakdown' | 'accident' | 'behaviour' | 'other';
export type IncidentSeverity = 'low' | 'medium' | 'high';

export interface Organization {
  id: number;
  name: string;
  logo_url: string | null;
  /** Blueprint §1.2 / §8: live GPS is excluded from the first release. */
  gps_enabled: boolean;
  /** Blueprint §1.2: payments are excluded from the first release. */
  payments_enabled: boolean;
  morning_cutoff: string;
  afternoon_cutoff: string;
  checkin_window_min: number;
  /**
   * How riders are marked on board. 'manual' (the driver taps each student) is
   * the only mode built; 'scan' (NFC/QR self check-in) is reserved for later.
   */
  attendance_mode: 'manual' | 'scan';

  /**
   * ATTENDANCE-ONLY MODE. Hides routes, trips, vehicles, check-in and the
   * driver entirely, and shows a register instead: a student scans one printed
   * code and is marked present for the evening.
   *
   * A toggle. Nothing is destroyed by turning it on — every route, trip and
   * rider row stays exactly where it was and is simply not rendered.
   */
  attendance_only: boolean;
  /** "This is only for evenings." Wall clock, in `time_zone`. */
  attendance_opens_at: string;
  /**
   * Weeks of full operational detail to keep. Older routine data is purged once
   * it has been archived into a weekly report and sent to the family. Incidents
   * and overrides are kept regardless of this setting.
   */
  retention_weeks: number;

  /**
   * The watchdog — the one thing that watches the clock instead of waiting for a
   * driver to tap something. Thresholds live in the database because the right
   * number is an operational question: a rural route with a 40-minute gap
   * between hubs needs different patience from a town run.
   */
  watchdog_enabled: boolean;
  /** Trip still `scheduled` this long after the first stop's planned departure. */
  watchdog_trip_start_min: number;
  /** A stop with riders on it, unreached this long after its planned arrival. */
  watchdog_stop_arrival_min: number;
  /** A student sat on `waiting` — "I am at the hub" — for this long. */
  watchdog_waiting_min: number;
  /** A trip `active` longer than any real route takes. */
  watchdog_trip_max_min: number;
  /** A rider still on board this long after the van reached its final stop. */
  watchdog_onboard_min: number;

  /**
   * How long a driver has to take back a mistap. This is a phone held one-handed
   * in a moving vehicle by someone also responsible for children — mistaps are
   * not an edge case.
   */
  undo_window_sec: number;

  /**
   * The timezone the VANS run in — a region name like 'America/New_York', not
   * an abbreviation like 'EST' (which is a fixed -05:00 and wrong all summer).
   *
   * `planned_arrival` and `planned_departure` are wall-clock times with no zone
   * attached. Everything that compares against them resolves through this: the
   * watchdog, the arrival alerts, the change cutoff and the check-in window.
   * Wrong here means all four are wrong by the same number of hours.
   */
  time_zone: string;
}

/** The five things the watchdog can notice. Mirrors the `watchdog_kind` enum. */
export type WatchdogKind =
  | 'trip_not_started'
  | 'stop_not_reached'
  | 'rider_waiting'
  | 'trip_overrunning'
  | 'rider_still_onboard'
  | 'urgent_unacknowledged';

/**
 * Something the watchdog noticed that nobody has said is fine yet.
 *
 * Raised at most once per (kind, trip, stop, student) — pg_cron runs every five
 * minutes and a stop twenty minutes late is still late on the next pass. It
 * clears itself when the underlying condition goes away.
 */
export interface WatchdogAlert {
  id: string;
  trip_id: string | null;
  stop_id: string | null;
  student_id: string | null;
  /** Set only for `urgent_unacknowledged` — the message nobody answered. */
  notification_id: string | null;
  kind: WatchdogKind;
  detail: string;
  raised_at: string;
  notified_at: string | null;
  resolved_at: string | null;
  resolved_by: string | null;
  resolution: string | null;
}

export const WATCHDOG_LABEL: Record<WatchdogKind, string> = {
  trip_not_started: 'Route not started',
  stop_not_reached: 'Van overdue at a stop',
  rider_waiting: 'Student still waiting',
  trip_overrunning: 'Trip never ended',
  rider_still_onboard: 'Student still on board',
  urgent_unacknowledged: 'Urgent message unanswered',
};

export interface Profile {
  id: string;
  role: Role;
  full_name: string;
  email: string | null;
  phone: string | null;
  status: AccountStatus;
  created_at: string;
}

/**
 * An invite is how an account comes into existence, and how it gets its role
 * (blueprint §6.1). The person redeeming it has no say in either.
 */
export interface Invite {
  id: string;
  code: string;
  role: Role;
  full_name: string;
  /** If set, only this address may redeem the code. */
  email: string | null;
  note: string | null;
  created_by: string | null;
  created_at: string;
  expires_at: string;
  used_by: string | null;
  used_at: string | null;
  revoked_at: string | null;
}

export interface School {
  id: string;
  name: string;
  address: string | null;
  lat: number | null;
  lng: number | null;
}

export interface Hub {
  id: string;
  name: string;
  address: string | null;
  lat: number;
  lng: number;
  active: boolean;
}

export interface Student {
  student_id: string;
  school_id: string | null;
  grade: string | null;
  morning_hub_id: string | null;
  afternoon_hub_id: string | null;
  /** Cannot self-scan. Somebody else has to account for them. */
  has_phone: boolean;
  /** Confirms the phone-less riders dealt to them. */
  is_monitor: boolean;
}

/** One rider a monitor has to account for this evening. */
export interface MonitorRosterRow {
  student_id: string;
  student_name: string;
  present: boolean;
  marked_at: string | null;
  source: AttendanceSource | null;
}

/** Staff view of who can scan and who answers for whom. */
export interface RollRow {
  student_id: string;
  full_name: string;
  has_phone: boolean;
  is_monitor: boolean;
  /** The monitor this rider is dealt to, or null. */
  answers_to: string | null;
}

/**
 * How a mark got there. Three different strengths of claim, deliberately never
 * merged: the student scanned, the office said so, or another student did.
 */
export type AttendanceSource = 'scan' | 'staff' | 'monitor';

export const SOURCE_LABEL: Record<AttendanceSource, string> = {
  scan: 'Scanned',
  staff: 'Marked by the office',
  monitor: 'Confirmed by a bus monitor',
};

export interface Vehicle {
  id: string;
  label: string;
  plate: string | null;
  capacity: number;
  active: boolean;
}

export interface RouteTemplate {
  id: string;
  name: string;
  type: RouteType;
  school_id: string | null;
  operating_weekdays: number[];
  default_driver_id: string | null;
  default_vehicle_id: string | null;
  active: boolean;
}

export interface RouteStop {
  id: string;
  route_id: string;
  seq: number;
  hub_id: string | null;
  school_id: string | null;
  planned_arrival: string | null;
  planned_departure: string | null;
}

export interface RouteAssignment {
  id: string;
  route_id: string;
  student_id: string;
  pickup_stop_id: string | null;
  dropoff_stop_id: string | null;
}

export interface DailyTrip {
  id: string;
  route_id: string;
  date: string;
  driver_id: string | null;
  vehicle_id: string | null;
  status: TripStatus;
  started_at: string | null;
  ended_at: string | null;
  delay_minutes: number | null;
  delay_reason: string | null;
}

export interface StudentTripStatus {
  id: string;
  trip_id: string;
  student_id: string;
  status: RiderStatus;
  pickup_stop_id: string | null;
  dropoff_stop_id: string | null;
  check_in_time: string | null;
  board_time: string | null;
  dropoff_time: string | null;
  note: string | null;
  /**
   * The token behind this rider's QR code, when `attendance_mode` is 'scan'.
   * Regenerated per trip row, so it is good for one leg of one day.
   */
  boarding_code: string;
  updated_by: string | null;
  updated_at: string;
}

/** What the driver's app encodes in, and reads out of, a student's QR code. */
export const BOARDING_QR_PREFIX = 'bustracker.board';

export function encodeBoardingQr(row: Pick<StudentTripStatus, 'id' | 'boarding_code'>) {
  return `${BOARDING_QR_PREFIX}:${row.id}:${row.boarding_code}`;
}

/** Null when the payload is not one of ours — a random QR code on a lamppost. */
export function decodeBoardingQr(raw: string): { rowId: string; code: string } | null {
  const parts = raw.trim().split(':');
  if (parts.length !== 3 || parts[0] !== BOARDING_QR_PREFIX) return null;
  if (!parts[1] || !parts[2]) return null;
  return { rowId: parts[1], code: parts[2] };
}

/**
 * What `find_rider_today()` gives a driver who says "this student isn't on my
 * list" — the narrowest answer that gets the child onto the right vehicle. No
 * contact details, no address, nothing beyond whose van they should be on.
 */
export interface RiderLookup {
  status_id: string;
  student_name: string;
  route_name: string;
  route_kind: RouteType;
  driver_name: string;
  hub_name: string;
  rider_status: RiderStatus;
  is_mine: boolean;
}

/**
 * The printed card in the van, which the STUDENT scans to board themselves.
 *
 * The payload carries `vehicle_devices.board_code` and nothing else — no trip,
 * no date, no student. Everything that decides whether a scan counts is
 * evaluated server-side by `board_by_vehicle_code()` against the trip that
 * vehicle is running at that second, which is what makes a photograph of the
 * card worthless away from a live run.
 *
 * Deliberately a different prefix from BOARDING_QR_PREFIX: that one was the
 * old direction (driver scans student) and the two must never be confused by a
 * scanner pointed at the wrong thing.
 */
export const VAN_QR_PREFIX = 'bustracker.van';

export function encodeVanQr(boardCode: string) {
  return `${VAN_QR_PREFIX}:${boardCode}`;
}

/** Null when the payload is not one of ours — a random QR code on a lamppost. */
export function decodeVanQr(raw: string): string | null {
  const parts = raw.trim().split(':');
  if (parts.length !== 2 || parts[0] !== VAN_QR_PREFIX) return null;
  return parts[1] || null;
}

/**
 * What `board_by_vehicle_code()` answers with. Never an exception: every one of
 * these is something a student standing in the rain has to be able to act on.
 */
export interface SelfScanResult {
  ok: boolean;
  tone: 'success' | 'warn' | 'danger';
  reason:
    | 'signed_out'
    | 'inactive'
    | 'unknown_code'
    | 'no_active_trip'
    | 'wrong_van'
    | 'not_riding'
    | 'already_aboard'
    | 'marked_away'
    | 'not_boardable'
    | 'van_departed'
    | 'van_not_here'
    | 'boarded';
  message: string;
  vehicle?: string;
}

/**
 * One mark in the register: this student presented the code on this evening.
 *
 * There is no `absent` row and deliberately so — a missing row is the lack of a
 * scan, not an assertion that anybody was away. Screens must render it as
 * "not marked", never as "absent".
 */
export interface Attendance {
  id: string;
  student_id: string;
  on_date: string;
  marked_at: string;
  /** A scan and a staff correction are different facts. Never merge them. */
  source: AttendanceSource;
  marked_by: string | null;
  note: string | null;
}

/**
 * A declared absence: this student is not expected on the bus.
 *
 * A SPAN, not a row per day — a fortnight away is one thing to declare and one
 * thing to cancel. Read it as `on_date`..`end_date ?? on_date`.
 *
 * Cancelled rather than deleted when it stops being true, because "they said
 * they were away and then rode anyway" is a different fact from "nobody ever
 * said anything", and a deleted row would look like the second.
 */
export interface AttendanceAbsence {
  id: string;
  student_id: string;
  on_date: string;
  end_date: string | null;
  kind: AbsenceKind;
  reason: string | null;
  declared_by: string | null;
  /** Who spoke for the student. A child telling the school is not the same event. */
  source: 'parent' | 'student' | 'staff';
  created_at: string;
  cancelled_at: string | null;
  cancelled_by: string | null;
}

export type AbsenceKind = 'absent' | 'club' | 'other';

export const ABSENCE_LABEL: Record<AbsenceKind, string> = {
  absent: 'Not riding',
  club: 'Staying for a club',
  other: 'Not riding',
};

/** A row of `attendance_register()` — every active student, marked or not. */
export interface RegisterRow {
  student_id: string;
  full_name: string;
  present: boolean;
  marked_at: string | null;
  source: AttendanceSource | null;
  note: string | null;
  /** Expected away, so they are out of the denominator rather than missing. */
  excused: boolean;
  excuse_kind: AbsenceKind | null;
  excuse_reason: string | null;
  excuse_id: string | null;
}

/**
 * The three numbers that make a register worth opening.
 *
 * `expected` deliberately counts an excused student who scanned ANYWAY: a club
 * that cancelled puts them back on the bus, so they belong in both halves of
 * "34 of 35" rather than vanishing from the count they are visibly part of.
 */
export function registerCounts(rows: RegisterRow[]) {
  const total = rows.length;
  const marked = rows.filter((r) => r.present).length;
  const away = rows.filter((r) => r.excused && !r.present).length;
  const expected = total - away;
  return { total, marked, away, expected, missing: expected - marked };
}

/** What `mark_attendance()` answers with. Never an exception. */
export interface AttendanceResult {
  ok: boolean;
  tone: 'success' | 'warn' | 'danger';
  reason:
    | 'signed_out'
    | 'inactive'
    | 'not_enabled'
    | 'too_early'
    | 'unknown_code'
    | 'already_marked'
    | 'marked'
    /** Was down as away — the club cancelled and they rode after all. */
    | 'marked_after_absence';
  message: string;
  at?: string;
}

/** One row of `vehicle_board_codes()` — what Setup needs to print the cards. */
export interface VehicleBoardCode {
  vehicle_id: string;
  label: string;
  plate: string | null;
  board_code: string;
}

/** What `identify_boarding_code()` returns for a code the driver cannot board. */
export interface BoardingCodeOwner {
  student_name: string;
  route_name: string;
  route_kind: RouteType;
  driver_name: string;
  trip_date: string;
  is_today: boolean;
}

/** The van's actual arrival and departure at one stop of one day's trip. */
export interface TripStopProgress {
  id: string;
  trip_id: string;
  stop_id: string;
  arrived_at: string | null;
  departed_at: string | null;
  /**
   * The driver left this stop with somebody still unaccounted for. The database
   * refuses the write unless this is set, and setting it files an incident per
   * affected child — see `guard_stop_departure()` in supabase/schema.sql.
   */
  departed_with_unresolved: boolean;
  /** Nobody was due here today, so the van never stopped. */
  skipped: boolean;
}

export interface ChangeRequest {
  id: string;
  student_id: string;
  date: string;
  /**
   * Last day covered, for a holiday or a long illness. Null means a single day.
   * Always read as `end_date ?? date`.
   */
  end_date: string | null;
  kind: ChangeKind;
  reason: string | null;
  requested_by: string | null;
  approval: ApprovalStatus;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  created_at: string;
}

/** A parent's pending request to change a child's hubs and school. */
export interface AssignmentRequest {
  id: string;
  student_id: string;
  requested_by: string | null;
  school_id: string | null;
  morning_hub_id: string | null;
  afternoon_hub_id: string | null;
  reason: string | null;
  status: ApprovalStatus;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  created_at: string;
}

export interface Incident {
  id: string;
  trip_id: string | null;
  student_id: string | null;
  driver_id: string | null;
  kind: IncidentKind;
  severity: IncidentSeverity;
  description: string | null;
  resolved_at: string | null;
  created_at: string;
}

export interface AppNotification {
  id: string;
  user_id: string;
  title: string;
  body: string;
  kind: string;
  read_at: string | null;
  created_at: string;
  /**
   * S6: what actually happened when this was pushed. Before, a user with no
   * push token produced no row, no retry and no trace — so "we sent it" was
   * unfalsifiable.
   */
  delivery_state: 'pending' | 'sent' | 'no_token' | 'failed';
  delivery_detail: string | null;
  delivered_at: string | null;
  /** The urgent kinds are not delivered until a person says they saw them. */
  requires_ack: boolean;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
}

export interface Announcement {
  id: string;
  title: string;
  body: string;
  route_id: string | null;
  created_at: string;
}

/**
 * Live GPS is switched off for the pilot (blueprint §1.2 / §7.3 / §8), but the
 * code is kept and working. These types belong to it.
 */
export interface VehicleLocation {
  id: number;
  vehicle_id: string;
  trip_id: string | null;
  lat: number;
  lng: number;
  heading: number | null;
  speed: number | null;
  source: 'driver_app' | 'device';
  recorded_at: string;
}

export interface Invoice {
  id: string;
  student_id: string;
  period: string;
  amount_cents: number;
  due_date: string;
  status: 'unpaid' | 'paid' | 'waived';
  paid_at: string | null;
  note: string | null;
}

/**
 * A week of a student's rides, archived into one row.
 *
 * This is what makes the weekly purge safe: the report IS the history, so
 * deleting the routine trip rows underneath it compacts a child's record rather
 * than erasing it. Anything that went wrong (incidents, no-shows, overrides) is
 * kept in full and never purged.
 */
export interface WeeklyReport {
  id: string;
  student_id: string;
  week_start: string;
  week_end: string;
  rides: {
    date: string;
    route: string;
    type: string;
    status: RiderStatus;
    hub: string | null;
    /** Who actually drove that day — including a substitute. */
    driver: string | null;
    vehicle: string | null;
    check_in: string | null;
    boarded: string | null;
    dropped_off: string | null;
    note: string | null;
  }[];
  totals: {
    total?: number;
    completed?: number;
    absent?: number;
    parent_pickup?: number;
    no_show?: number;
    unable_to_drop_off?: number;
  };
  generated_at: string;
}

export interface AuditLog {
  id: string;
  entity_type: string;
  entity_id: string | null;
  action: string;
  old_value: Record<string, unknown> | null;
  new_value: Record<string, unknown> | null;
  reason: string | null;
  changed_by: string | null;
  changed_at: string;
}

export const RIDER_STATUS_LABEL: Record<RiderStatus, string> = {
  scheduled: 'Scheduled',
  waiting: 'Waiting',
  boarded: 'Boarded',
  in_transit: 'In Transit',
  dropped_off: 'Dropped Off',
  completed: 'Completed',
  absent: 'Absent',
  parent_pickup: 'Parent Pickup',
  no_show: 'No-Show',
  unable_to_drop_off: 'Unable to Drop Off',
};

export type Tone = 'neutral' | 'success' | 'warn' | 'danger' | 'accent';

export const RIDER_STATUS_TONE: Record<RiderStatus, Tone> = {
  scheduled: 'neutral',
  waiting: 'warn',
  boarded: 'accent',
  in_transit: 'accent',
  dropped_off: 'success',
  completed: 'success',
  absent: 'neutral',
  parent_pickup: 'neutral',
  no_show: 'danger',
  unable_to_drop_off: 'danger',
};

/**
 * Blueprint §5.1: "A driver cannot complete the trip while a student remains
 * Scheduled, Waiting, Boarded, or In Transit." These are the statuses that
 * count as an outcome. `unable_to_drop_off` is deliberately NOT one — it is an
 * urgent exception that only a coordinator can clear.
 */
export const FINAL_STATUSES: RiderStatus[] = [
  'dropped_off',
  'completed',
  'absent',
  'parent_pickup',
  'no_show',
];

export const isFinal = (s: RiderStatus) => FINAL_STATUSES.includes(s);

/**
 * The statuses that mean "this child is not travelling with us today".
 *
 * All three are final, so the driver's normal boarding buttons are gone — which
 * is correct right up until the child is standing at the door. Then the app has
 * no way to record what everyone can see, the driver takes them anyway (of
 * course they do), and the record says the van is not carrying a child it is
 * carrying. That is the exact state this app exists to prevent, so boarding from
 * here has to be RECORDABLE rather than prevented: see "Boarding anyway" on the
 * driver's trip screen, and `guard_boarding_after_away()` in the schema, which
 * refuses it without a note.
 */
export const AWAY_STATUSES: RiderStatus[] = ['absent', 'parent_pickup', 'no_show'];

export const isAway = (s: RiderStatus) => AWAY_STATUSES.includes(s);

/**
 * Who has no outcome yet at a stop the van is about to leave.
 *
 * MIRRORS `riders_unresolved_at_stop()` in supabase/schema.sql, which is what
 * actually enforces this — the database refuses the departure. This copy exists
 * so the app can warn the driver and name them BEFORE the write, and offer the
 * outcome inline, instead of surfacing a Postgres error under a card. If the
 * rule changes, it changes in both places.
 *
 * A rider sits at two stops. Boarding here, they are unresolved while still
 * `scheduled` (never seen) or `waiting` (they said they were at the hub and the
 * van is leaving without them). Getting off here, they are unresolved while
 * still on board. `unable_to_drop_off` is not unresolved: it is already raised,
 * it already blocks the trip closing, and the driver is meant to drive on.
 */
export function unresolvedAtStop(riders: StudentTripStatus[], stopId: string) {
  return riders.filter(
    (r) =>
      (r.pickup_stop_id === stopId && ['scheduled', 'waiting'].includes(r.status)) ||
      (r.dropoff_stop_id === stopId && ['boarded', 'in_transit'].includes(r.status)),
  );
}

/**
 * How a change request's dates read in the UI: "Wed 12 Aug", or "12 Aug – 30 Aug
 * · 19 days" for a holiday. Parsed as local noon so a date-only string cannot
 * slip to the previous day west of UTC.
 */
export function formatDateSpan(date: string, endDate: string | null): string {
  const at = (d: string) => new Date(`${d}T12:00:00`);
  const short = (d: Date) => d.toLocaleDateString([], { day: 'numeric', month: 'short' });

  const from = at(date);
  if (!endDate || endDate === date) {
    return from.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
  }

  const to = at(endDate);
  const days = Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1;
  return `${short(from)} – ${short(to)} · ${days} days`;
}

export const CHANGE_LABEL: Record<ChangeKind, string> = {
  absent: 'Absent',
  parent_pickup: 'Parent Pickup',
  club_attending: 'Attending Club',
  club_cancelled: 'Club Cancelled',
  not_attending: 'Not Attending Club',
};

export const ROUTE_TYPE_LABEL: Record<RouteType, string> = {
  morning: 'Morning',
  afternoon: 'Afternoon',
  club: 'After-School Club',
  emergency: 'Emergency / Substitute',
};
