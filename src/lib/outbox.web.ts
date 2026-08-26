import { supabase } from './supabase';
import type { DailyTrip, StudentTripStatus, TripStopProgress } from './types';

/**
 * The outbox, on WEB — which is to say, no outbox.
 *
 * Same reason session-storage.web.ts and Map.web.tsx exist: Metro resolves
 * imports at build time, so a runtime Platform check cannot keep expo-sqlite out
 * of the web bundle. Referencing it here at all would pull in the SQLite WASM
 * worker, fail to resolve wa-sqlite.wasm, and kill the web build.
 *
 * That is the mechanical reason. The real one is that nobody drives a route from
 * a browser. The web build exists so a coordinator can work at a desk (§7.3), and
 * a desk has the same network the database does — an offline log there would be
 * solving a problem that does not exist while adding a layer that can lose data.
 *
 * So `enqueue` here is a direct write that returns the real result, and every
 * caller gets the same contract: `ok` means it is recorded somewhere durable.
 * On native that is the local log; on web it is the server itself.
 */

export type OutboxTable =
  | 'student_trip_status'
  | 'trip_stop_progress'
  | 'daily_trips'
  | 'incidents';

export type OutboxOp = 'update' | 'upsert' | 'insert';

export interface OutboxAction {
  id: string;
  seq: number;
  table: OutboxTable;
  op: OutboxOp;
  ids: string[];
  values: Record<string, unknown>;
  onConflict: string | null;
  label: string;
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
  ok: boolean;
  queued: boolean;
  error?: string;
}

export interface OutboxState {
  actions: OutboxAction[];
  pending: number;
  failed: number;
  connection: 'ok' | 'offline';
}

export interface PendingView {
  rows: StudentTripStatus[];
  trips: DailyTrip[];
  progress: TripStopProgress[];
}

const EMPTY: OutboxState = { actions: [], pending: 0, failed: 0, connection: 'ok' };

/** Same contract as native: callers supply insert ids so a retry cannot double up. */
export const newId = () =>
  globalThis.crypto?.randomUUID?.() ??
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });

export function snapshot(): OutboxState {
  return EMPTY;
}

export async function enqueue(input: EnqueueInput): Promise<EnqueueResult> {
  const { error } =
    input.op === 'update'
      ? await supabase
          .from(input.table)
          .update(input.values)
          .in('id', input.ids ?? [])
      : input.op === 'upsert'
        ? await supabase
            .from(input.table)
            .upsert(input.values, { onConflict: input.onConflict ?? 'id' })
        : await supabase
            .from(input.table)
            .upsert(input.values, { onConflict: 'id', ignoreDuplicates: true });

  if (error) return { ok: false, queued: false, error: error.message };
  return { ok: true, queued: false };
}

export async function flush(): Promise<void> {}
export async function retryFailed(): Promise<void> {}
export async function discard(_id: string): Promise<void> {}

/** Nothing is ever pending here, so the rows are already the truth. */
export function withPending(data: PendingView, _actions: OutboxAction[]): PendingView {
  return data;
}

export function useOutbox(): OutboxState {
  return EMPTY;
}

export function startOutboxSync() {}
export function stopOutboxSync() {}
