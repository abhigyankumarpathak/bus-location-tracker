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
   * Weeks of full operational detail to keep. Older routine data is purged once
   * it has been archived into a weekly report and sent to the family. Incidents
   * and overrides are kept regardless of this setting.
   */
  retention_weeks: number;
}

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
}

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
  updated_by: string | null;
  updated_at: string;
}

export interface ChangeRequest {
  id: string;
  student_id: string;
  date: string;
  kind: ChangeKind;
  reason: string | null;
  requested_by: string | null;
  approval: ApprovalStatus;
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
