"use strict";
/* Run: node sync/test/normalize.test.js
   The payloads below are the examples from the two banks' own documentation. */

const bog = require("../banks/bog");
const tbc = require("../banks/tbc");

const A = [];
const chk = (c, m) => { A.push((c ? "PASS " : "FAIL ") + m); if (!c) process.exitCode = 1; };
const eq = (got, want, m) => chk(JSON.stringify(got) === JSON.stringify(want), m + " → " + JSON.stringify(got));

/* ---------------------------------------------------------------- BOG --- */

// the documented sample, with one side of the entry zeroed so it reads as a real record
const bogRec = {
  entryDate: "2021-06-18T16:26:53.4094325+04:00",
  entryDocumentNumber: "sample string 1",
  entryAccountNumber: "GE00BG0000000000000000",
  entryAmountDebit: 0, entryAmountDebitBase: 0,
  entryAmountCredit: 100.5, entryAmountCreditBase: 100.5,
  entryAmount: 100.5, entryAmountBase: 100.5,
  entryComment: "comment",
  documentProductGroup: "ჩარიცხვა",
  documentNomination: "გადმორიცხვა ანგარიშზე",
  senderDetails: { name: "შპს პარტნიორი", inn: "404123456" },
  beneficiaryDetails: { name: "შპს ჩვენი" },
  entryId: 987654321,
  documentKey: 123,
};

let r = bog.normalize(bogRec, "bog-2026-07");
chk(r !== null, "BOG: a credit entry produces a row");
eq(r.dateStr, "2021-06-18", "BOG: the +04:00 timestamp keeps its own calendar day");
eq(r.type, "income", "BOG: credit is income");
eq(r.amount, 100.5, "BOG: amount");
eq(r._key, "BOG|987654321", "BOG: dedup key is bank + entryId");
eq(r.desc, "გადმორიცხვა ანგარიშზე — შპს პარტნიორი", "BOG: income names the sender");
eq(r.matchText, "გადმორიცხვა ანგარიშზე ჩარიცხვა", "BOG: match text is purpose + product group");
eq(r.bank, "BOG", "BOG: bank");

// a debit entry takes the beneficiary instead
r = bog.normalize(Object.assign({}, bogRec, {
  entryAmountCredit: 0, entryAmountCreditBase: 0,
  entryAmountDebit: 42.25, entryAmountDebitBase: 42.25,
}), "i");
eq(r.type, "expense", "BOG: debit is expense");
eq(r.amount, 42.25, "BOG: debit amount");
eq(r.desc, "გადმორიცხვა ანგარიშზე — შპს ჩვენი", "BOG: expense names the beneficiary");

// a foreign-currency account must total in lari, not in its own currency
r = bog.normalize(Object.assign({}, bogRec, {
  entryAmountCredit: 100, entryAmountCreditBase: 271.4,
}), "i");
eq(r.amount, 271.4, "BOG: a USD credit is stored as its GEL equivalent");

// older records carry no base amounts at all
r = bog.normalize({
  entryDate: "2024-02-02T00:00:00+04:00", entryAmountCredit: 7.5,
  documentNomination: "x", entryId: 5,
}, "i");
eq(r.amount, 7.5, "BOG: falls back to the account amount when no GEL equivalent is given");

// an entry that moves nothing is not a transaction
chk(bog.normalize(Object.assign({}, bogRec, {
  entryAmountCredit: 0, entryAmountCreditBase: 0,
  entryAmountDebit: 0, entryAmountDebitBase: 0,
}), "i") === null, "BOG: a zero entry is dropped");
chk(bog.normalize(null, "i") === null, "BOG: a missing record is dropped");

// paging
eq(bog.pageCount({ totalCount: 0 }), 0, "BOG: no pages for an empty period");
eq(bog.pageCount({ totalCount: 1000 }), 1, "BOG: exactly one full page");
eq(bog.pageCount({ totalCount: 1001 }), 2, "BOG: one over a page needs a second");
eq(bog.pageCount({ totalCount: 2500 }), 3, "BOG: page count rounds up");
eq(bog.statementPath("GE29BG1", "GEL", "2026-07-01", "2026-07-31"),
   "api/v2/statement/GE29BG1/GEL/2026-07-01/2026-07-31", "BOG: first page path");
eq(bog.statementPath("GE29BG1", "GEL", "2026-07-01", "2026-07-31", 2),
   "api/v2/statement/GE29BG1/GEL/2026-07-01/2026-07-31?page=2", "BOG: later page path");

/* ---------------------------------------------------------------- TBC --- */

const tbcMv = {
  movementId: "018745219864.1",
  paymentId: null,
  externalPaymentId: "18745219864",
  amount: 1280.75,
  currency: "GEL",
  purpose: "Invoice payment",
  isDebit: true,
  customerAccountInfo: { accountName: "Test Company LLC", accountIban: "GE29TB1234567890123456" },
  documentDate: "2026-04-22T00:00:00",
  exchangeRate: null,
  additionalInformation: "Test Partner LLC TBCBGE22 GE61TB9876543210987654 Invoice #INV-2026-042",
  opCode: "GIB",
  partnerAccountInfo: { accountIban: "GE61TB9876543210987654", bankName: "JSC TBC Bank", partnerName: "Test Partner LLC", taxCode: "204567891" },
  statusCode: 0,
  date: "2026-04-22T00:00:00",
  transactionReference: "TRN-2026-874521",
  additionalDescription: "Invoice #INV-2026-042",
  documentNumber: "DOC-452198",
  transactionType: 30,
};

r = tbc.normalize(tbcMv, "tbc-2026-04");
chk(r !== null, "TBC: an authorised movement produces a row");
eq(r.dateStr, "2026-04-22", "TBC: date");
eq(r.type, "expense", "TBC: isDebit true is an expense");
eq(r.amount, 1280.75, "TBC: amount");
eq(r._key, "TBC|018745219864.1", "TBC: dedup key is bank + movementId");
eq(r.desc, "Invoice payment — Test Partner LLC", "TBC: description names the partner");
eq(r.matchText, "Invoice payment Outgoing transfer or cash withdrawal", "TBC: type code becomes its label");
eq(r.bank, "TBC", "TBC: bank");

r = tbc.normalize(Object.assign({}, tbcMv, { isDebit: false, transactionType: 20 }), "i");
eq(r.type, "income", "TBC: isDebit false is income");
eq(r.matchText, "Invoice payment Credit / income", "TBC: income type label");

// money that has not moved yet must not be counted
chk(tbc.normalize(Object.assign({}, tbcMv, { statusCode: 1 }), "i") === null,
    "TBC: a movement waiting for a second authorisation is skipped");
chk(tbc.normalize(Object.assign({}, tbcMv, { statusCode: 2 }), "i") === null,
    "TBC: a movement waiting for authorisation is skipped");
chk(tbc.normalize(Object.assign({}, tbcMv, { amount: 0 }), "i") === null, "TBC: a zero movement is dropped");
chk(tbc.normalize(null, "i") === null, "TBC: a missing movement is dropped");

// an unknown type code must not break the row, only leave the label empty
r = tbc.normalize(Object.assign({}, tbcMv, { transactionType: 99 }), "i");
eq(r.matchText, "Invoice payment", "TBC: an unknown type code leaves the purpose alone");

// currency is carried through so a non-GEL movement can be spotted
eq(tbc.normalize(Object.assign({}, tbcMv, { currency: "USD" }), "i").currency, "USD",
   "TBC: currency is kept on the row");

// paging and the filter-combination rules
eq(tbc.pageCount({ total: 1500 }), 3, "TBC: 1,500 records over 700 per page is 3 pages");
eq(tbc.pageCount({ total: 700 }), 1, "TBC: exactly one full page");
eq(tbc.pageCount({ total: 0 }), 0, "TBC: no pages when nothing matches");

eq(tbc.movementsQuery({ from: "2026-04-01T00:00:00", to: "2026-04-30T23:59:59" }),
   { PeriodFrom: "2026-04-01T00:00:00", PeriodTo: "2026-04-30T23:59:59", PageIndex: 0, PageSize: 700 },
   "TBC: a period query");
eq(tbc.movementsQuery({ account: "GE29TB1", currency: "GEL", from: "a", to: "b", pageIndex: 1 }),
   { AccountNumber: "GE29TB1", AccountCurrencyCode: "GEL", PeriodFrom: "a", PeriodTo: "b", PageIndex: 1, PageSize: 700 },
   "TBC: an account query always carries the currency");
eq(tbc.movementsQuery({ since: "2026-04-01T15:23:12", account: "GE29TB1", from: "a", to: "b" }),
   { LastMovementTimeStamp: "2026-04-01T15:23:12", PageIndex: 0, PageSize: 700 },
   "TBC: an incremental query drops every other business filter");
eq(tbc.movementsQuery({ from: "a", to: "b", pageSize: 5000 }).PageSize, 700,
   "TBC: page size is capped at the documented maximum");

/* ------------------------------------------------- shared guarantees --- */

// both banks must produce the shape the app already stores
const FIELDS = ["dateStr", "desc", "matchText", "type", "amount", "bank", "importId", "manual", "_key"];
[["BOG", bog.normalize(bogRec, "i")], ["TBC", tbc.normalize(tbcMv, "i")]].forEach(([n, row]) => {
  chk(FIELDS.every(f => f in row), n + ": row carries every field the importer produces");
  chk(row.amount > 0, n + ": amount is stored unsigned, the type carries the direction");
  chk(/^\d{4}-\d{2}-\d{2}$/.test(row.dateStr), n + ": date is a plain calendar day");
  chk(row._key.startsWith(n + "|"), n + ": dedup key is namespaced by bank");
});

// a late-evening transaction must not slide into the previous day
eq(bog.normalize(Object.assign({}, bogRec, { entryDate: "2026-07-31T23:45:00+04:00" }), "i").dateStr,
   "2026-07-31", "BOG: 23:45 stays on its own day, not shifted back by the offset");
eq(tbc.normalize(Object.assign({}, tbcMv, { date: "2026-07-31T23:45:00" }), "i").dateStr,
   "2026-07-31", "TBC: 23:45 stays on its own day");

console.log(A.join("\n"));
console.log(A.every(x => x.startsWith("PASS")) ? "\nALL PASS ✅" : "\nFAILURES ❌");
