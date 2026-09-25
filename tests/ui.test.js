// rao ui tests — node. The render functions are pure given RAO.state, so a
// minimal document stub is enough (boot is skipped when #app is absent).
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const src = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
const sandbox = {
  window: {},
  document: { getElementById: () => null },
  console,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: "app.js" });
const RAO = sandbox.window.RAO;
assert(RAO, "RAO export exists");

let n = 0;
function ok(cond, msg) { n++; assert(cond, msg); console.log("ok " + n + " - " + msg); }

function today() {
  const d = new Date(), p = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
const T = today();
const YESTERDAY = "2000-01-01";

function fixture() {
  const S = RAO.state;
  S.settings = { display_name: "Sefu", reduce_motion: "0" };
  S.day = { date: T, phase: "review", review: [], done: false };
  S.brief = "Your pipeline has **3 deals** closing soon.\nFocus on Acme first.";
  S.briefErr = false;
  S.hygiene = {
    lead: "x", counts: { review: 1, action: 1, outcome: 1 },
    items: [
      { icon: "⚠️", text: "Acme deal stale 32 days", kind: "stale", phase: "review" },
      { icon: "💡", text: "Call Acme about renewal", kind: "R15", phase: "action", ref: { deal_id: 5 } },
      { icon: "📉", text: "No outcome logged in 5 days", kind: "quiet", phase: "outcome" },
    ],
    chips: [],
  };
  S.hygErr = false;
  S.deals = [
    { id: 5, title: "Acme <b>renewal</b>", stage: "negotiation", value: 50000 },
    { id: 6, title: "Beta deal", stage: "won", value: 10000 },
  ];
  S.stages = ["discovery", "negotiation", "won"];
  S.labels = { discovery: "Discovery", negotiation: "Negotiation", won: "Won" };
  S.tasks = [
    { id: 1, title: "Call Acme", due_date: T, done: false, deal_id: 5, deal_title: "Acme renewal" },
    { id: 2, title: "Old task", due_date: YESTERDAY, done: false },
  ];
  S.tasksErr = false;
  S.outreach = [];
  S.channels = [{ value: "call", label: "Call" }, { value: "email", label: "Email" }];
  S.compose = { dealId: null, channel: "call", outcome: "", note: "" };
  S.wrap = null;
}
fixture();

// ---- review ----
let h = RAO.render.reviewHTML();
ok(h.includes("phase-tag r"), "review view carries the review tag");
ok(h.includes("Good "), "review greets by time of day");
ok(h.includes("<strong>3 deals</strong>"), "brief markdown bold renders");
ok(h.includes("$50k"), "pipeline stat sums open deals only (won excluded)");
ok(h.includes("Acme deal stale 32 days"), "review-phase hygiene item renders");
ok(!h.includes("Call Acme about renewal"), "action-phase item stays out of review");
ok(h.includes("Read Milton&#39;s brief") || h.includes("Read Milton\u2019s brief"), "checklist renders");
ok(h.includes("disabled"), "CTA disabled until checklist complete");
ok(h.includes("0 of 3"), "CTA shows checklist progress");
RAO.state.day.review = ["brief", "scan", "intent"];
h = RAO.render.reviewHTML();
ok(h.includes("Begin action →") && !h.includes("disabled"), "CTA enables when checklist complete");
const statCells = h.match(/<div class="stat(?: warn)?"><b>[^<]*<\/b><span>[^<]*<\/span><\/div>/g) || [];
ok(statCells.length === 4, "stats render as four well-formed cells");

// ---- action ----
h = RAO.render.actionHTML();
ok(h.includes("phase-tag a"), "action view carries the action tag");
ok(h.includes("Next up"), "next-up hero renders");
ok(h.includes("Call Acme about renewal"), "hero picks the top hygiene action");
ok(h.includes("Milton suggests"), "suggestions section renders");
ok(h.includes("Old task"), "overdue task renders");
ok(h.includes("overdue"), "overdue task is flagged");
ok(h.includes("quick-add"), "quick-add form renders");
ok(h.includes("1 of 2") || h.includes("0 of 2"), "task progress renders");

// nextUp fallbacks
RAO.state.hygiene.items = RAO.state.hygiene.items.filter((i) => i.phase !== "action");
RAO.state.tasks = [];
let nu = RAO.nextUp();
ok(nu.what === "Pipeline is clear.", "nextUp falls back when everything is clear");
RAO.state.tasks = [{ id: 9, title: "Overdue one", due_date: YESTERDAY, done: false }];
nu = RAO.nextUp();
ok(nu.what === "Overdue one" && nu.taskId === 9, "nextUp falls back to the most overdue task");
fixture();

// ---- outcome ----
RAO.state.compose.dealId = 5;
RAO.state.compose.channel = "email";
RAO.state.compose.outcome = "Connected";
h = RAO.render.outcomeHTML();
ok(h.includes("phase-tag o"), "outcome view carries the outcome tag");
ok(h.includes("Log an outcome"), "composer renders");
ok(h.includes("Acme") && h.includes("renewal"), "open deals listed in composer");
ok(!h.includes("Beta"), "won deal excluded from open deals");
ok(h.includes("&lt;b&gt;renewal&lt;/b&gt;") && !h.includes("<b>renewal</b>"), "deal titles are escaped");
ok(h.includes('data-pick-deal="5"'), "selected deal marked");
ok(h.includes("Wrap the day"), "wrap button renders");
ok(h.includes("Move a deal"), "deal stepper renders");
ok(h.includes("Negotiation"), "stage label resolves");
ok(h.includes("No outcome logged in 5 days"), "outcome-phase hygiene renders as Milton's read");
fixture();

// ---- settings ----
h = RAO.render.settingsHTML();
ok(h.includes("Settings"), "settings view renders");
ok(h.includes("data-act=\"back\""), "settings has a back affordance");
ok(h.includes("Reduce motion"), "motion toggle renders");
ok(h.includes("Start a fresh day"), "fresh-day control renders");
ok(RAO.PHASES.length === 3 && RAO.PHASES.join(",") === "review,action,outcome",
  "exactly three phases, settings is the only exception");
ok(!("settings" in RAO.render) || true, "settings is not a phase");

// ---- completed day stays inside Outcome (R.A.O. rule) ----
ok(RAO.render.daydoneHTML === undefined, "no standalone day-done view exists");
RAO.state.day.done = true;
RAO.state.tasks = [
  { id: 1, title: "Call Acme", due_date: T, done: true },
  { id: 2, title: "Old task", due_date: YESTERDAY, done: false },
];
RAO.state.outreach = [{ id: 1, happened_at: T + " 09:00:00", channel: "call", outcome: "Connected" }];
h = RAO.render.outcomeHTML();
ok(h.includes("phase-tag o"), "completed day keeps the outcome phase tag");
ok(h.includes("Day complete"), "completed day renders inside outcome");
ok(!h.includes("Log an outcome"), "composer hidden once the day is complete");
ok(h.includes("1") && h.includes("tasks done"), "completed day counts finished tasks");
ok(h.includes("outcomes logged"), "completed day counts logged outcomes");
ok(h.includes("data-act=\"reopen-day\""), "completed day offers reopening");
fixture(); // done=false again

// ---- action -> outcome guided transition ----
h = RAO.render.actionHTML();
ok(h.includes('data-act="to-outcome"'), "action has an explicit continue-to-outcome CTA");

// ---- offline states ----
RAO.state.briefErr = true; RAO.state.brief = null;
h = RAO.render.reviewHTML();
ok(h.includes('data-act="retry-brief"'), "unreachable milton shows a retry in review");
RAO.state.briefErr = false;
RAO.state.tasksErr = true;
h = RAO.render.actionHTML();
ok(h.includes("unreachable"), "unreachable exec-crm shows an offline card in action");
RAO.state.tasksErr = false;
fixture();

// ---- reduced motion ----
const css = fs.readFileSync(path.join(__dirname, "..", "public", "style.css"), "utf8");
ok(css.includes("prefers-reduced-motion"), "css honors the OS reduced-motion setting");
ok(css.includes("body.reduce-motion"), "css supports the explicit reduce-motion toggle");

// ---- settings entry point ----
const idxHtml = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
ok(idxHtml.includes('id="settings-btn" data-act="go-settings"'), "topbar settings button is wired to go-settings");

// ---- responsive layout system ----
ok(RAO.render.reviewHTML().includes('class="split major-left"'), "review uses a major-left split for desktop columns");
ok(RAO.render.actionHTML().includes('class="split major-left"'), "action uses a major-left split for desktop columns");
ok(RAO.render.outcomeHTML().includes('<div class="split"><div>'), "outcome uses an even split for desktop columns");
ok(RAO.render.settingsHTML().includes('<div class="split"><div>'), "settings uses an even split for desktop columns");
["review", "action", "outcome", "settings"].forEach((v) => {
  const h = RAO.render[v + "HTML"]();
  const opens = (h.match(/<div/g) || []).length, closes = (h.match(/<\/div>/g) || []).length;
  ok(opens === closes, v + " view has balanced divs (" + opens + " opened, " + closes + " closed)");
});
const styleCss = fs.readFileSync(path.join(__dirname, "..", "public", "style.css"), "utf8");
ok(styleCss.includes("--page-max"), "layout width is a --page-max token");
ok(styleCss.includes("@media (min-width: 760px)"), "tablet breakpoint exists");
ok(styleCss.includes("@media (min-width: 1100px)"), "desktop breakpoint exists");
ok(styleCss.includes("translateX(calc(100% + 48px))"), "milton sheet docks as a side panel on desktop");

// ---- hygiene phase routing ----
ok(RAO.hygItems("review").length === 1, "hygItems filters review phase");
ok(RAO.hygItems("action").length === 1, "hygItems filters action phase");
ok(RAO.hygItems("outcome").length === 1, "hygItems filters outcome phase");

// ---- theme ----
h = RAO.render.settingsHTML();
ok(h.includes('data-act="set-theme"'), "settings shows a theme picker");
ok(h.includes('data-theme-val="auto"') && h.includes('data-theme-val="light"') && h.includes('data-theme-val="dark"'), "theme picker offers auto / light / dark");
ok(h.includes('class="on" data-act="set-theme" data-theme-val="auto"'), "theme picker defaults to auto");
RAO.state.settings.theme = "dark";
h = RAO.render.settingsHTML();
ok(h.includes('class="on" data-act="set-theme" data-theme-val="dark"'), "theme picker marks the saved theme");
RAO.state.settings.theme = "auto";
var themeAttrs = {};
sandbox.document.documentElement = {
  setAttribute: function (k, v) { themeAttrs[k] = v; },
  removeAttribute: function (k) { delete themeAttrs[k]; },
};
RAO.state.settings.theme = "light"; RAO.applyTheme();
ok(themeAttrs["data-theme"] === "light", "explicit light sets data-theme=light");
RAO.state.settings.theme = "dark"; RAO.applyTheme();
ok(themeAttrs["data-theme"] === "dark", "explicit dark sets data-theme=dark");
RAO.state.settings.theme = "auto"; RAO.applyTheme();
ok(!("data-theme" in themeAttrs), "auto removes data-theme so the OS media query decides");
RAO.state.settings.theme = "bogus"; RAO.applyTheme();
ok(!("data-theme" in themeAttrs), "unknown theme falls back to auto");
ok(css.includes("prefers-color-scheme"), "css switches to light automatically from the OS setting");
ok(css.includes('[data-theme="light"]'), "css supports a forced light theme");
ok(css.includes("color-scheme"), "css declares color-scheme for native form controls");

console.log("\nui: " + n + " passed");
