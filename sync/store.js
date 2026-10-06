"use strict";
/* Reads and writes through PostgREST directly — no client library, so the
   service deploys as plain files with nothing to install.

   This runs with the service role key, which bypasses row-level security.
   Every call therefore carries its own user_id filter: the database will not
   do it for us here. */

const CHUNK = 500;   // rows per insert; the same size the browser importer uses

function createStore(cfg, fetchImpl) {
  const doFetch = fetchImpl || globalThis.fetch;
  if (!doFetch) throw new Error("no fetch available: Node 18 or newer, or pass one in");

  const base = cfg.supabase.url + "/rest/v1";
  const userId = cfg.supabase.userId;
  const headers = {
    apikey: cfg.supabase.serviceKey,
    Authorization: "Bearer " + cfg.supabase.serviceKey,
    "Content-Type": "application/json",
  };

  async function request(path, init) {
    const res = await doFetch(base + path, Object.assign({ headers: headers }, init));
    const body = await res.text();
    if (!res.ok) {
      /* Never echo the body wholesale: a PostgREST error can quote the row it
         choked on, and these rows are the user's bank transactions. */
      throw new Error("supabase " + res.status + " on " + path.split("?")[0] + ": " + body.slice(0, 200));
    }
    return body ? JSON.parse(body) : null;
  }

  return {
    /* The user's own category rules, so a synced transaction is filed exactly
       as the same one imported from a spreadsheet would be. */
    async readCats() {
      const rows = await request("/finance_state?user_id=eq." + enc(userId) + "&select=cats&limit=1");
      const cats = rows && rows[0] && rows[0].cats;
      return Array.isArray(cats) && cats.length ? cats : null;
    },

    /* The keys the user entered in the app. Only the service role may call
       this function, and the key is decrypted from the vault inside it — the
       browser has no route to the value at all. */
    async readBankCredentials() {
      const rows = await request("/rpc/fin_bank_credentials", {
        method: "POST",
        body: JSON.stringify({ p_user_id: userId }),
      });
      const out = {};
      for (const r of rows || []) {
        if (!r.bank) continue;
        out[r.bank] = {
          baseUrl: r.base_url || "",
          clientId: r.client_id || "",
          clientSecret: r.client_secret || "",
          tokenUrl: r.token_url || "",
          scope: r.scope || "",
          authMode: r.auth_mode || "oauth_basic",
          accounts: r.accounts || "",
        };
      }
      return out;
    },

    async readSyncState(bank) {
      const rows = await request(
        "/sync_state?user_id=eq." + enc(userId) + "&bank=eq." + enc(bank) + "&select=*&limit=1");
      return (rows && rows[0]) || null;
    },

    async writeSyncState(bank, patch) {
      const row = Object.assign({ user_id: userId, bank: bank }, patch);
      await request("/sync_state?on_conflict=user_id,bank", {
        method: "POST",
        headers: Object.assign({}, headers, { Prefer: "resolution=merge-duplicates,return=minimal" }),
        body: JSON.stringify([row]),
      });
    },

    /* Insert ignoring anything already stored. The dedup key is the bank's own
       transaction id, so re-reading an overlapping window costs nothing and a
       transaction can never be counted twice. Returns how many were new. */
    async insertTransactions(rows) {
      let added = 0;
      for (let i = 0; i < rows.length; i += CHUNK) {
        const slice = rows.slice(i, i + CHUNK);
        const got = await request("/transactions?on_conflict=user_id,dedup_key", {
          method: "POST",
          headers: Object.assign({}, headers, {
            Prefer: "resolution=ignore-duplicates,return=representation",
          }),
          body: JSON.stringify(slice),
        });
        added += (got || []).length;
      }
      return added;
    },

    /* The dashboard reads pre-aggregated totals; new rows make them stale.
       Best effort — the app verifies its own figures against the rows and
       repairs them, so a failure here costs a slower first load, not a wrong
       number. */
    async rebuildSummary() {
      try {
        await request("/rpc/fin_rebuild_summary", { method: "POST", body: "{}" });
        return true;
      } catch (e) {
        return false;
      }
    },
  };
}

function enc(v) { return encodeURIComponent(v); }

module.exports = { createStore, CHUNK };
