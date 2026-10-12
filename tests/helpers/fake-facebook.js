/**
 * Facebook giả cho test Graph engine: trả lời Graph (me, act_X, users, assigned_users, userpermissions) và trang Ads Manager.
 * Có thể chèn lỗi / độ trễ bằng fb.hook(...). Không có mạng thật.
 */
const TOKEN = "EAAB" + "q".repeat(40);

function makeFacebook(opts) {
  opts = opts || {};
  const fb = {
    cookieUid: opts.cookieUid === undefined ? "1" : opts.cookieUid,
    tokenOwner: opts.tokenOwner || null, // mặc định = cookieUid
    pageRedirect: null,                  // vd "https://www.facebook.com/login/..." -> trang trả URL cuối này
    acts: opts.acts || {},
    calls: [],
    hooks: [],
    tokenHits: 0
  };

  fb.act = (id, init) => {
    fb.acts[id] = Object.assign({ owner: "900", business: null, denied: false, users: new Map() }, init || {});
    return fb.acts[id];
  };
  fb.addUser = (actId, uid, role, via) => fb.acts[actId].users.set(String(uid), { role, via: via || "users" });

  fb.hook = (match, respond, once) => { fb.hooks.push({ match, respond, once: once !== false, used: 0 }); };

  const res = (json, status, url) => ({
    ok: (status || 200) < 400, status: status || 200, url: url || "https://graph.facebook.com/",
    headers: { get: () => null }, text: async () => (typeof json === "string" ? json : JSON.stringify(json))
  });
  const gerr = (code, message, status, sub) => res({ error: { message, type: "OAuthException", code, error_subcode: sub, fbtrace_id: "T" } }, status || 400);
  fb.res = res; fb.gerr = gerr;

  const ROLE_BY_ID = { 1001: "ADMIN", 1002: "ADVERTISER", 1003: "ANALYST" };
  const dump = (u) => ({ id: u.uid, name: "User " + u.uid, role: u.role, tasks: u.via === "assigned" ? TASKS[u.role] : undefined });
  const TASKS = { ADMIN: ["MANAGE", "ADVERTISE", "ANALYZE"], ADVERTISER: ["ADVERTISE", "ANALYZE"], ANALYST: ["ANALYZE"] };

  fb.fetch = async (url, init) => {
    init = init || {};
    const u = new URL(url);
    const method = (init.method || "GET").toUpperCase();
    const params = {};
    u.searchParams.forEach((v, k) => { params[k] = v; });
    if (init.body) new URLSearchParams(init.body).forEach((v, k) => { params[k] = v; });
    const token = params.access_token;
    delete params.access_token;

    // trang Ads Manager / facebook.com
    if (!/^graph\./.test(u.hostname)) {
      const final = fb.pageRedirect || url;
      return res(`<html><script>window.__accessToken="${TOKEN}";</script><script>"EAAZ${"z".repeat(30)}"</script></html>`, 200, final);
    }

    const path = u.pathname.replace(/^\/v\d+\.\d+/, "");
    const call = { method, path, params, url, bodyHasToken: !!(init.body && String(init.body).includes("access_token")), urlHasToken: u.searchParams.has("access_token") };
    fb.calls.push(call);

    for (const h of fb.hooks) {
      if ((!h.once || h.used === 0) && h.match(call)) { h.used++; return h.respond(call, init); }
    }
    if (token !== TOKEN) return gerr(190, "Invalid OAuth access token.", 400);
    fb.tokenHits++;
    if (path === "/me") return res({ id: fb.tokenOwner || fb.cookieUid });

    let m = path.match(/^\/act_(\d+)(?:\/([a-z_]+)(?:\/(\d+))?)?$/);
    if (!m) return gerr(100, "Unsupported request", 400);
    const act = fb.acts[m[1]];
    if (!act || act.denied) return gerr(100, `Unsupported ${method.toLowerCase()} request. Object with ID 'act_${m[1]}' does not exist, cannot be loaded due to missing permissions`, 400);
    const edge = m[2]; const target = m[3];

    if (!edge && method === "GET") return res({ account_id: m[1], owner: act.owner, owner_business: act.business ? { id: act.business } : undefined, id: "act_" + m[1] });
    if (edge === "users" && method === "GET") {
      return res({ data: [...act.users].filter(([, v]) => v.via === "users").map(([uid, v]) => ({ id: uid, name: "User " + uid, role: v.role })) });
    }
    if (edge === "assigned_users" && method === "GET") {
      return res({ data: [...act.users].filter(([, v]) => v.via === "assigned").map(([uid, v]) => ({ id: uid, name: "User " + uid, tasks: TASKS[ROLE_BY_ID[v.role] || v.role] })) });
    }
    if (edge === "users" && method === "POST" && !target) {
      act.users.set(params.uid, { role: Number(params.role), via: "users" });
      return res({ success: true });
    }
    if (edge === "users" && method === "POST" && target && params.method === "DELETE") {
      if (!act.users.has(target)) return gerr(100, "Invalid user id: not found", 400);
      act.users.delete(target);
      return res({ success: true });
    }
    if (edge === "assigned_users" && method === "POST") {
      const tasks = JSON.parse(params.tasks);
      const role = tasks.includes("MANAGE") ? 1001 : tasks.includes("ADVERTISE") ? 1002 : 1003;
      act.users.set(params.user, { role, via: "assigned" });
      return res({ success: true });
    }
    if (edge === "userpermissions" && method === "POST" && params.method === "delete") {
      act.users.delete(params.user);
      return res({ success: true });
    }
    return gerr(100, "Unsupported request", 400);
  };

  fb.TOKEN = TOKEN;
  return fb;
}

module.exports = { makeFacebook, TOKEN };
