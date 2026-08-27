-- ---------------------------------------------------------------------------
-- The other half of the check-in window was a magic number.
--
-- `checkin_window_min` (default 60) has always controlled how long BEFORE a
-- stop's planned arrival a student may tap "I'm at the hub". How long AFTER it
-- they may still do so was hardcoded as `interval '30 min'` -- invisible in
-- Setup, unchangeable without a migration, and the thing that actually refuses
-- a check-in on a van running late.
--
-- That asymmetry is not defensible: a late van is precisely when a student is
-- still standing at the hub wanting to say so. Making it a setting costs one
-- column and removes a support question.
--
-- The default is unchanged at 30 minutes, so nothing moves for an existing
-- install until somebody decides otherwise.
-- ---------------------------------------------------------------------------

alter table organization
  add column if not exists checkin_grace_min int not null default 30
    check (checkin_grace_min >= 0);

create or replace function within_checkin_window(target_trip uuid, target_stop uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1
    from daily_trips t
    left join route_stops rs on rs.id = target_stop
    cross join organization o
    where t.id = target_trip
      and o.id = 1
      -- The operation's day, not the database's. On a UTC project this is the
      -- difference between a check-in working at 8pm Eastern and not.
      and t.date = today_local()
      and (
        rs.planned_arrival is null
        or now() between local_ts(t.date, rs.planned_arrival)
                         - make_interval(mins => o.checkin_window_min)
                     and local_ts(t.date, rs.planned_arrival)
                         + make_interval(mins => o.checkin_grace_min)
      )
  );
$$;
