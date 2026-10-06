"use strict";
/* Run: node sync/test/run.test.js
   Exercises the whole run against a fake bank and a fake store: the window it
   asks for, paging, categorisation, dedup, the bookmark, and what happens when
   a bank fails or a run is repeated. */

const { run, syncBank, windowFor, toRows, addDays, dayString } = require("../run");
const FinCat = require("../../shared/categorize");
const bog = require("../banks/bog");
const tbc = require("../banks/tbc");

const A = [];
const chk = (c, m) => { A.push((c ? "PASS " : "FAIL ") + m); if (!c) process.exitCode = 1; };
const eq = (got, want, m) => chk(JSON.stringify(got) === JSON.stringify(want), m + " → " + JSON.stringify(got));

const CFG = {
  supabase: { url: "https://x.supabase.co", serviceKey: "k", userId: "u1" },
  overlapDays: 7, backfillDays: 90,
};
const TODAY = "2026-07-20";

/* ---------------------------------------------------- the date window --- */

eq(addDays("2026-07-01", -7), "2026-06-24", "a window reaches back across a month boundary");
eq(addDays("2026-01-01", -1), "2025-12-31", "and across a year boundary");
eq(addDays("2028-03-01", -1), "2028-02-29", "and over a leap day");
eq(windowFor(null, CFG, TODAY), { from: "2026-04-21", to: TODAY }, "a first run backfills");
eq(windowFor({ last_day: "2026-07-18" }, CFG, TODAY), { from: "2026-07-11", to: TODAY },
   "a later run re-reads the overlap before the bookmark, not just what is new");
chk(windowFor({ last_day: "2026-07-18" }, CFG, TODAY).from < "2026-07-18",
    "the window always starts before the bookmark, so a backdated entry is still caught");

/* --------------------------------------------------------- fake store --- */

function fakeStore(opts) {
  const o = opts || {};
  return {
    rows: new Map(),            // dedup_key -> row
    state: new Map(),
    inserts: 0, rebuilds: 0,
    async readCats() { return o.cats || null; },
    async readSyncState(bank) { return this.state.get(bank) || null; },
    async writeSyncState(bank, patch) {
      this.state.set(bank, Object.assign({}, this.state.get(bank) || {}, patch));
    },
    async insertTransactions(rows) {
      this.inserts++;
      let added = 0;
      for (const r of rows) {
        if (this.rows.has(r.dedup_key)) continue;   // the database ignores duplicates
        this.rows.set(r.dedup_key, r); added++;
      }
      return added;
    },
    async rebuildSummary() { this.rebuilds++; return true; },
  };
}

/* ---------------------------------------------------------- fake bank --- */

// BOG: 2,300 entries over three pages of 1,000
function bogRecords(n, offset) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const k = offset + i;
    out.push({
      entryId: 100000 + k,
      entryDate: "2026-07-" + String(1 + (k % 20)).padStart(2, "0") + "T10:00:00+04:00",
      entryAmountCredit: 0, entryAmountCreditBase: 0,
      entryAmountDebit: 10 + (k % 5), entryAmountDebitBase: 10 + (k % 5),
      documentNomination: k % 7 === 0 ? "Yandex Go" : "გადარიცხვა " + k,
      documentProductGroup: "გადარიცხვა",
      beneficiaryDetails: { name: "პარტნიორი " + (k % 3) },
    });
  }
  return out;
}

function bogClient(total) {
  const calls = [];
  return {
    calls,
    async fetchPage(req) {
      calls.push(req);
      const start = req.pageIndex * bog.PAGE_SIZE;
      const n = Math.max(0, Math.min(bog.PAGE_SIZE, total - start));
      return { totalCount: total, count: n, records: bogRecords(n, start) };
    },
  };
}

/* ------------------------------------------------- paging and dedup --- */

(async () => {
  const rules = FinCat.compile(FinCat.defaultCats());

  // 2,300 BOG entries must come back over exactly three pages
  let store = fakeStore();
  let client = bogClient(2300);
  let r = await syncBank("bog", client, store, CFG, rules, () => {}, TODAY);
  eq(r.seen, 2300, "every record on every page was read");
  eq(r.pages, 3, "2,300 records over 1,000 per page is three requests");
  eq(r.added, 2300, "all of them were new");
  eq(store.rows.size, 2300, "and all of them were stored");
  eq(client.calls.map(c => c.pageIndex), [0, 1, 2], "pages were asked for in order from zero");
  chk(client.calls.every(c => c.from === "2026-04-21" && c.to === TODAY),
      "every page asked for the same window");

  // running it again must change nothing at all
  const before = store.rows.size;
  const second = await syncBank("bog", client, store, CFG, rules, () => {}, TODAY);
  eq(second.added, 0, "a repeated run adds nothing");
  eq(store.rows.size, before, "and leaves the stored rows exactly as they were");

  // an empty period stops after one request
  store = fakeStore(); client = bogClient(0);
  r = await syncBank("bog", client, store, CFG, rules, () => {}, TODAY);
  eq(r.pages, 1, "an empty period costs one request");
  eq(r.added, 0, "and stores nothing");

  /* ------------------------------------------- categories and shape --- */

  store = fakeStore();
  client = bogClient(20);
  await syncBank("bog", client, store, CFG, rules, () => {}, TODAY);
  const stored = [...store.rows.values()];
  const yandex = stored.filter(x => x.category === "იანდექსი");
  chk(yandex.length === 3, "synced rows are categorised by the user's rules → " + yandex.length + " Yandex rows");
  chk(stored.every(x => x.user_id === "u1"), "every row carries the user id");
  chk(stored.every(x => x.dedup_key.startsWith("BOG|")), "every dedup key is namespaced by bank");
  chk(stored.every(x => x.import_id === "sync-bog"), "synced rows are grouped under one import id");
  chk(stored.every(x => x.manual === false), "synced rows are not marked manual");
  chk(stored.every(x => /^\d{4}-\d{2}-\d{2}$/.test(x.txdate)), "every row has a plain calendar date");
  chk(stored.every(x => x.amount > 0 && x.ttype === "expense"), "amounts are unsigned, direction is the type");
  eq(Object.keys(stored[0]).sort(),
     ["amount", "bank", "category", "dedup_key", "descr", "id", "import_id", "manual", "match_text", "ttype", "txdate", "user_id"],
     "the row carries exactly the columns the app stores");

  // the user's own rules win over the defaults
  const custom = [
    { name: "ჩემი კატეგორია", type: "expense", keywords: ["yandex"], exclude: [], include: true },
    { name: "სხვა", type: "any", keywords: [], exclude: [], include: true },
  ];
  store = fakeStore({ cats: custom });
  await run({ cfg: CFG, store, clients: { bog: bogClient(20) }, log: () => {}, today: TODAY });
  chk([...store.rows.values()].some(x => x.category === "ჩემი კატეგორია"),
      "the user's own categories are used, not the defaults");

  /* -------------------------------------------------- the bookmark --- */

  store = fakeStore();
  await run({ cfg: CFG, store, clients: { bog: bogClient(50) }, log: () => {}, today: TODAY });
  let st = store.state.get("bog");
  chk(st && st.last_status === "ok", "a successful run is recorded");
  eq(st.last_day, "2026-07-20", "the bookmark moves to the newest transaction seen");
  eq(st.last_added, 50, "the run records how many rows were new");
  chk(!st.last_error, "and clears any previous error");

  /* ------------------------------------------------------ failures --- */

  store = fakeStore();
  await store.writeSyncState("bog", { last_day: "2026-07-18", last_status: "ok" });
  const broken = { async fetchPage() { throw new Error("401 unauthorized"); } };
  const out = await run({
    cfg: CFG, store,
    clients: { bog: broken, tbc: tbcClient(5) },
    log: () => {}, today: TODAY,
  });
  st = store.state.get("bog");
  eq(st.last_status, "error", "a failing bank is recorded as failed");
  eq(st.last_day, "2026-07-18", "and its bookmark does NOT move, so nothing is skipped next run");
  chk(/401/.test(st.last_error), "the reason is kept → " + st.last_error);
  chk(out.results.some(x => x.bank === "tbc" && x.ok), "the other bank still synced");
  // 5 movements, every third awaiting authorisation (k=0 and k=3), so 3 are stored
  chk(store.rows.size === 3, "and its authorised rows were stored → " + store.rows.size);

  // a bank with no client configured is skipped, not failed
  store = fakeStore();
  const partial = await run({ cfg: CFG, store, clients: { bog: bogClient(3) }, log: () => {}, today: TODAY });
  eq(partial.results.length, 1, "an unconfigured bank is skipped silently");
  eq(partial.results[0].bank, "bog", "and the configured one ran");

  /* ------------------------------------------------------- totals --- */

  store = fakeStore();
  await run({ cfg: CFG, store, clients: { bog: bogClient(10) }, log: () => {}, today: TODAY });
  eq(store.rebuilds, 1, "adding rows rebuilds the dashboard totals");

  store = fakeStore();
  await run({ cfg: CFG, store, clients: { bog: bogClient(0) }, log: () => {}, today: TODAY });
  eq(store.rebuilds, 0, "a run that adds nothing does not rebuild them");

  /* --------------------------------------------- TBC specific path --- */

  store = fakeStore();
  const tc = tbcClient(1500);
  r = await syncBank("tbc", tc, store, CFG, rules, () => {}, TODAY);
  eq(r.pages, 3, "1,500 TBC movements over 700 per page is three requests");
  eq(r.seen, 1500, "every movement was read");
  chk(r.added < 1500, "movements still awaiting authorisation were not stored");
  chk([...store.rows.values()].every(x => x.bank === "TBC"), "all stored under TBC");

  console.log(A.join("\n"));
  console.log(A.every(x => x.startsWith("PASS")) ? "\nALL PASS ✅" : "\nFAILURES ❌");
})().catch(e => { console.error(e); process.exitCode = 1; });

/* every third movement is unauthorised, so the run must drop it */
function tbcMovements(n, offset) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const k = offset + i;
    out.push({
      movementId: "mv-" + k,
      amount: 25 + (k % 9),
      currency: "GEL",
      purpose: "გადახდა " + k,
      isDebit: k % 2 === 0,
      date: "2026-07-" + String(1 + (k % 20)).padStart(2, "0") + "T09:00:00",
      statusCode: k % 3 === 0 ? 2 : 0,
      transactionType: 30,
      partnerAccountInfo: { partnerName: "პარტნიორი " + (k % 4) },
    });
  }
  return out;
}

function tbcClient(total) {
  return {
    async fetchPage(req) {
      const start = req.pageIndex * tbc.PAGE_SIZE;
      const n = Math.max(0, Math.min(tbc.PAGE_SIZE, total - start));
      return { total: total, pager: [{ pageIndex: req.pageIndex, pageSize: tbc.PAGE_SIZE }], transactions: tbcMovements(n, start) };
    },
  };
}
