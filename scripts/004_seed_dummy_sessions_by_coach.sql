do $$
declare
  -- ===== INPUTS =====
  v_coach_user_id uuid := '1d140341-4034-49c7-a8c5-cf86f3f55f8e'; -- profiles.id / coaches.user_id
  v_ensure_coach_row boolean := true; -- insert into coaches from profiles if missing
  v_session_type_name text := 'Beat 30';
  v_duration_mins int := 30;                                       -- 30 | 45 | 60
  v_capacity int := 2;
  v_is_online boolean := false;
  v_location_name text := 'Ipswich';                             -- coach base + session venue when in-person
  v_sessions_to_create int := 5;                                   -- number of dummy sessions
  v_start_day_offset int := 0;                                     -- start from now() + N days
  v_hour_of_day int := 8;                                           -- 0..23
  v_gap_days int := 1;                                              -- spacing between sessions

  -- ===== internal vars =====
  v_session_type_id uuid;
  v_token_type_id uuid;
  v_location_id uuid;
  i int;
  v_start_at timestamptz;
  v_end_at timestamptz;
  v_fk_coaches_col name;  -- coaches column referenced by sessions_coach_user_id_fkey
  v_session_coach_fk uuid; -- value to store in sessions.coach_user_id
begin
  if v_sessions_to_create <= 0 then
    raise exception 'v_sessions_to_create must be > 0';
  end if;

  -- Location first (coaches.location_id may be NOT NULL; sessions need it when in-person).
  insert into locations (name, slug)
  values (
    v_location_name,
    lower(regexp_replace(trim(v_location_name), '\s+', '-', 'g'))
  )
  on conflict (name) do nothing;

  select id
    into v_location_id
  from locations
  where name = v_location_name;

  if v_location_id is null then
    raise exception 'Could not resolve location named %.', v_location_name;
  end if;

  if v_ensure_coach_row then
    insert into coaches (user_id, weekly_hour_limit_mins, travel_buffer_minutes, location_id)
    select v_coach_user_id, 2400, 30, v_location_id
    from profiles p
    where p.id = v_coach_user_id
    on conflict (user_id) do nothing;
  end if;

  if not exists (select 1 from coaches c where c.user_id = v_coach_user_id) then
    raise exception
      'No coaches row for user_id %. Ensure profiles.id exists (v_ensure_coach_row inserts coaches from profiles), or insert into coaches manually.',
      v_coach_user_id;
  end if;

  -- sessions.coach_user_id FK may reference coaches(id) or coaches(user_id) depending on migration.
  select a.attname
    into v_fk_coaches_col
  from pg_constraint con
  join pg_attribute a on a.attrelid = con.confrelid and a.attnum = con.confkey[1]
  where con.conname = 'sessions_coach_user_id_fkey'
    and con.contype = 'f';

  if v_fk_coaches_col is null then
    v_fk_coaches_col := 'user_id';
  end if;

  if v_fk_coaches_col = 'id' then
    select c.id
      into v_session_coach_fk
    from coaches c
    where c.user_id = v_coach_user_id;
  else
    v_session_coach_fk := v_coach_user_id;
  end if;

  if v_session_coach_fk is null then
    raise exception
      'Could not resolve sessions.coach_user_id for profile % (coaches FK references %).',
      v_coach_user_id, v_fk_coaches_col;
  end if;

  -- Ensure session type exists.
  insert into session_types (name, token_type_id, default_capacity, default_duration_mins, is_active)
  values (v_session_type_name, gen_random_uuid(), v_capacity, v_duration_mins, true)
  on conflict (name) do nothing;

  select id, token_type_id
    into v_session_type_id, v_token_type_id
  from session_types
  where name = v_session_type_name;

  i := 0;
  while i < v_sessions_to_create loop
    v_start_at := date_trunc('day', now())
                  + make_interval(days => (v_start_day_offset + (i * v_gap_days)))
                  + make_interval(hours => v_hour_of_day);
    v_end_at := v_start_at + make_interval(mins => v_duration_mins);

    insert into sessions (
      session_type_id,
      token_type_id,
      coach_user_id,
      location_id,
      start_at,
      end_at,
      capacity,
      is_cancelled,
      "is_online"
    )
    values (
      v_session_type_id,
      v_token_type_id,
      v_session_coach_fk,
      case when v_is_online then null else v_location_id end,
      v_start_at,
      v_end_at,
      v_capacity,
      false,
      v_is_online
    );

    i := i + 1;
  end loop;

  raise notice 'Created % sessions for coach sessions.coach_user_id=% profile=% (session_type %, token_type %)',
    v_sessions_to_create, v_session_coach_fk, v_coach_user_id, v_session_type_id, v_token_type_id;
end $$;
