-- Soft-delete for sessions (recoverable in admin; hidden from normal lists).

alter table sessions add column if not exists deleted_at timestamptz null;

comment on column sessions.deleted_at is 'When set, session is removed from schedules; admin can restore by clearing deleted_at.';

create index if not exists idx_sessions_start_not_deleted
  on sessions (start_at)
  where deleted_at is null;
