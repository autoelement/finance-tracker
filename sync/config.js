"use strict";
/* Everything the service needs to run, read from the environment. Nothing is
   read from a file in the repository and nothing is ever logged: these are the
   credentials that, if they leak, give someone your bank statements.

   Set them wherever the service runs — systemd EnvironmentFile, Docker
   --env-file, or a .env this repository ignores. See sync/README.md. */

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error("missing environment variable: " + name);
  return v;
}

function optional(name, fallback) {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

function intOpt(name, fallback) {
  const n = parseInt(optional(name, ""), 10);
  return Number.isFinite(n) ? n : fallback;
}

function load() {
  return {
    supabase: {
      url: required("SUPABASE_URL").replace(/\/+$/, ""),
      /* The service role key bypasses row-level security, which is why this
         service must never run anywhere a browser can reach it. Every query
         below therefore filters by user_id itself. */
      serviceKey: required("SUPABASE_SERVICE_KEY"),
      userId: required("FINANCE_USER_ID"),
    },

    /* A transaction can appear in a statement days after its value date, and a
       TBC movement only shows up once it is authorised. So each run re-reads a
       window before the bookmark; the dedup key makes that free. */
    overlapDays: intOpt("SYNC_OVERLAP_DAYS", 7),

    /* How far back the very first run reaches when there is no bookmark yet. */
    backfillDays: intOpt("SYNC_BACKFILL_DAYS", 90),

    banks: {
      bog: bank("BOG", {
        baseUrl: optional("BOG_BASE_URL", ""),
        clientId: optional("BOG_CLIENT_ID", ""),
        clientSecret: optional("BOG_CLIENT_SECRET", ""),
        tokenUrl: optional("BOG_TOKEN_URL", ""),
        scope: optional("BOG_SCOPE", ""),
        authMode: optional("BOG_AUTH_MODE", "oauth_basic"),
        accounts: list(optional("BOG_ACCOUNTS", "")),   // IBAN:CURRENCY, comma separated
      }),
      tbc: bank("TBC", {
        baseUrl: optional("TBC_BASE_URL", ""),
        clientId: optional("TBC_CLIENT_ID", ""),
        clientSecret: optional("TBC_CLIENT_SECRET", ""),
        tokenUrl: optional("TBC_TOKEN_URL", ""),
        scope: optional("TBC_SCOPE", ""),
        authMode: optional("TBC_AUTH_MODE", "oauth_basic"),
        accounts: list(optional("TBC_ACCOUNTS", "")),   // optional; blank means every account
      }),
    },
  };
}

/* A bank is enabled only once it has everything it needs to call: somewhere to
   go and a credential pair. Until then the run skips it rather than failing,
   so one bank can go live while the other is still being arranged. */
function bank(label, cfg) {
  const complete = !!(cfg.baseUrl && cfg.clientId && cfg.clientSecret);
  return Object.assign({ label: label, enabled: complete }, cfg);
}

/* Credentials entered in the app win over the environment. The environment
   stays supported for a deployment that would rather keep the keys off the
   database entirely — it is the stronger of the two, just less convenient. */
function withStored(cfg, stored) {
  for (const id of Object.keys(cfg.banks)) {
    const s = stored && stored[id];
    /* A partial entry is not a configuration. Ignoring it keeps a working
       environment setup working rather than half-overwriting it. */
    if (!s || !s.baseUrl || !s.clientId || !s.clientSecret) continue;
    const b = cfg.banks[id];
    cfg.banks[id] = Object.assign({}, b, {
      baseUrl: s.baseUrl,
      clientId: s.clientId,
      clientSecret: s.clientSecret,
      tokenUrl: s.tokenUrl || b.tokenUrl,
      scope: s.scope || b.scope,
      authMode: s.authMode || b.authMode || "oauth_basic",
      accounts: s.accounts ? list(s.accounts) : b.accounts,
      enabled: true,
      source: "app",
    });
  }
  return cfg;
}

function list(s) {
  return String(s).split(",").map(x => x.trim()).filter(Boolean).map(entry => {
    const [account, currency] = entry.split(":");
    return { account: (account || "").trim(), currency: (currency || "GEL").trim() };
  });
}

module.exports = { load, withStored, required, optional, intOpt };
