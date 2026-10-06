"use strict";
/* Bank of Georgia — HTTP client.
   GET {BASE_URL}/api/v2/statement/{account}/{currency}/{from}/{to}?page=N

   The statement endpoint is per account and currency, so this builds one
   client per configured account; sync/run.js walks them in turn.

   ─────────────────────────────────────────────────────────────────────────
   STILL TO FILL IN: authentication. Everything else is done.
   Put the scheme the bank gave you in authHeaders() below — nothing else in
   the project needs to change. The usual shapes:

     API key      →  { "Authorization": "Bearer " + cfg.apiKey }
     Basic        →  { "Authorization": "Basic " + Buffer.from(u+":"+p).toString("base64") }
     OAuth2       →  fetch a token first, cache it until it expires, send it
                     as a bearer. Put that in getToken() and call it here.
     mTLS         →  no header at all; build an https.Agent with the client
                     certificate and pass it as `dispatcher`/`agent` on fetch.
   ───────────────────────────────────────────────────────────────────────── */

const bog = require("./bog");

function makeClients(bankCfg, fetchImpl) {
  const doFetch = fetchImpl || globalThis.fetch;
  const base = String(bankCfg.baseUrl || "").replace(/\/+$/, "");
  const accounts = bankCfg.accounts && bankCfg.accounts.length ? bankCfg.accounts : [];

  if (!base) return [];
  if (!accounts.length) throw new Error("BOG_ACCOUNTS is empty — set IBAN:CURRENCY, comma separated");

  return accounts.map(acc => ({
    label: "BOG " + acc.account + " " + acc.currency,
    async fetchPage(req) {
      /* The documentation describes `page` without pinning its first value.
         run.js counts pages from zero, so the first request here sends no
         page at all — which both conventions accept — and later ones send
         pageIndex + 1. Correct either way. */
      const page = req.pageIndex > 0 ? req.pageIndex + 1 : 0;
      const path = bog.statementPath(acc.account, acc.currency, req.from, req.to, page);
      const res = await doFetch(base + "/" + path, { headers: authHeaders(bankCfg) });
      if (!res.ok) {
        throw new Error("BOG " + res.status + " on statement " + acc.currency +
          ": " + (await res.text()).slice(0, 200));
      }
      return res.json();
    },
  }));
}

function authHeaders(cfg) {
  // TODO: the scheme BOG gave you. See the note at the top of this file.
  if (!cfg.apiKey) throw new Error("BOG authentication is not configured yet (sync/banks/bog-client.js)");
  return { Authorization: "Bearer " + cfg.apiKey, Accept: "application/json" };
}

module.exports = makeClients;
