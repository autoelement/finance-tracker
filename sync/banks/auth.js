"use strict";
/* OAuth2 client credentials.

   Both banks issue a Client ID and a Client Secret. The exchange is the same
   either way — post them to the token endpoint, get a bearer token back, send
   that on every request — but banks differ on where the credentials go in the
   token request, so both conventions are supported:

     oauth_basic  the pair goes in an Authorization: Basic header (commonest)
     oauth_body   the pair goes in the form body as client_id/client_secret
     header       no token exchange at all: some gateways take the pair
                  directly on each call

   A token is reused until shortly before it expires. A run takes seconds and
   a token usually lasts minutes, so in practice this fetches one per bank. */

const EXPIRY_MARGIN_MS = 60 * 1000;   // refresh a minute early rather than racing the clock

function basicHeader(id, secret) {
  return "Basic " + Buffer.from(String(id) + ":" + String(secret), "utf8").toString("base64");
}

/* Returns authorize(): a function giving the headers for one bank request. */
function createAuthorizer(bankCfg, fetchImpl) {
  const doFetch = fetchImpl || globalThis.fetch;
  const mode = bankCfg.authMode || "oauth_basic";
  const label = bankCfg.label || "bank";

  if (!bankCfg.clientId || !bankCfg.clientSecret) {
    throw new Error(label + ": client id and client secret are not set");
  }

  if (mode === "header") {
    /* No exchange: the pair is the credential. Named headers rather than a
       guess, so a bank that wants something else is an obvious one-line fix. */
    return async function authorize() {
      return {
        "Client-Id": bankCfg.clientId,
        "Client-Secret": bankCfg.clientSecret,
        Accept: "application/json",
      };
    };
  }

  if (!bankCfg.tokenUrl) throw new Error(label + ": a token endpoint is required for " + mode);

  let token = null;
  let expiresAt = 0;
  let inFlight = null;

  async function fetchToken() {
    const body = new URLSearchParams({ grant_type: "client_credentials" });
    if (bankCfg.scope) body.set("scope", bankCfg.scope);

    const headers = {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    };
    if (mode === "oauth_basic") {
      headers.Authorization = basicHeader(bankCfg.clientId, bankCfg.clientSecret);
    } else {
      body.set("client_id", bankCfg.clientId);
      body.set("client_secret", bankCfg.clientSecret);
    }

    const res = await doFetch(bankCfg.tokenUrl, { method: "POST", headers, body: body.toString() });
    const text = await res.text();
    if (!res.ok) {
      /* The response to a rejected token request can echo what was sent, so
         only the status and the bank are reported. A 400 or 401 here almost
         always means the other convention: try the other oauth mode. */
      throw new Error(label + ": token request refused (" + res.status + ")" +
        (res.status === 400 || res.status === 401
          ? " — if the credentials are right, try the other OAuth mode" : ""));
    }

    let data;
    try { data = JSON.parse(text); }
    catch (e) { throw new Error(label + ": token endpoint did not return JSON"); }

    const access = data.access_token || data.accessToken || data.token;
    if (!access) throw new Error(label + ": no access token in the response");

    const ttl = Number(data.expires_in || data.expiresIn);
    expiresAt = Date.now() + (Number.isFinite(ttl) && ttl > 0 ? ttl * 1000 : 5 * 60 * 1000);
    token = access;
    return token;
  }

  return async function authorize() {
    if (token && Date.now() < expiresAt - EXPIRY_MARGIN_MS) {
      return { Authorization: "Bearer " + token, Accept: "application/json" };
    }
    /* Several accounts of one bank are fetched in turn, but never let two
       expiries race into two token requests. */
    if (!inFlight) inFlight = fetchToken().finally(() => { inFlight = null; });
    const t = await inFlight;
    return { Authorization: "Bearer " + t, Accept: "application/json" };
  };
}

module.exports = { createAuthorizer, basicHeader, EXPIRY_MARGIN_MS };
