"use strict";
/* TBC — account movements
   GET /bab/v1/accounts/movements
   Up to 700 records per request; further pages via PageIndex (0-based).
   Docs: https://developers.tbcbank.ge/docs/bis-overview */

const { dayOf, num, text, matchTextOf, describe } = require("./common");

const NAME = "TBC";
const PAGE_SIZE = 700;

/* transactionType arrives as a code, while the spreadsheet export writes a
   label. The category keywords are matched against this text, so the wording
   here decides which rules fire — adjust it to match your own rules. */
const TYPE_LABELS = {
  1: "Transfer between own accounts",
  5: "Currency conversion",
  20: "Credit / income",
  30: "Outgoing transfer or cash withdrawal",
  31: "Utility payment, mobile top-up, fine",
  32: "Budget transfer",
  33: "Other expense, including commission",
};

/* statusCode: 0 authorised, 1 and 2 still waiting for an authorisation. Only
   an authorised movement has actually moved money, so the others are skipped
   and will be picked up on a later sync once they are approved. */
const AUTHORISED = 0;

function normalize(mv, importId) {
  if (!mv) return null;
  if (num(mv.statusCode) !== AUTHORISED) return null;

  const amount = num(mv.amount);
  if (!Number.isFinite(amount) || Math.abs(amount) === 0) return null;

  const type = mv.isDebit ? "expense" : "income";
  const day = dayOf(mv.date) || dayOf(mv.documentDate);
  const purpose = text(mv.purpose) || text(mv.additionalDescription) || text(mv.additionalInformation);
  const typeLabel = TYPE_LABELS[num(mv.transactionType)] || "";
  const partner = text(mv.partnerAccountInfo && mv.partnerAccountInfo.partnerName);

  /* movementId is the bank's unique transaction identifier and matches the
     spreadsheet's "ტრანზაქციის id", so a file import and a sync of the same
     transaction collapse onto one row. */
  const txid = text(mv.movementId);

  return {
    dateStr: day || "—",
    desc: describe(purpose, partner),
    matchText: matchTextOf(purpose, typeLabel),
    type: type,
    amount: Math.abs(amount),
    bank: NAME,
    importId: importId,
    manual: false,
    currency: text(mv.currency) || "GEL",
    _key: NAME + "|" + (txid || (day + "|" + Math.abs(amount).toFixed(2) + "|" + type + "|" + purpose)),
  };
}

/* LastMovementTimeStamp cannot be combined with any other business filter, so
   an incremental sync and a period sync are separate shapes of request. */
function movementsQuery(opts) {
  const q = {};
  if (opts.since) {
    q.LastMovementTimeStamp = opts.since;
  } else {
    if (opts.account) {
      q.AccountNumber = opts.account;
      q.AccountCurrencyCode = opts.currency;   // required whenever an account is given
    }
    q.PeriodFrom = opts.from;
    q.PeriodTo = opts.to;
  }
  q.PageIndex = opts.pageIndex || 0;
  q.PageSize = Math.min(opts.pageSize || PAGE_SIZE, PAGE_SIZE);
  return q;
}

function pageCount(body) {
  const total = num(body && body.total);
  if (!Number.isFinite(total) || total <= 0) return 0;
  return Math.ceil(total / PAGE_SIZE);
}

function recordsOf(body) {
  return (body && body.transactions) || [];
}

module.exports = {
  id: "tbc", name: NAME, PAGE_SIZE, TYPE_LABELS,
  normalize, movementsQuery, pageCount, recordsOf,
};
