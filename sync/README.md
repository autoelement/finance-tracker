# Bank sync

Fetches transactions from BOG and TBC and stores them in Supabase, so the
dashboard fills itself instead of being fed spreadsheets.

**This service must never run anywhere a browser can reach it.** It holds the
bank credentials and the Supabase service role key. Anything placed in the web
app is public — the page source is readable by anyone who opens the site.

## What is finished and what is not

Finished and tested: translating each bank's records into stored rows, paging,
categorising with the user's own rules, de-duplication, the bookmark, error
handling, and the schedule.

Authentication is OAuth2 client credentials: the banks issue a Client ID and a
Client Secret, which are exchanged for a bearer token at a token endpoint, and
the token is reused until shortly before it expires. Banks differ on where the
pair goes in the token request, so both conventions are supported and the mode
is chosen per bank:

| mode | where the pair goes |
|---|---|
| `oauth_basic` | an `Authorization: Basic` header — the usual one |
| `oauth_body` | `client_id` / `client_secret` in the form body |
| `header` | no exchange at all: the pair is sent on every call |

If a token request comes back 400 or 401 while the credentials are certainly
right, it is almost always the other OAuth mode.

## Running it

Needs Node 18 or newer. No dependencies to install.

```sh
node sync/index.js --check     # read-only: is the configuration right?
node sync/index.js --dry-run   # a full run that stores nothing
node sync/index.js             # fetch and store
```

`--check` reaches no bank and writes nothing. It confirms the Supabase URL,
key and user id work, reports which categories and bookmarks it found, and
builds each bank's client without calling it — so a missing account list or a
half-filled authentication shows up before a real run.

`--dry-run` does the whole thing except the writing, and prints what it would
have stored, broken down by category, so the figures can be checked against a
statement before anything lands in the database.

### Where the credentials come from

Two sources, and the app wins over the environment:

**From the app** — Settings → ბანკების კავშირი. The Client ID is an ordinary
column; the Client Secret goes into Supabase Vault, encrypted. The page can set
and replace it but has no route to read it back: the table grants the browser
named columns only, the pointer is not among them, and the function that
decrypts is granted to the service role alone. Convenient — a secret is rotated
from a browser — but it does pass through the browser once, when it is typed,
and it does rest in the database.

**From the environment** — the stronger of the two: the key never touches a
browser and is never in the database. Less convenient: rotating it means
reaching the machine.

An incomplete entry is ignored: a stored URL with no secret leaves a working
environment configuration alone rather than half-overwriting it.

Nothing is read from a file in this repository, and no credential is ever
printed.

| Variable | Required | Meaning |
|---|---|---|
| `SUPABASE_URL` | yes | e.g. `https://xxxx.supabase.co` |
| `SUPABASE_SERVICE_KEY` | yes | service role key — **server only** |
| `FINANCE_USER_ID` | yes | the account's user id, from Supabase → Authentication → Users |
| `BOG_BASE_URL` | per bank | leave unset to skip BOG |
| `BOG_CLIENT_ID` | per bank | |
| `BOG_CLIENT_SECRET` | per bank | |
| `BOG_TOKEN_URL` | for OAuth | the token endpoint |
| `BOG_SCOPE` | no | if the bank requires one |
| `BOG_AUTH_MODE` | no | `oauth_basic` (default), `oauth_body` or `header` |
| `BOG_ACCOUNTS` | with BOG | `GE00BG…:GEL,GE00BG…:USD` — the statement endpoint is per account |
| `TBC_BASE_URL` | per bank | leave unset to skip TBC |
| `TBC_CLIENT_ID` | per bank | |
| `TBC_CLIENT_SECRET` | per bank | |
| `TBC_TOKEN_URL` | for OAuth | the token endpoint |
| `TBC_SCOPE` | no | |
| `TBC_AUTH_MODE` | no | `oauth_basic` (default), `oauth_body` or `header` |
| `TBC_ACCOUNTS` | no | blank means every account the credentials can see |
| `SYNC_OVERLAP_DAYS` | no | days re-read before the bookmark (default 7) |
| `SYNC_BACKFILL_DAYS` | no | how far the first run reaches (default 90) |

A bank is used only once it has a base URL, a client id and a client secret.
Anything less is skipped rather than failing, so one bank can go live while the
other is still being arranged.

## Before the first run

In the Supabase SQL editor, run `sql/setup.sql`, then `sql/sync_state.sql`, then
`sql/bank_credentials.sql`.

## Two properties this depends on

**Running it twice changes nothing.** Every row carries the bank's own
transaction id as its dedup key — BOG's `entryId`, TBC's `movementId` — and the
insert ignores duplicates. A crashed run is fixed by running it again. Those
are also the ids the spreadsheet exports carry, so transactions already
imported from a file do not come back as duplicates.

**Nothing is missed.** Banks backdate: a statement entry can appear days after
its value date, and a TBC movement is invisible until it is authorised. So each
run re-reads `SYNC_OVERLAP_DAYS` before the bookmark rather than starting where
it stopped. A bank that fails does not move its bookmark, so the next run
covers the same ground.

## Scheduling

A timer, a cron line, or a container — it is a plain Node script, so all three
work the same.

```
# daily at 06:40, credentials from a root-only file
40 6 * * * set -a; . /etc/finance-sync.env; set +a; /usr/bin/node /opt/finance-tracker/sync/index.js >> /var/log/finance-sync.log 2>&1
```

Keep the environment file readable only by the user that runs the service
(`chmod 600`). It is the thing worth protecting here.

## Tests

```sh
npm test
```

The sync tests use a fake bank and a fake store, so they need no credentials
and reach no network.
