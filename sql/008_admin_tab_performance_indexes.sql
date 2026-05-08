-- Sessions tab / schedule / staff stats
create index if not exists idx_sessions_coach_active_start
  on sessions (coach_id, is_cancelled, start_at);

create index if not exists idx_sessions_active_start
  on sessions (is_cancelled, start_at);

-- Booking counters and staff stats (booked/no_show/cancelled by session and member)
create index if not exists idx_bookings_session_status
  on bookings (session_id, status);

create index if not exists idx_bookings_member_status_booked_at
  on bookings (member_id, status, booked_at desc);

-- Waitlist counts by session/date windows
create index if not exists idx_waiting_list_entries_session
  on waiting_list_entries (session_id);

-- Rota tab lookups (weekly/default by coach+kind+day, ordered by start)
create index if not exists idx_coach_availability_lookup
  on coach_availability (coach_id, kind, week_start_date, day_of_week, start_mins);

-- Rota snapshot lookup (weekly/default by coach without kind filter)
create index if not exists idx_coach_availability_snapshot
  on coach_availability (coach_id, week_start_date, day_of_week, start_mins);

-- Team tab leave history (coach leaves ordered by start date)
create index if not exists idx_coach_holidays_coach_start
  on coach_holidays (coach_id, start_at desc);

create index if not exists idx_coach_holidays_coach_end
  on coach_holidays (coach_id, end_at);

-- Rota snapshot holidays (active windows ordered by start date)
create index if not exists idx_coach_holidays_snapshot
  on coach_holidays (coach_id, end_at, start_at);
