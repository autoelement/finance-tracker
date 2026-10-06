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

Not finished: **authentication**. Each bank's client has one function to fill
in — `authHeaders()` in `banks/bog-client.js` and `banks/tbc-client.js` — and
nothing else in the project needs to change.

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

**From the app** — Settings → ბანკების კავშირი. The key goes into Supabase
Vault, encrypted. The page can set and replace it but has no route to read it
back: the table grants the browser named columns only, the pointer is not
among them, and the function that decrypts is granted to the service role
alone. Convenient — a key is rotated from a browser — but the key does pass
through the browser once, when it is typed, and it does sit in the database.

**From the environment** — the stronger of the two: the key never touches a
browser and is never in the database. Less convenient: rotating it means
reaching the machine.

Half a pair is ignored: a stored URL with no key leaves a working environment
configuration alone rather than breaking it.

Nothing is read from a file in this repository, and no credential is ever
printed.

| Variable | Required | Meaning |
|---|---|---|
| `SUPABASE_URL` | yes | e.g. `https://xxxx.supabase.co` |
| `SUPABASE_SERVICE_KEY` | yes | service role key — **server only** |
| `FINANCE_USER_ID` | yes | the account's user id, from Supabase → Authentication → Users |
| `BOG_BASE_URL` | per bank | leave unset to skip BOG |
| `BOG_API_KEY` | per bank | whatever the finished `authHeaders()` needs |
| `BOG_ACCOUNTS` | with BOG | `GE00BG…:GEL,GE00BG…:USD` — the statement endpoint is per account |
| `TBC_BASE_URL` | per bank | leave unset to skip TBC |
| `TBC_API_KEY` | per bank | |
| `TBC_ACCOUNTS` | no | blank means every account the credentials can see |
| `SYNC_OVERLAP_DAYS` | no | days re-read before the bookmark (default 7) |
| `SYNC_BACKFILL_DAYS` | no | how far the first run reaches (default 90) |

A bank with no `BASE_URL` is skipped rather than failing, so one bank can go
live while the other is still being arranged.

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
