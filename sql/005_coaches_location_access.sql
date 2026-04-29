-- Migration: stop relying on coaches.location_id for location access.
-- Coaches can now access multiple locations via admin_location_access.

-- 1) Ensure existing coaches.location_id grants are reflected in junction table.
insert into admin_location_access (admin_id, location_id)
select c.user_id, c.location_id
from coaches c
where c.user_id is not null
  and c.location_id is not null
on conflict do nothing;

-- 2) Make coaches.location_id optional (legacy only).
do $$
begin
  alter table coaches
    alter column location_id drop not null;
exception when others then null;
end $$;
