import { useEffect, useId, useRef } from 'react';
import { supabase } from './supabase';

/**
 * Re-read when somebody else changes something.
 *
 * USED AS A SIGNAL, NOT A DATA SOURCE. The payload is deliberately ignored and
 * the screen refetches instead. That costs one query per change and buys a lot:
 *
 *   - A DELETE only carries the primary key unless the table's replica identity
 *     is widened, so a screen built from payloads has to special-case it.
 *   - Most of these screens read through RPCs — attendance_register(),
 *     attendance_roll(), monitor_assignments() — which compute things no row
 *     event describes. A monitor's roster changes when a student is added, when
 *     a flag is flipped, and when somebody declares an absence; no single row
 *     tells you the new split.
 *   - A missed or out-of-order event cannot leave the screen permanently wrong,
 *     because every event re-reads the whole truth.
 *
 * RLS applies to the stream, so a parent is told about their own children's
 * rows and nobody else's.
 */

/**
 * A burst of changes is one refetch, not six.
 *
 * A monitor confirming five riders writes five rows in one statement; marking a
 * whole stop drops in just as fast. Without this, each would schedule its own
 * query and the screen would flicker through five intermediate states on its
 * way to the right one.
 */
const SETTLE_MS = 150;

export function useRealtime(tables: string[], onChange: () => void) {
  // Supabase hands back the SAME channel object for a given topic name, so two
  // screens watching the same tables would collide on one channel and the
  // second would try to add listeners after subscribe() — which throws. A
  // per-instance id keeps every subscriber on its own.
  const instance = useId();

  // Held in a ref so a caller passing an inline closure — which is all of them
  // — does not tear down and rebuild the subscription on every render.
  const latest = useRef(onChange);
  latest.current = onChange;

  const key = tables.join(',');

  useEffect(() => {
    if (!key) return;

    let timer: ReturnType<typeof setTimeout> | null = null;
    const settle = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => latest.current(), SETTLE_MS);
    };

    const channel = supabase.channel(`watch:${key}:${instance}`);
    for (const table of key.split(',')) {
      channel.on('postgres_changes', { event: '*', schema: 'public', table }, settle);
    }
    channel.subscribe();

    return () => {
      if (timer) clearTimeout(timer);
      supabase.removeChannel(channel);
    };
  }, [key, instance]);
}
