-- Allow gifted sessions to be stored as token rows (source = 'gift').

alter table tokens drop constraint if exists tokens_source_check;

alter table tokens add constraint tokens_source_check
  check (source in ('weekly', 'admin', 'purchase', 'gift'));
