-- Seed booking eligibility for one member by user_id.
-- Usage:
--   1) Replace values in INPUTS.
--   2) Run this file in your DB.

do $$
declare
  -- ===== INPUTS =====
  v_member_user_id uuid := '00000000-0000-0000-0000-000000000000'; -- required
  v_mode membership_mode := 'inperson';                              -- inperson | remote
  v_package plan_tier := 'pace';                                     -- structure | pace | performance
  v_session_type_name text := 'PT-60';
  v_weekly_allowance int := 3;
  v_session_duration int := 60;                                      -- 30 | 45 | 60
  v_session_capacity int := 2;

  -- ===== internal vars =====
  v_membership_id uuid;
  v_session_type_id uuid;
  v_token_type_id uuid;
begin
  -- Validate member exists.
  if not exists (select 1 from profiles p where p.id = v_member_user_id) then
    raise exception 'Member user_id % not found in profiles', v_member_user_id;
  end if;


  -- Ensure active membership for this member + mode.
  insert into member_memberships (
    member_id, mode, current_package, status, start_date, end_date, is_paused
  )
  values (
    v_member_user_id, v_mode, v_package, 'active', now(), now() + interval '30 days', false
  )
  on conflict (member_id, mode) do update
    set status = 'active',
        is_paused = false,
        current_package = excluded.current_package,
        start_date = least(member_memberships.start_date, now()),
        end_date = greatest(member_memberships.end_date, now() + interval '30 days'),
        updated_at = now();

  select id
    into v_membership_id
  from member_memberships
  where member_id = v_member_user_id
    and mode = v_mode;

  -- Ensure session type exists and fetch token type.
  insert into session_types (name, token_type_id, default_capacity, default_duration_mins, is_active)
  values (v_session_type_name, gen_random_uuid(), v_session_capacity, v_session_duration, true)
  on conflict (name) do nothing;

  select id, token_type_id
    into v_session_type_id, v_token_type_id
  from session_types
  where name = v_session_type_name;

  -- Allow this membership to book this session type.
  insert into membership_allowed_session_types (membership_id, session_type_id)
  values (v_membership_id, v_session_type_id)
  on conflict (membership_id, session_type_id) do nothing;

  -- Allow this member (user-level tag) for the same session type.
  insert into member_session_tags (member_id, session_type_id)
  values (v_member_user_id, v_session_type_id)
  on conflict (member_id, session_type_id) do nothing;

  -- Set weekly allowance for matching token type.
  insert into membership_session_allowances (membership_id, token_type_id, weekly_allowance)
  values (v_membership_id, v_token_type_id, v_weekly_allowance)
  on conflict (membership_id, token_type_id)
  do update set weekly_allowance = excluded.weekly_allowance;

  -- Give tokens for booking tests.
  insert into tokens (member_id, token_type_id, quantity, week_start, expiry_at, source)
  values (
    v_member_user_id,
    v_token_type_id,
    greatest(v_weekly_allowance, 1),
    date_trunc('week', now()),
    now() + interval '14 days',
    'weekly'
  );

  raise notice 'Seed complete. member=% membership=% session_type=% token_type=%',
    v_member_user_id, v_membership_id, v_session_type_id, v_token_type_id;
end $$;
