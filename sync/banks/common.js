"use strict";
/* Shared helpers for turning a bank's API record into the row shape the app
   already stores. The browser importer builds exactly this shape from the
   spreadsheets (see bankRow() in index.html); both paths must agree, or the
   same transaction would land twice under two different dedup keys. */

/* Banks send the transaction's own local time: BOG with a +04:00 offset, TBC
   with none at all. Both mean the same Georgian business day, so take the
   calendar date the bank wrote rather than converting — a conversion to UTC
   moves anything after 20:00 into the previous day. */
function dayOf(v) {
  if (!v) return null;
  const s = String(v);
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  return m ? m[1] + "-" + m[2] + "-" + m[3] : null;
}

function num(v) {
  if (v === null || v === undefined || v === "") return NaN;
  const n = typeof v === "number" ? v : parseFloat(String(v).replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : NaN;
}

function text(v) {
  return v === null || v === undefined ? "" : String(v).trim();
}

/* The importer joins the purpose and the operation type with a single space and
   matches the category keywords against that. Keep the composition identical:
   adding more text here would silently recategorise transactions. */
function matchTextOf(purpose, typeLabel) {
  return (text(purpose) + " " + text(typeLabel)).trim();
}

function describe(purpose, partner) {
  const d = text(purpose) || "—";
  const p = text(partner);
  return p ? d + " — " + p : d;
}

module.exports = { dayOf, num, text, matchTextOf, describe };
