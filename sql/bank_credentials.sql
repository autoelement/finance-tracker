-- ============================================================================
--  finance-tracker — bank API credentials (OAuth2 client credentials)
--  Run after sql/setup.sql and sql/sync_state.sql. Safe to re-run, and safe
--  to run over the earlier single-key version of this table.
--
--  The banks issue a Client ID and a Client Secret. Only the secret is a
--  secret: the id is an identifier and is stored as an ordinary column, while
--  the secret goes into Supabase Vault, encrypted, and the table keeps only a
--  pointer to it.
--
--    * the browser is granted named columns, and the pointer is not among
--      them, so there is nothing for it to follow;
--    * the browser has no write rights at all — it can only call
--      fin_set_bank_credential();
--    * decrypting is possible solely for the service role, through
--      fin_bank_credentials(), which the sync service calls.
--
--  So the page can show "set, 6 Oct" and can replace the secret, and cannot
--  show it — not to its user, not to anyone who opens the site.
-- ============================================================================

create table if not exists public.bank_credentials (
  user_id    uuid not null references auth.users (id) on delete cascade,
  bank       text not null check (bank in ('bog', 'tbc')),
  base_url   text,
  accounts   text,                    -- 'IBAN:CUR,IBAN:CUR'; blank means all
  secret_id  uuid,                    -- the client secret, in vault.secrets
  updated_at timestamptz not null default now(),
  has_secret boolean generated always as (secret_id is not null) stored,
  primary key (user_id, bank)
);

-- added here so an earlier install upgrades in place
alter table public.bank_credentials add column if not exists client_id text;
alter table public.bank_credentials add column if not exists token_url text;
alter table public.bank_credentials add column if not exists scope     text;
alter table public.bank_credentials add column if not exists auth_mode text
  not null default 'oauth_basic';

do $$ begin
  alter table public.bank_credentials
    add constraint bank_credentials_auth_mode_check
    check (auth_mode in ('oauth_basic', 'oauth_body', 'header'));
exception when duplicate_object then null; end $$;

alter table public.bank_credentials enable row level security;

drop policy if exists bank_credentials_read_own on public.bank_credentials;
create policy bank_credentials_read_own on public.bank_credentials
  for select using (user_id = auth.uid());

-- Everything the page may see is named here. secret_id deliberately is not.
revoke all on public.bank_credentials from anon, authenticated;
grant select (user_id, bank, base_url, accounts, client_id, token_url, scope,
              auth_mode, updated_at, has_secret)
  on public.bank_credentials to authenticated;

-- ------------------------------------------------- the page writes here ---
drop function if exists public.fin_set_bank_credential(text, text, text, text);
drop function if exists public.fin_set_bank_credential(text, text, text, text, text, text, text, text);
create function public.fin_set_bank_credential(
  p_bank          text,
  p_base_url      text,
  p_accounts      text,
  p_client_id     text,
  p_client_secret text,
  p_token_url     text default null,
  p_scope         text default null,
  p_auth_mode     text default 'oauth_basic')
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
  if p_auth_mode not in ('oauth_basic', 'oauth_body', 'header') then
    raise exception 'unknown auth mode: %', p_auth_mode;
  end if;

  select secret_id into sid from public.bank_credentials
   where user_id = uid and bank = p_bank;

  -- An empty secret means "leave the stored one alone", so a URL or a scope
  -- can be corrected without retyping it.
  if p_client_secret is not null and p_client_secret <> '' then
    if sid is null then
      sid := vault.create_secret(p_client_secret, 'fin_' || p_bank || '_' || uid::text,
                                 'finance-tracker bank client secret');
    else
      perform vault.update_secret(sid, p_client_secret);
    end if;
  end if;

  insert into public.bank_credentials
    (user_id, bank, base_url, accounts, client_id, token_url, scope, auth_mode, secret_id, updated_at)
  values
    (uid, p_bank, nullif(p_base_url, ''), nullif(p_accounts, ''), nullif(p_client_id, ''),
     nullif(p_token_url, ''), nullif(p_scope, ''), p_auth_mode, sid, now())
  on conflict (user_id, bank) do update
    set base_url   = excluded.base_url,
        accounts   = excluded.accounts,
        client_id  = excluded.client_id,
        token_url  = excluded.token_url,
        scope      = excluded.scope,
        auth_mode  = excluded.auth_mode,
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
returns table (bank text, base_url text, accounts text, client_id text,
               client_secret text, token_url text, scope text, auth_mode text)
language sql
security definer
set search_path = public
as $$
  select c.bank, c.base_url, c.accounts, c.client_id,
         v.decrypted_secret, c.token_url, c.scope, c.auth_mode
  from public.bank_credentials c
  left join vault.decrypted_secrets v on v.id = c.secret_id
  where c.user_id = p_user_id;
$$;

-- ----------------------------------------------------------------- grants ---
revoke all on function public.fin_set_bank_credential(text, text, text, text, text, text, text, text) from public, anon;
revoke all on function public.fin_clear_bank_credential(text) from public, anon;
revoke all on function public.fin_bank_credentials(uuid) from public, anon, authenticated;

grant execute on function public.fin_set_bank_credential(text, text, text, text, text, text, text, text) to authenticated;
grant execute on function public.fin_clear_bank_credential(text) to authenticated;
grant execute on function public.fin_bank_credentials(uuid) to service_role;

notify pgrst, 'reload schema';
