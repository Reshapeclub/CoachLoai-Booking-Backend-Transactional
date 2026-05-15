-- Optional per-window site for session rota (null = legacy “any site coach can access”).
alter table coach_availability
  add column if not exists location_id uuid references locations(id) on delete set null;

create index if not exists idx_coach_availability_location
  on coach_availability (location_id)
  where location_id is not null;
