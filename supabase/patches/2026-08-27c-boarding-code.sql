-- ===========================================================================
-- Patch 2026-08-27 (c) — the last column drift.sql found
--
-- `student_trip_status.boarding_code` is the token behind the OLD scan
-- direction: the driver pointing a camera at a code on each student's phone.
-- The self-scan patch (5) inverted that -- the code now lives on the van and
-- the students scan it -- and schema.sql says plainly why the column stayed:
-- removing it mid-pilot buys nothing, and it is worth deleting only once the
-- self-scan model has survived a term.
--
-- Kept means kept, so it belongs in the database too. Nothing reads it today:
-- identify_boarding_code() is the only caller, no screen invokes that, and
-- encodeBoardingQr/decodeBoardingQr in src/lib/types.ts have no callers either.
-- Which is exactly why it went unnoticed -- the one function that touches it is
-- never run, so it never raised the way ensure_daily_trips() did.
--
-- Per TRIP ROW rather than per student: the code changes every day and for every
-- leg, so a screenshot of yesterday's is worthless, and one scanned off a
-- classmate's phone identifies THAT classmate.
--
-- Safe to re-run.
-- ===========================================================================

-- Defined first: a column default cannot reference a function that does not
-- exist yet, and this one is missing on any database that never had the column.
create or replace function new_boarding_code() returns text
language sql volatile as $$
  select translate(encode(gen_random_bytes(12), 'base64'), '+/=', '-_');
$$;

-- The default is VOLATILE, which is the point -- Postgres evaluates it per row,
-- so every existing trip row gets its own code rather than all sharing one.
-- That means a table rewrite. On a pilot-sized table it is instant; on a large
-- one, run it outside the school run.
alter table student_trip_status
  add column if not exists boarding_code text not null default new_boarding_code();

-- Every row distinct, and none of them null. Expect rows = distinct_codes.
select count(*) as rows,
       count(distinct boarding_code) as distinct_codes,
       count(*) filter (where boarding_code is null) as nulls
from student_trip_status;
