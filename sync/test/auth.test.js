"use strict";
/* Run: node sync/test/auth.test.js
   The token exchange, against a fake endpoint: both conventions, caching,
   expiry, concurrency, and what a rejected request is allowed to say. */

const { createAuthorizer, basicHeader } = require("../banks/auth");

const A = [];
const chk = (c, m) => { A.push((c ? "PASS " : "FAIL ") + m); if (!c) process.exitCode = 1; };
const eq = (got, want, m) => chk(JSON.stringify(got) === JSON.stringify(want), m + " → " + JSON.stringify(got));

function fakeTokenEndpoint(opts) {
  const o = opts || {};
  const calls = [];
  let n = 0;
  const f = async (url, init) => {
    n++;
    calls.push({ url, headers: init.headers, body: init.body, method: init.method });
    if (o.status && o.status >= 400) {
      return { ok: false, status: o.status, async text() { return o.body || "client_secret=hunter2 rejected"; } };
    }
    return {
      ok: true, status: 200,
      async text() {
        return JSON.stringify(Object.assign(
          { access_token: "tok-" + n, expires_in: o.expiresIn === undefined ? 300 : o.expiresIn },
          o.extra || {}));
      },
    };
  };
  f.calls = calls;
  return f;
}

const CRED = {
  label: "BOG", clientId: "my-client", clientSecret: "hunter2",
  tokenUrl: "https://bank.example/oauth2/token", authMode: "oauth_basic",
};

(async () => {
  /* ---- oauth_basic: the pair goes in the Authorization header ---- */
  let f = fakeTokenEndpoint();
  let authorize = createAuthorizer(CRED, f);
  let h = await authorize();
  eq(h.Authorization, "Bearer tok-1", "a bearer token comes back");
  eq(f.calls.length, 1, "one token request");
  eq(f.calls[0].method, "POST", "posted");
  eq(f.calls[0].url, CRED.tokenUrl, "to the configured token endpoint");
  eq(f.calls[0].headers.Authorization, basicHeader("my-client", "hunter2"),
     "the pair is sent as Basic");
  chk(/grant_type=client_credentials/.test(f.calls[0].body), "with the client_credentials grant");
  chk(!/client_secret/.test(f.calls[0].body), "and the secret is not also in the body");

  /* ---- the token is reused ---- */
  await authorize(); await authorize();
  eq(f.calls.length, 1, "the token is reused rather than re-fetched");

  /* ---- several accounts asking at once must not race into two requests ---- */
  f = fakeTokenEndpoint();
  authorize = createAuthorizer(CRED, f);
  const many = await Promise.all([authorize(), authorize(), authorize(), authorize()]);
  eq(f.calls.length, 1, "four simultaneous callers still cause one token request");
  chk(many.every(x => x.Authorization === "Bearer tok-1"), "and all get the same token");

  /* ---- an expired token is replaced ---- */
  f = fakeTokenEndpoint({ expiresIn: 1 });   // expires inside the refresh margin
  authorize = createAuthorizer(CRED, f);
  await authorize();
  await authorize();
  eq(f.calls.length, 2, "a token about to expire is fetched again rather than used");

  /* ---- oauth_body: the pair goes in the form body ---- */
  f = fakeTokenEndpoint();
  authorize = createAuthorizer(Object.assign({}, CRED, { authMode: "oauth_body" }), f);
  h = await authorize();
  eq(h.Authorization, "Bearer tok-1", "body mode also yields a bearer token");
  chk(!f.calls[0].headers.Authorization, "no Basic header is sent");
  chk(/client_id=my-client/.test(f.calls[0].body), "the client id is in the body");
  chk(/client_secret=hunter2/.test(f.calls[0].body), "and so is the secret");

  /* ---- scope ---- */
  f = fakeTokenEndpoint();
  authorize = createAuthorizer(Object.assign({}, CRED, { scope: "statements:read" }), f);
  await authorize();
  chk(/scope=statements%3Aread/.test(f.calls[0].body), "a scope is passed when set");
  f = fakeTokenEndpoint();
  authorize = createAuthorizer(CRED, f);
  await authorize();
  chk(!/scope=/.test(f.calls[0].body), "and omitted when not");

  /* ---- header mode does no exchange at all ---- */
  f = fakeTokenEndpoint();
  authorize = createAuthorizer(Object.assign({}, CRED, { authMode: "header", tokenUrl: "" }), f);
  h = await authorize();
  eq(f.calls.length, 0, "header mode contacts no token endpoint");
  eq(h["Client-Id"], "my-client", "it sends the client id");
  eq(h["Client-Secret"], "hunter2", "and the secret");

  /* ---- failures ---- */
  f = fakeTokenEndpoint({ status: 401 });
  authorize = createAuthorizer(CRED, f);
  let err = await authorize().then(() => null, e => e.message);
  chk(/401/.test(err), "a refused token request reports its status → " + err);
  chk(!/hunter2/.test(err), "and never quotes the response, which can echo the secret");
  chk(/other OAuth mode/.test(err), "a 401 suggests the other convention");

  f = fakeTokenEndpoint({ status: 500 });
  authorize = createAuthorizer(CRED, f);
  err = await authorize().then(() => null, e => e.message);
  chk(/500/.test(err) && !/other OAuth mode/.test(err), "a server error does not blame the convention");

  f = async () => ({ ok: true, status: 200, async text() { return "<html>nope</html>"; } });
  err = await createAuthorizer(CRED, f)().then(() => null, e => e.message);
  chk(/did not return JSON/.test(err), "a non-JSON reply is reported plainly → " + err);

  f = async () => ({ ok: true, status: 200, async text() { return JSON.stringify({ hello: 1 }); } });
  err = await createAuthorizer(CRED, f)().then(() => null, e => e.message);
  chk(/no access token/.test(err), "a reply with no token is reported → " + err);

  /* ---- misconfiguration is caught before anything is sent ---- */
  err = (() => { try { createAuthorizer({ label: "X", clientId: "a" }, f); } catch (e) { return e.message; } })();
  chk(/client id and client secret/.test(err), "a missing secret is refused up front → " + err);
  err = (() => { try { createAuthorizer({ label: "X", clientId: "a", clientSecret: "b" }, f); } catch (e) { return e.message; } })();
  chk(/token endpoint is required/.test(err), "OAuth with no token endpoint is refused up front → " + err);

  /* ---- a token field under another name is still found ---- */
  f = async () => ({ ok: true, status: 200, async text() { return JSON.stringify({ accessToken: "camel", expiresIn: 60 }); } });
  h = await createAuthorizer(CRED, f)();
  eq(h.Authorization, "Bearer camel", "accessToken/expiresIn spelling is accepted too");

  console.log(A.join("\n"));
  console.log(A.every(x => x.startsWith("PASS")) ? "\nALL PASS ✅" : "\nFAILURES ❌");
})().catch(e => { console.error(e); process.exitCode = 1; });
