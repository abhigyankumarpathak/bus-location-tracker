-- ---------------------------------------------------------------------------
-- Family links are accepted on the spot.
--
-- A link used to sit `pending` until the OTHER party accepted. That handshake
-- was what stopped anybody attaching themselves to a child, and removing it has
-- a real cost, stated here rather than buried:
--
--   find_user_by_contact() matches on email or phone. So any parent account
--   that knows a student's email can now link to them and immediately read
--   their attendance and history. Nothing asks the child, and nothing asks the
--   office first.
--
-- That is a deliberate operator decision, taken because the handshake assumed a
-- student who has the app, opens it, and understands what they are agreeing to
-- -- and for a rider with no phone all three are false. A link nobody can
-- complete is not safety, it is a dead end.
--
-- TWO THINGS MAKE IT SURVIVABLE, and they are the reason this is not simply a
-- weakening:
--
--   1. IT IS ANNOUNCED. The student and every coordinator are told the moment
--      it happens. The handshake's real value was that somebody knew; this
--      keeps that and drops only the waiting.
--   2. IT IS REVERSIBLE BY EITHER SIDE. Unlink already existed for the parent
--      and the student, and staff can now do it too. A mistake costs one tap,
--      not a support ticket.
--
-- To put the handshake back: drop the trigger. The `accept link` policy, the
-- pending queue and the UI for both are all still here and still work.
-- ---------------------------------------------------------------------------

create or replace function auto_accept_link() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'pending' then
    new.status := 'accepted';
  end if;
  return new;
end;
$$;

drop trigger if exists on_link_proposed on guardian_links;
create trigger on_link_proposed before insert on guardian_links
  for each row execute function auto_accept_link();


-- ---------------------------------------------------------------------------
-- Say so, loudly, to the people who would have been asked.
--
-- This is the half that replaces the handshake. A link made in error is now
-- caught by somebody noticing rather than by somebody being blocked, so the
-- noticing has to actually happen.
-- ---------------------------------------------------------------------------
create or replace function notify_on_link() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  parent_name  text;
  student_name text;
  audience     uuid[];
begin
  if new.status <> 'accepted' then return new; end if;

  select full_name into parent_name  from profiles where id = new.parent_id;
  select full_name into student_name from profiles where id = new.student_id;
  parent_name  := coalesce(nullif(parent_name, ''), 'A parent');
  student_name := coalesce(nullif(student_name, ''), 'a student');

  -- The student, unless they made it themselves.
  if new.requested_by is distinct from new.student_id then
    insert into notifications (user_id, title, body, kind)
    values (new.student_id,
            parent_name || ' can now see your attendance',
            parent_name || ' has linked themselves to you as a parent or guardian. '
            || 'If you do not know who that is, tell the transport office now — '
            || 'you can also remove the link yourself.',
            'guardian_linked');
  end if;

  -- And the office, always. They are the ones who can act on a link that is
  -- wrong when a fourteen-year-old does not realise it is.
  select array_agg(id) into audience from profiles
  where role in ('coordinator', 'admin') and status = 'active';

  if audience is not null then
    insert into notifications (user_id, title, body, kind)
    select distinct u,
           'New family link: ' || parent_name || ' → ' || student_name,
           'Linked without approval, because links are set to accept
automatically. Check it on the Riders screen if the pairing looks wrong.',
           'guardian_linked'
    from unnest(audience) as u where u is not null;
  end if;

  return new;
end;
$$;

drop trigger if exists on_link_accepted on guardian_links;
create trigger on_link_accepted after insert on guardian_links
  for each row execute function notify_on_link();


-- Staff removing a link somebody made by mistake.
--
-- The `remove link` policy already allowed it; there was no screen for it, and
-- "delete the right row from guardian_links" is not something anybody should be
-- doing in a SQL console.
create or replace function staff_unlink_guardian(student uuid, parent uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not is_staff() then
    raise exception 'Only the transport office can do this.';
  end if;

  delete from guardian_links where student_id = student and parent_id = parent;

  insert into audit_logs (entity_type, entity_id, action, new_value, reason, changed_by)
  values ('guardian_links', student, 'unlinked_by_office',
          jsonb_build_object('parent_id', parent),
          'Unlinked by the transport office.', auth.uid());

  return jsonb_build_object('ok', true);
end;
$$;

revoke execute on function staff_unlink_guardian(uuid, uuid) from public, anon;
grant execute on function staff_unlink_guardian(uuid, uuid) to authenticated;
