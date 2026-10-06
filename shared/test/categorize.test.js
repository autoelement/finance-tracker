"use strict";
/* Run: node shared/test/categorize.test.js
   The reference below is the engine as it was written inline in index.html
   before it moved here. The shared module must agree with it on every input —
   that is the whole point of the move, since the sync service and the browser
   now both depend on this one answer. */

const FinCat = require("../categorize");

const A = [];
const chk = (c, m) => { A.push((c ? "PASS " : "FAIL ") + m); if (!c) process.exitCode = 1; };
const eq = (got, want, m) => chk(got === want, m + " → " + JSON.stringify(got));

/* ---- the original implementation, copied verbatim as a reference ---- */
const REF_DEFAULT = "სხვა";
function refNorm(s) { return ("" + s).toLowerCase().replace(/\s+/g, " ").trim(); }
function refCompile(CATS) {
  return CATS.map(function (c) {
    return {
      name: c.name, type: c.type,
      kws: c.keywords.map(function (k) { return refNorm(k); }).filter(Boolean),
      ex: (c.exclude || []).map(function (k) { return refNorm(k); }).filter(Boolean)
    };
  });
}
function refMatch(R, low, type) {
  for (var i = 0; i < R.length; i++) {
    var c = R[i]; if (c.type !== "any" && c.type !== type) continue;
    var hit = false, ks = c.kws, j;
    for (j = 0; j < ks.length; j++) { if (low.indexOf(ks[j]) > -1) { hit = true; break; } }
    if (!hit) continue;
    var bad = false, ex = c.ex;
    for (j = 0; j < ex.length; j++) { if (low.indexOf(ex[j]) > -1) { bad = true; break; } }
    if (bad) continue;
    return c.name;
  }
  return REF_DEFAULT;
}

/* ---- behaviour ---- */

const cats = [
  { name: "მძღოლებზე გაცემული", type: "expense", keywords: ["გამომუშავებ"] },
  { name: "იანდექსი", type: "expense", keywords: ["yandex", "იანდექს"], exclude: ["დაბრუნება"] },
  { name: "ხელფასი", type: "expense", keywords: ["ხელფას"] },
  { name: "შემოსავალი", type: "income", keywords: ["ჩარიცხვა"] },
  { name: "ორივე", type: "any", keywords: ["კონვერტაცია"] },
  { name: "სხვა", type: "any", keywords: [] },
];
const rules = FinCat.compile(cats);

eq(FinCat.categorize(rules, "Yandex Go გადარიცხვა", "expense"), "იანდექსი", "keyword matches, case-insensitively");
eq(FinCat.categorize(rules, "  ᲨᲔᲛᲝᲡᲐ�•  ", "expense"), "სხვა", "no keyword falls through to the default");
eq(FinCat.categorize(rules, "ჩარიცხვა ანგარიშზე", "income"), "შემოსავალი", "an income rule matches income");
eq(FinCat.categorize(rules, "ჩარიცხვა ანგარიშზე", "expense"), "სხვა", "an income rule never matches an expense");
eq(FinCat.categorize(rules, "კონვერტაცია", "income"), "ორივე", "an 'any' rule matches income");
eq(FinCat.categorize(rules, "კონვერტაცია", "expense"), "ორივე", "an 'any' rule matches expense");

// exclusions: the near-identical descriptions that split on one word
eq(FinCat.categorize(rules, "yandex გადარიცხვა", "expense"), "იანდექსი", "included when the excluded word is absent");
eq(FinCat.categorize(rules, "yandex დაბრუნება", "expense"), "სხვა", "an excluded word disqualifies the category");

// order is priority
const ordered = FinCat.compile([
  { name: "პირველი", type: "any", keywords: ["ა"] },
  { name: "მეორე", type: "any", keywords: ["ა"] },
]);
eq(FinCat.match(ordered, "ა", "expense"), "პირველი", "the first matching rule wins");

// normalisation
eq(FinCat.norm("  Yandex   GO \n"), "yandex go", "norm lowercases and collapses whitespace");
eq(FinCat.categorize(rules, "YANDEX", "expense"), "იანდექსი", "an uppercase description still matches");
eq(FinCat.match(FinCat.compile([{ name: "ც", type: "any", keywords: ["  Y A "] }]), "x y a z", "expense"), "ც",
   "a keyword's own whitespace is normalised too");

// empty and missing inputs must not throw
eq(FinCat.categorize(rules, "", "expense"), "სხვა", "empty text falls through");
eq(FinCat.categorize(rules, null, "expense"), "სხვა", "null text falls through");
eq(FinCat.match([], "anything", "expense"), "სხვა", "no rules at all falls through");
eq(FinCat.match(null, "anything", "expense"), "სხვა", "missing rules fall through");
eq(FinCat.compile(null).length, 0, "compiling nothing yields no rules");
eq(FinCat.compile([{ name: "ა", type: "any" }])[0].kws.length, 0, "a category with no keywords compiles");

/* ---- the shared module must answer exactly as the inline engine did ---- */

const defaults = FinCat.defaultCats();
const mine = FinCat.compile(defaults);
const theirs = refCompile(defaults);

const samples = [
  "გამომუშავებული თანხა მძღოლს", "საკომისიო ბანკის მომსახურებისთვის", "Yandex Go",
  "იანდექსი ივნისი", "დენის გადასახადი", "SILKNET ინტერნეტი", "Google Workspace subscription",
  "Facebook Ads რეკლამა", "საშემოსავლო გადასახადი ბიუჯეტში", "ხელფასი თანამშრომელს",
  "დივიდენდი — მოგების განაწილება", "ბონუსი პარკს კომპენსაცია", "პრო პაკეტის შემოსავალი",
  "ბალანსის შევსება", "ავტომატური კონვერტაცია, კურსი: 2.724", "",
  "   ", "MAGTI mobile", "commission fee", "უცნობი რამე სრულიად",
  "მომსახურების საფასური", "ხაზინა", "დღგ", "მარკეტინგის ხარჯი",
];
let agree = 0;
samples.forEach(function (text) {
  ["income", "expense"].forEach(function (t) {
    const low = FinCat.norm(text);
    const a = FinCat.match(mine, low, t);
    const b = refMatch(theirs, refNorm(text), t);
    if (a === b) agree++;
    else chk(false, "differs from the original on " + JSON.stringify(text) + "/" + t + ": " + a + " vs " + b);
  });
});
chk(agree === samples.length * 2, "identical to the original engine on all " + agree + " cases");

/* ---- the default list ---- */
eq(defaults.length, 19, "the default category list is unchanged in length");
eq(defaults[0].name, "მძღოლებზე გაცემული", "the highest-priority category is unchanged");
eq(defaults[defaults.length - 1].name, "სხვა", "the fallback category is last");
chk(defaults.every(c => c.name && (c.type === "any" || c.type === "income" || c.type === "expense")),
    "every default category has a name and a valid type");
chk(defaults.every(c => Array.isArray(c.keywords) && Array.isArray(c.exclude) && c.include === true),
    "every default category is fully formed, usable without the page's normaliser");
chk(new Set(defaults.map(c => c.name)).size === defaults.length, "no duplicate default category names");
eq(FinCat.DEFAULT_CAT, "სხვა", "the fallback name");
chk(defaults.some(c => c.name === FinCat.DEFAULT_CAT), "the fallback category exists in the list");

// callers mutate the list they are given, so it must be a fresh copy each time
const one = FinCat.defaultCats();
one[0].keywords.push("ტესტი");
chk(FinCat.defaultCats()[0].keywords.indexOf("ტესტი") === -1, "defaultCats hands back a fresh copy");

console.log(A.join("\n"));
console.log(A.every(x => x.startsWith("PASS")) ? "\nALL PASS ✅" : "\nFAILURES ❌");
