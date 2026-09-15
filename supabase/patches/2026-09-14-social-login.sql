-- ---------------------------------------------------------------------------
-- Social login, without giving up the one thing the invite system guarantees.
--
-- Parents asked for it, and the reason is sound: a password nobody has to
-- remember is a password nobody writes on a sticky note. Supabase Auth already
-- holds the passwords (this app never sees one beyond the sign-in form), so the
-- gain is not "the app stops managing passwords" -- it never did -- but "the
-- family stops having one for this".
--
-- THE PROBLEM IT CREATES. Every account here gets its role FROM AN INVITE, at
-- signup, via handle_new_user(). A password signup carries the code in its
-- metadata. An OAuth signup carries nothing: Google creates the user and hands
-- it back, and there is no moment to ask for a code first. The old trigger
-- raised on a missing code, which for OAuth means every social sign-in fails
-- at the provider callback with an error nobody can act on.
--
-- THE FIX IS NOT TO STOP ASKING. The obvious shortcut -- create OAuth users as
-- students by default -- would let anybody with a Google account walk into the
-- register. Instead onboarding becomes two steps: sign in however you like,
-- then CLAIM your invite. Until it is claimed the account has no profile, no
-- role, and RLS lets it read nothing. Nobody picks their own role; it still
-- comes from a code an administrator issued.
-- ---------------------------------------------------------------------------

-- The checks, in one place, so the trigger and the claim cannot drift apart.
create or replace function validate_invite(supplied text, for_email text)
returns invites
language plpgsql security definer set search_path = public as $$
declare
  inv invites%rowtype;
begin
  select * into inv from invites where upper(code) = upper(trim(supplied)) for update;

  if not found then
    raise exception 'That invite code is not recognised.';
  end if;
  if inv.revoked_at is not null then
    raise exception 'That invite has been withdrawn.';
  end if;
  if inv.used_at is not null then
    raise exception 'That invite has already been used.';
  end if;
  if inv.expires_at < now() then
    raise exception 'That invite has expired.';
  end if;
  -- An invite addressed to one person cannot be redeemed by another. For a
  -- social sign-in the address is whatever the provider vouched for.
  if inv.email is not null and lower(inv.email) <> lower(coalesce(for_email, '')) then
    raise exception 'That invite was issued to a different email address.';
  end if;

  return inv;
end;
$$;

revoke execute on function validate_invite(text, text) from public, anon, authenticated;


-- What happens once an invite is good: the profile, the role, the student row,
-- the used-up invite, and the office told. Shared by both doors.
create or replace function apply_invite(inv invites, user_id uuid, user_email text, user_phone text)
returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, role, full_name, email, phone, status)
  values (
    user_id,
    inv.role,                                   -- from the invite. Not negotiable.
    coalesce(nullif(inv.full_name, ''), split_part(coalesce(user_email, ''), '@', 1)),
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
         coalesce(nullif(inv.full_name, ''), user_email) || ' has joined as a ' || inv.role || '.',
         'account'
  from profiles p where p.role in ('coordinator', 'admin') and p.status = 'active';
end;
$$;

revoke execute on function apply_invite(invites, uuid, text, text) from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- The trigger. Unchanged for a password signup; tolerant of a social one.
-- ---------------------------------------------------------------------------
create or replace function handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  supplied text := upper(trim(coalesce(new.raw_user_meta_data ->> 'invite_code', '')));
  provider text := coalesce(new.raw_app_meta_data ->> 'provider', 'email');
  inv invites%rowtype;
begin
  if supplied = '' then
    -- A PASSWORD signup with no code is somebody bypassing the sign-up screen.
    -- Refuse it, exactly as before.
    if provider = 'email' then
      raise exception 'An invite code is required. Ask the transport office to invite you.';
    end if;
    -- A SOCIAL signup has nowhere to have carried a code. Let the auth user
    -- exist with no profile: it can read nothing, and app/index.tsx sends it
    -- to the claim screen. claim_invite() finishes the job.
    return new;
  end if;

  inv := validate_invite(supplied, new.email);
  perform apply_invite(inv, new.id, new.email, new.phone);
  return new;
end;
$$;


-- ---------------------------------------------------------------------------
-- The second step. A signed-in account with no profile presents its code.
--
-- Returns a verdict rather than raising, because the person reading it is at
-- a sign-in screen with a code somebody read out to them, and "check
-- constraint violated" helps nobody.
-- ---------------------------------------------------------------------------
create or replace function claim_invite(code text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me    uuid := auth.uid();
  u     record;
  inv   invites%rowtype;
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

  perform apply_invite(inv, me, u.email, u.phone);

  return jsonb_build_object('ok', true, 'role', inv.role);
end;
$$;

revoke execute on function claim_invite(text) from public, anon;
grant execute on function claim_invite(text) to authenticated;


-- ---------------------------------------------------------------------------
-- While here: the people-lookup was callable by anyone, including anon.
--
-- find_user_by_contact() had no grant statement, and Postgres grants EXECUTE
-- on a new function to PUBLIC. It returns nothing to anon in practice (the
-- `p.id <> auth.uid()` clause is null with no session), but "in practice" is
-- not a policy. Signed-in users can still call it -- that is what linking a
-- family needs -- and the enumeration that allows is written up in
-- docs/SECURITY.md rather than pretended away.
-- ---------------------------------------------------------------------------
revoke execute on function find_user_by_contact(text) from public, anon;
grant execute on function find_user_by_contact(text) to authenticated;

notify pgrst, 'reload schema';
