/**
 * Trang giả mô phỏng Ads Manager (do chúng tôi tự dựng, KHÔNG phải DOM thật của Meta).
 * Dùng chung cho test executor và test log. Chỉ chứng minh cơ chế code chạy đúng.
 */
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

function makeSetup(ROOT, opts) {
  opts = opts || {};
  const coreSrc = fs.readFileSync(path.join(ROOT, "shared/super-share-core.js"), "utf8");
  const execSrc = fs.readFileSync(path.join(ROOT, "extension/content-scripts/executor.js"), "utf8");
  const loggerSrc = fs.readFileSync(path.join(ROOT, "shared/logger.js"), "utf8");

  // Trang giả: mô phỏng Ads Manager theo cách tôi đoán. Chỉ để kiểm tra cơ chế code.
  function pageHtml(variant) {
    return `<!doctype html><html><body>
  <header><button id="acct" aria-haspopup="listbox">1288013719961305 (Ten TK)</button></header>
  <main>
   <div class="card" id="rolesCard"><h2>${variant.heading || "Vai trò trên tài khoản quảng cáo"}</h2><div id="list"></div><button id="addbtn">${variant.addLabel || "Thêm người"}</button></div>
   <div class="card"><h2>Lựa chọn báo cáo với nhà phát hành</h2><p>abc</p></div>
  </main>
  <div id="toast" role="alert"></div>
  <script>
   window.accounts = [{id:"1288013719961305",name:"Ten TK"},{id:"86851031",name:"Van phi"}];
   window.cur = "1288013719961305";
   window.directory = {"50":"Nguoi Nam","60":"Nguoi Sau","70":"Nguoi Bay"};
   window.users = ${JSON.stringify(variant.users)};
   window.ROLE_VN = {ADMIN:"Quản trị viên",ADVERTISER:"Nhà quảng cáo",ANALYST:"Nhà phân tích quảng cáo"};
   window.mode = ${JSON.stringify(variant.mode || "normal")}; window.RM = ${JSON.stringify(variant.removeLabel || "Xóa")}; window.OKL = ${JSON.stringify(variant.okLabel || "Thêm")};
   function el(html){const d=document.createElement("div");d.innerHTML=html.trim();return d.firstChild;}
   function openDialog(inner){const d=el('<div role="dialog">'+inner+'</div>');document.body.appendChild(d);return d;}
   function render(){
     document.getElementById("acct").textContent = window.cur+" (Ten TK)";
     const list=document.getElementById("list"); list.innerHTML="";
     if (window.mode==="error"){ document.getElementById("toast").textContent="Rất tiếc, đã xảy ra lỗi. Hãy thử lại."; document.getElementById("addbtn").style.display="none"; return; }
     if (window.mode==="noaccess"){ document.getElementById("rolesCard").innerHTML="<h2>Vai trò trên tài khoản quảng cáo</h2><p>Bạn không có quyền truy cập tài khoản này</p>"; return; }
     window.users.forEach(u=>{
       const row=el('<div class="row"></div>');
       const link = window.mode==="nouid" ? '<span>'+u.name+'</span>' : '<a href="/profile.php?id='+u.uid+'">'+u.name+'</a>';
       row.innerHTML = link+'<span>'+window.ROLE_VN[u.role]+'</span><button aria-label="'+window.RM+'">'+window.RM+'</button>';
       row.querySelector("button").onclick=()=>{
         const d=openDialog('<p>Xóa người dùng?</p><button>Hủy</button><button>Xóa</button>');
         const bs=d.querySelectorAll("button"); bs[0].onclick=()=>d.remove();
         bs[1].onclick=()=>{ if(window.refuse===u.uid){d.innerHTML+='<p>Rất tiếc, đã xảy ra lỗi</p>';return;}
           window.users=window.users.filter(x=>x.uid!==u.uid); d.remove(); render();
           if(u.uid===window.selfUid && window.mode==="normal"){ window.mode="noaccess"; render(); } };
       };
       list.appendChild(row);
     });
   }
   document.getElementById("addbtn").onclick=()=>{
     let chosen=null, role="ADMIN";
     const d=openDialog('<input placeholder="Tìm kiếm"><ul id="res"></ul><div id="roles"></div><button id="ok">'+window.OKL+'</button>');
     const input=d.querySelector("input"), res=d.querySelector("#res"), roles=d.querySelector("#roles");
     Object.entries(window.ROLE_VN).forEach(([k,v])=>{const r=el('<div role="radio" aria-checked="'+(k===role)+'">'+v+'</div>');
       r.onclick=()=>{role=k;[...roles.children].forEach(c=>c.setAttribute("aria-checked","false"));r.setAttribute("aria-checked","true");}; roles.appendChild(r);});
     input.addEventListener("input",()=>{res.innerHTML="";const v=input.value.trim();
       if(window.directory[v]){const li=el('<li role="option"><a href="/profile.php?id='+v+'">'+window.directory[v]+'</a></li>');li.onclick=()=>{chosen=v};res.appendChild(li);}
       else if(window.mode==="ambiguous"){const li=el('<li role="option">Ket qua gan giong</li>');res.appendChild(li);} });
     d.querySelector("#ok").onclick=()=>{ if(!chosen) return; window.users.push({uid:chosen,name:window.directory[chosen],role}); d.remove(); render(); };
   };
   document.getElementById("acct").onclick=()=>{
     const d=openDialog('<input placeholder="Search"><ul id="r"></ul>'); const input=d.querySelector("input"), r=d.querySelector("#r");
     input.addEventListener("input",()=>{r.innerHTML="";window.accounts.filter(a=>a.id.includes(input.value.trim())&&input.value.trim()).forEach(a=>{
       const li=el('<li role="option">'+a.id+' '+a.name+'</li>'); li.onclick=()=>{window.cur=a.id;d.remove();render();}; r.appendChild(li);});});
   };
   window.selfUid="1"; render();
  </script></body></html>`;
  }

  async function setup(variant) {
    const dom = new JSDOM(pageHtml(variant), { runScripts: "dangerously", url: "https://adsmanager.facebook.com/adsmanager/manage/ad_account_settings?act=1288013719961305", pretendToBeVisual: true });
    const w = dom.window;
    w.__AMIT_TEST__ = true;
    // jsdom thiếu một số API layout
    w.Element.prototype.getClientRects = function () { return [{ width: 1, height: 1 }]; };
    w.Element.prototype.getBoundingClientRect = function () { return { top: 10, left: 0, width: 1, height: 1, right: 1, bottom: 11 }; };
    w.Element.prototype.scrollIntoView = function () {};
    // innerText giả: như trình duyệt thật, KHÔNG gồm nội dung <script>/<style>
    Object.defineProperty(w.HTMLElement.prototype, "innerText", {
      get() { const c = this.cloneNode(true); c.querySelectorAll("script,style").forEach(n => n.remove()); return c.textContent; },
      configurable: true
    });
    w.document.cookie = "c_user=1";
    w.chrome = { runtime: { onMessage: { addListener(fn) { w.__listener = fn; } } } };
    if (opts.withLogger) {
      // Logger thật của extension, ghi vào mảng w.__logs thay vì gửi về service worker
      w.eval(loggerSrc);
      w.__logs = [];
      w.AmitLog.setSink(e => w.__logs.push(e));
      w.AmitLog.init("content");
    }
    w.eval(coreSrc);
    w.eval(execSrc);
    const I = w.__AmitExecutorInternals;
    I.CONFIG.uidHrefPatterns.unshift(/profile\.php\?id=(\d+)/); // UID giả trong test ngắn hơn UID thật
    Object.assign(I.CONFIG.timeouts, { accountHeader: 1500, section: 1500, dialog: 1500, results: 1200, dialogClose: 1500, settle: 50, poll: 30 });
    return { w, I, C: w.AmitSuperShareCore };
  }

  return { pageHtml, setup };
}

module.exports = { makeSetup };
