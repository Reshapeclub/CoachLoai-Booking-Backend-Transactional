-- Seed for 5 horizontal-scroll categories for the Online Tab
-- Populates session_types with colors and categories, gives member tokens, and schedules sessions.
-- Usage: Replace values in INPUTS and run in DB.

DO $$
DECLARE
  -- ===== INPUTS =====
  v_member_user_id uuid := '00000000-0000-0000-0000-000000000000'; -- REQUIRED (User to view/book)
  v_coach_user_id uuid := '00000000-0000-0000-0000-000000000000';  -- REQUIRED (Coach leading classes)

  -- Data structures
  v_membership_id uuid;
  v_now timestamptz := now();
  
  -- Array of record data to simulate the 5 categories
  -- Structure: name, category, color, duration_mins, difficulty
  class_defs text[][] := array[
    ['Tabata Torcher', 'HIIT and Conditioning', '#FF5733', '30', 'Advanced'],
    ['Cardio Blast', 'HIIT and Conditioning', '#FF8D1A', '45', 'Intermediate'],
    ['Heavy Lifts', 'Strength Training', '#335BFF', '60', 'Advanced'],
    ['Power Flow', 'Mobility and Yoga', '#00FFFF', '45', 'All Levels'],
    ['Abs of Steel', 'Core and Stability', '#800080', '30', 'Intermediate'],
    ['Deep Stretch', 'Recovery and Rehab', '#008000', '45', 'Beginner']
  ];
  
  v_class text[];
  v_type_id uuid;
  v_token_id uuid;
  v_start_at timestamptz;
BEGIN
  -- 1. Validate Users
  IF NOT EXISTS (SELECT 1 FROM profiles p WHERE p.id = v_member_user_id) THEN
    RAISE EXCEPTION 'Member user_id % not found in profiles', v_member_user_id;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM coaches c WHERE c.user_id = v_coach_user_id) THEN
    RAISE EXCEPTION 'Coach user_id % not found. Ensure they have a coach record.', v_coach_user_id;
  END IF;

  -- 2. Ensure Remote Membership
  INSERT INTO member_memberships (member_id, mode, current_package, status, start_date, end_date)
  VALUES (v_member_user_id, 'remote', 'pace', 'active', v_now - interval '1 day', v_now + interval '30 days')
  ON CONFLICT (member_id, mode) DO UPDATE
    SET status = 'active', is_paused = false, end_date = greatest(member_memberships.end_date, v_now + interval '30 days');

  SELECT id INTO v_membership_id FROM member_memberships WHERE member_id = v_member_user_id AND mode = 'remote';

  -- Loop through each structured definition
  FOREACH v_class SLICE 1 IN ARRAY class_defs LOOP
    
    -- 3. Create Session Type (with category, color, and difficulty)
    v_token_id := gen_random_uuid();
    INSERT INTO session_types (name, category, difficulty_level, color, token_type_id, default_capacity, default_duration_mins, is_active)
    VALUES (v_class[1], v_class[2], v_class[5], v_class[3], v_token_id, 500, v_class[4]::int, true)
    ON CONFLICT (name) DO UPDATE SET category = excluded.category, color = excluded.color, difficulty_level = excluded.difficulty_level;

    SELECT id, token_type_id INTO v_type_id, v_token_id FROM session_types WHERE name = v_class[1];

    -- 4. Set Permissions and Give Currency
    INSERT INTO membership_allowed_session_types (membership_id, session_type_id)
    VALUES (v_membership_id, v_type_id) ON CONFLICT DO NOTHING;
    
    INSERT INTO member_session_tags (member_id, session_type_id)
    VALUES (v_member_user_id, v_type_id) ON CONFLICT DO NOTHING;

    INSERT INTO tokens (member_id, token_type_id, quantity, week_start, expiry_at, source)
    VALUES (v_member_user_id, v_token_id, 10, date_trunc('week', v_now), v_now + interval '30 days', 'admin');

    -- 5. Create Sessions offset to appear "Live Now" or "Upcoming"
    -- We'll make the first item "Live Now" by setting start 5 mins ago, the remainder upcoming today
    IF v_class[1] = 'Tabata Torcher' THEN
       v_start_at := v_now - interval '5 minutes'; -- This makes it "LIVE NOW"
    ELSE
       -- Randomize upcoming sessions for later today
       v_start_at := v_now + make_interval(mins => (random() * 240 + 30)::int);
    END IF;

    INSERT INTO sessions (
      session_type_id, token_type_id, coach_user_id, location_id,
      start_at, end_at, capacity, is_cancelled, "is_online"
    )
    VALUES (
      v_type_id, v_token_id, v_coach_user_id, null,
      v_start_at, v_start_at + make_interval(mins => v_class[4]::int), 500, false, true
    );
    
  END LOOP;

  RAISE NOTICE '-----------------------------------------';
  RAISE NOTICE 'Online UI Data successfully seeded!';
  RAISE NOTICE 'Categories loaded: HIIT, Strength, Mobility, Core, Recovery.';
  RAISE NOTICE 'Tokens assigned for Member to book everything.';
  RAISE NOTICE '-----------------------------------------';
END $$;
