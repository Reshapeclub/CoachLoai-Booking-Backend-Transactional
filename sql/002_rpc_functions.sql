-- CLM Booking RPC Functions
-- Core: member_memberships + membership_pause_weeks

create or replace function clm_current_week_start(p_now timestamptz)
returns timestamptz
language plpgsql
immutable
as $$
declare
  v_dow int;
  v_start timestamptz;
begin
  v_dow := extract(dow from p_now);
  if v_dow = 0 then
    v_start := date_trunc('day', p_now) - interval '6 days';
  else
    v_start := date_trunc('day', p_now) - ((v_dow - 1) || ' days')::interval;
  end if;
  return v_start;
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
    and p_now >= mm.start_date
    and p_now < mm.end_date
    and (mm.termination_date is null or p_now < mm.termination_date)
    and not exists (
      select 1 from membership_pause_weeks mpw
      where mpw.membership_id = mm.id and mpw.week_start = v_week_start
    )
  order by mm.created_at desc
  limit 1;

  return v_membership_id;
end;
$$;

create or replace function clm_pick_token_id(
  p_member_id uuid,
  p_token_type_id uuid,
  p_now timestamptz
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

  select t.id into v_token_id
  from tokens t
  where t.member_id = p_member_id and t.token_type_id = p_token_type_id and t.quantity > 0 and p_now < t.expiry_at and t.week_start = v_current_week
  order by t.created_at asc limit 1 for update;
  if v_token_id is not null then return v_token_id; end if;

  select t.id into v_token_id
  from tokens t
  where t.member_id = p_member_id and t.token_type_id = p_token_type_id and t.quantity > 0 and p_now < t.expiry_at and (t.week_start is null or t.week_start < v_current_week)
  order by coalesce(t.week_start, t.created_at) asc, t.created_at asc limit 1 for update;
  if v_token_id is not null then return v_token_id; end if;

  select t.id into v_token_id
  from tokens t
  where t.member_id = p_member_id and t.token_type_id = p_token_type_id and t.quantity > 0 and p_now < t.expiry_at and t.week_start = v_next_week
  order by t.created_at asc limit 1 for update;

  return v_token_id;
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
  v_current_week timestamptz;
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

  v_current_week := clm_current_week_start(p_now);
  v_session_week := clm_current_week_start(v_session.start_at);
  v_horizon := p_now + interval '28 days';

  if not (p_now >= v_membership.start_date and p_now < v_membership.end_date) then raise exception 'Membership not active'; end if;
  if v_membership.termination_date is not null and p_now >= v_membership.termination_date then raise exception 'Membership terminated'; end if;
  if exists (select 1 from membership_pause_weeks mpw where mpw.membership_id = v_membership.id and mpw.week_start = v_current_week) then raise exception 'Membership paused'; end if;
  if v_session.start_at >= v_membership.end_date then raise exception 'Cannot book beyond membership end date'; end if;
  if v_membership.termination_date is not null and v_session.start_at >= v_membership.termination_date then raise exception 'Cannot book beyond termination date'; end if;
  if exists (select 1 from membership_pause_weeks mpw where mpw.membership_id = v_membership.id and mpw.week_start = v_session_week) then raise exception 'Cannot book in paused week'; end if;
  if v_session.start_at > v_horizon then raise exception 'Session beyond booking horizon'; end if;
  if v_member.location_id is distinct from v_session.location_id then raise exception 'Location mismatch'; end if;
  if not exists (select 1 from membership_session_allowances msa where msa.membership_id = v_membership.id and msa.token_type_id = v_session.token_type_id) then raise exception 'Session not covered by membership allowance'; end if;
  --if not exists (select 1 from member_session_tags mst where mst.member_id = p_member_id and mst.session_type_id = v_session.session_type_id) then raise exception 'Session type not allowed by user tags'; end if;

  select count(*) into v_duplicate_count
  from bookings b join sessions s on s.id=b.session_id
  where b.member_id=p_member_id and b.status='booked' and s.start_at=v_session.start_at;
  if v_duplicate_count > 0 then raise exception 'Duplicate booking at same time'; end if;

  select count(*) into v_booked_count from bookings where session_id=v_session.id and status='booked';
  if v_booked_count >= v_session.capacity then raise exception 'Session full'; end if;

  v_token_id := clm_pick_token_id(p_member_id, v_session.token_type_id, p_now);
  if v_token_id is null then raise exception 'No valid token available'; end if;

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
    (p_member_id, 'in_app', 'booking_confirmed', jsonb_build_object('bookingId', v_booking_id, 'sessionId', v_session.id)),
    (p_member_id, 'email', 'booking_confirmed', jsonb_build_object('bookingId', v_booking_id, 'sessionId', v_session.id));

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

  if (extract(epoch from (v_session.start_at - p_now)) / 3600.0) <= 12 then
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

  v_refund := (extract(epoch from (v_session.start_at - p_now)) / 3600.0) >= 12;
  update bookings set status='cancelled', cancelled_at=p_now where id=v_booking.id;

  if v_refund then
    update tokens t set quantity = t.quantity + d.quantity
    from booking_token_deductions d where d.booking_id=v_booking.id and d.token_id=t.id;
  end if;

  insert into audit_logs(actor_type, actor_id, action, meta)
  values ('member', p_member_id, 'booking.cancel', jsonb_build_object('bookingId', v_booking.id, 'refundApplied', v_refund));

  insert into notifications(member_id, channel, type, payload)
  values
    (p_member_id, 'in_app', 'booking_cancelled', jsonb_build_object('bookingId', v_booking.id, 'refundApplied', v_refund)),
    (p_member_id, 'email', 'booking_cancelled', jsonb_build_object('bookingId', v_booking.id, 'refundApplied', v_refund));

  v_waitlist_result := clm_process_waitlist_after_opening(v_session.id, p_now);
  return jsonb_build_object('ok', true, 'bookingId', v_booking.id, 'refundApplied', v_refund, 'waitlist', v_waitlist_result);
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
  v_has_token boolean;
  v_position int;
begin
  select * into v_membership from member_memberships where id = p_membership_id and member_id = p_member_id;
  if not found then raise exception 'Membership not found'; end if;
  select * into v_session from sessions where id = p_session_id;
  if not found then raise exception 'Session not found'; end if;
  select * into v_member from profiles where id = p_member_id;
  if not found then raise exception 'Member not found'; end if;
  if v_member.location_id is distinct from v_session.location_id then raise exception 'Location mismatch'; end if;
  if v_session.start_at > (p_now + interval '28 days') then raise exception 'Session beyond booking horizon'; end if;
  if (select count(*) from bookings where session_id=p_session_id and status='booked') < v_session.capacity then raise exception 'Session has available space'; end if;

  v_has_token := clm_pick_token_id(p_member_id, v_session.token_type_id, p_now) is not null;
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
begin
  if p_refund not in ('refund','charge') then raise exception 'Invalid refund mode'; end if;
  for v_booking in select * from bookings where session_id = p_session_id and status = 'booked' for update loop
    update bookings set status = 'cancelled', cancelled_at = p_now where id = v_booking.id;
    if p_refund = 'refund' then
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
  values ('admin', p_admin_id, 'session.cancel', jsonb_build_object('sessionId', p_session_id, 'refundMode', p_refund, 'removedBookings', v_count));

  return jsonb_build_object('ok', true, 'sessionId', p_session_id, 'refundMode', p_refund, 'removedBookings', v_count);
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
        where mpw.membership_id = mm.id and mpw.week_start = p_week_start
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
  v_cancelled_count int := 0;
  v_session_ids uuid[] := '{}';
  v_sid uuid;
  v_waitlist jsonb;
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

  -- Zero weekly tokens for paused weeks
  delete from tokens t
  where t.member_id = v_membership.member_id
    and t.source = 'weekly'
    and t.week_start >= p_start_week
    and t.week_start <= p_end_week_inclusive;

  for v_booking in
    select b.id as booking_id, b.member_id, b.session_id
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
      (v_booking.member_id, 'in_app', 'booking_cancelled', jsonb_build_object('bookingId', v_booking.booking_id, 'refundApplied', false, 'reason', 'membership_paused')),
      (v_booking.member_id, 'email', 'booking_cancelled', jsonb_build_object('bookingId', v_booking.booking_id, 'refundApplied', false, 'reason', 'membership_paused'));
  end loop;

  foreach v_sid in array (select distinct unnest(v_session_ids))
  loop
    v_waitlist := clm_process_waitlist_after_opening(v_sid, p_now);
  end loop;

  v_new_end_date := v_membership.end_date + (v_inserted_weeks * interval '7 days');
  update member_memberships set end_date = v_new_end_date, is_paused = true, updated_at = p_now where id = p_membership_id;

  return jsonb_build_object(
    'ok', true,
    'insertedWeeks', v_inserted_weeks,
    'cancelledBookings', v_cancelled_count,
    'newEndDate', v_new_end_date
  );
end;
$$;
