"use strict";
/* A store that reads for real but never writes. Used by --dry-run so a first
   run can be watched end to end — the window, the paging, what each record
   turns into and which category it lands in — without putting a single row
   into the database. */

function dryStore(real, log) {
  const planned = [];
  return {
    async readCats() { return real.readCats(); },
    async readSyncState(bank) { return real.readSyncState(bank); },

    async writeSyncState(bank, patch) {
      log("  would set the " + bank + " bookmark to " + JSON.stringify(patch));
    },

    /* Reports every row as new. Real runs skip what is already stored, so a
       dry run's count is an upper bound, not a prediction. */
    async insertTransactions(rows) {
      for (const r of rows) planned.push(r);
      return rows.length;
    },

    async rebuildSummary() { log("  would rebuild the dashboard totals"); return true; },

    planned,
  };
}

/* What the run would have stored, in the shape a person can check against
   their own statement. */
function summarise(planned) {
  if (!planned.length) return "nothing to store";
  const byCat = new Map();
  let income = 0, expense = 0, dmin = null, dmax = null;
  for (const r of planned) {
    const k = r.category + " · " + (r.ttype === "income" ? "შემოს." : "ხარჯი");
    const e = byCat.get(k) || { n: 0, total: 0 };
    e.n++; e.total += r.amount; byCat.set(k, e);
    if (r.ttype === "income") income += r.amount; else expense += r.amount;
    if (r.txdate) { if (!dmin || r.txdate < dmin) dmin = r.txdate; if (!dmax || r.txdate > dmax) dmax = r.txdate; }
  }
  const lines = [...byCat.entries()]
    .sort((a, b) => b[1].total - a[1].total)
    .map(([k, v]) => "    " + k.padEnd(48) + String(v.n).padStart(7) + "  " + v.total.toFixed(2).padStart(14));

  return [
    "  " + planned.length + " transaction(s), " + (dmin || "?") + " → " + (dmax || "?"),
    "  income " + income.toFixed(2) + " · expense " + expense.toFixed(2) + " · net " + (income - expense).toFixed(2),
    "", "    category".padEnd(52) + "  count".padStart(6) + "           total", ...lines,
  ].join("\n");
}

module.exports = { dryStore, summarise };
