/**
 * What day is it where the vans are?
 *
 * This used to be `new Date().toISOString().slice(0, 10)`, which is the UTC
 * date. For an operation running in New York that rolls over at 8pm local, so
 * between 8pm and midnight every screen asked the server for tomorrow, found no
 * trips generated against that date, and showed an empty day — while a van was
 * still finishing its afternoon run.
 *
 * The server answers the same question with today_local() in schema.sql, which
 * reads `organization.time_zone`. The two have to agree, so screens should use
 * useToday() from ./org, which feeds this the operation's zone. The bare
 * today() below falls back to the DEVICE's zone: right for anybody standing
 * where the vans are, and in practice only the seed for a render or two before
 * the organisation row arrives.
 */

/**
 * Null rather than an exception. An unrecognised zone is a typo in one settings
 * field, and a missing Intl is a platform we have not met yet — neither may
 * take down every screen that needs to know the date.
 */
function format(timeZone: string | undefined): string | null {
  try {
    // By parts, not by locale string: the separator and the digit order cannot
    // then drift with whatever locale the device is set to.
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date());

    const at = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
    const iso = `${at('year')}-${at('month')}-${at('day')}`;
    return /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso : null;
  } catch {
    return null;
  }
}

/** The date in `timeZone`, as YYYY-MM-DD. Falls back to the device's zone. */
export function todayIn(timeZone?: string | null): string {
  const zone = timeZone?.trim();
  return (
    format(zone || undefined) ??
    format(undefined) ??
    new Date().toISOString().slice(0, 10)
  );
}

/** Today in the device's own zone. Prefer useToday() where the org is loaded. */
export const today = () => todayIn(null);
