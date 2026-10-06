"use strict";
/* Run: node sync/test/config.test.js
   Which credentials win, and what happens when only half of a pair is set. */

const path = require("path");
const { withStored } = require("../config");

const A = [];
const chk = (c, m) => { A.push((c ? "PASS " : "FAIL ") + m); if (!c) process.exitCode = 1; };
const eq = (got, want, m) => chk(JSON.stringify(got) === JSON.stringify(want), m + " → " + JSON.stringify(got));

function baseCfg(over) {
  return {
    banks: {
      bog: Object.assign({ label: "BOG", enabled: false, baseUrl: "", clientId: "", clientSecret: "", accounts: [] }, (over || {}).bog),
      tbc: Object.assign({ label: "TBC", enabled: false, baseUrl: "", clientId: "", clientSecret: "", accounts: [] }, (over || {}).tbc),
    },
  };
}

/* nothing stored, nothing in the environment */
let c = withStored(baseCfg(), {});
chk(!c.banks.bog.enabled && !c.banks.tbc.enabled, "with nothing configured, no bank is enabled");

/* the app's credentials enable a bank that the environment knows nothing about */
c = withStored(baseCfg(), {
  bog: { baseUrl: "https://bog.example", clientId: "cid", clientSecret: "sec",
         tokenUrl: "https://bog.example/token", scope: "statements:read", accounts: "GE1:GEL,GE2:USD" },
});
chk(c.banks.bog.enabled, "credentials entered in the app enable the bank");
eq(c.banks.bog.baseUrl, "https://bog.example", "the stored base url is used");
eq(c.banks.bog.clientId, "cid", "the stored client id is used");
eq(c.banks.bog.clientSecret, "sec", "the stored client secret is used");
eq(c.banks.bog.tokenUrl, "https://bog.example/token", "the stored token endpoint is used");
eq(c.banks.bog.scope, "statements:read", "the stored scope is used");
eq(c.banks.bog.authMode, "oauth_basic", "the auth mode defaults to Basic");
eq(c.banks.bog.accounts, [{ account: "GE1", currency: "GEL" }, { account: "GE2", currency: "USD" }],
   "the stored account list is parsed");
eq(c.banks.bog.source, "app", "and the source is recorded, so --check can say where it came from");
chk(!c.banks.tbc.enabled, "a bank with nothing stored stays disabled");

/* an account without a currency still parses, defaulting to lari */
c = withStored(baseCfg(), { tbc: { baseUrl: "u", clientId: "i", clientSecret: "s", accounts: "GE9" } });
eq(c.banks.tbc.accounts, [{ account: "GE9", currency: "GEL" }], "an account with no currency defaults to GEL");

/* blank accounts leave whatever the environment had, rather than wiping it */
c = withStored(baseCfg({ tbc: { accounts: [{ account: "ENV", currency: "GEL" }] } }),
               { tbc: { baseUrl: "u", clientId: "i", clientSecret: "s", accounts: "" } });
eq(c.banks.tbc.accounts, [{ account: "ENV", currency: "GEL" }],
   "a blank stored account list does not wipe the environment's");

/* the app wins over the environment when both are set */
c = withStored(baseCfg({ bog: { enabled: true, baseUrl: "https://env", clientId: "env-id", clientSecret: "env-sec" } }),
               { bog: { baseUrl: "https://app", clientId: "app-id", clientSecret: "app-sec", accounts: "" } });
eq(c.banks.bog.baseUrl, "https://app", "the app's base url wins over the environment's");
eq(c.banks.bog.clientSecret, "app-sec", "and so does its secret");

/* half a pair is not a configuration: it must not override a working one */
c = withStored(baseCfg({ bog: { enabled: true, baseUrl: "https://env", clientId: "env-id", clientSecret: "env-sec" } }),
               { bog: { baseUrl: "https://app", clientId: "app-id", clientSecret: "" } });
eq(c.banks.bog.baseUrl, "https://env", "a stored entry with no secret is ignored, the environment keeps working");
eq(c.banks.bog.clientSecret, "env-sec", "and its secret is untouched");

c = withStored(baseCfg(), { bog: { baseUrl: "", clientId: "i", clientSecret: "s" } });
chk(!c.banks.bog.enabled, "a stored pair with no url does not enable the bank");
c = withStored(baseCfg(), { bog: { baseUrl: "u", clientId: "", clientSecret: "s" } });
chk(!c.banks.bog.enabled, "a secret with no client id does not enable the bank either");

/* a database that cannot answer must leave the environment alone */
c = withStored(baseCfg({ bog: { enabled: true, baseUrl: "https://env", clientId: "i", clientSecret: "s" } }), null);
chk(c.banks.bog.enabled && c.banks.bog.baseUrl === "https://env",
    "no stored credentials at all leaves the environment's configuration intact");

/* ---- the key must not be able to reach the browser by any route ---- */
const fs = require("fs");
const sql = fs.readFileSync(path.join(__dirname, "../../sql/bank_credentials.sql"), "utf8");
chk(/revoke all on public\.bank_credentials from anon, authenticated/.test(sql),
    "the credentials table grants the browser nothing by default");
chk(/grant select \(user_id, bank, base_url, accounts, client_id, token_url, scope,\s*\n\s*auth_mode, updated_at, has_secret\)/.test(sql),
    "the browser is granted named columns only");
chk(!/grant select[^;]*secret_id/.test(sql), "and secret_id is not among them");
chk(/revoke all on function public\.fin_bank_credentials\(uuid\) from public, anon, authenticated/.test(sql),
    "the read-back function is revoked from the browser");
chk(/grant execute on function public\.fin_bank_credentials\(uuid\) to service_role/.test(sql),
    "and granted only to the service role");

const appJs = fs.readFileSync(path.join(__dirname, "../../index.html"), "utf8");
chk(!/fin_bank_credentials/.test(appJs), "the page never calls the read-back function");
chk(/secEl\.value\s*=\s*""/.test(appJs), "the form clears the secret field after saving");
chk(/type="password"/.test(appJs), "the secret is typed into a password field");

console.log(A.join("\n"));
console.log(A.every(x => x.startsWith("PASS")) ? "\nALL PASS ✅" : "\nFAILURES ❌");
