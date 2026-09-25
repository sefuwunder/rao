// rao interaction tests — node + vm. Exercises the event-handler logic
// (toggleCheck, go) against a stubbed fetch and a minimal fake DOM,
// plus the review gate end to end.
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const src = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");

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

const posts = [];
const elements = {};
const sandbox = {
  window: {},
  console,
  fetch: (url, opts) => {
    posts.push({ url, body: opts && opts.body ? JSON.parse(opts.body) : null });
    return Promise.resolve({
      status: 200,
      json: () => Promise.resolve({ day: { date: "2026-09-24", phase: "review", review: [], done: false } }),
    });
  },
  document: {
    getElementById: (id) => (id === "app" ? null : (elements[id] || (elements[id] = el()))),
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
S.day = { date: "2026-09-24", phase: "review", review: [], done: false };

let n = 0;
function ok(cond, msg) { n++; assert(cond, msg); console.log("ok " + n + " - " + msg); }
// promise callbacks inside the vm sandbox drain on a macrotask, not on a
// host-side await of the cross-context promise, so settle via a timer.
function settle() { return new Promise((r) => setTimeout(r, 25)); }

(async () => {
  // 1. checklist toggle persists to the server and updates state
  RAO.toggleCheck("brief");
  await settle();
  ok(posts.length === 1 && posts[0].url === "/api/day", "toggleCheck POSTs to /api/day");
  assert.deepStrictEqual(posts[0].body.review, ["brief"]);
  ok(true, "server receives the checked id");
  assert.deepStrictEqual(S.day.review, ["brief"]);
  ok(true, "local day state reflects the check");

  // 2. toggling again unchecks
  RAO.toggleCheck("brief");
  await settle();
  assert.deepStrictEqual(posts[1].body.review, []);
  assert.deepStrictEqual(S.day.review, []);
  ok(true, "toggleCheck unchecks an already-checked step");

  // 3. checking all three opens the gate (interaction + render together)
  RAO.toggleCheck("brief");
  await settle();
  RAO.toggleCheck("scan");
  await settle();
  RAO.toggleCheck("intent");
  await settle();
  assert.deepStrictEqual(S.day.review, ["brief", "scan", "intent"]);
  const h = RAO.render.reviewHTML();
  ok(h.includes("Begin action →") && !h.includes("disabled"), "review gate opens after all three checks");

  // 4. phase navigation posts the phase and switches the view
  posts.length = 0;
  RAO.go("outcome");
  await settle();
  const nav = posts.find((p) => p.body && p.body.phase);
  ok(nav && nav.body.phase === "outcome", "go() persists the phase change");
  ok(S.view === "outcome" && S.day.phase === "outcome", "go() switches the active view");

  // 5. invalid phase is ignored
  const before = S.view;
  RAO.go("settings");
  await settle();
  ok(S.view === before, "go() ignores non-phase views");

  // 6. entering a view loads its data exactly once per loader (no re-render loop)
  posts.length = 0;
  RAO.enter("review");
  await settle();
  await settle();
  const afterFirst = posts.length;
  ok(afterFirst > 0, "enter() fires the view's data loads (" + afterFirst + " requests)");
  await settle();
  await settle();
  ok(posts.length === afterFirst, "loader refresh cycle terminates — no infinite re-mount");

  // 7. the topbar settings gear opens settings through the delegated tap handler
  function fakeBtn(attrs) {
    return {
      hasAttribute: (k) => attrs[k] !== undefined,
      getAttribute: (k) => (attrs[k] !== undefined ? attrs[k] : null),
    };
  }
  RAO.onTap({ target: { closest: () => fakeBtn({ "data-act": "go-settings" }) } });
  await settle();
  ok(S.view === "settings", "settings gear (data-act=go-settings) opens the settings view");

  // 8. rail phase buttons still navigate through the single delegated handler
  posts.length = 0;
  RAO.onTap({ target: { closest: () => fakeBtn({ "data-go": "action" }) } });
  await settle(); await settle();
  ok(S.view === "action", "rail data-go navigates via the delegated handler");
  ok(posts.some((p) => p.body && p.body.phase === "action"), "rail navigation persists the phase");

  // 9. bind() attaches no click listener of its own — one document-level
  // onTap handles everything, so handlers can never stack on #view again
  let clicks = 0;
  const r2 = el();
  r2.addEventListener = (t) => { if (t === "click") clicks++; };
  RAO.bind("review", r2); RAO.bind("action", r2);
  ok(clicks === 0, "bind() attaches no click listener (single document-level delegation)");

  console.log("\ninteraction: " + n + " passed");
})().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
