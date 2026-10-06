-- ============================================================================
--  finance-tracker — bank API credentials
--  Run after sql/setup.sql and sql/sync_state.sql. Safe to re-run.
--
--  The key is entered in the browser but must never be readable by it. So:
--
--    * the key itself is not stored in this table at all — it goes into
--      Supabase Vault, encrypted, and the table keeps only a pointer;
--    * the browser has no rights on that pointer column, and no write rights
--      on the table at all: it can only call fin_set_bank_credential();
--    * reading the key back is possible only for the service role, through
--      fin_bank_credentials(), which the sync service calls.
--
--  So the page can show "set, 6 Oct" and can replace the key, and cannot
--  show it — not to its user, not to anyone who opens the site.
-- ============================================================================

create table if not exists public.bank_credentials (
  user_id    uuid not null references auth.users (id) on delete cascade,
  bank       text not null check (bank in ('bog', 'tbc')),
  base_url   text,
  accounts   text,                    -- 'IBAN:CUR,IBAN:CUR'; blank means all
  secret_id  uuid,                    -- points into vault.secrets
  updated_at timestamptz not null default now(),
  has_secret boolean generated always as (secret_id is not null) stored,
  primary key (user_id, bank)
);

alter table public.bank_credentials enable row level security;

drop policy if exists bank_credentials_read_own on public.bank_credentials;
create policy bank_credentials_read_own on public.bank_credentials
  for select using (user_id = auth.uid());

-- No direct writes, and no sight of the pointer. Everything the page is
-- allowed to see is named here; secret_id deliberately is not.
revoke all on public.bank_credentials from anon, authenticated;
grant select (user_id, bank, base_url, accounts, updated_at, has_secret)
  on public.bank_credentials to authenticated;

-- ------------------------------------------------- the page writes here ---
drop function if exists public.fin_set_bank_credential(text, text, text, text);
create function public.fin_set_bank_credential(
  p_bank text, p_base_url text, p_accounts text, p_api_key text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  sid uuid;
begin
  if uid is null then raise exception 'not signed in'; end if;
  if p_bank not in ('bog', 'tbc') then raise exception 'unknown bank: %', p_bank; end if;

  select secret_id into sid from public.bank_credentials
   where user_id = uid and bank = p_bank;

  -- An empty key means "leave the stored one alone": the form can be used to
  -- correct a URL without retyping the key.
  if p_api_key is not null and p_api_key <> '' then
    if sid is null then
      sid := vault.create_secret(p_api_key, 'fin_' || p_bank || '_' || uid::text,
                                 'finance-tracker bank API key');
    else
      perform vault.update_secret(sid, p_api_key);
    end if;
  end if;

  insert into public.bank_credentials (user_id, bank, base_url, accounts, secret_id, updated_at)
  values (uid, p_bank, nullif(p_base_url, ''), nullif(p_accounts, ''), sid, now())
  on conflict (user_id, bank) do update
    set base_url   = excluded.base_url,
        accounts   = excluded.accounts,
        secret_id  = coalesce(excluded.secret_id, public.bank_credentials.secret_id),
        updated_at = now();
end;
$$;

drop function if exists public.fin_clear_bank_credential(text);
create function public.fin_clear_bank_credential(p_bank text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  sid uuid;
begin
  if uid is null then raise exception 'not signed in'; end if;
  select secret_id into sid from public.bank_credentials
   where user_id = uid and bank = p_bank;
  delete from public.bank_credentials where user_id = uid and bank = p_bank;
  if sid is not null then delete from vault.secrets where id = sid; end if;
end;
$$;

-- ------------------------------------------- only the service reads back ---
drop function if exists public.fin_bank_credentials(uuid);
create function public.fin_bank_credentials(p_user_id uuid)
returns table (bank text, base_url text, accounts text, api_key text)
language sql
security definer
set search_path = public
as $$
  select c.bank, c.base_url, c.accounts, v.decrypted_secret
  from public.bank_credentials c
  left join vault.decrypted_secrets v on v.id = c.secret_id
  where c.user_id = p_user_id;
$$;

-- ----------------------------------------------------------------- grants ---
revoke all on function public.fin_set_bank_credential(text, text, text, text) from public, anon;
revoke all on function public.fin_clear_bank_credential(text) from public, anon;
revoke all on function public.fin_bank_credentials(uuid) from public, anon, authenticated;

grant execute on function public.fin_set_bank_credential(text, text, text, text) to authenticated;
grant execute on function public.fin_clear_bank_credential(text) to authenticated;
grant execute on function public.fin_bank_credentials(uuid) to service_role;

notify pgrst, 'reload schema';
