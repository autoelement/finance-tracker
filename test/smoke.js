"use strict";
/* Run: node test/smoke.js
   Loads index.html in a real browser over HTTP, the way GitHub Pages serves
   it, with the CDN libraries and Supabase stubbed. It checks that the page
   boots, that the shared categorisation engine is actually reachable from it,
   and that the dashboard renders the figures the stub data implies.

   Needs Playwright and Chromium; skips cleanly if either is missing. */

const fs = require("fs");
const http = require("http");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const PORT = 8791;

let chromium;
try { ({ chromium } = require("playwright")); }
catch (e) { console.log("SKIP smoke test: playwright is not installed"); process.exit(0); }

const STUBS = `
<script>
window.Chart=function(){this.destroy=function(){};};
window.Chart.defaults={color:"",font:{}};
window.XLSX={read:function(){return {SheetNames:["S"],Sheets:{S:{}}};},utils:{sheet_to_json:function(){return [];}}};
(function(){
  var TX=[],cats=["იანდექსი","ხელფასი","სხვა"];
  for(var i=0;i<300;i++){
    var m=1+(i%3),d=1+(i%27);
    TX.push({id:"t"+String(i).padStart(5,"0"),user_id:"u1",import_id:"imp1",
      txdate:"2026-0"+m+"-"+(d<10?"0":"")+d,descr:"row "+i,category:cats[i%3],
      ttype:(i%3===0)?"income":"expense",amount:(i%40)+1.5,bank:"BOG",manual:false,match_text:"row "+i});
  }
  window.__TX=TX;
  var STATE={cats:null,imports:[]};
  var CREDS=[];   // what bank_credentials would return: never the key itself
  var VAULT={};   // what the browser must never be able to reach
  window.__vault=VAULT;
  function summary(){var m={};TX.forEach(function(r){var k=r.txdate.slice(0,7)+"|"+r.category+"|"+r.ttype;
    if(!m[k])m[k]={mkey:r.txdate.slice(0,7),category:r.category,ttype:r.ttype,total:0,cnt:0,dmin:r.txdate,dmax:r.txdate};
    m[k].total+=r.amount;m[k].cnt++;});return Object.keys(m).map(function(k){return m[k];});}
  var SUMMARY=summary();
  function Q(t){this.t=t;this.f=[];this._head=false;}
  Q.prototype.select=function(c,o){this._head=!!(o&&o.head);return this;};
  Q.prototype.eq=function(c,v){if(c!=="user_id")this.f.push([c,"eq",v]);return this;};
  Q.prototype.gt=function(c,v){this.f.push([c,"gt",v]);return this;};
  Q.prototype.gte=function(c,v){this.f.push([c,"gte",v]);return this;};
  Q.prototype.lte=function(c,v){this.f.push([c,"lte",v]);return this;};
  Q.prototype.lt=function(c,v){this.f.push([c,"lt",v]);return this;};
  Q.prototype.is=function(c){this.f.push([c,"is",null]);return this;};
  Q.prototype["in"]=function(c,v){this.f.push([c,"in",v.slice()]);return this;};
  Q.prototype.not=function(){return this;};
  Q.prototype.ilike=function(c,v){this.f.push([c,"ilike",v.replace(/%/g,"")]);return this;};
  Q.prototype.order=function(){return this;};
  Q.prototype.limit=function(n){this._b=n-1;this._a=0;return this;};
  Q.prototype.range=function(a,b){this._a=a;this._b=b;return this;};
  Q.prototype.upsert=function(r){this._up=r;return this;};
  Q.prototype.update=function(v){this._upd=v;return this;};
  Q.prototype["delete"]=function(){this._del=true;return this;};
  Q.prototype.maybeSingle=function(){this._one=true;return this;};
  Q.prototype.single=function(){this._one=true;return this;};
  Q.prototype.rows=function(){
    var src=this.t==="transactions"?TX:this.t==="fin_summary"?SUMMARY:this.t==="bank_credentials"?CREDS:[STATE],f=this.f;
    return src.filter(function(r){return f.every(function(fl){
      var rv=r[fl[0]],op=fl[1],v=fl[2];
      if(op==="eq")return rv===v; if(op==="gt")return rv>v; if(op==="gte")return rv>=v;
      if(op==="lte")return rv<=v; if(op==="lt")return rv!=null&&rv<v;
      if(op==="is")return rv==null; if(op==="in")return v.indexOf(rv)>-1;
      if(op==="ilike")return (""+rv).indexOf(v)>-1; return true;});});
  };
  Q.prototype.then=function(cb){var s=this;setTimeout(function(){
    if(s.t==="finance_state"){
      if(s._up){var u=Array.isArray(s._up)?s._up[0]:s._up;STATE.cats=u.cats;STATE.imports=u.imports;return cb({data:null,error:null});}
      return cb({data:STATE.cats?{cats:STATE.cats,imports:STATE.imports}:null,error:null});
    }
    if(s._up||s._upd||s._del)return cb({data:null,error:null});
    var rs=s.rows(),total=rs.length;
    if(s._head)return cb({data:null,count:total,error:null});
    var a=s._a==null?0:s._a,b=s._b==null?999:s._b;
    var page=rs.slice(a,Math.min(b+1,a+1000));
    if(s._one)return cb({data:page[0]||null,count:total,error:null});
    cb({data:page,count:total,error:null});},1);return this;};
  function kpi(month){var i=0,e=0,ic=0,ec=0,dn=null,dx=null;
    TX.forEach(function(r){if(month&&r.txdate.slice(0,7)!==month)return;
      if(r.ttype==="income"){i+=r.amount;ic++;}else{e+=r.amount;ec++;}
      if(!dn||r.txdate<dn)dn=r.txdate; if(!dx||r.txdate>dx)dx=r.txdate;});
    return [{income:i,expense:e,inc_cnt:ic,exp_cnt:ec,cnt:ic+ec,dmin:dn,dmax:dx}];}
  window.supabase={createClient:function(){return{
    from:function(t){return new Q(t);},
    rpc:function(n,a){return {then:function(cb){setTimeout(function(){
      if(n==="fin_rebuild_summary"){SUMMARY=summary();return cb({data:SUMMARY.length,error:null});}
      if(n==="fin_kpi")return cb({data:kpi(a&&a.p_month),error:null});
      if(n==="fin_monthly"){var mk={};TX.forEach(function(r){mk[r.txdate.slice(0,7)]=1;});
        return cb({data:Object.keys(mk).sort().map(function(k){return {mkey:k};}),error:null});}
      if(n==="fin_set_bank_credential"){
        VAULT[a.p_bank]=a.p_client_secret||VAULT[a.p_bank]||"";
        var row=null;for(var i=0;i<CREDS.length;i++)if(CREDS[i].bank===a.p_bank)row=CREDS[i];
        if(!row){row={bank:a.p_bank};CREDS.push(row);}
        row.base_url=a.p_base_url;row.accounts=a.p_accounts;row.client_id=a.p_client_id;
        row.token_url=a.p_token_url;row.scope=a.p_scope;row.auth_mode=a.p_auth_mode;
        row.updated_at=new Date().toISOString();row.has_secret=!!VAULT[a.p_bank];
        return cb({data:null,error:null});}
      if(n==="fin_clear_bank_credential"){
        delete VAULT[a.p_bank];
        CREDS=CREDS.filter(function(r){return r.bank!==a.p_bank;});
        return cb({data:null,error:null});}
      if(n==="fin_by_category"){var m={};TX.forEach(function(r){
          if(a&&a.p_type&&r.ttype!==a.p_type)return;
          if(a&&a.p_month&&r.txdate.slice(0,7)!==a.p_month)return;
          if(!m[r.category])m[r.category]={category:r.category,total:0,cnt:0};
          m[r.category].total+=r.amount;m[r.category].cnt++;});
        return cb({data:Object.keys(m).map(function(k){return m[k];}),error:null});}
      cb({data:[],error:null});},1);return this;}};},
    auth:{
      getSession:function(){return Promise.resolve({data:{session:{user:{id:"u1",email:"t@example.com"}}}});},
      signInWithPassword:function(){return Promise.resolve({data:{user:{id:"u1"}},error:null});},
      signUp:function(){return Promise.resolve({data:{user:{id:"u1"}},error:null});},
      signOut:function(){return Promise.resolve({});}
    }};}};
})();
</script>`;

(async () => {
  const A = [];
  const chk = (c, m) => { A.push((c ? "PASS " : "FAIL ") + m); if (!c) process.exitCode = 1; };

  const page1 = fs.readFileSync(path.join(ROOT, "index.html"), "utf8")
    .replace(/<script src="https:[^"]*"><\/script>/g, "")
    .replace("<body>", "<body>" + STUBS);

  // serve the repo so shared/categorize.js resolves exactly as it will in production
  const srv = http.createServer((req, res) => {
    const url = (req.url || "/").split("?")[0];
    if (url === "/" || url === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(page1);
    }
    const file = path.join(ROOT, url.replace(/^\/+/, ""));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404); return res.end("not found");
    }
    res.writeHead(200, { "Content-Type": url.endsWith(".js") ? "application/javascript" : "text/plain" });
    res.end(fs.readFileSync(file));
  });
  await new Promise(r => srv.listen(PORT, "127.0.0.1", r));

  let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium" });
  } catch (e) {
    console.log("SKIP smoke test: chromium is not available (" + String(e.message).slice(0, 80) + ")");
    srv.close(); process.exit(0);
  }

  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("pageerror", e => errors.push("PAGEERROR: " + e.message));
  page.on("requestfailed", r => { if (!/^https:/.test(r.url())) errors.push("REQUEST FAILED: " + r.url()); });
  page.on("response", r => { if (r.status() >= 400) errors.push("HTTP " + r.status() + " " + r.url()); });
  await page.route(/^(?!http:\/\/127\.0\.0\.1:8791).*$/, r => r.abort());
  await page.goto("http://127.0.0.1:" + PORT + "/", { waitUntil: "load" });
  await page.waitForTimeout(2500);

  // the shared engine must have loaded and be the one the page uses
  const eng = await page.evaluate(() => ({
    loaded: typeof window.FinCat === "object" && !!window.FinCat,
    fallback: window.FinCat && window.FinCat.DEFAULT_CAT,
    defaults: window.FinCat ? window.FinCat.defaultCats().length : 0,
    pageDefault: typeof DEFAULT_CAT !== "undefined" ? DEFAULT_CAT : null,
    normWorks: typeof norm === "function" ? norm("  Yandex  GO ") : null,
  }));
  chk(eng.loaded, "shared/categorize.js loaded over HTTP");
  chk(eng.fallback === "სხვა", "fallback category reaches the page → " + eng.fallback);
  chk(eng.defaults === 19, "default categories reach the page → " + eng.defaults);
  chk(eng.pageDefault === "სხვა", "the page's DEFAULT_CAT comes from the module");
  chk(eng.normWorks === "yandex go", "the page's norm() is the shared one → " + eng.normWorks);

  // and categorisation through the page's own wrappers still works
  const cat = await page.evaluate(() => {
    CATS = FinCat.defaultCats();
    normalizeCats();
    compileRules();
    return {
      yandex: categorizeFast(norm("Yandex Go გადარიცხვა"), "expense"),
      salary: categorizeFast(norm("ხელფასი თანამშრომელს"), "expense"),
      unknown: categorizeFast(norm("სრულიად უცნობი"), "expense"),
    };
  });
  chk(cat.yandex === "იანდექსი", "page categorises a known expense → " + cat.yandex);
  chk(cat.salary === "თანამშრომელთა ხელფასები", "page categorises a salary → " + cat.salary);
  chk(cat.unknown === "სხვა", "page falls back for an unknown description → " + cat.unknown);

  // the dashboard still renders real figures
  const dash = await page.evaluate(() => ({
    income: (document.getElementById("k-income") || {}).textContent,
    expense: (document.getElementById("k-expense") || {}).textContent,
    period: (document.getElementById("period") || {}).value,
    catRows: document.querySelectorAll("#catsum-body tr").length,
    tblRows: document.querySelectorAll("#tbody tr").length,
  }));
  const truth = await page.evaluate(() => {
    const newest = [...new Set(window.__TX.map(r => r.txdate.slice(0, 7)))].sort().pop();
    let i = 0, e = 0;
    window.__TX.forEach(r => { if (r.txdate.slice(0, 7) !== newest) return; r.ttype === "income" ? i += r.amount : e += r.amount; });
    return { newest, i: +i.toFixed(2), e: +e.toFixed(2) };
  });
  const amt = s => parseFloat(String(s).replace(/[^\d.-]/g, "")) || 0;
  chk(dash.period === truth.newest, "opens on the newest month → " + dash.period);
  chk(Math.abs(amt(dash.income) - truth.i) < 0.05, "income matches the data → " + dash.income + " want " + truth.i);
  chk(Math.abs(amt(dash.expense) - truth.e) < 0.05, "expense matches the data → " + dash.expense + " want " + truth.e);
  chk(dash.catRows > 0, "the category summary rendered → " + dash.catRows + " rows");
  chk(dash.tblRows > 0, "the transactions table rendered → " + dash.tblRows + " rows");

  // every tab opens
  for (const t of ["monthly", "categories", "settings", "history", "dashboard"]) {
    const shown = await page.evaluate(n => { showTab(n); return !!document.querySelector("#page-" + n + ".active"); }, t);
    chk(shown, "tab opens: " + t);
    await page.waitForTimeout(150);
  }

  // the spreadsheet importer is out of the daily path but still reachable
  const imp = await page.evaluate(() => {
    const header = !!document.getElementById("btn-import");
    showTab("settings");
    const inSettings = [...document.querySelectorAll("#page-settings button")]
      .some(b => /ატვირთვა/.test(b.textContent));
    const dz = document.getElementById("dropzone");
    return { header, inSettings, dzClickable: !!(dz && dz.getAttribute("onclick")),
             fileInput: !!document.getElementById("file-input") };
  });
  chk(!imp.header, "the import button is gone from the header");
  chk(imp.inSettings, "and lives in Settings instead");
  chk(!imp.dzClickable, "the empty state is no longer an upload target");
  chk(imp.fileInput, "the file input is still there for Settings to use");
  await page.evaluate(() => showTab("dashboard"));
  await page.waitForTimeout(200);

  // ---- the bank credentials form ----
  await page.evaluate(() => { BANK_CREDS = null; showTab("settings"); });
  await page.waitForTimeout(600);
  let cred = await page.evaluate(() => ({
    cards: document.querySelectorAll("#bank-creds .cat-card").length,
    keyType: (document.getElementById("cred-sec-bog") || {}).type,
    state: (document.getElementById("bank-creds") || {}).textContent.slice(0, 200),
  }));
  chk(cred.cards === 2, "a card per bank is rendered → " + cred.cards);
  chk(cred.keyType === "password", "the secret field is a password field → " + cred.keyType);
  chk(/Secret არ არის/.test(cred.state), "it starts by saying no secret is stored");

  // saving a key
  await page.evaluate(() => {
    document.getElementById("cred-url-bog").value = "https://api.bog.ge";
    document.getElementById("cred-acc-bog").value = "GE00BG0000000000000000:GEL";
    document.getElementById("cred-cid-bog").value = "my-client-id";
    document.getElementById("cred-turl-bog").value = "https://api.bog.ge/oauth2/token";
    document.getElementById("cred-sec-bog").value = "super-secret-key-123";
    saveBankCred("bog");
  });
  await page.waitForTimeout(800);
  cred = await page.evaluate(() => ({
    state: document.getElementById("bank-creds").textContent,
    field: document.getElementById("cred-sec-bog").value,
    stored: Object.keys(window.__vault),
    vaultValue: window.__vault.bog,
    html: document.getElementById("bank-creds").innerHTML,
    inMemory: JSON.stringify(window.BANK_CREDS || []),
  }));
  chk(/Secret დაყენებულია/.test(cred.state), "after saving it says a secret is stored");
  chk(cred.field === "", "and the field is cleared, not left holding the secret");
  chk(cred.vaultValue === "super-secret-key-123", "the secret did reach the database");
  chk(cred.html.indexOf("super-secret-key-123") === -1, "but it is nowhere in the rendered page");
  chk(cred.inMemory.indexOf("super-secret-key-123") === -1, "and nowhere in what the page holds in memory");

  // the url can be corrected without retyping the key
  await page.evaluate(() => {
    document.getElementById("cred-url-bog").value = "https://api.bog.ge/v2";
    document.getElementById("cred-sec-bog").value = "";
    saveBankCred("bog");
  });
  await page.waitForTimeout(800);
  cred = await page.evaluate(() => ({ vault: window.__vault.bog, state: document.getElementById("bank-creds").textContent }));
  chk(cred.vault === "super-secret-key-123", "an empty secret field leaves the stored secret alone");
  chk(/Secret დაყენებულია/.test(cred.state), "and it is still reported as set");

  // a missing url is refused rather than stored half-formed
  const before = await page.evaluate(() => JSON.stringify(window.__vault));
  await page.evaluate(() => {
    document.getElementById("cred-url-tbc").value = "";
    document.getElementById("cred-cid-tbc").value = "c";
    document.getElementById("cred-sec-tbc").value = "x";
    saveBankCred("tbc");
  });
  await page.waitForTimeout(400);
  const after = await page.evaluate(() => JSON.stringify(window.__vault));
  chk(before === after, "saving without a base url stores nothing");

  // OAuth needs a token endpoint, and the form must say so before saving
  const before2 = await page.evaluate(() => JSON.stringify(window.__vault));
  await page.evaluate(() => {
    document.getElementById("cred-url-tbc").value = "https://tbc.example";
    document.getElementById("cred-cid-tbc").value = "c";
    document.getElementById("cred-sec-tbc").value = "x";
    document.getElementById("cred-turl-tbc").value = "";
    document.getElementById("cred-mode-tbc").value = "oauth_basic";
    saveBankCred("tbc");
  });
  await page.waitForTimeout(400);
  chk(before2 === await page.evaluate(() => JSON.stringify(window.__vault)),
      "OAuth with no token endpoint is refused before anything is stored");

  // header mode needs none, so the same entry saves
  await page.evaluate(() => {
    document.getElementById("cred-mode-tbc").value = "header";
    saveBankCred("tbc");
  });
  await page.waitForTimeout(700);
  const hdr = await page.evaluate(() => ({ vault: window.__vault.tbc,
    mode: (window.BANK_CREDS.filter(c => c.bank === "tbc")[0] || {}).auth_mode }));
  chk(hdr.vault === "x", "header mode saves without a token endpoint");
  chk(hdr.mode === "header", "and the chosen mode is stored → " + hdr.mode);

  await page.evaluate(() => showTab("dashboard"));
  await page.waitForTimeout(200);

  chk(errors.length === 0, "no page errors or failed requests" + (errors.length ? " → " + errors.slice(0, 4).join(" | ") : ""));

  console.log(A.join("\n"));
  console.log(A.every(x => x.startsWith("PASS")) ? "\nALL PASS ✅" : "\nFAILURES ❌");
  await browser.close();
  srv.close();
})();
