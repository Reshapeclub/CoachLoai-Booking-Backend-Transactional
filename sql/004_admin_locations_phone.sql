-- Migration: Add phone to admins + admin_location_access junction table
-- Run this in Supabase SQL editor once before deploying the updated backend.

-- 1. Add phone column to admins table
do $$
begin
  alter table admins add column if not exists phone text;
exception when others then null;
end $$;

-- 2. Create junction table for many-to-many staff ↔ locations
create table if not exists admin_location_access (
  admin_id    integer  not null,
  location_id uuid     not null references locations(id) on delete cascade,
  primary key (admin_id, location_id)
);

create index if not exists idx_admin_location_access_admin_id
  on admin_location_access(admin_id);

-- 3. Back-fill: seed junction table from existing location_id values
insert into admin_location_access (admin_id, location_id)
select id, location_id
from   admins
where  location_id is not null
on conflict do nothing;
