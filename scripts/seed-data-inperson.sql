-- Seed combined member eligibility, allowances, tokens, and dummy sessions by coach.
-- Usage: 
--  1) Replace values in INPUTS (specifically user IDs).
--  2) Run in your DB.

DO $$
DECLARE
  -- ===== INPUTS: Member =====
  v_member_user_id uuid := 'dd23f9e8-0bbf-4ae5-b947-d5ff6dd90bf6'; -- REQUIRED
  v_mode membership_mode := 'inperson';                              
  v_package plan_tier := 'pace';                                     
  v_weekly_allowance int := 3;

  -- ===== INPUTS: Coach & Sessions =====
  v_coach_user_id uuid := 'e9749a3c-ecbf-4bfe-a3c0-9b82cdbfc55f'; -- REQUIRED: coach profile id / coaches.user_id
  v_session_type_name text := '1:1';
  v_session_duration int := 60;                                      
  v_session_capacity int := 2;
  v_is_online boolean := false;
  v_location_name text := 'Ipswich';                             
  v_sessions_to_create int := 5;                                   
  v_start_day_offset int := 1;                                     
  v_hour_of_day int := 15;                                           
  v_gap_days int := 1;                                              

  -- ===== internal vars =====
  v_membership_id uuid;
  v_session_type_id uuid;
  v_token_type_id uuid;
  v_location_id uuid;
  v_fk_coaches_col name;      -- coaches column referenced by sessions_coach_user_id_fkey
  v_session_coach_fk uuid;    -- resolved value to store in sessions.coach_user_id
  i int;
  v_start_at timestamptz;
  v_end_at timestamptz;
BEGIN
  IF v_sessions_to_create <= 0 THEN
    RAISE EXCEPTION 'v_sessions_to_create must be > 0';
  END IF;

  -- 1. Validate Member and Coach Exit
  IF NOT EXISTS (SELECT 1 FROM profiles p WHERE p.id = v_member_user_id) THEN
    RAISE EXCEPTION 'Member user_id % not found in profiles', v_member_user_id;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM coaches c WHERE c.user_id = v_coach_user_id) THEN
    RAISE EXCEPTION 'Coach user_id % not found in the coaches table. Ensure they have a coach record.', v_coach_user_id;
  END IF;

  -- sessions.coach_user_id FK can reference coaches(id) or coaches(user_id) depending on DB migrations.
  SELECT a.attname
    INTO v_fk_coaches_col
  FROM pg_constraint con
  JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = con.confkey[1]
  WHERE con.conname = 'sessions_coach_user_id_fkey'
    AND con.contype = 'f';

  IF v_fk_coaches_col IS NULL THEN
    v_fk_coaches_col := 'user_id';
  END IF;

  IF v_fk_coaches_col = 'id' THEN
    SELECT c.id INTO v_session_coach_fk
    FROM coaches c
    WHERE c.user_id = v_coach_user_id;
  ELSE
    v_session_coach_fk := v_coach_user_id;
  END IF;

  IF v_session_coach_fk IS NULL THEN
    RAISE EXCEPTION
      'Could not resolve sessions.coach_user_id for profile % (coaches FK references %).',
      v_coach_user_id, v_fk_coaches_col;
  END IF;

  -- 2. Setup Location
  IF NOT v_is_online THEN
    INSERT INTO locations (name, slug)
    VALUES (
      v_location_name,
      lower(regexp_replace(trim(v_location_name), '\s+', '-', 'g'))
    )
    ON CONFLICT (name) DO NOTHING;

    SELECT id INTO v_location_id FROM locations WHERE name = v_location_name;
  ELSE
    v_location_id := null;
  END IF;

  -- 3. Ensure Session Type and Token Type exist
  INSERT INTO session_types (name, token_type_id, default_capacity, default_duration_mins, is_active)
  VALUES (v_session_type_name, gen_random_uuid(), v_session_capacity, v_session_duration, true)
  ON CONFLICT (name) DO NOTHING;

  SELECT id, token_type_id INTO v_session_type_id, v_token_type_id
  FROM session_types WHERE name = v_session_type_name;

  -- 4. Setup Member's Membership
  INSERT INTO member_memberships (
    member_id, mode, current_package, status, start_date, end_date, is_paused
  )
  VALUES (
    v_member_user_id, v_mode, v_package, 'active', now(), now() + interval '30 days', false
  )
  ON CONFLICT (member_id, mode) DO UPDATE
    SET status = 'active',
        is_paused = false,
        current_package = EXCLUDED.current_package,
        start_date = least(member_memberships.start_date, now()),
        end_date = greatest(member_memberships.end_date, now() + interval '30 days'),
        updated_at = now();

  SELECT id INTO v_membership_id
  FROM member_memberships WHERE member_id = v_member_user_id AND mode = v_mode;

  -- 5. Setup Membership Linkages
  INSERT INTO membership_allowed_session_types (membership_id, session_type_id)
  VALUES (v_membership_id, v_session_type_id)
  ON CONFLICT (membership_id, session_type_id) DO NOTHING;

  INSERT INTO member_session_tags (member_id, session_type_id)
  VALUES (v_member_user_id, v_session_type_id)
  ON CONFLICT (member_id, session_type_id) DO NOTHING;

  INSERT INTO membership_session_allowances (membership_id, token_type_id, weekly_allowance)
  VALUES (v_membership_id, v_token_type_id, v_weekly_allowance)
  ON CONFLICT (membership_id, token_type_id)
  DO UPDATE SET weekly_allowance = EXCLUDED.weekly_allowance;

  -- 6. Grant Active Tokens to the Member
  INSERT INTO tokens (member_id, token_type_id, quantity, week_start, expiry_at, source)
  VALUES (
    v_member_user_id,
    v_token_type_id,
    greatest(v_weekly_allowance, 1),
    date_trunc('week', now()),
    now() + interval '14 days',
    'weekly'
  );

  -- 7. Create the Dummy Sessions
  i := 0;
  WHILE i < v_sessions_to_create LOOP
    v_start_at := date_trunc('day', now())
                  + make_interval(days => (v_start_day_offset + (i * v_gap_days)))
                  + make_interval(hours => v_hour_of_day);
    v_end_at := v_start_at + make_interval(mins => v_session_duration);

    INSERT INTO sessions (
      session_type_id, token_type_id, coach_user_id, location_id,
      start_at, end_at, capacity, is_cancelled, "is_online"
    )
    SELECT
      v_session_type_id, v_token_type_id, v_session_coach_fk, v_location_id,
      v_start_at, v_end_at, v_session_capacity, false, v_is_online
    WHERE NOT EXISTS (
      SELECT 1
      FROM sessions s
      WHERE s.session_type_id = v_session_type_id
        AND s.coach_user_id = v_session_coach_fk
        AND s.start_at = v_start_at
        AND s.end_at = v_end_at
        AND s."is_online" = v_is_online
        AND (
          (v_is_online = true AND s.location_id IS NULL)
          OR
          (v_is_online = false AND s.location_id = v_location_id)
        )
    );

    i := i + 1;
  END LOOP;

  RAISE NOTICE '-----------------------------------------';
  RAISE NOTICE 'Seed completely successfully!';
  RAISE NOTICE 'Member % was given tokens for session_type %', v_member_user_id, v_session_type_id;
  RAISE NOTICE 'Coach profile % resolved to sessions.coach_user_id %; % sessions scheduled',
    v_coach_user_id, v_session_coach_fk, v_sessions_to_create;
  RAISE NOTICE '-----------------------------------------';
END $$;
