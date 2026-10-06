"use strict";
/* Bank of Georgia — statement API
   GET api/v2/statement/{accountNumber}/{currency}/{startDate}/{endDate}
   Up to 1,000 records per request; further pages via the page parameter.
   Docs: https://api.bog.ge/docs/en/bonline/statement-new */

const { dayOf, num, text, matchTextOf, describe } = require("./common");

const NAME = "BOG";
const PAGE_SIZE = 1000;

/* One statement record -> one stored row, or null when there is nothing to
   store (a zero-value entry, which the spreadsheet importer also drops). */
function normalize(rec, importId) {
  if (!rec) return null;

  /* Prefer the GEL equivalents: a foreign-currency account otherwise adds
     dollars into a lari total. They are absent on older records, so fall back
     to the account's own amount. */
  const debit = pick(rec.entryAmountDebitBase, rec.entryAmountDebit);
  const credit = pick(rec.entryAmountCreditBase, rec.entryAmountCredit);

  let type, amount;
  if (Number.isFinite(credit) && Math.abs(credit) > 0) { type = "income"; amount = Math.abs(credit); }
  else if (Number.isFinite(debit) && Math.abs(debit) > 0) { type = "expense"; amount = Math.abs(debit); }
  else return null;

  const day = dayOf(rec.entryDate) || dayOf(rec.documentValueDate);
  const purpose = text(rec.documentNomination) || text(rec.entryComment) || text(rec.docComment);
  const typeLabel = text(rec.documentProductGroup);
  const partner = type === "income"
    ? text(rec.senderDetails && rec.senderDetails.name)
    : text(rec.beneficiaryDetails && rec.beneficiaryDetails.name);

  /* entryId is the bank's own unique entry number and is what the spreadsheet
     export puts in "ოპერაციის იდ", so a transaction imported from a file and
     the same one fetched here collapse onto one row. */
  const txid = text(rec.entryId) || text(rec.documentKey);

  return {
    dateStr: day || "—",
    desc: describe(purpose, partner),
    matchText: matchTextOf(purpose, typeLabel),
    type: type,
    amount: amount,
    bank: NAME,
    importId: importId,
    manual: false,
    _key: NAME + "|" + (txid || (day + "|" + amount.toFixed(2) + "|" + type + "|" + purpose)),
  };
}

function pick(preferred, fallback) {
  const p = num(preferred);
  return Number.isFinite(p) ? p : num(fallback);
}

/* The request for one page of a period. The caller owns transport and auth. */
function statementPath(account, currency, startDate, endDate, page) {
  const base = "api/v2/statement/" +
    encodeURIComponent(account) + "/" + encodeURIComponent(currency) + "/" +
    encodeURIComponent(startDate) + "/" + encodeURIComponent(endDate);
  return page ? base + "?page=" + page : base;
}

/* totalCount counts the whole period, count only this page. */
function pageCount(body) {
  const total = num(body && body.totalCount);
  if (!Number.isFinite(total) || total <= 0) return 0;
  return Math.ceil(total / PAGE_SIZE);
}

function recordsOf(body) {
  return (body && body.records) || [];
}

module.exports = { id: "bog", name: NAME, PAGE_SIZE, normalize, statementPath, pageCount, recordsOf };
