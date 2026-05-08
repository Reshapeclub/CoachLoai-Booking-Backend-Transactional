

alter table coach_availability
  add column if not exists kind text not null default 'session';

do $$
begin
  alter table coach_availability
    drop constraint if exists coach_availability_kind_check;

  alter table coach_availability
    add constraint coach_availability_kind_check
    check (kind in ('session', 'meeting'));
exception when others then null;
end $$;

create index if not exists idx_coach_availability_coach_kind_day
  on coach_availability(coach_id, kind, day_of_week);


--
-- delete from coach_availability where kind = 'meeting';
--
-- drop index if exists idx_coach_availability_coach_kind_day;
--
-- alter table coach_availability
--   drop constraint if exists coach_availability_kind_check;
--
-- alter table coach_availability
--   drop column if exists kind;
