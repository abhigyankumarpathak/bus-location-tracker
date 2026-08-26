import { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import * as SQLite from 'expo-sqlite';
import { supabase } from './supabase';
import type { DailyTrip, StudentTripStatus, TripStopProgress } from './types';

/**
 * C3 — the offline queue. A write-ahead log for everything the driver records.
 *
 * THE PROBLEM. Every driver action was a direct PostgREST write and a failure
 * surfaced as a red string under a card. No retry, no queue, no local log. The
 * realistic failure is not that the driver stops — it is that they keep driving,
 * because they have to. Ten minutes of dead zone is three stops with no boarding
 * record, reconstructed afterwards from somebody's memory, in an app whose entire
 * job is knowing where children are.
 *
 * WHY A LOG AND NOT A RETRY. Every mutation is written to SQLite BEFORE it is
 * attempted, not after it fails. That is the difference between a queue and a
 * write-ahead log, and it is what makes "the app was killed mid-request" a
 * recoverable state rather than a lost boarding. The screen never waits on the
 * network to show what the driver just recorded — `withPending()` puts the
 * unsent writes back on top of whatever the server last said.
 *
 * ORDERING. One serial queue, drained in insertion order, and a network failure
 * STOPS the drain rather than skipping ahead. This is the rule the whole design
 * rests on: replaying "boarded Priya" after "departed Oak Road" would hit
 * guard_stop_departure() with a different roster than the driver was looking at.
 * The server sees the same sequence of facts the driver produced.
 *
 * IDEMPOTENCY. Replay is safe by construction rather than by bookkeeping:
 *   - every rider write is an UPDATE keyed by row id, so applying it twice lands
 *     the same row in the same state;
 *   - stop progress is an upsert on (trip_id, stop_id), and guard_stop_departure()
 *     already refuses to let a driver overwrite a recorded arrival or departure,
 *     so a replayed arrival keeps the ORIGINAL timestamp;
 *   - inserts carry a client-generated id and go through an ignore-duplicates
 *     upsert, so a flush that half-succeeded does not file two incidents.
 *
 * WHAT IS DELIBERATELY NOT QUEUED. Undo is time-boxed server-side against
 * `now()`, so a queued undo is refused by definition — queueing it would mean
 * showing a driver an undo that silently evaporates. The rider lookup and
 * `board_at_other_stop` need a server answer to be worth anything, and
 * `report_delay` is cumulative, so replaying it would double-count. Those stay
 * online-only and the screen says so rather than pretending.
 *
 * THIS FILE IS NATIVE-ONLY. There is an `outbox.web.ts` sibling and the split is
 * load-bearing for the same reason as session-storage.ts: Metro resolves imports
 * at build time, so a runtime Platform check cannot keep expo-sqlite out of the
 * web bundle. Nobody drives a route from a browser, so on web the writes go
 * straight through.
 */

export type OutboxTable =
  | 'student_trip_status'
  | 'trip_stop_progress'
  | 'daily_trips'
  | 'incidents';

export type OutboxOp = 'update' | 'upsert' | 'insert';

export interface OutboxAction {
  /** Client-generated. The idempotency key, and what the UI keys a row on. */
  id: string;
  /** Insertion order. The queue is drained by this and nothing else. */
  seq: number;
  table: OutboxTable;
  op: OutboxOp;
  /** Rows to patch, for `update`. Every driver write is keyed by row id. */
  ids: string[];
  /** The columns being written. */
  values: Record<string, unknown>;
  /** Upsert conflict target, e.g. 'trip_id,stop_id'. */
  onConflict: string | null;
  /** What the driver did, in their words — for the banner and the failure list. */
  label: string;
  /** When the driver actually did it. Not when it reached the server. */
  clientTs: string;
  attempts: number;
  state: 'pending' | 'failed';
  error: string | null;
}

export interface EnqueueInput {
  table: OutboxTable;
  op: OutboxOp;
  values: Record<string, unknown>;
  ids?: string[];
  onConflict?: string;
  label: string;
}

export interface EnqueueResult {
  /** The write is recorded somewhere that survives the app being killed. */
  ok: boolean;
  /** It is in the log but not yet on the server. */
  queued: boolean;
  error?: string;
}

export interface OutboxState {
  actions: OutboxAction[];
  /** Written down, not yet accepted by the server. */
  pending: number;
  /** The server refused these. They need a human. */
  failed: number;
  /** Whether the last attempt reached the server at all. */
  connection: 'ok' | 'offline';
}

/**
 * How long between retries while the queue is stalled. Deliberately short: a van
 * leaving a dead spot should catch up before it reaches the next hub, and the
 * cost of a failed request on a phone that has no signal is close to nothing.
 */
const RETRY_MS = 20_000;

/**
 * Attempts before an error with no Postgres code is treated as permanent.
 *
 * A clear network signature retries forever — a driver stuck in a dead zone for
 * an hour must not lose the queue. But an error we cannot classify would block
 * the drain indefinitely, and a blocked queue is silent data loss wearing a
 * "pending" badge. Ten attempts is a bit over three minutes.
 */
const AMBIGUOUS_LIMIT = 10;

/**
 * A row id generated on the phone.
 *
 * INSERTS need one so that replaying a half-finished flush collides on the
 * primary key instead of filing a second incident. Letting the server generate
 * it would make every retry a new row, which is the classic way an offline queue
 * turns one breakdown into four.
 */
export const newId = () =>
  globalThis.crypto?.randomUUID?.() ??
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });

const uuid = newId;

interface Row {
  seq: number;
  id: string;
  tbl: string;
  op: string;
  ids: string;
  values_json: string;
  on_conflict: string | null;
  label: string;
  client_ts: string;
  attempts: number;
  state: string;
  error: string | null;
}

const fromRow = (r: Row): OutboxAction => ({
  id: r.id,
  seq: r.seq,
  table: r.tbl as OutboxTable,
  op: r.op as OutboxOp,
  ids: JSON.parse(r.ids) as string[],
  values: JSON.parse(r.values_json) as Record<string, unknown>,
  onConflict: r.on_conflict,
  label: r.label,
  clientTs: r.client_ts,
  attempts: r.attempts,
  state: r.state as 'pending' | 'failed',
  error: r.error,
});

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

function db() {
  if (!dbPromise) {
    dbPromise = (async () => {
      const handle = await SQLite.openDatabaseAsync('outbox.db');
      // `table` and `values` are reserved words; hence tbl / values_json.
      await handle.execAsync(`
        pragma journal_mode = WAL;
        create table if not exists outbox (
          seq         integer primary key autoincrement,
          id          text not null unique,
          tbl         text not null,
          op          text not null,
          ids         text not null,
          values_json text not null,
          on_conflict text,
          label       text not null,
          client_ts   text not null,
          attempts    integer not null default 0,
          state       text not null default 'pending',
          error       text
        );
      `);
      return handle;
    })();
  }
  return dbPromise;
}

// ---------------------------------------------------------------------------
// The in-memory mirror. React renders from this, so it has to be synchronous.
// ---------------------------------------------------------------------------

let cache: OutboxAction[] = [];
let connection: 'ok' | 'offline' = 'ok';
const listeners = new Set<() => void>();

const emit = () => listeners.forEach((l) => l());

async function refresh() {
  const handle = await db();
  const rows = await handle.getAllAsync<Row>('select * from outbox order by seq');
  cache = rows.map(fromRow);
  emit();
}

export function snapshot(): OutboxState {
  return {
    actions: cache,
    pending: cache.filter((a) => a.state === 'pending').length,
    failed: cache.filter((a) => a.state === 'failed').length,
    connection,
  };
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

async function send(a: OutboxAction) {
  if (a.op === 'update') {
    return supabase.from(a.table).update(a.values).in('id', a.ids);
  }
  if (a.op === 'upsert') {
    return supabase.from(a.table).upsert(a.values, { onConflict: a.onConflict ?? 'id' });
  }
  // An insert replayed after a half-successful flush would file a second
  // incident. The id is generated client-side precisely so the second one
  // collides and can be ignored.
  return supabase
    .from(a.table)
    .upsert(a.values, { onConflict: 'id', ignoreDuplicates: true });
}

/**
 * Did this fail because the phone has no signal, or because the server said no?
 *
 * PostgREST and Postgres always set a `code`. A fetch that never landed has
 * none, so an empty code means we probably never reached the server — but
 * "probably" is doing work there, which is what AMBIGUOUS_LIMIT is for.
 */
function classify(e: { message?: string; code?: string }) {
  if (e.code) return 'refused' as const;
  if (/network|fetch|timeout|abort|connection|offline|failed to fetch/i.test(e.message ?? '')) {
    return 'offline' as const;
  }
  return 'unclear' as const;
}

let inFlight: Promise<void> | null = null;

async function pass() {
  const handle = await db();

  for (;;) {
    const row = await handle.getFirstAsync<Row>(
      `select * from outbox where state = 'pending' order by seq limit 1`,
    );
    if (!row) break;

    const a = fromRow(row);
    const { error } = await send(a);

    if (!error) {
      await handle.runAsync('delete from outbox where id = ?', a.id);
      connection = 'ok';
      continue;
    }

    const attempts = a.attempts + 1;
    const kind = classify(error);

    if (kind === 'offline' || (kind === 'unclear' && attempts < AMBIGUOUS_LIMIT)) {
      // STOP, do not skip. Order is the whole contract.
      connection = 'offline';
      await handle.runAsync('update outbox set attempts = ? where id = ?', attempts, a.id);
      break;
    }

    // The server answered and refused, or we have stopped believing it is the
    // network. Park it so the rest of the queue can drain, and put it in front
    // of the driver — a refused write is a fact about a child that did not get
    // recorded, and silence here is the bug this whole file exists to fix.
    connection = kind === 'refused' ? 'ok' : 'offline';
    await handle.runAsync(
      `update outbox set attempts = ?, state = 'failed', error = ? where id = ?`,
      attempts,
      error.message || 'The server refused this write.',
      a.id,
    );
  }

  await refresh();
}

/** Drain the queue. Serialised, so two callers cannot interleave the order. */
export function flush(): Promise<void> {
  inFlight = (inFlight ?? Promise.resolve()).then(pass, pass);
  return inFlight;
}

/**
 * Record a driver action.
 *
 * Writes the log entry first, then tries to send. Online this behaves exactly as
 * a direct write did — the caller awaits one round trip and gets the real error
 * — so nothing about the connected path got slower or vaguer. Offline it returns
 * `queued` immediately and the banner takes over.
 */
export async function enqueue(input: EnqueueInput): Promise<EnqueueResult> {
  const handle = await db();
  const id = uuid();
  const clientTs = new Date().toISOString();

  await handle.runAsync(
    `insert into outbox (id, tbl, op, ids, values_json, on_conflict, label, client_ts)
     values (?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    input.table,
    input.op,
    JSON.stringify(input.ids ?? []),
    JSON.stringify(input.values),
    input.onConflict ?? null,
    input.label,
    clientTs,
  );

  // The screen updates here, before any network call. This is the optimistic
  // return the plan asks for.
  await refresh();
  await flush();

  const row = cache.find((a) => a.id === id);
  if (!row) return { ok: true, queued: false };
  if (row.state === 'failed') return { ok: false, queued: false, error: row.error ?? undefined };
  return { ok: true, queued: true };
}

/** Put a refused write back in the queue — after the office has fixed the cause. */
export async function retryFailed() {
  const handle = await db();
  await handle.runAsync(
    `update outbox set state = 'pending', attempts = 0, error = null where state = 'failed'`,
  );
  await refresh();
  await flush();
}

/**
 * Throw away a refused write.
 *
 * Deliberately explicit and deliberately per-item. A driver discarding a failed
 * boarding is deleting the only record that it happened, so this is never
 * automatic and never bulk.
 */
export async function discard(id: string) {
  const handle = await db();
  await handle.runAsync('delete from outbox where id = ?', id);
  await refresh();
}

// ---------------------------------------------------------------------------
// The optimistic overlay
// ---------------------------------------------------------------------------

export interface PendingView {
  rows: StudentTripStatus[];
  trips: DailyTrip[];
  progress: TripStopProgress[];
}

/**
 * Put the unsent writes back on top of whatever the server last said.
 *
 * Without this the driver taps Boarded in a dead zone, the card does not change,
 * and they tap it again — and again — because the app is telling them nothing
 * happened. Every one of those taps is another queue entry. The overlay is not a
 * nicety; it is what stops the offline path generating duplicate work.
 *
 * FAILED actions are deliberately NOT applied. The server refused them, so they
 * did not happen, and showing them as though they did would be the one lie this
 * app cannot tell.
 */
export function withPending(data: PendingView, actions: OutboxAction[]): PendingView {
  const live = actions.filter((a) => a.state === 'pending');
  if (!live.length) return data;

  let { rows, trips, progress } = data;

  for (const a of live) {
    if (a.table === 'student_trip_status' && a.op === 'update') {
      rows = rows.map((r) =>
        a.ids.includes(r.id) ? { ...r, ...(a.values as Partial<StudentTripStatus>) } : r,
      );
      continue;
    }

    if (a.table === 'daily_trips' && a.op === 'update') {
      trips = trips.map((t) =>
        a.ids.includes(t.id) ? { ...t, ...(a.values as Partial<DailyTrip>) } : t,
      );
      continue;
    }

    if (a.table === 'trip_stop_progress' && a.op === 'upsert') {
      const v = a.values as Partial<TripStopProgress> & { trip_id: string; stop_id: string };
      const idx = progress.findIndex((p) => p.trip_id === v.trip_id && p.stop_id === v.stop_id);

      if (idx === -1) {
        progress = [
          ...progress,
          {
            id: `pending:${a.id}`,
            arrived_at: null,
            departed_at: null,
            departed_with_unresolved: false,
            skipped: false,
            // Last, so the queued write wins. trip_id and stop_id come from here.
            ...v,
          },
        ];
        continue;
      }

      const existing = progress[idx];
      const merged = { ...existing, ...v };
      // Mirrors guard_stop_departure(): a driver cannot overwrite a time that is
      // already recorded, so the screen must not show one moving either. A
      // second arrival tap is a mistap, not a correction.
      if (existing.arrived_at) merged.arrived_at = existing.arrived_at;
      if (existing.departed_at) merged.departed_at = existing.departed_at;
      progress = progress.map((p, i) => (i === idx ? merged : p));
    }
  }

  return { rows, trips, progress };
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

export function useOutbox(): OutboxState {
  const [state, setState] = useState<OutboxState>(snapshot);

  useEffect(() => {
    const listener = () => setState(snapshot());
    listeners.add(listener);
    // Pick up anything a previous session left behind — the log outlives the
    // process, which is the point of it.
    refresh();
    return () => {
      listeners.delete(listener);
    };
  }, []);

  return state;
}

let timer: ReturnType<typeof setInterval> | null = null;

/**
 * Keep trying, on a timer and on foreground.
 *
 * Started from the driver's screens rather than at import, so a parent's phone
 * never runs a retry loop for a queue it can never have.
 */
export function startOutboxSync() {
  if (timer) return;
  flush();
  timer = setInterval(() => {
    if (cache.some((a) => a.state === 'pending')) flush();
  }, RETRY_MS);
}

export function stopOutboxSync() {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

// Coming back to the app is the single best moment to try again: it usually
// means the driver has just picked the phone up, which usually means they have
// stopped somewhere.
AppState.addEventListener('change', (s) => {
  if (s === 'active' && cache.some((a) => a.state === 'pending')) flush();
});
