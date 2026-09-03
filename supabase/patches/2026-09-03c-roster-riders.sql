-- ---------------------------------------------------------------------------
-- Linking a parent to a rider who cannot be searched for.
--
-- A parent finds their child with find_user_by_contact(), which matches on
-- email or phone. A rider created by staff has neither: their address is a
-- placeholder on a reserved TLD precisely so it can never reach anybody. So the
-- self-serve link is unavailable to exactly the families whose children most
-- need someone accounting for them, and the office has to make it.
--
-- Staff could already INSERT into guardian_links, but not from any screen, and
-- getting the shape right by hand (status, requested_by) is the kind of thing
-- nobody should be doing in a SQL console during a school run.
-- ---------------------------------------------------------------------------

create or replace function staff_link_guardian(student uuid, parent uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not is_staff() then
    raise exception 'Only the transport office can link a family.';
  end if;

  if not exists (select 1 from profiles where id = student and role = 'student') then
    raise exception 'That account is not a student.';
  end if;
  if not exists (select 1 from profiles where id = parent and role = 'parent') then
    raise exception 'That account is not a parent.';
  end if;

  -- Accepted outright. The two-party handshake exists so that nobody can attach
  -- themselves to a child; the office deciding is the authority that handshake
  -- was standing in for.
  insert into guardian_links (parent_id, student_id, status, requested_by)
  values (parent, student, 'accepted', auth.uid())
  on conflict (parent_id, student_id) do update set status = 'accepted';

  insert into audit_logs (entity_type, entity_id, action, new_value, reason, changed_by)
  values ('guardian_links', student, 'linked_by_office',
          jsonb_build_object('parent_id', parent),
          'Linked by the transport office.', auth.uid());

  return jsonb_build_object('ok', true);
end;
$$;

revoke execute on function staff_link_guardian(uuid, uuid) from public, anon;
grant execute on function staff_link_guardian(uuid, uuid) to authenticated;


-- Who is already linked to whom, for the office's own screen.
create or replace function student_guardians(target uuid)
returns table (parent_id uuid, parent_name text, status text)
language sql stable security definer set search_path = public as $$
  select gl.parent_id, p.full_name, gl.status
  from guardian_links gl
  join profiles p on p.id = gl.parent_id
  where is_staff() and gl.student_id = target
  order by p.full_name;
$$;

revoke execute on function student_guardians(uuid) from public, anon;
grant execute on function student_guardians(uuid) to authenticated;


-- Every parent account, so the office can pick one.
create or replace function all_parents()
returns table (id uuid, full_name text, email text)
language sql stable security definer set search_path = public as $$
  select p.id, p.full_name, p.email
  from profiles p
  where is_staff() and p.role = 'parent' and p.status = 'active'
  order by p.full_name;
$$;

revoke execute on function all_parents() from public, anon;
grant execute on function all_parents() to authenticated;
