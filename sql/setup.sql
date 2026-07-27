-- ============================================================================
--  finance-tracker — Supabase setup
--  Run the whole file in the SQL Editor (Supabase → SQL Editor → New query).
--  Safe to re-run: everything is drop-and-recreate.
--
--  Every aggregate below reads from `transactions`, never from `fin_summary`.
--  That matters: the app compares the two to detect a stale summary, and a
--  function that reads the summary would only ever confirm itself.
-- ============================================================================

-- ---------------------------------------------------------------- indexes ---
create index if not exists transactions_user_date_idx on public.transactions (user_id, txdate);
create index if not exists transactions_user_cat_idx  on public.transactions (user_id, category);

-- ------------------------------------------------------- summary storage ---
create table if not exists public.fin_summary (
  user_id  uuid not null references auth.users (id) on delete cascade,
  mkey     text not null,          -- 'YYYY-MM'
  category text not null,
  ttype    text not null,          -- 'income' | 'expense'
  total    numeric not null default 0,
  cnt      integer not null default 0,
  dmin     date,
  dmax     date,
  primary key (user_id, mkey, category, ttype)
);

alter table public.fin_summary enable row level security;

drop policy if exists fin_summary_own on public.fin_summary;
create policy fin_summary_own on public.fin_summary
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- --------------------------------------------------------------- rebuild ---
drop function if exists public.fin_rebuild_summary();
create function public.fin_rebuild_summary()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  n   integer;
begin
  if uid is null then
    return 0;                       -- called outside a user session
  end if;

  delete from public.fin_summary where user_id = uid;

  insert into public.fin_summary (user_id, mkey, category, ttype, total, cnt, dmin, dmax)
  select uid,
         coalesce(to_char(t.txdate, 'YYYY-MM'), 'უცნობი'),
         coalesce(t.category, 'სხვა'),
         coalesce(t.ttype, 'expense'),
         sum(abs(coalesce(t.amount, 0))),
         count(*),
         min(t.txdate),
         max(t.txdate)
  from public.transactions t
  where t.user_id = uid
  group by 1, 2, 3, 4;

  get diagnostics n = row_count;
  return n;
end;
$$;

-- ------------------------------------------------------------------- kpi ---
drop function if exists public.fin_kpi(text[], text);
create function public.fin_kpi(p_excluded text[] default '{}', p_month text default null)
returns table (income numeric, expense numeric, inc_cnt bigint, exp_cnt bigint,
               cnt bigint, dmin date, dmax date)
language sql
stable
security definer
set search_path = public
as $$
  select
    coalesce(sum(abs(amount)) filter (where ttype = 'income'), 0),
    coalesce(sum(abs(amount)) filter (where ttype <> 'income'), 0),
    count(*) filter (where ttype = 'income'),
    count(*) filter (where ttype <> 'income'),
    count(*),
    min(txdate),
    max(txdate)
  from public.transactions
  where user_id = auth.uid()
    and coalesce(category, 'სხვა') <> all (coalesce(p_excluded, '{}'))
    and (p_month is null or to_char(txdate, 'YYYY-MM') = p_month);
$$;

-- --------------------------------------------------------------- monthly ---
drop function if exists public.fin_monthly(text[]);
create function public.fin_monthly(p_excluded text[] default '{}')
returns table (mkey text, income numeric, expense numeric, cnt bigint)
language sql
stable
security definer
set search_path = public
as $$
  select to_char(txdate, 'YYYY-MM'),
         coalesce(sum(abs(amount)) filter (where ttype = 'income'), 0),
         coalesce(sum(abs(amount)) filter (where ttype <> 'income'), 0),
         count(*)
  from public.transactions
  where user_id = auth.uid()
    and txdate is not null
    and coalesce(category, 'სხვა') <> all (coalesce(p_excluded, '{}'))
  group by 1
  order by 1;
$$;

-- ----------------------------------------------------------- by category ---
drop function if exists public.fin_by_category(text[], text, text);
create function public.fin_by_category(p_excluded text[] default '{}',
                                       p_month text default null,
                                       p_type text default null)
returns table (category text, total numeric, cnt bigint)
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(category, 'სხვა'),
         coalesce(sum(abs(amount)), 0),
         count(*)
  from public.transactions
  where user_id = auth.uid()
    and coalesce(category, 'სხვა') <> all (coalesce(p_excluded, '{}'))
    and (p_month is null or to_char(txdate, 'YYYY-MM') = p_month)
    and (p_type is null
         or (p_type = 'income' and ttype = 'income')
         or (p_type <> 'income' and ttype <> 'income'))
  group by 1
  order by 2 desc;
$$;

-- ----------------------------------------------------------------- daily ---
drop function if exists public.fin_daily(text[], text);
create function public.fin_daily(p_excluded text[] default '{}', p_month text default null)
returns table (d date, delta numeric)
language sql
stable
security definer
set search_path = public
as $$
  select txdate,
         coalesce(sum(case when ttype = 'income' then abs(amount) else -abs(amount) end), 0)
  from public.transactions
  where user_id = auth.uid()
    and txdate is not null
    and coalesce(category, 'სხვა') <> all (coalesce(p_excluded, '{}'))
    and (p_month is null or to_char(txdate, 'YYYY-MM') = p_month)
  group by 1
  order by 1;
$$;

-- ------------------------------------------------------------------ grant ---
grant execute on function public.fin_rebuild_summary()             to authenticated;
grant execute on function public.fin_kpi(text[], text)             to authenticated;
grant execute on function public.fin_monthly(text[])               to authenticated;
grant execute on function public.fin_by_category(text[], text, text) to authenticated;
grant execute on function public.fin_daily(text[], text)           to authenticated;

-- Reload PostgREST's schema cache so the new signatures are visible at once.
notify pgrst, 'reload schema';
