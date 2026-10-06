/* The one categorisation engine. Loaded as a plain script by index.html and
   required by the sync service, so a transaction fetched from a bank API and
   the same one read from a spreadsheet always land in the same category.
   Two copies of these rules would drift, and the drift would be invisible:
   the figures would simply be wrong. No build step — keep it ES5. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.FinCat = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var DEFAULT_CAT = "სხვა";

  function norm(s) {
    return ("" + s).toLowerCase().replace(/\s+/g, " ").trim();
  }

  /* Normalise the keywords once. categorise() runs per transaction — on this
     data that is hundreds of thousands of calls — so it must do no work that
     can be done here instead. */
  function compile(cats) {
    return (cats || []).map(function (c) {
      return {
        name: c.name,
        type: c.type,
        kws: (c.keywords || []).map(norm).filter(Boolean),
        ex: (c.exclude || []).map(norm).filter(Boolean),
      };
    });
  }

  /* First rule that matches wins, so the order of the categories is their
     priority. `low` must already be normalised. */
  function match(rules, low, type) {
    var R = rules || [];
    for (var i = 0; i < R.length; i++) {
      var c = R[i];
      if (c.type !== "any" && c.type !== type) continue;
      var hit = false, ks = c.kws, j;
      for (j = 0; j < ks.length; j++) { if (low.indexOf(ks[j]) > -1) { hit = true; break; } }
      if (!hit) continue;
      var bad = false, ex = c.ex;
      for (j = 0; j < ex.length; j++) { if (low.indexOf(ex[j]) > -1) { bad = true; break; } }
      if (bad) continue;          // an excluded word disqualifies this category
      return c.name;
    }
    return DEFAULT_CAT;
  }

  function categorize(rules, text, type) {
    return match(rules, norm(text), type);
  }

  /* Order is matching priority: the first match wins. Every category comes out
     fully formed — exclude and include present — so a caller without the
     page's normaliser (the sync service) can use the list as it stands. */
  function defaultCats() {
    return [
      { name: "მძღოლებზე გაცემული", type: "expense", keywords: ["გამომუშავებ"] },
      { name: "ბანკის საკომისიო", type: "expense", keywords: ["საკომისიო", "commission", "მომსახურების საფასურ"] },
      { name: "იანდექსი", type: "expense", keywords: ["yandex", "იანდექს"] },
      { name: "კომუნალური მომსახურება", type: "expense", keywords: ["დენ", "ელექტრო", "წყალ", "გაზი", "ინტერნეტ", "კომუნალ", "magti", "silknet"] },
      { name: "პროგრამული უზრუნველყოფა", type: "expense", keywords: ["software", "subscription", "google", "microsoft", "პროგრამ"] },
      { name: "მარკეტინგი", type: "expense", keywords: ["რეკლამ", "marketing", "facebook", "meta", "google ads", "მარკეტ"] },
      { name: "საბიუჯეტო გადასახადი", type: "expense", keywords: ["ბიუჯეტ", "საშემოსავლო", "დღგ", "ხაზინა", "საგადასახადო"] },
      { name: "ონლაინ გადასახადები", type: "expense", keywords: [] },
      { name: "აღჭურვილობა", type: "expense", keywords: [] },
      { name: "ინვენტარი", type: "expense", keywords: [] },
      { name: "თანამშრომელთა ხელფასები", type: "expense", keywords: ["ხელფას", "ანაზღაურება თანამშრ"] },
      { name: "საოპერაციო ხარჯები", type: "expense", keywords: [] },
      { name: "მოგების განაწილება", type: "expense", keywords: ["მოგების განაწ", "დივიდენდ"] },
      { name: "კომპენსაცია პარკებს (ბონუსები)", type: "expense", keywords: ["კომპენსაცია", "ბონუს"] },
      { name: "საკომისიო პარკებიდან", type: "income", keywords: [] },
      { name: "ახალი მძღოლების საკომისიო პარკებიდან", type: "income", keywords: [] },
      { name: "პრო პაკეტის შემოსავალი", type: "income", keywords: ["პრო პაკეტ"] },
      { name: "ბალანსის შევსება", type: "any", keywords: ["ბალანსის შევსება", "შევსება"] },
      { name: "სხვა", type: "any", keywords: [] }
    ].map(function (c) {
      return { name: c.name, type: c.type, keywords: c.keywords.slice(), exclude: [], include: true };
    });
  }

  return {
    DEFAULT_CAT: DEFAULT_CAT,
    norm: norm,
    compile: compile,
    match: match,
    categorize: categorize,
    defaultCats: defaultCats,
  };
});
