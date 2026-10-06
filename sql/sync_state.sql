-- ============================================================================
--  finance-tracker — bank sync bookmark
--  Run after sql/setup.sql. Safe to re-run.
--
--  One row per bank, holding where the last run got to and how it went. The
--  sync service writes it with the service role key; the browser only reads
--  it, to show the last sync in Settings.
-- ============================================================================

create table if not exists public.sync_state (
  user_id     uuid not null references auth.users (id) on delete cascade,
  bank        text not null,            -- 'bog' | 'tbc'
  last_day    date,                     -- newest transaction date stored so far
  last_run_at timestamptz,
  last_status text,                     -- 'ok' | 'error'
  last_error  text,
  last_added  integer,
  primary key (user_id, bank)
);

alter table public.sync_state enable row level security;

-- The browser may look at its own sync status, but must never write it: the
-- bookmark decides which transactions get fetched, and a wrong one silently
-- skips a period. Only the service role (which bypasses RLS) moves it.
drop policy if exists sync_state_read_own on public.sync_state;
create policy sync_state_read_own on public.sync_state
  for select using (user_id = auth.uid());

notify pgrst, 'reload schema';
