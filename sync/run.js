"use strict";
/* One sync run: work out the window, page through the bank, turn each record
   into a row, file it under the user's own category rules, and store it.

   Two properties matter more than anything else here:

   - Repeating a run must change nothing. Every row carries the bank's own
     transaction id as its dedup key, and the insert ignores duplicates, so a
     crashed run is fixed by running it again.
   - A transaction must never be missed. Banks backdate: a statement entry can
     appear days after its value date, and a TBC movement only becomes visible
     once authorised. So each run re-reads a window before the last bookmark
     rather than starting where it left off. */

const FinCat = require("../shared/categorize");
const bogAdapter = require("./banks/bog");
const tbcAdapter = require("./banks/tbc");

const ADAPTERS = { bog: bogAdapter, tbc: tbcAdapter };
const MAX_PAGES = 2000;   // a guard against a bank that keeps saying "one more"

function dayString(d) {
  const p = n => (n < 10 ? "0" : "") + n;
  return d.getUTCFullYear() + "-" + p(d.getUTCMonth() + 1) + "-" + p(d.getUTCDate());
}
function addDays(day, n) {
  const d = new Date(day + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return dayString(d);
}

/* Where this run starts: a window before the last bookmark, or the backfill
   reach on the very first run. */
function windowFor(state, cfg, today) {
  const last = state && state.last_day;
  const from = last ? addDays(last, -cfg.overlapDays) : addDays(today, -cfg.backfillDays);
  return { from: from, to: today };
}

/* rows the page already holds, as the app stores them */
function toRows(records, adapter, importId, rules, userId) {
  const out = [];
  for (const rec of records) {
    const r = adapter.normalize(rec, importId);
    if (!r) continue;
    out.push({
      id: "t" + Math.random().toString(36).slice(2, 10),
      user_id: userId,
      import_id: r.importId,
      dedup_key: r._key,
      txdate: r.dateStr && r.dateStr !== "—" ? r.dateStr : null,
      descr: r.desc,
      category: FinCat.match(rules, FinCat.norm(r.matchText), r.type),
      ttype: r.type,
      amount: r.amount,
      bank: r.bank,
      manual: false,
      match_text: r.matchText,
    });
  }
  return out;
}

/* Fetch every page of one bank's window. `client.fetchPage(req)` is the only
   part that talks to the bank; it is injected so this logic can be tested
   without credentials and so each bank's authentication stays in one place.

   A bank may have several streams — BOG's statement endpoint is per account
   and currency, so one client per account. They share the bank's window and
   its bookmark, which is what we want: a run covers the whole bank or none
   of it. */
async function syncBank(bankId, clientOrList, store, cfg, rules, log, today) {
  const adapter = ADAPTERS[bankId];
  if (!adapter) throw new Error("unknown bank: " + bankId);

  const clients = Array.isArray(clientOrList) ? clientOrList : [clientOrList];
  const state = await store.readSyncState(bankId);
  const win = windowFor(state, cfg, today);
  const importId = "sync-" + bankId;

  log("· " + adapter.name + ": " + win.from + " → " + win.to +
      (clients.length > 1 ? " (" + clients.length + " accounts)" : ""));

  let seen = 0, added = 0, pages = 0, latest = state && state.last_day;

  for (const client of clients) {
    for (let pageIndex = 0; pageIndex < MAX_PAGES; pageIndex++) {
      const body = await client.fetchPage({ from: win.from, to: win.to, pageIndex: pageIndex });
      const records = adapter.recordsOf(body);
      pages++;
      seen += records.length;

      if (records.length) {
        const rows = toRows(records, adapter, importId, rules, cfg.supabase.userId);
        added += await store.insertTransactions(rows);
        for (const r of rows) if (r.txdate && (!latest || r.txdate > latest)) latest = r.txdate;
      }

      const total = adapter.pageCount(body);
      if (pageIndex + 1 >= total || records.length === 0) break;
    }
  }

  log("  " + adapter.name + ": " + seen + " read over " + pages + " page(s), " + added + " new");
  return { bank: bankId, seen, added, pages, from: win.from, to: win.to, latest: latest || win.to };
}

/* `clients` maps a bank id to something with fetchPage(). Banks without one
   are skipped, so the other still syncs while credentials are being arranged. */
async function run(opts) {
  const { cfg, store, clients } = opts;
  const log = opts.log || console.log;
  const today = opts.today || dayString(new Date());

  const cats = (await store.readCats()) || FinCat.defaultCats();
  const rules = FinCat.compile(cats);

  const results = [];
  let totalAdded = 0;

  for (const bankId of Object.keys(ADAPTERS)) {
    const client = clients[bankId];
    const any = Array.isArray(client) ? client.length > 0 : !!client;
    if (!any) { log("· " + ADAPTERS[bankId].name + ": skipped, not configured"); continue; }

    const startedAt = new Date().toISOString();
    try {
      const r = await syncBank(bankId, client, store, cfg, rules, log, today);
      totalAdded += r.added;
      results.push(Object.assign({ ok: true }, r));
      await store.writeSyncState(bankId, {
        last_day: r.latest,
        last_run_at: startedAt,
        last_status: "ok",
        last_error: null,
        last_added: r.added,
      });
    } catch (e) {
      /* One bank failing must not stop the other, and the bookmark must not
         move: the next run then re-reads the same window. */
      const msg = String((e && e.message) || e).slice(0, 300);
      log("  " + ADAPTERS[bankId].name + ": FAILED — " + msg);
      results.push({ ok: false, bank: bankId, error: msg });
      try {
        await store.writeSyncState(bankId, {
          last_run_at: startedAt, last_status: "error", last_error: msg,
        });
      } catch (_) { /* reporting the failure must not mask it */ }
    }
  }

  if (totalAdded > 0) {
    const rebuilt = await store.rebuildSummary();
    log(rebuilt ? "· totals rebuilt" : "· totals not rebuilt; the app will repair them on next open");
  }

  return { results, added: totalAdded };
}

module.exports = { run, syncBank, windowFor, toRows, dayString, addDays, ADAPTERS, MAX_PAGES };
