"use strict";
/* Entry point: node sync/index.js
   Reads its configuration from the environment, builds a client per bank that
   has credentials, and runs one sync. Exits non-zero on failure so a cron or
   a systemd timer reports it. */

const { load } = require("./config");
const { createStore } = require("./store");
const { run } = require("./run");
const makeBogClients = require("./banks/bog-client");
const makeTbcClients = require("./banks/tbc-client");

async function main() {
  const cfg = load();
  const store = createStore(cfg);

  const clients = {};
  if (cfg.banks.bog.enabled) clients.bog = makeBogClients(cfg.banks.bog);
  if (cfg.banks.tbc.enabled) clients.tbc = makeTbcClients(cfg.banks.tbc);

  if (!Object.values(clients).some(c => c && c.length)) {
    console.error("no bank is configured — set BOG_BASE_URL and/or TBC_BASE_URL");
    process.exit(2);
  }

  const started = Date.now();
  const out = await run({ cfg, store, clients });
  const failed = out.results.filter(r => !r.ok);

  console.log("done in " + ((Date.now() - started) / 1000).toFixed(1) + "s, " +
    out.added + " new transaction(s)");
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
