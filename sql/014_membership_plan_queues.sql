-- Queued / active training & nutrition plans (admin Member > Memberships tab)

create table if not exists membership_training_plans (
  id uuid primary key default gen_random_uuid(),
  membership_id uuid not null references member_memberships(id) on delete cascade,
  plan_type text not null default 'fixed' check (plan_type in ('fixed', 'rolling')),
  status text not null default 'active' check (status in ('active', 'queued', 'completed', 'cancelled')),
  start_date date not null,
  end_date date null,
  allocation_mode text not null default 'sessions' check (allocation_mode in ('sessions', 'location')),
  note text null,
  created_by uuid null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_training_plan_membership_status
  on membership_training_plans (membership_id, status);

create table if not exists membership_training_plan_allocations (
  id uuid primary key default gen_random_uuid(),
  training_plan_id uuid not null references membership_training_plans(id) on delete cascade,
  allocation_key varchar(32) not null,
  allocation_value smallint not null default 0 check (allocation_value between 0 and 7),
  unique (training_plan_id, allocation_key)
);

create table if not exists membership_nutrition_plans (
  id uuid primary key default gen_random_uuid(),
  membership_id uuid not null references member_memberships(id) on delete cascade,
  tier text not null default 'pace' check (tier in ('structure', 'pace', 'performance')),
  plan_type text not null default 'fixed' check (plan_type in ('fixed', 'rolling')),
  status text not null default 'active' check (status in ('active', 'queued', 'completed', 'cancelled')),
  start_date date not null,
  end_date date null,
  note text null,
  created_by uuid null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_nutrition_plan_membership_status
  on membership_nutrition_plans (membership_id, status);

do $$
begin
  alter table membership_training_plans add column if not exists cancel_mode varchar(16) null;
  alter table membership_training_plans add column if not exists cancel_effective_date date null;
  alter table membership_training_plans add column if not exists cancel_reason text null;
  alter table membership_training_plans add column if not exists cancelled_at timestamptz null;
  alter table membership_training_plans add column if not exists cancelled_by uuid null;
  alter table membership_nutrition_plans add column if not exists cancel_mode varchar(16) null;
  alter table membership_nutrition_plans add column if not exists cancel_effective_date date null;
  alter table membership_nutrition_plans add column if not exists cancel_reason text null;
  alter table membership_nutrition_plans add column if not exists cancelled_at timestamptz null;
  alter table membership_nutrition_plans add column if not exists cancelled_by uuid null;
exception when others then null;
end $$;
