-- Fix legacy FK drift where membership_pause_weeks.membership_id points to memberships(id)
-- instead of member_memberships(id). Pause RPCs use member_memberships.id.

do $$
declare
  fk_def text;
begin
  select pg_get_constraintdef(c.oid)
  into fk_def
  from pg_constraint c
  join pg_class t on t.oid = c.conrelid
  join pg_namespace n on n.oid = t.relnamespace
  where c.contype = 'f'
    and n.nspname = 'public'
    and t.relname = 'membership_pause_weeks'
    and c.conname = 'membership_pause_weeks_membership_id_fkey';

  -- If FK already points to member_memberships(id), do nothing.
  if fk_def is not null and fk_def ilike '%references member_memberships(id)%' then
    return;
  end if;

  -- Drop mismatched FK (if present), then recreate with correct reference.
  if fk_def is not null then
    execute 'alter table public.membership_pause_weeks drop constraint membership_pause_weeks_membership_id_fkey';
  end if;

  execute '
    alter table public.membership_pause_weeks
    add constraint membership_pause_weeks_membership_id_fkey
    foreign key (membership_id)
    references public.member_memberships(id)
    on delete cascade
  ';
end $$;

