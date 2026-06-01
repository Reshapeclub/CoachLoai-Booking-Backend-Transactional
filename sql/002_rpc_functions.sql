-- CLM Booking RPC Functions
-- Core: member_memberships + membership_pause_weeks

-- Monday 00:00 **UTC** (same convention as weekly-token-generation.ts getCurrentWeekStartIso).
-- Using session timezone here caused week_start on tokens to not match v_session_week in pick,
-- which led to "No valid token available" for future-week bookings.
create or replace function clm_current_week_start(p_now timestamptz)
returns timestamptz
language plpgsql
immutable
as $$
declare
  v_dow int;
  v_day date;
  v_start date;
begin
  v_day := (p_now at time zone 'utc')::date;
  v_dow := extract(dow from v_day);
  if v_dow = 0 then
    v_start := v_day - 6;
  else
    v_start := v_day - (v_dow - 1);
  end if;
  return (v_start::timestamp without time zone at time zone 'utc');
end;
$$;

-- Find active membership for booking: member_memberships with status/date range, not paused for current week
create or replace function clm_find_active_membership(p_member_id uuid, p_now timestamptz)
returns uuid
language plpgsql
as $$
declare
  v_membership_id uuid;
  v_week_start timestamptz;
begin
  v_week_start := clm_current_week_start(p_now);

  select mm.id into v_membership_id
  from member_memberships mm
  where mm.member_id = p_member_id
    and mm.status = 'active'
    and mm.mode = 'inperson'
    and mm.start_date <= p_now
    and mm.end_date > p_now
    and (mm.termination_date is null or p_now < mm.termination_date)
    and not exists (
      select 1 from membership_pause_weeks mpw
      where mpw.membership_id = mm.id and clm_current_week_start(mpw.week_start) = v_week_start
    )
  order by mm.created_at desc
  limit 1;

  return v_membership_id;
end;
$$;

create or replace function clm_find_membership_overlapping_window(
  p_member_id uuid,
  p_window_start timestamptz,
  p_window_end timestamptz
)
returns uuid
language plpgsql
as $$
declare
  v_membership_id uuid;
  v_end timestamptz;
begin
  v_end := p_window_end;
  if v_end is null or v_end <= p_window_start then
    v_end := p_window_start + interval '28 days';
  end if;

  select mm.id into v_membership_id
  from member_memberships mm
  where mm.member_id = p_member_id
    and mm.status = 'active'
    and mm.mode = 'inperson'
    and mm.start_date < v_end
    and mm.end_date > p_window_start
    and (mm.termination_date is null or mm.termination_date > p_window_start)
  order by mm.created_at desc
  limit 1;

  return v_membership_id;
end;
$$;

create or replace function clm_pick_token_id(
  p_member_id uuid,
  p_token_type_id uuid,
  p_now timestamptz,
  p_session_week timestamptz default null
)
returns uuid
language plpgsql
as $$
declare
  v_current_week timestamptz;
  v_next_week timestamptz;
  v_token_id uuid;
begin
  v_current_week := clm_current_week_start(p_now);
  v_next_week := v_current_week + interval '7 days';

  if p_session_week is not null then
    select t.id into v_token_id
    from tokens t
    where t.member_id = p_member_id and t.token_type_id = p_token_type_id and t.quantity > 0 and p_now < t.expiry_at
      and t.week_start is not null and clm_current_week_start(t.week_start) = clm_current_week_start(p_session_week)
    order by t.created_at asc limit 1 for update;
    if v_token_id is not null then return v_token_id; end if;
  end if;

  select t.id into v_token_id
  from tokens t
  where t.member_id = p_member_id and t.token_type_id = p_token_type_id and t.quantity > 0 and p_now < t.expiry_at
    and t.week_start is not null and clm_current_week_start(t.week_start) = v_current_week
  order by t.created_at asc limit 1 for update;
  if v_token_id is not null then return v_token_id; end if;

  select t.id into v_token_id
  from tokens t
  where t.member_id = p_member_id and t.token_type_id = p_token_type_id and t.quantity > 0 and p_now < t.expiry_at
    and (
      t.week_start is null
      or (t.week_start is not null and clm_current_week_start(t.week_start) < v_current_week)
    )
  order by coalesce(t.week_start, t.created_at) asc, t.created_at asc limit 1 for update;
  if v_token_id is not null then return v_token_id; end if;

  select t.id into v_token_id
  from tokens t
  where t.member_id = p_member_id and t.token_type_id = p_token_type_id and t.quantity > 0 and p_now < t.expiry_at
    and t.week_start is not null and clm_current_week_start(t.week_start) = v_next_week
  order by t.created_at asc limit 1 for update;

  return v_token_id;
end;
$$;

-- Map training-plan allocation_key to session_types.category label.
create or replace function clm_allocation_key_category(p_key text)
returns text
language sql
immutable
as $$
  select case p_key
    when 'oneToOne' then '1:1'
    when 'elite' then 'Elite'
    when 'octave' then 'Octave'
    when 'group' then 'Group'
    else null
  end;
$$;

-- Session falls within member_memberships dates (respecting termination).
create or replace function clm_session_within_membership_window(
  p_membership member_memberships,
  p_session_at timestamptz
)
returns boolean
language plpgsql
stable
as $$
begin
  if p_session_at < p_membership.start_date then return false; end if;
  if p_session_at >= p_membership.end_date then return false; end if;
  if p_membership.termination_date is not null and p_session_at >= p_membership.termination_date then
    return false;
  end if;
  return true;
end;
$$;

-- Queued training plan covering session date (earliest start wins).
create or replace function clm_queued_plan_weekly_allowance(
  p_membership_id uuid,
  p_token_type_id uuid,
  p_session_at timestamptz
)
returns int
language plpgsql
stable
as $$
declare
  v_session_ymd date;
  v_allowance int;
begin
  v_session_ymd := (p_session_at at time zone 'utc')::date;

  select mtpa.allocation_value into v_allowance
  from membership_training_plans mtp
  join membership_training_plan_allocations mtpa
    on mtpa.training_plan_id = mtp.id
  join session_types st
    on st.token_type_id = p_token_type_id
    and lower(trim(st.category)) = lower(trim(clm_allocation_key_category(mtpa.allocation_key)))
  where mtp.membership_id = p_membership_id
    and mtp.status = 'queued'
    and mtp.allocation_mode = 'sessions'
    and mtpa.allocation_value > 0
    and mtp.start_date <= v_session_ymd
    and (mtp.end_date is null or mtp.end_date >= v_session_ymd)
  order by mtp.start_date asc
  limit 1;

  return coalesce(v_allowance, 0);
end;
$$;

-- Allowance for cap/tokens: live MM row when session is in that window, else queued plan.
create or replace function clm_effective_weekly_allowance(
  p_membership_id uuid,
  p_token_type_id uuid,
  p_session_at timestamptz
)
returns int
language plpgsql
stable
as $$
declare
  v_mm member_memberships%rowtype;
  v_mm_allowance int;
begin
  select * into v_mm from member_memberships where id = p_membership_id;
  if not found then return 0; end if;

  if clm_session_within_membership_window(v_mm, p_session_at) then
    select coalesce(msa.weekly_allowance, 0) into v_mm_allowance
    from membership_session_allowances msa
    where msa.membership_id = p_membership_id
      and msa.token_type_id = p_token_type_id;
    return coalesce(v_mm_allowance, 0);
  end if;

  return clm_queued_plan_weekly_allowance(p_membership_id, p_token_type_id, p_session_at);
end;
$$;

create or replace function clm_session_allowed_for_membership(
  p_membership_id uuid,
  p_session_at timestamptz
)
returns boolean
language plpgsql
stable
as $$
declare
  v_mm member_memberships%rowtype;
begin
  select * into v_mm from member_memberships where id = p_membership_id;
  if not found then return false; end if;

  if clm_session_within_membership_window(v_mm, p_session_at) then
    return true;
  end if;

  return exists (
    select 1
    from membership_training_plans mtp
    where mtp.membership_id = p_membership_id
      and mtp.status = 'queued'
      and mtp.start_date <= (p_session_at at time zone 'utc')::date
      and (mtp.end_date is null or mtp.end_date >= (p_session_at at time zone 'utc')::date)
  );
end;
$$;

-- Calendar week overlaps member_memberships window and/or a queued training plan.
create or replace function clm_week_covered_by_membership_or_queued(
  p_membership_id uuid,
  p_week_start timestamptz
)
returns boolean
language plpgsql
stable
as $$
declare
  v_mm member_memberships%rowtype;
  v_week_end date;
  v_week_start_ymd date;
begin
  select * into v_mm from member_memberships where id = p_membership_id;
  if not found then return false; end if;

  v_week_start_ymd := (p_week_start at time zone 'utc')::date;
  v_week_end := (p_week_start + interval '7 days')::date;

  if p_week_start < v_mm.end_date and p_week_start + interval '7 days' > v_mm.start_date then
    return true;
  end if;

  return exists (
    select 1
    from membership_training_plans mtp
    where mtp.membership_id = p_membership_id
      and mtp.status = 'queued'
      and mtp.start_date < v_week_end
      and (mtp.end_date is null or mtp.end_date >= v_week_start_ymd)
  );
end;
$$;

create or replace function clm_ensure_weekly_tokens_for_membership_week(
  p_membership_id uuid,
  p_week_start timestamptz,
  p_now timestamptz default now()
)
returns void
language plpgsql
as $$
declare
  v_mm member_memberships%rowtype;
  v_row record;
begin
  select * into v_mm from member_memberships where id = p_membership_id;
  if not found then return; end if;

  if v_mm.status <> 'active' then return; end if;
  -- Issue tokens for weeks overlapping MM and/or a queued plan (future queued-only weeks included).
  if not clm_week_covered_by_membership_or_queued(p_membership_id, p_week_start) then return; end if;
  if clm_session_within_membership_window(v_mm, p_week_start + interval '3 days')
     and v_mm.termination_date is not null
     and p_week_start >= v_mm.termination_date then
    return;
  end if;
  if exists (
    select 1 from membership_pause_weeks mpw
    where mpw.membership_id = v_mm.id and clm_current_week_start(mpw.week_start) = clm_current_week_start(p_week_start)
  ) then return; end if;

  for v_row in
    select
      x.token_type_id,
      clm_effective_weekly_allowance(
        v_mm.id,
        x.token_type_id,
        p_week_start + interval '3 days'
      ) as weekly_allowance
    from (
      select msa.token_type_id
      from membership_session_allowances msa
      where msa.membership_id = v_mm.id
      union
      select st.token_type_id
      from membership_training_plans mtp
      join membership_training_plan_allocations mtpa
        on mtpa.training_plan_id = mtp.id
      join session_types st
        on lower(trim(st.category)) = lower(trim(clm_allocation_key_category(mtpa.allocation_key)))
      where mtp.membership_id = v_mm.id
        and mtp.status = 'queued'
        and mtp.allocation_mode = 'sessions'
        and mtpa.allocation_value > 0
        and mtp.start_date < (p_week_start + interval '7 days')::date
        and (mtp.end_date is null or mtp.end_date >= (p_week_start at time zone 'utc')::date)
    ) x
  loop
    if coalesce(v_row.weekly_allowance, 0) <= 0 then
      continue;
    end if;

    if not exists (
      select 1 from tokens t
      where t.member_id = v_mm.member_id
        and t.token_type_id = v_row.token_type_id
        and t.week_start is not null
        and clm_current_week_start(t.week_start) = clm_current_week_start(p_week_start)
        and t.source = 'weekly'
    ) then
      insert into tokens(member_id, token_type_id, quantity, week_start, expiry_at, source, source_meta)
      values (
        v_mm.member_id,
        v_row.token_type_id,
        v_row.weekly_allowance,
        p_week_start,
        p_week_start + interval '14 days',
        'weekly',
        jsonb_build_object('weekStart', p_week_start)
      );
    end if;
  end loop;
end;
$$;

-- Active bookings in the session's calendar week for a token type (optional booking to exclude on rebook).
create or replace function clm_count_member_week_bookings(
  p_member_id uuid,
  p_token_type_id uuid,
  p_session_week timestamptz,
  p_exclude_booking_id uuid default null
)
returns int
language plpgsql
stable
as $$
declare
  v_count int;
begin
  select count(*)::int into v_count
  from bookings b
  join sessions s on s.id = b.session_id
  where b.member_id = p_member_id
    and b.status = 'booked'
    and s.token_type_id = p_token_type_id
    and clm_current_week_start(s.start_at) = clm_current_week_start(p_session_week)
    and (p_exclude_booking_id is null or b.id <> p_exclude_booking_id);

  return coalesce(v_count, 0);
end;
$$;

-- Mint weekly tokens for session week plus current/next week (advance booking spend).
create or replace function clm_ensure_weekly_tokens_for_booking(
  p_membership_id uuid,
  p_session_week timestamptz,
  p_now timestamptz default now()
)
returns void
language plpgsql
as $$
declare
  v_current_week timestamptz;
begin
  v_current_week := clm_current_week_start(p_now);
  perform clm_ensure_weekly_tokens_for_membership_week(p_membership_id, v_current_week, p_now);
  perform clm_ensure_weekly_tokens_for_membership_week(p_membership_id, v_current_week + interval '7 days', p_now);
  perform clm_ensure_weekly_tokens_for_membership_week(
    p_membership_id,
    clm_current_week_start(p_session_week),
    p_now
  );
end;
$$;

-- Resolve the membership that should mint weekly tokens for a specific token type/week.
-- Prefers active in-person memberships that actually provide allowance for that week.
create or replace function clm_resolve_membership_for_token_week(
  p_member_id uuid,
  p_token_type_id uuid,
  p_week_start timestamptz,
  p_now timestamptz default now()
)
returns uuid
language plpgsql
stable
as $$
declare
  v_membership_id uuid;
begin
  select mm.id
  into v_membership_id
  from member_memberships mm
  where mm.member_id = p_member_id
    and mm.status = 'active'
    and mm.mode = 'inperson'
    and clm_week_covered_by_membership_or_queued(mm.id, clm_current_week_start(p_week_start))
    and not exists (
      select 1
      from membership_pause_weeks mpw
      where mpw.membership_id = mm.id
        and clm_current_week_start(mpw.week_start) = clm_current_week_start(p_week_start)
    )
    and clm_effective_weekly_allowance(
      mm.id,
      p_token_type_id,
      clm_current_week_start(p_week_start) + interval '3 days'
    ) > 0
  order by mm.created_at desc
  limit 1;

  return v_membership_id;
end;
$$;

-- Mint weekly tokens for booking using the entitlement-bearing membership per target week
-- (current week, session week, and following session week) so next-week borrow is always mintable.
create or replace function clm_ensure_weekly_tokens_for_booking_token(
  p_member_id uuid,
  p_token_type_id uuid,
  p_fallback_membership_id uuid,
  p_session_week timestamptz,
  p_now timestamptz default now()
)
returns void
language plpgsql
as $$
declare
  v_current_week timestamptz;
  v_target_week timestamptz;
  v_membership_id uuid;
begin
  v_current_week := clm_current_week_start(p_now);

  foreach v_target_week in array array[
    v_current_week,
    clm_current_week_start(p_session_week),
    clm_current_week_start(p_session_week) + interval '7 days'
  ] loop
    v_membership_id := clm_resolve_membership_for_token_week(
      p_member_id,
      p_token_type_id,
      v_target_week,
      p_now
    );
    if v_membership_id is null then
      v_membership_id := p_fallback_membership_id;
    end if;
    if v_membership_id is not null then
      perform clm_ensure_weekly_tokens_for_membership_week(v_membership_id, v_target_week, p_now);
    end if;
  end loop;
end;
$$;

-- Weekly token available for booking (session week → older → next session-week), non-locking.
create or replace function clm_has_weekly_token_advance(
  p_member_id uuid,
  p_token_type_id uuid,
  p_session_week timestamptz,
  p_now timestamptz
)
returns boolean
language plpgsql
stable
as $$
declare
  v_next_week timestamptz;
  v_session_week_norm timestamptz;
begin
  v_session_week_norm := clm_current_week_start(p_session_week);
  v_next_week := v_session_week_norm + interval '7 days';

  if exists (
    select 1 from tokens t
    where t.member_id = p_member_id
      and t.token_type_id = p_token_type_id
      and t.quantity > 0
      and p_now < t.expiry_at
      and t.source = 'weekly'
      and t.week_start is not null
      and clm_current_week_start(t.week_start) = v_session_week_norm
  ) then
    return true;
  end if;

  if exists (
    select 1 from tokens t
    where t.member_id = p_member_id
      and t.token_type_id = p_token_type_id
      and t.quantity > 0
      and p_now < t.expiry_at
      and t.source = 'weekly'
      and t.week_start is not null
      and clm_current_week_start(t.week_start) < v_session_week_norm
  ) then
    return true;
  end if;

  if v_session_week_norm <> v_next_week and exists (
    select 1 from tokens t
    where t.member_id = p_member_id
      and t.token_type_id = p_token_type_id
      and t.quantity > 0
      and p_now < t.expiry_at
      and t.source = 'weekly'
      and t.week_start is not null
      and clm_current_week_start(t.week_start) = v_next_week
  ) then
    return true;
  end if;

  return false;
end;
$$;

-- Pick weekly token: session week → older → next session-week.
create or replace function clm_pick_weekly_token_advance(
  p_member_id uuid,
  p_token_type_id uuid,
  p_session_week timestamptz,
  p_now timestamptz
)
returns uuid
language plpgsql
as $$
declare
  v_next_week timestamptz;
  v_session_week_norm timestamptz;
  v_token_id uuid;
begin
  v_session_week_norm := clm_current_week_start(p_session_week);
  v_next_week := v_session_week_norm + interval '7 days';

  select t.id into v_token_id
  from tokens t
  where t.member_id = p_member_id
    and t.token_type_id = p_token_type_id
    and t.quantity > 0
    and p_now < t.expiry_at
    and t.source = 'weekly'
    and t.week_start is not null
    and clm_current_week_start(t.week_start) = v_session_week_norm
  order by t.created_at asc
  limit 1
  for update;
  if v_token_id is not null then return v_token_id; end if;

  select t.id into v_token_id
  from tokens t
  where t.member_id = p_member_id
    and t.token_type_id = p_token_type_id
    and t.quantity > 0
    and p_now < t.expiry_at
    and t.source = 'weekly'
    and t.week_start is not null
    and clm_current_week_start(t.week_start) < v_session_week_norm
  order by coalesce(t.week_start, t.created_at) asc, t.created_at asc
  limit 1
  for update;
  if v_token_id is not null then return v_token_id; end if;

  if v_session_week_norm <> v_next_week then
    select t.id into v_token_id
    from tokens t
    where t.member_id = p_member_id
      and t.token_type_id = p_token_type_id
      and t.quantity > 0
      and p_now < t.expiry_at
      and t.source = 'weekly'
      and t.week_start is not null
      and clm_current_week_start(t.week_start) = v_next_week
    order by t.created_at asc
    limit 1
    for update;
  end if;

  return v_token_id;
end;
$$;

-- Overflow weekly tokens usable beyond the session-week allocation:
-- older than session week, or the following week relative to `p_session_week`.
create or replace function clm_has_older_weekly_token(
  p_member_id uuid,
  p_token_type_id uuid,
  p_session_week timestamptz,
  p_now timestamptz
)
returns boolean
language plpgsql
stable
as $$
declare
  v_session_week_norm timestamptz;
  v_next_week timestamptz;
begin
  v_session_week_norm := clm_current_week_start(p_session_week);
  v_next_week := v_session_week_norm + interval '7 days';
  return exists (
    select 1
    from tokens t
    where t.member_id = p_member_id
      and t.token_type_id = p_token_type_id
      and t.quantity > 0
      and p_now < t.expiry_at
      and t.source = 'weekly'
      and t.week_start is not null
      and (
        clm_current_week_start(t.week_start) < v_session_week_norm
        or (
          clm_current_week_start(t.week_start) = v_next_week
          and clm_current_week_start(t.week_start) <> v_session_week_norm
        )
      )
  );
end;
$$;

create or replace function clm_pick_older_weekly_token(
  p_member_id uuid,
  p_token_type_id uuid,
  p_session_week timestamptz,
  p_now timestamptz
)
returns uuid
language plpgsql
as $$
declare
  v_session_week_norm timestamptz;
  v_next_week timestamptz;
  v_token_id uuid;
begin
  v_session_week_norm := clm_current_week_start(p_session_week);
  v_next_week := v_session_week_norm + interval '7 days';
  select t.id into v_token_id
  from tokens t
  where t.member_id = p_member_id
    and t.token_type_id = p_token_type_id
    and t.quantity > 0
    and p_now < t.expiry_at
    and t.source = 'weekly'
    and t.week_start is not null
    and (
      clm_current_week_start(t.week_start) < v_session_week_norm
      or (
        clm_current_week_start(t.week_start) = v_next_week
        and clm_current_week_start(t.week_start) <> v_session_week_norm
      )
    )
  order by coalesce(t.week_start, t.created_at) asc, t.created_at asc
  limit 1
  for update;
  return v_token_id;
end;
$$;

-- Pick token for booking: weekly allowance capped per session week; weekly spend uses
-- session week → older → next session-week; overflow past-week/following-week tokens
-- after allocation is full; extras use purchase/admin/gift.
create or replace function clm_pick_token_for_booking(
  p_member_id uuid,
  p_membership_id uuid,
  p_token_type_id uuid,
  p_session_week timestamptz,
  p_now timestamptz,
  p_exclude_booking_id uuid default null
)
returns uuid
language plpgsql
as $$
declare
  v_weekly_allowance int;
  v_week_bookings int;
  v_token_id uuid;
begin
  v_weekly_allowance := clm_effective_weekly_allowance(
    p_membership_id,
    p_token_type_id,
    p_session_week + interval '3 days'
  );

  v_week_bookings := clm_count_member_week_bookings(
    p_member_id,
    p_token_type_id,
    p_session_week,
    p_exclude_booking_id
  );

  if v_week_bookings < v_weekly_allowance then
    v_token_id := clm_pick_weekly_token_advance(
      p_member_id,
      p_token_type_id,
      p_session_week,
      p_now
    );
    if v_token_id is not null then
      return v_token_id;
    end if;
  end if;

  -- Overflow weekly tokens after this session week's allocation is used up:
  -- past-week rollover first, plus next-week borrow (max 1 week ahead from now).
  if v_week_bookings >= v_weekly_allowance then
    v_token_id := clm_pick_older_weekly_token(p_member_id, p_token_type_id, p_session_week, p_now);
    if v_token_id is not null then
      return v_token_id;
    end if;
  end if;

  select t.id into v_token_id
  from tokens t
  where t.member_id = p_member_id
    and t.token_type_id = p_token_type_id
    and t.quantity > 0
    and p_now < t.expiry_at
    and t.source in ('purchase', 'admin', 'gift')
  order by t.created_at asc
  limit 1
  for update;

  if v_token_id is not null then
    return v_token_id;
  end if;

  if v_week_bookings >= v_weekly_allowance and not clm_has_older_weekly_token(p_member_id, p_token_type_id, p_session_week, p_now) then
    raise exception 'Weekly session limit reached for this session type';
  end if;

  raise exception 'No valid token available';
end;
$$;

-- Non-locking availability check (waitlist join).
create or replace function clm_has_token_for_booking(
  p_member_id uuid,
  p_membership_id uuid,
  p_token_type_id uuid,
  p_session_week timestamptz,
  p_now timestamptz,
  p_exclude_booking_id uuid default null
)
returns boolean
language plpgsql
stable
as $$
declare
  v_weekly_allowance int;
  v_week_bookings int;
begin
  v_weekly_allowance := clm_effective_weekly_allowance(
    p_membership_id,
    p_token_type_id,
    p_session_week + interval '3 days'
  );

  v_week_bookings := clm_count_member_week_bookings(
    p_member_id,
    p_token_type_id,
    p_session_week,
    p_exclude_booking_id
  );

  if v_week_bookings < v_weekly_allowance then
    if clm_has_weekly_token_advance(p_member_id, p_token_type_id, p_session_week, p_now) then
      return true;
    end if;
  end if;

  if v_week_bookings >= v_weekly_allowance and clm_has_older_weekly_token(p_member_id, p_token_type_id, p_session_week, p_now) then
    return true;
  end if;

  return exists (
    select 1
    from tokens t
    where t.member_id = p_member_id
      and t.token_type_id = p_token_type_id
      and t.quantity > 0
      and p_now < t.expiry_at
      and t.source in ('purchase', 'admin', 'gift')
  );
end;
$$;

create or replace function clm_create_booking(
  p_member_id uuid,
  p_membership_id uuid,
  p_session_id uuid,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
as $$
declare
  v_membership member_memberships%rowtype;
  v_session sessions%rowtype;
  v_member profiles%rowtype;
  v_booked_count int;
  v_session_week timestamptz;
  v_duplicate_count int;
  v_booking_id uuid;
  v_token_id uuid;
  v_token_week_start timestamptz;
  v_horizon timestamptz;
begin
  select * into v_membership from member_memberships where id = p_membership_id and member_id = p_member_id for update;
  if not found then raise exception 'Membership not found'; end if;

  select * into v_session from sessions where id = p_session_id for update;
  if not found then raise exception 'Session not found'; end if;

  select * into v_member from profiles where id = p_member_id;
  if not found then raise exception 'Member not found'; end if;

  v_session_week := clm_current_week_start(v_session.start_at);
  v_horizon := p_now + interval '28 days';

  -- If caller passed a membership that cannot fund this token type/session, try another
  -- membership for the same member that is valid for this session (including queued plans).
  if (
    not clm_session_allowed_for_membership(v_membership.id, v_session.start_at)
    or clm_effective_weekly_allowance(v_membership.id, v_session.token_type_id, v_session.start_at) <= 0
  ) then
    select mm.*
    into v_membership
    from member_memberships mm
    where mm.member_id = p_member_id
      and mm.status = 'active'
      and (
        clm_session_within_membership_window(mm, v_session.start_at)
        or exists (
          select 1
          from membership_training_plans mtp
          where mtp.membership_id = mm.id
            and mtp.status = 'queued'
            and mtp.start_date <= (v_session.start_at at time zone 'utc')::date
            and (mtp.end_date is null or mtp.end_date >= (v_session.start_at at time zone 'utc')::date)
        )
      )
      and clm_effective_weekly_allowance(mm.id, v_session.token_type_id, v_session.start_at) > 0
    order by mm.created_at desc
    limit 1;
  end if;

  if not clm_session_allowed_for_membership(v_membership.id, v_session.start_at) then
    raise exception 'Membership not active for this session';
  end if;
  -- Block only when the session falls in a paused week (not merely because today is in a paused week).
  if exists (select 1 from membership_pause_weeks mpw where mpw.membership_id = v_membership.id and clm_current_week_start(mpw.week_start) = v_session_week) then raise exception 'Cannot book in paused week'; end if;
  if v_session.start_at > v_horizon then raise exception 'Session beyond booking horizon'; end if;
  if v_session.start_at <= p_now then raise exception 'Session has already started/completed'; end if;
  if not coalesce(v_session.is_online, false) and v_session.location_id is not null then
    if not exists (
      select 1
      from member_location_access mla
      where mla.member_id = p_member_id
        and (
          lower(regexp_replace(coalesce(mla.location_code, ''), '[^a-z0-9]+', '', 'g'))
          =
          lower(regexp_replace(coalesce((select l.slug from locations l where l.id = v_session.location_id), ''), '[^a-z0-9]+', '', 'g'))
          or
          lower(regexp_replace(coalesce(mla.location_code, ''), '[^a-z0-9]+', '', 'g'))
          =
          lower(regexp_replace(coalesce((select l.name from locations l where l.id = v_session.location_id), ''), '[^a-z0-9]+', '', 'g'))
        )
    ) and v_member.location_id is distinct from v_session.location_id then
      raise exception 'Location mismatch';
    end if;
  end if;
  if clm_effective_weekly_allowance(v_membership.id, v_session.token_type_id, v_session.start_at) <= 0 then
    raise exception 'Session not covered by membership allowance';
  end if;
  --if not exists (select 1 from member_session_tags mst where mst.member_id = p_member_id and mst.session_type_id = v_session.session_type_id) then raise exception 'Session type not allowed by user tags'; end if;

  select count(*) into v_duplicate_count
  from bookings b join sessions s on s.id=b.session_id
  where b.member_id=p_member_id and b.status='booked' and s.start_at=v_session.start_at;
  if v_duplicate_count > 0 then raise exception 'Duplicate booking at same time'; end if;

  select count(*) into v_booked_count from bookings where session_id=v_session.id and status='booked';
  if v_booked_count >= v_session.capacity then raise exception 'Session full'; end if;

  perform clm_ensure_weekly_tokens_for_booking_token(
    p_member_id,
    v_session.token_type_id,
    v_membership.id,
    v_session_week,
    p_now
  );
  v_token_id := clm_pick_token_for_booking(
    p_member_id,
    v_membership.id,
    v_session.token_type_id,
    v_session_week,
    p_now
  );

  update tokens set quantity = quantity - 1 where id = v_token_id and quantity > 0;
  if not found then raise exception 'Token deduction failed'; end if;

  insert into bookings(member_id, session_id, status, booked_at)
  values (p_member_id, v_session.id, 'booked', p_now)
  returning id into v_booking_id;

  select week_start into v_token_week_start from tokens where id = v_token_id;
  insert into booking_token_deductions(booking_id, token_id, token_type_id, quantity, token_week_start)
  values (v_booking_id, v_token_id, v_session.token_type_id, 1, v_token_week_start);

  insert into audit_logs(actor_type, actor_id, action, meta)
  values ('member', p_member_id, 'booking.create', jsonb_build_object('bookingId', v_booking_id, 'sessionId', v_session.id));

  insert into notifications(member_id, channel, type, payload)
  values
    (p_member_id, 'in_app', 'booking_confirmed', jsonb_build_object('bookingId', v_booking_id, 'sessionId', v_session.id, 'sessionStartAt', v_session.start_at, 'sessionEndAt', v_session.end_at, 'locationName', (select l.name from locations l where l.id = v_session.location_id))),
    (p_member_id, 'email', 'booking_confirmed', jsonb_build_object('bookingId', v_booking_id, 'sessionId', v_session.id, 'sessionStartAt', v_session.start_at, 'sessionEndAt', v_session.end_at, 'locationName', (select l.name from locations l where l.id = v_session.location_id)));

  return jsonb_build_object('ok', true, 'bookingId', v_booking_id, 'sessionId', v_session.id, 'tokenId', v_token_id, 'tokenWeekStart', v_token_week_start);
end;
$$;

create or replace function clm_process_waitlist_after_opening(p_session_id uuid, p_now timestamptz default now())
returns jsonb
language plpgsql
as $$
declare
  v_session sessions%rowtype;
  v_entry record;
  v_membership_id uuid;
  v_result jsonb;
begin
  select * into v_session from sessions where id = p_session_id for update;
  if not found then return jsonb_build_object('ok', false, 'message', 'Session not found'); end if;

  if (extract(epoch from (v_session.start_at - p_now)) / 3600.0) <= 24 then
    insert into notifications(member_id, channel, type, payload)
    select w.member_id, 'in_app', 'waitlist_space_available', jsonb_build_object('sessionId', p_session_id)
    from waiting_list_entries w where w.session_id = p_session_id;
    insert into notifications(member_id, channel, type, payload)
    select w.member_id, 'email', 'waitlist_space_available', jsonb_build_object('sessionId', p_session_id)
    from waiting_list_entries w where w.session_id = p_session_id;
    return jsonb_build_object('ok', true, 'mode', 'notify_only');
  end if;

  for v_entry in select * from waiting_list_entries where session_id = p_session_id order by joined_at asc loop
    v_membership_id := clm_find_active_membership(v_entry.member_id, p_now);
    if v_membership_id is null then delete from waiting_list_entries where id = v_entry.id; continue; end if;
    begin
      v_result := clm_create_booking(v_entry.member_id, v_membership_id, p_session_id, p_now);
      delete from waiting_list_entries where id = v_entry.id;
      return jsonb_build_object('ok', true, 'mode', 'auto_allocate', 'result', v_result);
    exception when others then
      delete from waiting_list_entries where id = v_entry.id;
      continue;
    end;
  end loop;

  return jsonb_build_object('ok', true, 'mode', 'no_candidate');
end;
$$;

create or replace function clm_cancel_booking(p_member_id uuid, p_booking_id uuid, p_now timestamptz default now())
returns jsonb
language plpgsql
as $$
declare
  v_booking bookings%rowtype;
  v_session sessions%rowtype;
  v_refund boolean;
  v_waitlist_result jsonb;
begin
  select * into v_booking from bookings where id = p_booking_id and member_id = p_member_id and status = 'booked' for update;
  if not found then raise exception 'Active booking not found'; end if;
  select * into v_session from sessions where id = v_booking.session_id;
  if not found then raise exception 'Session not found'; end if;

  v_refund := (extract(epoch from (v_session.start_at - p_now)) / 3600.0) >= 24;
  update bookings set status='cancelled', cancelled_at=p_now where id=v_booking.id;

  if v_refund then
    update tokens t set quantity = t.quantity + d.quantity
    from booking_token_deductions d where d.booking_id=v_booking.id and d.token_id=t.id;
  end if;

  insert into audit_logs(actor_type, actor_id, action, meta)
  values ('member', p_member_id, 'booking.cancel', jsonb_build_object('bookingId', v_booking.id, 'refundApplied', v_refund));

  insert into notifications(member_id, channel, type, payload)
  values
    (p_member_id, 'in_app', 'booking_cancelled', jsonb_build_object('bookingId', v_booking.id, 'refundApplied', v_refund, 'sessionId', v_session.id, 'sessionStartAt', v_session.start_at, 'sessionEndAt', v_session.end_at, 'locationName', (select l.name from locations l where l.id = v_session.location_id))),
    (p_member_id, 'email', 'booking_cancelled', jsonb_build_object('bookingId', v_booking.id, 'refundApplied', v_refund, 'sessionId', v_session.id, 'sessionStartAt', v_session.start_at, 'sessionEndAt', v_session.end_at, 'locationName', (select l.name from locations l where l.id = v_session.location_id)));

  v_waitlist_result := clm_process_waitlist_after_opening(v_session.id, p_now);
  return jsonb_build_object('ok', true, 'bookingId', v_booking.id, 'refundApplied', v_refund, 'waitlist', v_waitlist_result);
end;
$$;

create or replace function clm_rebook_booking(
  p_member_id uuid,
  p_booking_id uuid,
  p_membership_id uuid,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
as $$
declare
  v_booking bookings%rowtype;
  v_membership member_memberships%rowtype;
  v_session sessions%rowtype;
  v_member profiles%rowtype;
  v_booked_count int;
  v_session_week timestamptz;
  v_duplicate_count int;
  v_token_id uuid;
  v_token_week_start timestamptz;
  v_horizon timestamptz;
begin
  select * into v_booking from bookings where id = p_booking_id and member_id = p_member_id and status = 'cancelled' for update;
  if not found then raise exception 'Cancelled booking not found'; end if;

  select * into v_membership from member_memberships where id = p_membership_id and member_id = p_member_id for update;
  if not found then raise exception 'Membership not found'; end if;

  select * into v_session from sessions where id = v_booking.session_id for update;
  if not found then raise exception 'Session not found'; end if;

  select * into v_member from profiles where id = p_member_id;
  if not found then raise exception 'Member not found'; end if;

  if exists (
    select 1 from bookings b
    where b.member_id = p_member_id and b.session_id = v_session.id and b.status = 'booked' and b.id <> v_booking.id
  ) then
    raise exception 'Already booked for this session';
  end if;

  v_session_week := clm_current_week_start(v_session.start_at);
  v_horizon := p_now + interval '28 days';

  -- Resolve to a membership that can fund this token type/session when possible.
  if (
    not clm_session_allowed_for_membership(v_membership.id, v_session.start_at)
    or clm_effective_weekly_allowance(v_membership.id, v_session.token_type_id, v_session.start_at) <= 0
  ) then
    select mm.*
    into v_membership
    from member_memberships mm
    where mm.member_id = p_member_id
      and mm.status = 'active'
      and (
        clm_session_within_membership_window(mm, v_session.start_at)
        or exists (
          select 1
          from membership_training_plans mtp
          where mtp.membership_id = mm.id
            and mtp.status = 'queued'
            and mtp.start_date <= (v_session.start_at at time zone 'utc')::date
            and (mtp.end_date is null or mtp.end_date >= (v_session.start_at at time zone 'utc')::date)
        )
      )
      and clm_effective_weekly_allowance(mm.id, v_session.token_type_id, v_session.start_at) > 0
    order by mm.created_at desc
    limit 1;
  end if;

  if not clm_session_allowed_for_membership(v_membership.id, v_session.start_at) then
    raise exception 'Membership not active for this session';
  end if;
  if exists (select 1 from membership_pause_weeks mpw where mpw.membership_id = v_membership.id and clm_current_week_start(mpw.week_start) = v_session_week) then raise exception 'Cannot book in paused week'; end if;
  if v_session.start_at > v_horizon then raise exception 'Session beyond booking horizon'; end if;
  if v_session.start_at <= p_now then raise exception 'Session has already started/completed'; end if;
  if coalesce(v_session.is_cancelled, false) then raise exception 'Session has been cancelled'; end if;

  if not coalesce(v_session.is_online, false) and v_session.location_id is not null then
    if not exists (
      select 1
      from member_location_access mla
      where mla.member_id = p_member_id
        and (
          lower(regexp_replace(coalesce(mla.location_code, ''), '[^a-z0-9]+', '', 'g'))
          =
          lower(regexp_replace(coalesce((select l.slug from locations l where l.id = v_session.location_id), ''), '[^a-z0-9]+', '', 'g'))
          or
          lower(regexp_replace(coalesce(mla.location_code, ''), '[^a-z0-9]+', '', 'g'))
          =
          lower(regexp_replace(coalesce((select l.name from locations l where l.id = v_session.location_id), ''), '[^a-z0-9]+', '', 'g'))
        )
    ) and v_member.location_id is distinct from v_session.location_id then
      raise exception 'Location mismatch';
    end if;
  end if;
  if clm_effective_weekly_allowance(v_membership.id, v_session.token_type_id, v_session.start_at) <= 0 then
    raise exception 'Session not covered by membership allowance';
  end if;

  select count(*) into v_duplicate_count
  from bookings b join sessions s on s.id = b.session_id
  where b.member_id = p_member_id and b.status = 'booked' and s.start_at = v_session.start_at and b.id <> v_booking.id;
  if v_duplicate_count > 0 then raise exception 'Duplicate booking at same time'; end if;

  select count(*) into v_booked_count from bookings where session_id = v_session.id and status = 'booked';
  if v_booked_count >= v_session.capacity then raise exception 'Session full'; end if;

  perform clm_ensure_weekly_tokens_for_booking_token(
    p_member_id,
    v_session.token_type_id,
    v_membership.id,
    v_session_week,
    p_now
  );
  v_token_id := clm_pick_token_for_booking(
    p_member_id,
    v_membership.id,
    v_session.token_type_id,
    v_session_week,
    p_now,
    v_booking.id
  );

  update tokens set quantity = quantity - 1 where id = v_token_id and quantity > 0;
  if not found then raise exception 'Token deduction failed'; end if;

  update bookings
  set status = 'booked', cancelled_at = null, booked_at = p_now
  where id = v_booking.id;

  select week_start into v_token_week_start from tokens where id = v_token_id;
  insert into booking_token_deductions(booking_id, token_id, token_type_id, quantity, token_week_start)
  values (v_booking.id, v_token_id, v_session.token_type_id, 1, v_token_week_start);

  delete from waiting_list_entries where session_id = v_session.id and member_id = p_member_id;

  insert into audit_logs(actor_type, actor_id, action, meta)
  values ('member', p_member_id, 'booking.rebook', jsonb_build_object('bookingId', v_booking.id, 'sessionId', v_session.id));

  insert into notifications(member_id, channel, type, payload)
  values
    (p_member_id, 'in_app', 'booking_confirmed', jsonb_build_object('bookingId', v_booking.id, 'sessionId', v_session.id, 'sessionStartAt', v_session.start_at, 'sessionEndAt', v_session.end_at, 'locationName', (select l.name from locations l where l.id = v_session.location_id))),
    (p_member_id, 'email', 'booking_confirmed', jsonb_build_object('bookingId', v_booking.id, 'sessionId', v_session.id, 'sessionStartAt', v_session.start_at, 'sessionEndAt', v_session.end_at, 'locationName', (select l.name from locations l where l.id = v_session.location_id)));

  return jsonb_build_object('ok', true, 'bookingId', v_booking.id, 'sessionId', v_session.id, 'tokenId', v_token_id, 'tokenWeekStart', v_token_week_start);
end;
$$;

create or replace function clm_join_waitlist(p_member_id uuid, p_membership_id uuid, p_session_id uuid, p_now timestamptz default now())
returns jsonb
language plpgsql
as $$
declare
  v_membership member_memberships%rowtype;
  v_session sessions%rowtype;
  v_member profiles%rowtype;
  v_session_week timestamptz;
  v_has_token boolean;
  v_position int;
begin
  select * into v_membership from member_memberships where id = p_membership_id and member_id = p_member_id;
  if not found then raise exception 'Membership not found'; end if;
  select * into v_session from sessions where id = p_session_id;
  if not found then raise exception 'Session not found'; end if;
  select * into v_member from profiles where id = p_member_id;
  if not found then raise exception 'Member not found'; end if;
  if not coalesce(v_session.is_online, false) and v_session.location_id is not null then
    if not exists (
      select 1
      from member_location_access mla
      where mla.member_id = p_member_id
        and (
          lower(regexp_replace(coalesce(mla.location_code, ''), '[^a-z0-9]+', '', 'g'))
          =
          lower(regexp_replace(coalesce((select l.slug from locations l where l.id = v_session.location_id), ''), '[^a-z0-9]+', '', 'g'))
          or
          lower(regexp_replace(coalesce(mla.location_code, ''), '[^a-z0-9]+', '', 'g'))
          =
          lower(regexp_replace(coalesce((select l.name from locations l where l.id = v_session.location_id), ''), '[^a-z0-9]+', '', 'g'))
        )
    ) and v_member.location_id is distinct from v_session.location_id then
      raise exception 'Location mismatch';
    end if;
  end if;
  if v_session.start_at > (p_now + interval '28 days') then raise exception 'Session beyond booking horizon'; end if;
  if v_session.start_at <= p_now then raise exception 'Session has already started'; end if;
  if (select count(*) from bookings where session_id=p_session_id and status='booked') < v_session.capacity then raise exception 'Session has available space'; end if;

  v_session_week := clm_current_week_start(v_session.start_at);

  -- Resolve to a membership that can fund this token type/session when possible.
  if (
    not clm_session_allowed_for_membership(v_membership.id, v_session.start_at)
    or clm_effective_weekly_allowance(v_membership.id, v_session.token_type_id, v_session.start_at) <= 0
  ) then
    select mm.*
    into v_membership
    from member_memberships mm
    where mm.member_id = p_member_id
      and mm.status = 'active'
      and (
        clm_session_within_membership_window(mm, v_session.start_at)
        or exists (
          select 1
          from membership_training_plans mtp
          where mtp.membership_id = mm.id
            and mtp.status = 'queued'
            and mtp.start_date <= (v_session.start_at at time zone 'utc')::date
            and (mtp.end_date is null or mtp.end_date >= (v_session.start_at at time zone 'utc')::date)
        )
      )
      and clm_effective_weekly_allowance(mm.id, v_session.token_type_id, v_session.start_at) > 0
    order by mm.created_at desc
    limit 1;
  end if;

  if exists (select 1 from membership_pause_weeks mpw where mpw.membership_id = v_membership.id and clm_current_week_start(mpw.week_start) = v_session_week) then
    raise exception 'Cannot join waitlist in paused week';
  end if;
  perform clm_ensure_weekly_tokens_for_booking_token(
    p_member_id,
    v_session.token_type_id,
    v_membership.id,
    v_session_week,
    p_now
  );
  v_has_token := clm_has_token_for_booking(
    p_member_id,
    p_membership_id,
    v_session.token_type_id,
    v_session_week,
    p_now
  );
  if not v_has_token then raise exception 'No valid token available'; end if;

  insert into waiting_list_entries(session_id, member_id, joined_at)
  values (p_session_id, p_member_id, p_now)
  on conflict (session_id, member_id) do nothing;

  select row_number into v_position from (
    select member_id, row_number() over(order by joined_at asc) as row_number
    from waiting_list_entries where session_id = p_session_id
  ) q where q.member_id = p_member_id;

  insert into audit_logs(actor_type, actor_id, action, meta)
  values ('member', p_member_id, 'waitlist.join', jsonb_build_object('sessionId', p_session_id));

  return jsonb_build_object('ok', true, 'waitlistPosition', coalesce(v_position, 1));
end;
$$;

create or replace function clm_admin_remove_member(p_admin_id uuid, p_booking_id uuid, p_refund text, p_now timestamptz default now())
returns jsonb
language plpgsql
as $$
declare
  v_booking bookings%rowtype;
  v_waitlist_result jsonb;
begin
  if p_refund not in ('refund','charge') then raise exception 'Invalid refund mode'; end if;
  select * into v_booking from bookings where id = p_booking_id and status='booked' for update;
  if not found then raise exception 'Active booking not found'; end if;

  update bookings set status='cancelled', cancelled_at=p_now where id=v_booking.id;
  if p_refund='refund' then
    update tokens t set quantity = t.quantity + d.quantity
    from booking_token_deductions d where d.booking_id=v_booking.id and d.token_id=t.id;
  end if;

  insert into audit_logs(actor_type, actor_id, action, meta)
  values ('admin', p_admin_id, 'booking.admin_remove_member', jsonb_build_object('bookingId', v_booking.id, 'refundMode', p_refund));

  v_waitlist_result := clm_process_waitlist_after_opening(v_booking.session_id, p_now);
  return jsonb_build_object('ok', true, 'bookingId', v_booking.id, 'refundMode', p_refund, 'waitlist', v_waitlist_result);
end;
$$;

create or replace function clm_admin_cancel_session(p_admin_id uuid, p_session_id uuid, p_refund text, p_now timestamptz default now())
returns jsonb
language plpgsql
as $$
declare
  v_booking record;
  v_count int := 0;
  v_session_updated int;
  v_session sessions%rowtype;
  v_apply_refund boolean;
  v_hours_until numeric;
begin
  if p_refund not in ('refund','charge') then raise exception 'Invalid refund mode'; end if;
  select * into v_session from sessions where id = p_session_id;
  if not found then raise exception 'Session not found'; end if;

  v_hours_until := extract(epoch from (v_session.start_at - p_now)) / 3600.0;

  for v_booking in select * from bookings where session_id = p_session_id and status = 'booked' for update loop
    update bookings set status = 'cancelled', cancelled_at = p_now where id = v_booking.id;
    -- refund: always return tokens; charge: same 24h window as member cancel (incl. future-week tokens).
    v_apply_refund := (p_refund = 'refund') or (v_hours_until >= 24);
    if v_apply_refund then
      update tokens t set quantity = t.quantity + d.quantity
      from booking_token_deductions d where d.booking_id = v_booking.id and d.token_id = t.id;
    end if;
    v_count := v_count + 1;
  end loop;

  delete from waiting_list_entries where session_id = p_session_id;

  update sessions set is_cancelled = true where id = p_session_id;
  get diagnostics v_session_updated = row_count;
  if v_session_updated = 0 then
    raise exception 'Session not found';
  end if;

  insert into audit_logs(actor_type, actor_id, action, meta)
  values ('admin', p_admin_id, 'session.cancel', jsonb_build_object('sessionId', p_session_id, 'refundMode', p_refund, 'hoursUntilStart', v_hours_until, 'removedBookings', v_count));

  return jsonb_build_object('ok', true, 'sessionId', p_session_id, 'refundMode', p_refund, 'hoursUntilStart', v_hours_until, 'removedBookings', v_count);
end;
$$;

-- Generate weekly tokens from member_memberships + membership_session_allowances
create or replace function clm_generate_weekly_tokens(p_week_start timestamptz, p_now timestamptz default now())
returns jsonb
language plpgsql
as $$
declare
  v_membership record;
  v_row record;
  v_count int := 0;
begin
  for v_membership in
    select mm.id, mm.member_id from member_memberships mm
    where mm.status = 'active'
      and p_now >= mm.start_date
      and p_now < mm.end_date
      and (mm.termination_date is null or p_now < mm.termination_date)
      and not exists (
        select 1 from membership_pause_weeks mpw
        where mpw.membership_id = mm.id and clm_current_week_start(mpw.week_start) = clm_current_week_start(p_week_start)
      )
  loop
    for v_row in
      select msa.token_type_id, msa.weekly_allowance from membership_session_allowances msa
      where msa.membership_id = v_membership.id and msa.weekly_allowance > 0
    loop
      if not exists (
        select 1 from tokens t where t.member_id = v_membership.member_id and t.token_type_id = v_row.token_type_id and t.week_start = p_week_start and t.source = 'weekly'
      ) then
        insert into tokens(member_id, token_type_id, quantity, week_start, expiry_at, source, source_meta)
        values (v_membership.member_id, v_row.token_type_id, v_row.weekly_allowance, p_week_start, p_week_start + interval '14 days', 'weekly', jsonb_build_object('weekStart', p_week_start));
        v_count := v_count + 1;
      end if;
    end loop;
  end loop;

  insert into audit_logs(actor_type, action, meta)
  values ('system', 'tokens.weekly_generate', jsonb_build_object('weekStart', p_week_start, 'createdCount', v_count));

  return jsonb_build_object('ok', true, 'createdCount', v_count);
end;
$$;

-- Pause membership: insert membership_pause_weeks, cancel bookings in window, extend end_date by 1 week per paused week
create or replace function clm_apply_membership_pause(
  p_membership_id uuid,
  p_start_week timestamptz,
  p_end_week_inclusive timestamptz,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
as $$
declare
  v_membership member_memberships%rowtype;
  v_inserted_weeks int;
  v_booking record;
  v_waitlist_entry record;
  v_cancelled_count int := 0;
  v_removed_waitlist int := 0;
  v_session_ids uuid[] := '{}';
  v_sid uuid;
  v_waitlist_proc jsonb;
  v_new_end_date timestamptz;
begin
  select * into v_membership from member_memberships where id = p_membership_id for update;
  if not found then raise exception 'Membership not found'; end if;
  if p_start_week > p_end_week_inclusive then raise exception 'start_week must be <= end_week_inclusive'; end if;

  with inserted as (
    insert into membership_pause_weeks(membership_id, week_start)
    select p_membership_id, d
    from generate_series(p_start_week, p_end_week_inclusive, interval '7 days') as d
    on conflict (membership_id, week_start) do nothing
    returning 1
  )
  select count(*)::int into v_inserted_weeks from inserted;

  -- Cancel bookings in paused weeks before touching tokens (deduction rows keep token_id FK).
  for v_booking in
    select
      b.id as booking_id,
      b.member_id,
      b.session_id,
      s.start_at as session_start_at,
      s.end_at as session_end_at,
      (select l.name from locations l where l.id = s.location_id) as location_name
    from bookings b
    join sessions s on s.id = b.session_id
    where b.member_id = v_membership.member_id
      and b.status = 'booked'
      and clm_current_week_start(s.start_at) >= p_start_week
      and clm_current_week_start(s.start_at) <= p_end_week_inclusive
    for update of b
  loop
    update bookings set status = 'cancelled', cancelled_at = p_now where id = v_booking.booking_id;
    v_cancelled_count := v_cancelled_count + 1;
    v_session_ids := array_append(v_session_ids, v_booking.session_id);
    insert into audit_logs(actor_type, actor_id, action, meta)
    values ('system', null, 'booking.cancelled_by_pause', jsonb_build_object('bookingId', v_booking.booking_id, 'membershipId', p_membership_id, 'refundApplied', false));
    insert into notifications(member_id, channel, type, payload)
    values
      (v_booking.member_id, 'in_app', 'booking_cancelled', jsonb_build_object('bookingId', v_booking.booking_id, 'refundApplied', false, 'reason', 'membership_paused', 'sessionId', v_booking.session_id, 'sessionStartAt', v_booking.session_start_at, 'sessionEndAt', v_booking.session_end_at, 'locationName', v_booking.location_name)),
      (v_booking.member_id, 'email', 'booking_cancelled', jsonb_build_object('bookingId', v_booking.booking_id, 'refundApplied', false, 'reason', 'membership_paused', 'sessionId', v_booking.session_id, 'sessionStartAt', v_booking.session_start_at, 'sessionEndAt', v_booking.session_end_at, 'locationName', v_booking.location_name));
  end loop;

  for v_waitlist_entry in
    select w.id as entry_id, w.session_id
    from waiting_list_entries w
    join sessions s on s.id = w.session_id
    where w.member_id = v_membership.member_id
      and clm_current_week_start(s.start_at) >= p_start_week
      and clm_current_week_start(s.start_at) <= p_end_week_inclusive
    for update of w
  loop
    delete from waiting_list_entries where id = v_waitlist_entry.entry_id;
    v_removed_waitlist := v_removed_waitlist + 1;
    insert into audit_logs(actor_type, actor_id, action, meta)
    values ('system', null, 'waitlist.removed_by_pause', jsonb_build_object(
      'memberId', v_membership.member_id,
      'membershipId', p_membership_id,
      'sessionId', v_waitlist_entry.session_id,
      'entryId', v_waitlist_entry.entry_id
    ));
  end loop;

  -- Zero weekly tokens for paused weeks; only delete rows not referenced by booking_token_deductions.
  update tokens t
  set quantity = 0
  where t.member_id = v_membership.member_id
    and t.source = 'weekly'
    and t.week_start >= p_start_week
    and t.week_start <= p_end_week_inclusive;

  delete from tokens t
  where t.member_id = v_membership.member_id
    and t.source = 'weekly'
    and t.week_start >= p_start_week
    and t.week_start <= p_end_week_inclusive
    and not exists (
      select 1 from booking_token_deductions d where d.token_id = t.id
    );

  if coalesce(array_length(v_session_ids, 1), 0) > 0 then
    foreach v_sid in array coalesce(
      (select array_agg(distinct sid) from unnest(v_session_ids) as sid),
      '{}'::uuid[]
    )
    loop
      v_waitlist_proc := clm_process_waitlist_after_opening(v_sid, p_now);
    end loop;
  end if;

  v_new_end_date := v_membership.end_date + (v_inserted_weeks * interval '7 days');
  update member_memberships set end_date = v_new_end_date, is_paused = true, updated_at = p_now where id = p_membership_id;

  return jsonb_build_object(
    'ok', true,
    'insertedWeeks', v_inserted_weeks,
    'cancelledBookings', v_cancelled_count,
    'removedWaitlist', v_removed_waitlist,
    'newEndDate', v_new_end_date
  );
end;
$$;

-- Mirror pause apply: shift member_memberships.end_date by N weeks (negative to reverse a pause).
create or replace function clm_adjust_membership_end_by_weeks(
  p_membership_id uuid,
  p_weeks int
)
returns jsonb
language plpgsql
as $$
declare
  v_new_end timestamptz;
begin
  update member_memberships
  set
    end_date = end_date + (p_weeks * interval '7 days'),
    updated_at = now()
  where id = p_membership_id
  returning end_date into v_new_end;

  if not found then raise exception 'Membership not found'; end if;

  return jsonb_build_object(
    'ok', true,
    'endDate', v_new_end,
    'weeksAdjusted', p_weeks
  );
end;
$$;

-- Cancel pause atomically: delete pause week rows and reverse end_date once (avoids double reversal).
create or replace function clm_cancel_membership_pause(
  p_membership_id uuid,
  p_pause_week_ids uuid[] default null,
  p_reverse_extensions boolean default true,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
as $$
declare
  v_removed_weeks int;
  v_new_end timestamptz;
  v_has_remaining boolean;
  v_week timestamptz;
  v_week_starts timestamptz[];
begin
  perform 1 from member_memberships where id = p_membership_id for update;
  if not found then raise exception 'Membership not found'; end if;

  select coalesce(
    array_agg(distinct clm_current_week_start(mpw.week_start)),
    '{}'::timestamptz[]
  )
  into v_week_starts
  from membership_pause_weeks mpw
  where mpw.membership_id = p_membership_id
    and (
      p_pause_week_ids is null
      or mpw.id = any(p_pause_week_ids)
    );

  v_removed_weeks := coalesce(array_length(v_week_starts, 1), 0);

  delete from membership_pause_weeks mpw
  where mpw.membership_id = p_membership_id
    and (
      p_pause_week_ids is null
      or mpw.id = any(p_pause_week_ids)
    );

  if v_removed_weeks > 0 then
    foreach v_week in array v_week_starts loop
      perform clm_ensure_weekly_tokens_for_membership_week(p_membership_id, v_week, p_now);
      -- Refill zeroed weekly tokens for unpaused weeks back up to the effective weekly allowance.
      update tokens t
      set quantity = clm_effective_weekly_allowance(
        p_membership_id,
        t.token_type_id,
        v_week + interval '3 days'
      )
      where t.member_id = (
        select member_id from member_memberships where id = p_membership_id
      )
        and t.source = 'weekly'
        and t.week_start is not null
        and clm_current_week_start(t.week_start) = clm_current_week_start(v_week)
        and t.quantity = 0
        and clm_effective_weekly_allowance(
          p_membership_id,
          t.token_type_id,
          v_week + interval '3 days'
        ) > 0;
    end loop;
  end if;

  if p_reverse_extensions and v_removed_weeks > 0 then
    update member_memberships
    set
      end_date = end_date - (v_removed_weeks * interval '7 days'),
      updated_at = p_now
    where id = p_membership_id
    returning end_date into v_new_end;
  else
    select end_date into v_new_end
    from member_memberships
    where id = p_membership_id;
  end if;

  select exists (
    select 1 from membership_pause_weeks mpw where mpw.membership_id = p_membership_id
  ) into v_has_remaining;

  update member_memberships
  set is_paused = v_has_remaining, updated_at = p_now
  where id = p_membership_id;

  return jsonb_build_object(
    'ok', true,
    'removedWeeks', v_removed_weeks,
    'reversedDays', case when p_reverse_extensions then v_removed_weeks * 7 else 0 end,
    'endDate', v_new_end,
    'isPaused', v_has_remaining
  );
end;
$$;
