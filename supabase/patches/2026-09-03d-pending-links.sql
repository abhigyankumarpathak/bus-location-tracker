-- ---------------------------------------------------------------------------
-- The office can see, and settle, a family link that is waiting.
--
-- A parent proposing a link leaves it `pending` until the STUDENT accepts. That
-- handshake is the thing stopping anybody attaching themselves to a child, so
-- it is not being removed -- but it assumes the student has an app, opens it,
-- and understands what they are agreeing to. Two of those three are false for a
-- rider created by the office, who has no phone and will never sign in, and the
-- first is shaky for everybody else.
--
-- So the office gets to settle it too. That is not a weaker authority than the
-- child's; it is a stronger one, and it is the same authority
-- staff_link_guardian() already exercises when it links a roster rider.
-- ---------------------------------------------------------------------------

create or replace function pending_links()
returns table (
  parent_id    uuid,
  parent_name  text,
  parent_email text,
  student_id   uuid,
  student_name text,
  requested_by uuid,
  asked_by     text,
  created_at   timestamptz
)
language sql stable security definer set search_path = public as $$
  select gl.parent_id, pp.full_name, pp.email,
         gl.student_id, sp.full_name,
         gl.requested_by,
         case when gl.requested_by = gl.parent_id then 'parent' else 'student' end,
         gl.created_at
  from guardian_links gl
  join profiles pp on pp.id = gl.parent_id
  join profiles sp on sp.id = gl.student_id
  where is_staff() and gl.status = 'pending'
  order by gl.created_at;
$$;

revoke execute on function pending_links() from public, anon;
grant execute on function pending_links() to authenticated;


-- Turning one down. Deleted rather than marked rejected: a refused link is not
-- a record anybody needs, and leaving it would block the pair from ever trying
-- again through the unique constraint.
create or replace function reject_link(parent uuid, student uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not is_staff() then
    raise exception 'Only the transport office can do this.';
  end if;

  delete from guardian_links
  where parent_id = parent and student_id = student and status = 'pending';

  insert into audit_logs (entity_type, entity_id, action, new_value, reason, changed_by)
  values ('guardian_links', student, 'link_rejected',
          jsonb_build_object('parent_id', parent),
          'Refused by the transport office.', auth.uid());

  return jsonb_build_object('ok', true);
end;
$$;

revoke execute on function reject_link(uuid, uuid) from public, anon;
grant execute on function reject_link(uuid, uuid) to authenticated;
