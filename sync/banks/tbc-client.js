"use strict";
/* TBC — HTTP client.
   GET {BASE_URL}/bab/v1/accounts/movements?PeriodFrom=…&PeriodTo=…&PageIndex=N

   Unlike BOG, the account filter is optional: with no account the endpoint
   returns the movements of every account the credentials can see, which is
   what we want. Naming an account means also naming its currency.

   ─────────────────────────────────────────────────────────────────────────
   STILL TO FILL IN: authentication. Everything else is done.
   See the same note in bog-client.js — put the scheme TBC gave you in
   authHeaders() and nothing else in the project needs to change.
   ───────────────────────────────────────────────────────────────────────── */

const tbc = require("./tbc");

function makeClients(bankCfg, fetchImpl) {
  const doFetch = fetchImpl || globalThis.fetch;
  const base = String(bankCfg.baseUrl || "").replace(/\/+$/, "");
  if (!base) return [];

  /* With no account configured, one stream covering everything. */
  const accounts = bankCfg.accounts && bankCfg.accounts.length ? bankCfg.accounts : [null];

  return accounts.map(acc => ({
    label: acc ? "TBC " + acc.account + " " + acc.currency : "TBC all accounts",
    async fetchPage(req) {
      /* The period filters want a date-time, and the day must be covered end
         to end or the last day's transactions are lost. */
      const query = tbc.movementsQuery({
        account: acc ? acc.account : undefined,
        currency: acc ? acc.currency : undefined,
        from: req.from + "T00:00:00",
        to: req.to + "T23:59:59",
        pageIndex: req.pageIndex,
      });
      const url = base + "/bab/v1/accounts/movements?" + new URLSearchParams(query).toString();
      const res = await doFetch(url, { headers: authHeaders(bankCfg) });
      if (!res.ok) {
        throw new Error("TBC " + res.status + " on movements: " + (await res.text()).slice(0, 200));
      }
      return res.json();
    },
  }));
}

function authHeaders(cfg) {
  // TODO: the scheme TBC gave you. See the note at the top of this file.
  if (!cfg.apiKey) throw new Error("TBC authentication is not configured yet (sync/banks/tbc-client.js)");
  return { Authorization: "Bearer " + cfg.apiKey, Accept: "application/json" };
}

module.exports = makeClients;
