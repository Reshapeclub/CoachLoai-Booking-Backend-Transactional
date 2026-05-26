-- Sync admin_location_assignments → admin_location_access (table already exists in Supabase).
-- Run once in SQL editor.

-- Mirror assignments → admin_location_access (integer admin_id).
create or replace function public.clm_sync_admin_location_access(p_admin_id bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_admin_id is null then
    return;
  end if;

  delete from public.admin_location_access
  where admin_id = p_admin_id::integer;

  insert into public.admin_location_access (admin_id, location_id)
  select p_admin_id::integer, a.location_id
  from public.admin_location_assignments a
  where a.admin_id = p_admin_id
  on conflict (admin_id, location_id) do nothing;
end;
$$;

-- Row trigger: any insert/update/delete on assignments refreshes access for that admin.
create or replace function public.clm_admin_location_assignments_sync_access()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.clm_sync_admin_location_access(coalesce(new.admin_id, old.admin_id));
  return coalesce(new, old);
end;
$$;

drop trigger if exists trg_admin_location_assignments_sync_access on public.admin_location_assignments;

create trigger trg_admin_location_assignments_sync_access
after insert or update or delete on public.admin_location_assignments
for each row
execute function public.clm_admin_location_assignments_sync_access();
