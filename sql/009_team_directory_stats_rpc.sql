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

  -- Team tab: utilization + no-show over a historical window per coach.
  -- Utilization = avg(booked_non_cancelled / capacity) across sessions in window.
  -- No-show = no_show_bookings / non_cancelled_bookings in window.
  create or replace function clm_coach_past_stats(
    p_window_start timestamptz,
    p_window_end timestamptz,
    p_coach_ids uuid[]
  )
  returns table (
    coach_id uuid,
    util_pct int,
    noshow_pct int
  )
  language sql
  stable
  parallel safe
  as $$
    with coach_sessions as (
      select s.id, s.coach_id, coalesce(s.capacity, 0)::int as capacity
      from sessions s
      where not s.is_cancelled
        and s.start_at >= p_window_start
        and s.start_at < p_window_end
        and s.coach_id = any(p_coach_ids)
    ),
    booking_rollup as (
      select
        cs.coach_id,
        cs.id as session_id,
        cs.capacity,
        count(*) filter (where b.status <> 'cancelled')::int as non_cancelled_count,
        count(*) filter (where b.status = 'no_show')::int as no_show_count
      from coach_sessions cs
      left join bookings b on b.session_id = cs.id
      group by cs.coach_id, cs.id, cs.capacity
    )
    select
      br.coach_id,
      round(
        avg(
          case
            when br.capacity > 0
              then least(br.non_cancelled_count::numeric / br.capacity::numeric, 1)
            else 0
          end
        ) * 100
      )::int as util_pct,
      round(
        case
          when sum(br.non_cancelled_count) > 0
            then (sum(br.no_show_count)::numeric / sum(br.non_cancelled_count)::numeric) * 100
          else 0
        end
      )::int as noshow_pct
    from booking_rollup br
    group by br.coach_id;
  $$;
