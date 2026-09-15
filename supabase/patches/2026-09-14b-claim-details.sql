-- ---------------------------------------------------------------------------
-- The name somebody typed has to survive the trip to Google and back.
--
-- Sign-up is code first, then details, then a choice: set a password, or finish
-- with Google. Choosing Google navigates the page away, so the name and phone
-- they just typed are gone by the time they come back holding a session.
--
-- The client stashes them and hands them to claim_invite() on return. Neither
-- can overrule the invite on the thing that matters: the ROLE still comes from
-- the invite row, and a name is not a permission.
-- ---------------------------------------------------------------------------

create or replace function apply_invite(
  inv        invites,
  user_id    uuid,
  user_email text,
  user_phone text,
  -- What they typed on the way through, if anything. The invite's own name wins
  -- when they typed nothing, and the email stub is the last resort.
  given_name text default null
)
returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, role, full_name, email, phone, status)
  values (
    user_id,
    inv.role,                                   -- from the invite. Not negotiable.
    coalesce(
      nullif(btrim(given_name), ''),
      nullif(inv.full_name, ''),
      split_part(coalesce(user_email, ''), '@', 1)
    ),
    user_email,
    user_phone,
    'active'
  );

  if inv.role = 'student' then
    insert into students (student_id) values (user_id)
    on conflict (student_id) do nothing;
  end if;

  update invites set used_by = user_id, used_at = now() where id = inv.id;

  insert into notifications (user_id, title, body, kind)
  select p.id, 'New account',
         coalesce(nullif(btrim(given_name), ''), nullif(inv.full_name, ''), user_email)
           || ' has joined as a ' || inv.role || '.',
         'account'
  from profiles p where p.role in ('coordinator', 'admin') and p.status = 'active';
end;
$$;

revoke execute on function apply_invite(invites, uuid, text, text, text)
  from public, anon, authenticated;


-- Dropped rather than replaced: adding parameters makes a new signature, and
-- leaving the old one behind is an overload nobody meant to create.
drop function if exists claim_invite(text);

create or replace function claim_invite(
  code       text,
  given_name text default null,
  given_phone text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me  uuid := auth.uid();
  u   record;
  inv invites%rowtype;
begin
  if me is null then
    return jsonb_build_object('ok', false, 'message', 'Sign in first.');
  end if;

  if exists (select 1 from profiles where id = me) then
    return jsonb_build_object('ok', false, 'message', 'This account is already set up.');
  end if;

  select email, phone into u from auth.users where id = me;

  begin
    inv := validate_invite(code, u.email);
  exception when others then
    return jsonb_build_object('ok', false, 'message', sqlerrm);
  end;

  perform apply_invite(inv, me, u.email, coalesce(nullif(btrim(given_phone), ''), u.phone), given_name);

  return jsonb_build_object('ok', true, 'role', inv.role);
end;
$$;

revoke execute on function claim_invite(text, text, text) from public, anon;
grant execute on function claim_invite(text, text, text) to authenticated;


-- The trigger calls apply_invite with the new arity. Unchanged otherwise.
create or replace function handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  supplied text := upper(trim(coalesce(new.raw_user_meta_data ->> 'invite_code', '')));
  provider text := coalesce(new.raw_app_meta_data ->> 'provider', 'email');
  given    text := nullif(btrim(coalesce(new.raw_user_meta_data ->> 'full_name', '')), '');
  inv invites%rowtype;
begin
  if supplied = '' then
    if provider = 'email' then
      raise exception 'An invite code is required. Ask the transport office to invite you.';
    end if;
    -- A social signup carries no code. The account exists with no profile, can
    -- read nothing, and app/claim.tsx finishes the job.
    return new;
  end if;

  inv := validate_invite(supplied, new.email);
  perform apply_invite(inv, new.id, new.email, new.phone, given);
  return new;
end;
$$;

notify pgrst, 'reload schema';
