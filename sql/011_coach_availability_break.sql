alter table coach_availability
  add column if not exists break_start_mins int null;

alter table coach_availability
  add column if not exists break_duration_mins int null;

do $$
begin
  alter table coach_availability
    add constraint coach_availability_break_duration_values
    check (
      break_duration_mins is null
      or break_duration_mins in (30, 60)
    );
exception
  when duplicate_object then null;
end $$;

do $$
begin
  alter table coach_availability
    add constraint coach_availability_break_start_with_duration
    check (
      (break_start_mins is null and break_duration_mins is null)
      or (break_start_mins is not null and break_duration_mins is not null)
    );
exception
  when duplicate_object then null;
end $$;

do $$
begin
  alter table coach_availability
    add constraint coach_availability_break_inside_window
    check (
      break_start_mins is null
      or (
        break_start_mins >= start_mins
        and break_start_mins + break_duration_mins <= end_mins
      )
    );
exception
  when duplicate_object then null;
end $$;
