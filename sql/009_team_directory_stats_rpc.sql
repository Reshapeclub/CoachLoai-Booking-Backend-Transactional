-- Team tab: aggregate staff note counts in the database (avoid transferring every row)
create or replace function clm_staff_note_counts()
returns table (staff_id int, note_count bigint)
language sql
stable
parallel safe
as $$
  select sn.staff_id::int, count(*)::bigint
  from staff_notes sn
  group by sn.staff_id;
$$;

-- Team tab: week session counts per coach (single grouped query)
create or replace function clm_coach_week_session_counts(
  p_week_start timestamptz,
  p_week_end timestamptz,
  p_coach_ids uuid[]
)
returns table (coach_id uuid, cnt bigint)
language sql
stable
parallel safe
as $$
  select s.coach_id, count(*)::bigint
  from sessions s
  where not s.is_cancelled
    and s.start_at >= p_week_start
    and s.start_at < p_week_end
    and s.coach_id = any(p_coach_ids)
  group by s.coach_id;
$$;
