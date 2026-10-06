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
      bog: Object.assign({ label: "BOG", enabled: false, baseUrl: "", apiKey: "", accounts: [] }, (over || {}).bog),
      tbc: Object.assign({ label: "TBC", enabled: false, baseUrl: "", apiKey: "", accounts: [] }, (over || {}).tbc),
    },
  };
}

/* nothing stored, nothing in the environment */
let c = withStored(baseCfg(), {});
chk(!c.banks.bog.enabled && !c.banks.tbc.enabled, "with nothing configured, no bank is enabled");

/* the app's credentials enable a bank that the environment knows nothing about */
c = withStored(baseCfg(), {
  bog: { baseUrl: "https://bog.example", apiKey: "k1", accounts: "GE1:GEL,GE2:USD" },
});
chk(c.banks.bog.enabled, "credentials entered in the app enable the bank");
eq(c.banks.bog.baseUrl, "https://bog.example", "the stored base url is used");
eq(c.banks.bog.apiKey, "k1", "the stored key is used");
eq(c.banks.bog.accounts, [{ account: "GE1", currency: "GEL" }, { account: "GE2", currency: "USD" }],
   "the stored account list is parsed");
eq(c.banks.bog.source, "app", "and the source is recorded, so --check can say where it came from");
chk(!c.banks.tbc.enabled, "a bank with nothing stored stays disabled");

/* an account without a currency still parses, defaulting to lari */
c = withStored(baseCfg(), { tbc: { baseUrl: "u", apiKey: "k", accounts: "GE9" } });
eq(c.banks.tbc.accounts, [{ account: "GE9", currency: "GEL" }], "an account with no currency defaults to GEL");

/* blank accounts leave whatever the environment had, rather than wiping it */
c = withStored(baseCfg({ tbc: { accounts: [{ account: "ENV", currency: "GEL" }] } }),
               { tbc: { baseUrl: "u", apiKey: "k", accounts: "" } });
eq(c.banks.tbc.accounts, [{ account: "ENV", currency: "GEL" }],
   "a blank stored account list does not wipe the environment's");

/* the app wins over the environment when both are set */
c = withStored(baseCfg({ bog: { enabled: true, baseUrl: "https://env", apiKey: "env-key" } }),
               { bog: { baseUrl: "https://app", apiKey: "app-key", accounts: "" } });
eq(c.banks.bog.baseUrl, "https://app", "the app's base url wins over the environment's");
eq(c.banks.bog.apiKey, "app-key", "and so does its key");

/* half a pair is not a configuration: it must not override a working one */
c = withStored(baseCfg({ bog: { enabled: true, baseUrl: "https://env", apiKey: "env-key" } }),
               { bog: { baseUrl: "https://app", apiKey: "" } });
eq(c.banks.bog.baseUrl, "https://env", "a stored url with no key is ignored, the environment keeps working");
eq(c.banks.bog.apiKey, "env-key", "and its key is untouched");

c = withStored(baseCfg(), { bog: { baseUrl: "", apiKey: "k" } });
chk(!c.banks.bog.enabled, "a stored key with no url does not enable the bank");

/* a database that cannot answer must leave the environment alone */
c = withStored(baseCfg({ bog: { enabled: true, baseUrl: "https://env", apiKey: "env-key" } }), null);
chk(c.banks.bog.enabled && c.banks.bog.baseUrl === "https://env",
    "no stored credentials at all leaves the environment's configuration intact");

/* ---- the key must not be able to reach the browser by any route ---- */
const fs = require("fs");
const sql = fs.readFileSync(path.join(__dirname, "../../sql/bank_credentials.sql"), "utf8");
chk(/revoke all on public\.bank_credentials from anon, authenticated/.test(sql),
    "the credentials table grants the browser nothing by default");
chk(/grant select \(user_id, bank, base_url, accounts, updated_at, has_secret\)/.test(sql),
    "the browser is granted named columns only");
chk(!/grant select[^;]*secret_id/.test(sql), "and secret_id is not among them");
chk(/revoke all on function public\.fin_bank_credentials\(uuid\) from public, anon, authenticated/.test(sql),
    "the read-back function is revoked from the browser");
chk(/grant execute on function public\.fin_bank_credentials\(uuid\) to service_role/.test(sql),
    "and granted only to the service role");

const appJs = fs.readFileSync(path.join(__dirname, "../../index.html"), "utf8");
chk(!/fin_bank_credentials/.test(appJs), "the page never calls the read-back function");
chk(/keyEl\.value\s*=\s*""/.test(appJs), "the form clears the key field after saving");

console.log(A.join("\n"));
console.log(A.every(x => x.startsWith("PASS")) ? "\nALL PASS ✅" : "\nFAILURES ❌");
