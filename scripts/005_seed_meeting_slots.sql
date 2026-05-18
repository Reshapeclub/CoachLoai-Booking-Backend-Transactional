-- Insert meeting_slots: several slots per day across consecutive days (SUPPORT by default).
-- Usage: adjust INPUTS, then run (psql, Supabase SQL editor, etc.).
--
-- Default: 5 calendar days starting v_first_day, 4 slots per day at v_slot_times (UTC wall clock).
-- For 3 slots per day, remove one entry from v_slot_times (keep 3 times).
--
-- slot_end = slot_start + meeting_types.duration_mins (30 for SUPPORT), unless
-- v_duration_mins_override is set.

DO $$
DECLARE
  -- ===== INPUTS =====
  v_meeting_type_code text := 'SUPPORT';
  v_location_slug text := 'ipswich';

  -- First calendar day to seed (inclusive)
  v_first_day date := CURRENT_DATE;

  -- How many consecutive days (e.g. 5 = today + next 4 days when v_first_day = today)
  v_num_days int := 5;

  -- Wall-clock times (UTC) for each slot on every day. Length = slots per day (3 or 4).
  v_slot_times time[] := ARRAY[
    time '09:00',
    time '11:00',
    time '14:00',
    time '16:00'
  ]::time[];

  v_capacity int := 1;
  v_is_active boolean := true;
  v_duration_mins_override int := NULL;

  -- ===== resolved =====
  v_meeting_type_id uuid;
  v_location_id uuid;
  v_duration_mins int;
  d int;
  slot_idx int;
  v_ts timestamp;
  v_start timestamptz;
  v_end timestamptz;
  v_n_slots int;
BEGIN
  IF v_num_days <= 0 THEN
    RAISE EXCEPTION 'v_num_days must be > 0';
  END IF;

  v_n_slots := array_length(v_slot_times, 1);
  IF v_n_slots IS NULL OR v_n_slots < 1 THEN
    RAISE EXCEPTION 'v_slot_times must have at least one time';
  END IF;

  SELECT id, duration_mins
  INTO v_meeting_type_id, v_duration_mins
  FROM meeting_types
  WHERE code = v_meeting_type_code
  LIMIT 1;

  IF v_meeting_type_id IS NULL THEN
    RAISE EXCEPTION 'meeting_types.code % not found', v_meeting_type_code;
  END IF;

  SELECT id INTO v_location_id
  FROM locations
  WHERE slug = v_location_slug
  LIMIT 1;

  IF v_location_id IS NULL THEN
    RAISE EXCEPTION 'locations.slug % not found', v_location_slug;
  END IF;

  IF v_duration_mins_override IS NOT NULL THEN
    IF v_duration_mins_override <= 0 THEN
      RAISE EXCEPTION 'v_duration_mins_override must be NULL or > 0';
    END IF;
    v_duration_mins := v_duration_mins_override;
  END IF;

  FOR d IN 0 .. (v_num_days - 1) LOOP
    FOR slot_idx IN 1 .. v_n_slots LOOP
      v_ts := (v_first_day + (d * interval '1 day'))::timestamp + v_slot_times[slot_idx];
      v_start := v_ts AT TIME ZONE 'UTC';
      v_end := v_start + (v_duration_mins * interval '1 minute');

      IF v_end <= v_start THEN
        RAISE EXCEPTION 'computed slot_end must be after slot_start (check duration)';
      END IF;

      INSERT INTO meeting_slots (
        meeting_type_id,
        location_id,
        slot_start,
        slot_end,
        capacity,
        is_active
      )
      VALUES (
        v_meeting_type_id,
        v_location_id,
        v_start,
        v_end,
        v_capacity,
        v_is_active
      )
      ON CONFLICT ON CONSTRAINT meeting_slots_unique DO NOTHING;
    END LOOP;
  END LOOP;
END $$;
