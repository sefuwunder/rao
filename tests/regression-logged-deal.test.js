// rao regression test: logging an outcome must advance the Action recommendation.
// Bug: after "Log it." succeeded, going back to Action recommended the same
// deal again, because the hero reads Milton's cached hygiene suggestions and
// logging only refreshed outreach. Fix: deals touched today (from outreach)
// are excluded from the hero and marked "Logged ✓" in the suggestion list.
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const src = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
const T = "2026-09-24";

function el() {
  return {
    innerHTML: "", textContent: "", className: "", value: "", style: {},
    offsetWidth: 0, scrollTop: 0, scrollHeight: 0,
    addEventListener() {}, remove() {},
    appendChild() {}, focus() {},
    classList: { add() {}, remove() {}, toggle() {} },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    getBoundingClientRect() { return { width: 120 }; },
  };
}

const outreach = []; // stateful: POST appends (like exec-crm), GET returns
const elements = {};
const J = (o, status) => Promise.resolve({ status: status || 200, json: () => Promise.resolve(o) });
const sandbox = {
  window: {},
  console,
  fetch: (url, opts) => {
    const method = (opts && opts.method) || "GET";
    const body = opts && opts.body ? JSON.parse(opts.body) : null;
    if (url === "/api/state") return J({ settings: { display_name: "Sefu", reduce_motion: "0" }, day: { date: T, phase: "action", review: ["brief", "scan", "intent"], done: false } });
    if (url === "/api/milton/hygiene") return J({ items: [
      { text: "Acme renewal has gone quiet", kind: "stale", phase: "action", ref: { deal_id: 5 } },
      { text: "Initech pilot needs a nudge", kind: "nudge", phase: "action", ref: { deal_id: 7 } },
    ] });
    if (url === "/api/crm/deals") return J({ deals: [
      { id: 5, title: "Acme renewal", stage: "negotiation", value: 50000 },
      { id: 7, title: "Initech pilot", stage: "discovery", value: 12000 },
    ], stages: ["discovery", "negotiation", "won"], labels: {} });
    if (url === "/api/crm/tasks") return J({ tasks: [] });
    if (url === "/api/crm/outreach") {
      if (method === "POST") {
        // exec-crm stores happened_at as "" when the composer sends none;
        // created_at carries the real timestamp.
        outreach.push({ id: outreach.length + 1, deal_id: body.deal_id, channel: body.channel, outcome: body.outcome, happened_at: "", created_at: T + " 10:30:00", deal_title: body.deal_id === 5 ? "Acme renewal" : "Initech pilot" });
        return J({ ok: true }, 201);
      }
      return J({ outreach: outreach.slice(), channels: [{ value: "call", label: "Call" }] });
    }
    if (url === "/api/day") return J({ day: { date: T, phase: "action", review: ["brief", "scan", "intent"], done: false } });
    return J({});
  },
  document: {
    getElementById: (id) => (elements[id] || (elements[id] = el())),
    querySelector: () => null,
    createElement: () => el(),
    body: el(),
    addEventListener() {},
  },
  setTimeout: (fn) => 0,
  clearTimeout: () => {},
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: "app.js" });
const RAO = sandbox.window.RAO;
const S = RAO.state;
S.settings = { display_name: "Sefu", reduce_motion: "0" };
S.day = { date: T, phase: "action", review: ["brief", "scan", "intent"], done: false };

let n = 0;
function ok(cond, msg) { n++; assert(cond, msg); console.log("ok " + n + " - " + msg); }
// promise callbacks inside the vm sandbox drain on a macrotask, not on a
// host-side await of the cross-context promise, so settle via a timer.
function settle() { return new Promise((r) => setTimeout(r, 25)); }
const hero = () => elements["view"].innerHTML;

(async () => {
  // 1. entering action recommends the first Milton-flagged deal
  RAO.enter("action");
  await settle(); await settle();
  ok(hero().includes("Acme renewal"), "action hero recommends the Milton-flagged deal (Acme)");

  // 2. user logs an outcome for Acme through the real logOutcome path
  S.compose.dealId = 5;
  S.compose.outcome = "Connected";
  S.compose.channel = "call";
  RAO.logOutcome();
  await settle(); await settle();
  ok(outreach.length === 1 && outreach[0].deal_id === 5, "outcome POST lands in outreach");
  ok(S.outreach.length === 1, "app refreshes its outreach list after logging");

  // 3. going back to action must NOT recommend Acme again
  RAO.enter("action");
  await settle(); await settle();
  const h = hero();
  ok(!h.includes("Touch next") || !/Touch next[\s\S]{0,200}Acme renewal/.test(h), "hero no longer recommends the logged deal");
  ok(h.includes("Initech pilot"), "hero advances to the next untouched deal (Initech)");
  ok(h.includes("Logged ✓"), "logged deal is marked Logged in the suggestion list");

  console.log("\nregression: " + n + " passed");
})().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
