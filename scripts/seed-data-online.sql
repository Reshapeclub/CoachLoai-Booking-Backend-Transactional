-- Seed combined member eligibility, allowances, tokens, and dummy ONLINE sessions by coach.
-- Usage: 
--  1) Replace values in INPUTS (specifically user IDs).
--  2) Run in your DB.

DO $$
DECLARE
  -- ===== INPUTS: Member =====
  v_member_user_id uuid := '00000000-0000-0000-0000-000000000000'; -- REQUIRED
  v_mode membership_mode := 'remote';  -- Changed to remote                            
  v_package plan_tier := 'pace';                                     
  v_weekly_allowance int := 3;

  -- ===== INPUTS: Coach & Sessions =====
  v_coach_user_id uuid := '00000000-0000-0000-0000-000000000000'; -- REQUIRED
  v_session_type_name text := 'Online Tabata Torcher';
  v_session_duration int := 30;                                      
  v_session_capacity int := 100; -- Online classes typically have a larger capacity
  v_is_online boolean := true; -- Changed to true
  v_sessions_to_create int := 5;                                   
  v_start_day_offset int := 0; -- Target today                                    
  v_hour_of_day int := 18;     -- Target 6 PM                                       
  v_gap_days int := 1;                                              

  -- ===== internal vars =====
  v_membership_id uuid;
  v_session_type_id uuid;
  v_token_type_id uuid;
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

  -- 2. Ensure Session Type and Token Type exist
  INSERT INTO session_types (name, token_type_id, default_capacity, default_duration_mins, is_active)
  VALUES (v_session_type_name, gen_random_uuid(), v_session_capacity, v_session_duration, true)
  ON CONFLICT (name) DO NOTHING;

  SELECT id, token_type_id INTO v_session_type_id, v_token_type_id
  FROM session_types WHERE name = v_session_type_name;

  -- 3. Setup Member's Remote Membership
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

  -- 4. Setup Membership Linkages
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

  -- 5. Grant Active Tokens to the Member
  INSERT INTO tokens (member_id, token_type_id, quantity, week_start, expiry_at, source)
  VALUES (
    v_member_user_id,
    v_token_type_id,
    greatest(v_weekly_allowance, 1),
    date_trunc('week', now()),
    now() + interval '14 days',
    'weekly'
  );

  -- 6. Create the Dummy ONLINE Sessions
  i := 0;
  WHILE i < v_sessions_to_create LOOP
    v_start_at := date_trunc('day', now())
                  + make_interval(days => (v_start_day_offset + (i * v_gap_days)))
                  + make_interval(hours => v_hour_of_day);
    v_end_at := v_start_at + make_interval(mins => v_session_duration);

    -- Notice: location_id is NULL for online sessions
    INSERT INTO sessions (
      session_type_id, token_type_id, coach_user_id, location_id,
      start_at, end_at, capacity, is_cancelled, "is_online"
    )
    VALUES (
      v_session_type_id, v_token_type_id, v_coach_user_id, null,
      v_start_at, v_end_at, v_session_capacity, false, v_is_online
    );

    i := i + 1;
  END LOOP;

  RAISE NOTICE '-----------------------------------------';
  RAISE NOTICE 'Seed completely successfully for ONLINE Sessions!';
  RAISE NOTICE 'Member % was given tokens for session_type %', v_member_user_id, v_session_type_id;
  RAISE NOTICE 'Coach % has % online sessions scheduled', v_coach_user_id, v_sessions_to_create;
  RAISE NOTICE '-----------------------------------------';
END $$;
