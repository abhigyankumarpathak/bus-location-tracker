-- ===========================================================================
-- Patch 2026-08-12 (third) — one function, one line.
--
-- ONLY needed if you have already applied the first two patches. A fresh
-- schema.sql, or the first two patches run after this date, already contain it.
--
-- Found by an end-to-end run of a whole school day, which is the only way it
-- could have been found: every piece was correct on its own.
--
-- C4 requires a note before a student recorded as absent can be boarded. The
-- check was `note is not empty` — but `note` is one column shared by every path
-- that writes the row, and apply_change_request() already puts the ABSENCE
-- REASON in it. So a child marked absent with the reason "Ill." could be boarded
-- with no explanation at all, and notify_on_rider_status() would then tell the
-- parents:
--
--     "Ill. Boarded at 3:42 PM."
--
-- presenting the reason they were marked absent as the driver's explanation for
-- carrying them. The note must be non-empty AND CHANGED by this write.
-- ===========================================================================

create or replace function guard_boarding_after_away() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'boarded'
     and old.status in ('absent', 'parent_pickup', 'no_show')
     -- The note must be non-empty AND NEW.
     --
     -- `note` is one column shared by every path that writes this row, and
     -- apply_change_request() already puts the ABSENCE REASON in it ("Ill.").
     -- Checking only that it is non-empty therefore passed on a note left behind
     -- by a different action entirely — and notify_on_rider_status() would then
     -- have told the parents "Ill. Boarded at 3:42 PM", presenting the reason
     -- they were marked absent as the driver's explanation for carrying them.
     -- A note that has not changed is not an explanation for THIS write.
     and (coalesce(btrim(new.note), '') = '' or new.note is not distinct from old.note) then
    raise exception
      'Boarding a student recorded as % needs a note saying what happened.',
      replace(old.status::text, '_', ' ');
  end if;
  return new;
end;
$$;
