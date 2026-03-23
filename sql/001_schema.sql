create extension if not exists pgcrypto;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'membership_mode') then
    create type membership_mode as enum ('inperson', 'remote');
  end if;
  if not exists (select 1 from pg_type where typname = 'plan_tier') then
    create type plan_tier as enum ('structure', 'pace', 'performance');
  end if;
  if not exists (select 1 from pg_type where typname = 'plan_type') then
    create type plan_type as enum ('fixed', 'rolling');
  end if;
  if not exists (select 1 from pg_type where typname = 'plan_status') then
    create type plan_status as enum ('active', 'queued', 'completed', 'cancelled');
  end if;
end $$;

create table if not exists locations (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists profiles (
  id uuid primary key default gen_random_uuid(),
  role text not null check (role in ('member','coach','admin')),
  full_name text not null,
  email text unique,
  location_id uuid references locations(id),
  created_at timestamptz not null default now()
);

create table if not exists member_memberships (
  id uuid not null default gen_random_uuid(),
  member_id uuid not null,
  mode membership_mode not null,
  current_package plan_tier not null default 'pace'::plan_tier,
  is_paused boolean not null default false,
  status text not null default 'active' check (status in ('active','paused','ended','terminated')),
  start_date timestamptz not null default now(),
  end_date timestamptz not null,
  termination_date timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint member_memberships_pkey primary key (id),
  constraint member_memberships_member_id_mode_key unique (member_id, mode)
);

create index if not exists idx_member_memberships_member_mode
  on member_memberships (member_id, mode);

do $$
begin
  alter table member_memberships add column if not exists status text default 'active';
  alter table member_memberships add column if not exists start_date timestamptz default now();
  alter table member_memberships add column if not exists end_date timestamptz default (now() + interval '1 year');
  alter table member_memberships add column if not exists termination_date timestamptz;
exception when others then null;
end $$;

create table if not exists membership_pause_weeks (
  id uuid primary key default gen_random_uuid(),
  membership_id uuid not null references member_memberships(id) on delete cascade,
  week_start timestamptz not null,
  constraint membership_pause_weeks_unique unique (membership_id, week_start)
);

create table if not exists session_types (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  token_type_id uuid not null unique,
  default_capacity int not null check (default_capacity > 0),
  default_duration_mins int not null check (default_duration_mins in (30,45,60)),
  created_at timestamptz not null default now()
);

create table if not exists membership_session_allowances (
  id uuid primary key default gen_random_uuid(),
  membership_id uuid not null references member_memberships(id) on delete cascade,
  token_type_id uuid not null,
  weekly_allowance int not null default 0 check (weekly_allowance >= 0),
  constraint membership_allowance_unique unique (membership_id, token_type_id)
);

create table if not exists membership_allowed_session_types (
  id uuid primary key default gen_random_uuid(),
  membership_id uuid not null references member_memberships(id) on delete cascade,
  session_type_id uuid not null references session_types(id) on delete cascade,
  constraint membership_allowed_session_types_membership_session_unique unique (membership_id, session_type_id)
);

create table if not exists member_session_tags (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references profiles(id) on delete cascade,
  session_type_id uuid not null references session_types(id) on delete cascade,
  constraint member_tag_unique unique (member_id, session_type_id)
);

create table if not exists coaches (
  user_id uuid primary key references profiles(id) on delete cascade,
  weekly_hour_limit_mins int not null default 2400 check (weekly_hour_limit_mins >= 0),
  travel_buffer_minutes int not null default 30 check (travel_buffer_minutes >= 0)
);

create table if not exists coach_allowed_session_types (
  id uuid primary key default gen_random_uuid(),
  coach_user_id uuid not null references coaches(user_id) on delete cascade,
  session_type_id uuid not null references session_types(id) on delete cascade,
  constraint coach_allowed_unique unique (coach_user_id, session_type_id)
);

create table if not exists coach_availability (
  id uuid primary key default gen_random_uuid(),
  coach_user_id uuid not null references coaches(user_id) on delete cascade,
  day_of_week int not null check (day_of_week between 1 and 7),
  start_mins int not null check (start_mins between 0 and 1439),
  end_mins int not null check (end_mins between 1 and 1440)
);

create table if not exists coach_holidays (
  id uuid primary key default gen_random_uuid(),
  coach_user_id uuid not null references coaches(user_id) on delete cascade,
  start_at timestamptz not null,
  end_at timestamptz not null,
  check (end_at > start_at)
);

create table if not exists sessions (
  id uuid primary key default gen_random_uuid(),
  session_type_id uuid not null references session_types(id),
  token_type_id uuid not null,
  coach_user_id uuid not null references coaches(user_id),
  location_id uuid references locations(id),
  start_at timestamptz not null,
  end_at timestamptz not null,
  capacity int not null check (capacity > 0),
  created_at timestamptz not null default now(),
  check (end_at > start_at)
);
create index if not exists idx_sessions_start_at on sessions(start_at);

create table if not exists tokens (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references profiles(id) on delete cascade,
  token_type_id uuid not null,
  quantity int not null check (quantity >= 0),
  week_start timestamptz,
  created_at timestamptz not null default now(),
  expiry_at timestamptz not null,
  source text not null check (source in ('weekly','admin','purchase')),
  source_meta jsonb not null default '{}'::jsonb
);
create index if not exists idx_tokens_member_type on tokens(member_id, token_type_id);

create table if not exists bookings (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references profiles(id) on delete cascade,
  session_id uuid not null references sessions(id) on delete cascade,
  status text not null check (status in ('booked','cancelled','no_show')),
  booked_at timestamptz not null default now(),
  cancelled_at timestamptz
);

create table if not exists booking_token_deductions (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references bookings(id) on delete cascade,
  token_id uuid not null references tokens(id),
  token_type_id uuid not null,
  quantity int not null check (quantity > 0),
  token_week_start timestamptz
);

create table if not exists waiting_list_entries (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references sessions(id) on delete cascade,
  member_id uuid not null references profiles(id) on delete cascade,
  joined_at timestamptz not null default now(),
  constraint waitlist_unique unique (session_id, member_id)
);
create index if not exists idx_waitlist_fifo on waiting_list_entries(session_id, joined_at);

create table if not exists track_meetings (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references profiles(id) on delete cascade,
  tier text not null check (tier in ('performance','pace','structure')),
  booked_at timestamptz not null default now(),
  meeting_start timestamptz not null,
  meeting_end timestamptz not null,
  check (meeting_end > meeting_start)
);

create table if not exists audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_type text not null check (actor_type in ('system','admin','member')),
  actor_id uuid,
  action text not null,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists notifications (
  id uuid primary key default gen_random_uuid(),
  member_id uuid references profiles(id) on delete cascade,
  channel text not null check (channel in ('push','email','in_app')),
  type text not null,
  payload jsonb not null default '{}'::jsonb,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);
