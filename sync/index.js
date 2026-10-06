"use strict";
/* Entry point.

     node sync/index.js            fetch and store
     node sync/index.js --check    read-only: can it reach Supabase, and is
                                   the configuration right? Touches no bank
                                   and writes nothing.
     node sync/index.js --dry-run  a full run that stores nothing, printing
                                   what it would have stored.

   Exits non-zero on failure so a cron or a systemd timer reports it. */

const { load } = require("./config");
const { createStore } = require("./store");
const { run } = require("./run");
const { dryStore, summarise } = require("./dryrun");
const makeBogClients = require("./banks/bog-client");
const makeTbcClients = require("./banks/tbc-client");

const MODE = process.argv.includes("--check") ? "check"
  : process.argv.includes("--dry-run") ? "dry" : "run";

function buildClients(cfg) {
  const clients = {};
  if (cfg.banks.bog.enabled) clients.bog = makeBogClients(cfg.banks.bog);
  if (cfg.banks.tbc.enabled) clients.tbc = makeTbcClients(cfg.banks.tbc);
  return clients;
}

/* Everything that can go wrong before a bank is ever called: a wrong project
   URL, a key without the rights, the wrong user id, tables not created yet. */
async function check(cfg, store) {
  console.log("Supabase  " + cfg.supabase.url);
  console.log("user      " + cfg.supabase.userId);

  const cats = await store.readCats();
  console.log(cats
    ? "categories  " + cats.length + " of your own rules found"
    : "categories  none stored yet — the defaults would be used");

  for (const id of ["bog", "tbc"]) {
    const b = cfg.banks[id];
    if (!b.enabled) { console.log(b.label.padEnd(10) + "not configured, would be skipped"); continue; }
    const st = await store.readSyncState(id);
    console.log(b.label.padEnd(10) + (b.accounts.length || "all") + " account(s), " +
      (st ? "last run " + (st.last_run_at || "?") + " (" + (st.last_status || "?") + "), bookmark " + (st.last_day || "none")
          : "never run"));
    if (st && st.last_error) console.log("          last error: " + st.last_error);
  }

  /* The clients are built but never called: this catches a missing account
     list or a half-filled authentication before a real run does. */
  const clients = buildClients(cfg);
  for (const id of Object.keys(clients)) {
    const list = clients[id];
    console.log(cfg.banks[id].label.padEnd(10) + "client ready: " + list.map(c => c.label).join(", "));
  }

  console.log("\nlooks reachable. Nothing was written.");
}

async function main() {
  const cfg = load();
  const real = createStore(cfg);

  if (MODE === "check") return check(cfg, real);

  const clients = buildClients(cfg);
  if (!Object.values(clients).some(c => c && c.length)) {
    console.error("no bank is configured — set BOG_BASE_URL and/or TBC_BASE_URL");
    process.exit(2);
  }

  const dry = MODE === "dry";
  const store = dry ? dryStore(real, console.log) : real;
  if (dry) console.log("DRY RUN — nothing will be stored\n");

  const started = Date.now();
  const out = await run({ cfg, store, clients });
  const failed = out.results.filter(r => !r.ok);

  if (dry) console.log("\n" + summarise(store.planned) + "\n");
  console.log("done in " + ((Date.now() - started) / 1000).toFixed(1) + "s, " +
    out.added + (dry ? " transaction(s) would be stored" : " new transaction(s)"));

  if (failed.length) {
    console.error(failed.length + " bank(s) failed: " + failed.map(f => f.bank).join(", "));
    process.exit(1);
  }
}

main().catch(e => {
  /* The message may name a host or a path but never a credential — config.js
     keeps those out of anything printed. */
  console.error("sync failed: " + String((e && e.message) || e));
  process.exit(1);
});
