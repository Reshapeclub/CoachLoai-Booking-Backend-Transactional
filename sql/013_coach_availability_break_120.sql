-- Allow 120-minute rota breaks (in addition to 30 and 60).

alter table coach_availability
  drop constraint if exists coach_availability_break_duration_values;

alter table coach_availability
  add constraint coach_availability_break_duration_values
  check (
    break_duration_mins is null
    or break_duration_mins in (30, 60, 120)
  );
