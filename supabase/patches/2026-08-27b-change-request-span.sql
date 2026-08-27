-- ===========================================================================
-- Patch 2026-08-27 (b) — the column patch 2 forgot to add
--
-- THIS IS THE ONE THAT WAS BREAKING TRIP GENERATION. Of everything in this
-- directory, run this.
--
-- `change_requests.end_date` — the span on a multi-day request, so a fortnight
-- away is one submission rather than fourteen — was added to schema.sql, and to
-- every function that reads it, but never to a patch. Patch 2
-- (2026-08-12b) shipped an ensure_daily_trips() that joins on
-- `coalesce(c.end_date, c.date)`.
--
-- On a database built from schema.sql before the span existed and then brought
-- forward with patches, that function has been raising
--
--   ERROR: column c.end_date does not exist
--
-- on every single call since. And because the apps call it through
-- ensureTodaysTrips(), whose error is deliberately swallowed so a coordinator
-- opening a tab does not get a red banner, the failure was completely silent:
-- no trips generated, ever, for any route. The dashboard said "No trips today"
-- and the driver said "No trips assigned to you today", and both were reporting
-- an exception nobody could see.
--
-- Existence checks did not catch it because the FUNCTION exists. plpgsql does
-- not resolve column names until the statement runs, so a function body can
-- reference a column that was never created and still be created happily.
--
-- Safe to re-run.
-- ===========================================================================

-- The column. Nullable, because almost every request really is one day.
alter table change_requests add column if not exists end_date date;

-- The constraint separately: `add constraint` has no `if not exists`, so this
-- is the idempotent form.
do $do$
begin
  alter table change_requests
    add constraint change_requests_end_date_check
    check (end_date is null or end_date >= date);
exception when duplicate_object then null;
end
$do$;

create index if not exists change_requests_span_idx
  on change_requests (student_id, date, end_date);

-- ---------------------------------------------------------------------------
-- The other half of the span, also never patched: applying an approved change
-- to EVERY day it covers rather than only its first. Without this a fortnight's
-- absence marked the child away on day one and left them expected on the
-- van for the other thirteen.
-- ---------------------------------------------------------------------------
create or replace function apply_change_request() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.approval not in ('auto_approved', 'approved') then
    return new;
  end if;

  if new.kind in ('absent', 'parent_pickup') then
    update student_trip_status sts
    set status = case new.kind
                   when 'absent' then 'absent'::rider_status
                   else 'parent_pickup'::rider_status
                 end,
        note = coalesce(new.reason, sts.note),
        updated_by = new.requested_by,
        updated_at = now()
    from daily_trips t
    where sts.trip_id = t.id
      -- Every day the request spans that already has trips generated. Days
      -- further out have no rows yet; ensure_daily_trips seats them as Absent
      -- when it reaches them, reading the same range.
      and t.date between new.date and coalesce(new.end_date, new.date)
      and sts.student_id = new.student_id
      -- Do not overwrite an outcome the driver already recorded.
      and sts.status in ('scheduled', 'waiting');
  end if;

  -- Club attendance changes what the club trip's roster should be.
  if new.kind in ('club_attending', 'club_cancelled', 'not_attending') then
    perform ensure_daily_trips(new.date);
  end if;

  if new.kind in ('club_cancelled', 'not_attending') then
    delete from student_trip_status sts
    using daily_trips t, route_templates rt
    where sts.trip_id = t.id
      and t.route_id = rt.id
      and rt.type = 'club'
      and t.date between new.date and coalesce(new.end_date, new.date)
      and sts.student_id = new.student_id
      and sts.status = 'scheduled';
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Now generate the day. This is the call that has been failing silently.
-- Expect a number back: the trips it created.
--
-- Run 2026-08-27-local-date.sql BEFORE this if you have not already, so the day
-- it generates is the operation's day and not UTC's. If today_local() does not
-- exist yet, use ensure_daily_trips(current_date) for this one call.
-- ---------------------------------------------------------------------------
select ensure_daily_trips(today_local()) as trips_created;

select date, status, driver_id is not null as has_driver,
       (select count(*) from student_trip_status s where s.trip_id = t.id) as riders
from daily_trips t
where t.date >= today_local() - 1
order by t.date desc;
