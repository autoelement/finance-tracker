"use strict";
/* Bank of Georgia — HTTP client.
   GET {BASE_URL}/api/v2/statement/{account}/{currency}/{from}/{to}?page=N

   The statement endpoint is per account and currency, so this builds one
   client per configured account; sync/run.js walks them in turn. The token
   is shared across them — one exchange per run, not one per account. */

const bog = require("./bog");
const { createAuthorizer } = require("./auth");

function makeClients(bankCfg, fetchImpl) {
  const doFetch = fetchImpl || globalThis.fetch;
  const base = String(bankCfg.baseUrl || "").replace(/\/+$/, "");
  const accounts = bankCfg.accounts && bankCfg.accounts.length ? bankCfg.accounts : [];

  if (!base) return [];
  if (!accounts.length) throw new Error("BOG: no accounts configured — set IBAN:CURRENCY, comma separated");

  const authorize = createAuthorizer(Object.assign({ label: "BOG" }, bankCfg), doFetch);

  return accounts.map(acc => ({
    label: "BOG " + acc.account + " " + acc.currency,
    async fetchPage(req) {
      /* The documentation describes `page` without pinning its first value.
         run.js counts from zero, so the first request sends no page at all —
         which both conventions accept — and later ones send pageIndex + 1. */
      const page = req.pageIndex > 0 ? req.pageIndex + 1 : 0;
      const path = bog.statementPath(acc.account, acc.currency, req.from, req.to, page);
      const res = await doFetch(base + "/" + path, { headers: await authorize() });
      if (!res.ok) {
        /* The body can quote the account, so only the status is reported. */
        throw new Error("BOG " + res.status + " on statement " + acc.currency);
      }
      return res.json();
    },
  }));
}

module.exports = makeClients;
