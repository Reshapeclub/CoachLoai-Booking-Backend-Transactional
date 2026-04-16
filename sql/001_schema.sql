create extension if not exists pgcrypto;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'membership_mode') then
    create type membership_mode as enum ('inperson', 'remote');
  end if;
  if not exists (select 1 from pg_type where typname = 'plan_tier') then
    create type plan_tier as enum ('structure', 'pace', 'performance');
  end if;
end $$;

create table if not exists locations (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  slug text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists profiles (
  id uuid primary key default gen_random_uuid(),
  role text not null default 'member' check (role in ('member','coach','admin')),
  first_name text not null,
  last_name text not null,
  full_name text not null,
  dob date not null,
  sex text not null,
  photo_url text,
  marketing_opt_in boolean default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  result boolean,
  "answersSectionsIds" jsonb,
  adherence_rate integer default 1,
  workouts_completed integer default 0,
  hydration_delta_percent integer default 0,
  email text not null,
  notes jsonb,
  allowed_food_groups jsonb,
  last_check_in_date timestamptz default now(),
  phone text,
  "isReviewUser" boolean not null default false,
  location_id uuid references locations(id),
  constraint profiles_email_key unique (email),
  constraint profiles_sex_check check (sex = any (array['male'::text, 'female'::text]))
);

do $$
begin
  alter table profiles add column if not exists role text default 'member';
  alter table profiles alter column role set default 'member';
  alter table profiles add column if not exists full_name text;
  alter table profiles add column if not exists location_id uuid references locations(id);
  update profiles set role = coalesce(role, 'member') where role is null;

  update profiles
  set full_name = trim(both from concat_ws(' ', nullif(trim(coalesce(first_name, '')), ''), nullif(trim(coalesce(last_name, '')), '')))
  where full_name is null or btrim(coalesce(full_name, '')) = '';
  if not exists (select 1 from pg_constraint where conname = 'profiles_role_check') then
    alter table profiles add constraint profiles_role_check check (
      role = any (array['member'::text, 'coach'::text, 'admin'::text])
    );
  end if;
exception when others then null;
end $$;

-- Keep full_name in sync whenever first_name / last_name are set or changed (inserts + those updates).
create or replace function clm_profiles_sync_full_name()
returns trigger
language plpgsql
as $$
declare
  v text;
begin
  v := trim(both from concat_ws(
    ' ',
    nullif(trim(coalesce(NEW.first_name, '')), ''),
    nullif(trim(coalesce(NEW.last_name, '')), '')
  ));
  NEW.full_name := case when v = '' then '-' else v end;
  return NEW;
end;
$$;

drop trigger if exists profiles_sync_full_name on profiles;
create trigger profiles_sync_full_name
  before insert or update of first_name, last_name on profiles
  for each row
  execute procedure clm_profiles_sync_full_name();

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
  category text not null default '1:1' check (category in ('1:1','Elite','Octave','Group')),
  token_type_id uuid not null,
  default_capacity int not null check (default_capacity > 0),
  max_per_day int not null default 1 check (max_per_day > 0),
  default_duration_mins int not null check (default_duration_mins in (30,45,60)),
  color text null,
  icon text null,
  display_order int not null default 0 check (display_order >= 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

do $$
begin
  -- allow token sharing across multiple names in same category
  alter table session_types drop constraint if exists session_types_token_type_id_key;
  alter table session_types add column if not exists max_per_day int default 4;
  alter table session_types add column if not exists category text default '1:1';
  if not exists (select 1 from pg_constraint where conname = 'session_types_category_check') then
    alter table session_types add constraint session_types_category_check check (category in ('1:1','Elite','Octave','Group'));
  end if;
  alter table session_types add column if not exists color text;
  alter table session_types add column if not exists icon text;
exception when others then null;
end;
$$ language plpgsql;

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
  user_id uuid primary key references admins(id) on delete cascade,
  weekly_hour_limit_mins int not null default 2400 check (weekly_hour_limit_mins >= 0),
  travel_buffer_minutes int not null default 30 check (travel_buffer_minutes >= 0)
);

-- create table if not exists coach_allowed_session_types (
--   id uuid primary key default gen_random_uuid(),
--   coach_user_id uuid not null references coaches(user_id) on delete cascade,
--   session_type_id uuid not null references session_types(id) on delete cascade,
--   constraint coach_allowed_unique unique (coach_user_id, session_type_id)
-- );

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
  coach_user_id uuid not null references coaches(id),
  location_id uuid references locations(id),
  start_at timestamptz not null,
  end_at timestamptz not null,
  capacity int not null check (capacity > 0),
  created_at timestamptz not null default now(),
  is_cancelled boolean not null default false,
  "is_online" boolean not null default false,
  check (end_at > start_at)
);
create index if not exists idx_sessions_start_at on sessions(start_at);

do $$
begin
  alter table sessions add column if not exists is_cancelled boolean not null default false;
  alter table sessions add column if not exists "is_online" boolean not null default false;
exception when others then null;
end $$;

create table if not exists tokens (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references profiles(id) on delete cascade,
  token_type_id uuid not null,
  quantity int not null check (quantity >= 0),
  week_start timestamptz,
  created_at timestamptz not null default now(),
  expiry_at timestamptz not null,
  source text not null check (source in ('weekly','admin','purchase')),
  source_meta jsonb not null default '{}'::jsonb,
  coach_id uuid NULL references coaches(id)
)

do $$
begin
  alter table tokens add column if not exists coach_id uuid references coaches(id);
exception when others then null;
end $$;

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
  tier text,
  meeting_type_id uuid,
  location_id uuid references locations(id),
  booked_at timestamptz not null default now(),
  meeting_start timestamptz not null,
  meeting_end timestamptz not null,
  status text not null default 'booked' check (status in ('booked','cancelled','no_show')),
  check (tier is not null or meeting_type_id is not null),
  check (meeting_end > meeting_start)
);

create table if not exists meeting_types (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  code text not null unique,
  duration_mins int not null check (duration_mins > 0),
  description text,
  color text,
  icon text,
  display_order int not null default 0 check (display_order >= 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists meeting_slots (
  id uuid primary key default gen_random_uuid(),
  meeting_type_id uuid not null references meeting_types(id) on delete cascade,
  location_id uuid not null references locations(id) on delete cascade,
  slot_start timestamptz not null,
  slot_end timestamptz not null,
  capacity int not null default 1 check (capacity > 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  check (slot_end > slot_start),
  constraint meeting_slots_unique unique (meeting_type_id, location_id, slot_start)
);

create index if not exists idx_meeting_slots_lookup
  on meeting_slots (meeting_type_id, location_id, slot_start);

create index if not exists idx_track_meetings_slot_lookup
  on track_meetings (meeting_type_id, location_id, meeting_start, status);

do $$
begin
  alter table track_meetings add column if not exists meeting_type_id uuid;
  alter table track_meetings add column if not exists location_id uuid references locations(id);
  alter table track_meetings alter column status set default 'booked';
  if not exists (select 1 from pg_constraint where conname = 'track_meetings_meeting_type_id_fkey') then
    alter table track_meetings
      add constraint track_meetings_meeting_type_id_fkey
      foreign key (meeting_type_id) references meeting_types(id);
  end if;
exception when others then null;
end $$;

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
