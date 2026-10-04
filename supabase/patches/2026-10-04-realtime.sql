-- ---------------------------------------------------------------------------
-- Realtime for everything added since the attendance work.
--
-- Postgres only streams changes for tables in the `supabase_realtime`
-- publication. The original six were added when the trip screens were built and
-- nothing has been added since -- so the register, the absences, the roll and
-- the family links all required a manual refresh to show what somebody else had
-- just done. On a screen two people use at the same moment, that is not a
-- refinement: a coordinator marking a student present while a monitor confirms
-- the same list means one of them is working from a stale page.
--
-- `organization` is in here for a reason worth stating: it carries the
-- attendance-only toggle. Without it, flipping that switch leaves every other
-- signed-in person on the old app until they reload, which during a changeover
-- is exactly when nobody is reloading anything.
--
-- RLS still applies. Realtime evaluates the same policies, so a parent is told
-- about their own children's rows and nothing else; a table being published
-- does not widen who can read it.
--
-- Safe to re-run: adding a table twice raises, so each is checked first.
-- ---------------------------------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array[
    'attendance',
    'attendance_absence',
    'profiles',
    'students',
    'guardian_links',
    'invites',
    'organization'
  ]
  loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
      raise notice 'published %', t;
    end if;
  end loop;
end $$;

-- What is actually streaming now. Expect all thirteen.
select tablename
from pg_publication_tables
where pubname = 'supabase_realtime' and schemaname = 'public'
order by tablename;
