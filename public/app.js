/* rao — Review · Action · Outcome. Milton is the logic engine, exec-crm the
   system of record. Every screen outside Settings is one of the three phases,
   and each phase hand-holds the user to the next. */
(function () {
"use strict";

var PHASES = ["review", "action", "outcome"];
var PHASE_TAG = { review: "r", action: "a", outcome: "o" };
var REVIEW_STEPS = [
  { id: "brief", label: "Read Milton's brief" },
  { id: "scan", label: "Scan what needs your eyes" },
  { id: "intent", label: "Set today's intention" },
];
var OUTCOMES = ["Connected", "No answer", "Follow-up set", "Advanced", "Won", "Lost"];

var S = {
  settings: null, day: null, view: "review",
  brief: null, briefErr: false,
  hygiene: null, hygErr: false,
  deals: [], stages: [], labels: {},
  tasks: [], tasksErr: false,
  outreach: [], channels: [],
  compose: { dealId: null, channel: "call", outcome: "", note: "" },
  chat: [], chatOpen: false,
  wrap: null,
  ui: { expanded: {} },
};

/* ---------- tiny helpers ---------- */
function $(id) { return document.getElementById(id); }
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}
function todayStr() {
  var d = new Date(), p = function (n) { return String(n).padStart(2, "0"); };
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}
/* Local wall-clock "YYYY-MM-DD HH:MM". exec-crm stamps created_at in UTC, so a
   rao-logged outcome must carry its own local happened_at — otherwise anything
   logged after 20:00 EDT lands on "tomorrow" and vanishes from today's views. */
function nowLocal() {
  var d = new Date(), p = function (n) { return String(n).padStart(2, "0"); };
  return todayStr() + " " + p(d.getHours()) + ":" + p(d.getMinutes());
}
/* Theme: "auto" follows the OS via prefers-color-scheme (no data-theme attr);
   "light"/"dark" force it through data-theme on <html>. */
function applyTheme() {
  var t = (S.settings && S.settings.theme) || "auto";
  if (t !== "light" && t !== "dark") t = "auto";
  var root = document.documentElement;
  if (!root || !root.setAttribute) return;
  if (t === "auto") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", t);
}
function fmtMoney(n) {
  n = Number(n) || 0;
  if (n >= 1000000) return "$" + (n / 1000000).toFixed(n % 1000000 ? 1 : 0) + "M";
  if (n >= 1000) return "$" + (n / 1000).toFixed(n % 1000 ? 1 : 0) + "k";
  return "$" + n;
}
function md(s) {
  return esc(s).replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/\n/g, "<br>");
}
function api(path, opts) {
  return fetch(path, opts).then(function (r) {
    return r.json().then(function (j) { return { status: r.status, body: j }; });
  });
}
var toastT = null;
function toast(msg) {
  var t = document.querySelector(".toast");
  if (!t) {
    t = document.createElement("div"); t.className = "toast";
    document.getElementById("app").appendChild(t);
  }
  t.textContent = msg; t.classList.add("show");
  clearTimeout(toastT); toastT = setTimeout(function () { t.classList.remove("show"); }, 2600);
}
function greeting() {
  var h = new Date().getHours();
  var name = S.settings && S.settings.display_name ? ", " + esc(S.settings.display_name.split(" ")[0]) : "";
  if (h < 12) return "Good morning" + name + ".";
  if (h < 17) return "Good afternoon" + name + ".";
  return "Good evening" + name + ".";
}
function dealById(id) {
  for (var i = 0; i < S.deals.length; i++) if (S.deals[i].id === id) return S.deals[i];
  return null;
}
function openDeals() {
  return S.deals.filter(function (d) {
    var s = String(d.stage || "").toLowerCase();
    return s.indexOf("won") === -1 && s.indexOf("lost") === -1 && s.indexOf("dead") === -1;
  });
}
function stageLabel(slug) {
  return S.labels[slug] || String(slug || "").replace(/_/g, " ");
}
function taskDue(d) { return String(d.due_date || "").slice(0, 10); }
var LIST_CAP = 8;
/* No list runs longer than LIST_CAP by default — a "more" button reveals the rest. */
function cappedList(id, items, rowFn) {
  var expanded = S.ui.expanded[id];
  var shown = expanded ? items : items.slice(0, LIST_CAP);
  var h = shown.map(rowFn).join("");
  if (!expanded && items.length > LIST_CAP)
    h += '<button class="more-btn" data-act="expand-list" data-list="' + esc(id) + '">Show ' +
      (items.length - LIST_CAP) + " more</button>";
  return h;
}
function overdueTasks() {
  var t = todayStr();
  return S.tasks.filter(function (x) { return !x.done && taskDue(x) && taskDue(x) < t; });
}
function dueTodayTasks() {
  var t = todayStr();
  return S.tasks.filter(function (x) { return !x.done && taskDue(x) === t; });
}

/* ---------- data loading ---------- */
function loadBrief() {
  if (S.brief || S.briefErr) return Promise.resolve();
  return api("/api/milton/chat", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "morning brief" }),
  }).then(function (res) {
    if (res.status === 200 && res.body.text) { S.brief = res.body.text; }
    else { S.briefErr = true; }
    if (S.view === "review") mount("review", true);
  });
}
function loadHygiene() {
  if (S.hygiene || S.hygErr) return Promise.resolve();
  return api("/api/milton/hygiene").then(function (res) {
    if (res.status === 200 && res.body.items) { S.hygiene = res.body; }
    else { S.hygErr = true; }
    if (PHASES.indexOf(S.view) !== -1) mount(S.view, true);
  });
}
function loadDeals() {
  return api("/api/crm/deals").then(function (res) {
    if (res.status === 200) {
      S.deals = res.body.deals || []; S.stages = res.body.stages || []; S.labels = res.body.labels || {};
    }
    if (PHASES.indexOf(S.view) !== -1) mount(S.view, true);
  });
}
function loadTasks() {
  return api("/api/crm/tasks").then(function (res) {
    if (res.status === 200) { S.tasks = res.body.tasks || []; S.tasksErr = false; }
    else { S.tasksErr = true; }
    if (S.view === "action" || S.view === "review" || S.view === "outcome") mount(S.view, true);
  });
}
function loadOutreach() {
  return api("/api/crm/outreach").then(function (res) {
    if (res.status === 200) {
      S.outreach = res.body.outreach || [];
      S.channels = res.body.channels || [];
      if (S.compose.channel === "call" && S.channels.length) S.compose.channel = S.channels[0].value;
    }
    if (S.view === "outcome" || S.view === "action") mount(S.view, true);
  });
}
function hygItems(phase) {
  if (!S.hygiene) return [];
  return S.hygiene.items.filter(function (it) { return it.phase === phase; });
}
/* Deals with an outcome logged today (rao's composer sends no happened_at, so
   fall back to created_at — same rule as the day-wrap stats). The Action hero
   and suggestion list skip these: logging a touch advances the loop. */
function touchedTodayDealIds() {
  var t = todayStr(), ids = {};
  (S.outreach || []).forEach(function (o) {
    var d = String(o.happened_at || o.created_at || "").slice(0, 10);
    if (d && d === t && o.deal_id != null) ids[Number(o.deal_id)] = true;
  });
  return ids;
}

/* ---------- phase navigation ---------- */
function go(phase, back) {
  if (PHASES.indexOf(phase) === -1) return Promise.resolve();
  return api("/api/day", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ phase: phase }),
  }).then(function () {
    S.day.phase = phase;
    enter(phase, true, back);
  });
}
function paintRail() {
  var rail = $("rail"); if (!rail) return;
  var idx = PHASES.indexOf(S.view);
  var html = '<div class="rail-glider ' + (idx === -1 ? "" : S.view) + '" id="glider"></div>';
  PHASES.forEach(function (p, i) {
    var cls = "phase-btn" + (p === S.view ? " active" : "");
    if (p === "review" && S.day && S.day.review.length >= REVIEW_STEPS.length) cls += " done-ph";
    html += '<button class="' + cls + '" data-go="' + p + '"><span class="dot"></span>' + p + "</button>";
  });
  rail.innerHTML = html;
  var g = $("glider");
  if (g && idx !== -1) {
    var w = rail.querySelector(".phase-btn");
    if (w) {
      var bw = w.getBoundingClientRect().width;
      g.style.width = bw + "px";
      g.style.left = (6 + idx * (bw + 6)) + "px";
    }
  }
}
function mount(view, soft, back) {
  var v = $("view"); if (!v) return;
  var R = RAO.render;
  var html = view === "review" ? R.reviewHTML()
    : view === "action" ? R.actionHTML()
    : view === "outcome" ? R.outcomeHTML()
    : view === "settings" ? R.settingsHTML() : "";
  v.innerHTML = html;
  v.className = "";
  void v.offsetWidth;
  v.className = "view-enter" + (back ? " back" : "");
  RAO.bind(view, v);
  var sc = v.querySelector(".stagger"); if (sc) void sc.offsetWidth;
}

/* Enter a view: render it, then fetch its data once. Loaders re-render on
   resolve but never re-trigger loads, so the cycle always terminates. */
function loadFor(view) {
  if (view === "review") { loadBrief(); loadHygiene(); loadDeals(); loadTasks(); }
  else if (view === "action") { loadHygiene(); loadTasks(); loadDeals(); loadOutreach(); }
  else if (view === "outcome") { loadDeals(); loadOutreach(); loadHygiene(); loadTasks(); }
}
function enter(view, soft, back) {
  S.view = view; paintRail(); mount(view, soft, back); loadFor(view);
}

/* ---------- pure render functions (testable) ---------- */
function skeleton(n) {
  var h = "";
  for (var i = 0; i < n; i++) h += '<div class="skeleton sk-line"></div>';
  return h;
}
function offlineCard(what) {
  return '<div class="card offline-card"><h3><span class="accent-r">○</span> ' + what + " unreachable</h3>" +
    "<p>rao couldn't reach " + what + ". Check that it's running, then confirm the URL in Settings.</p>" +
    '<button class="ghost-btn" data-act="go-settings">Open settings</button></div>';
}

function reviewHTML() {
  var h = '<div class="stagger">';
  h += '<span class="phase-tag r">Review</span>';
  h += '<div class="greet">' + greeting() + "</div>";
  h += '<p class="greet-sub">Look at the day before the day looks at you.</p>';

  h += '<div class="split major-left"><div>';

  // brief
  h += '<div class="card"><h3><span class="accent-r">◉</span> Milton\u2019s brief</h3>';
  if (S.brief) h += '<div class="brief-body">' + md(S.brief) + "</div>";
  else if (S.briefErr) h += '<p class="empty-note">Milton is unreachable right now.<br><button class="ghost-btn" data-act="retry-brief" style="margin-top:10px">Retry</button></p>';
  else h += skeleton(4);
  h += "</div>";

  // stats
  var open = openDeals();
  var pipe = open.reduce(function (a, d) { return a + (Number(d.value) || 0); }, 0);
  var due = dueTodayTasks().length, od = overdueTasks().length;
  h += '<div class="stats">' +
    stat(fmtMoney(pipe), "pipeline") + stat(open.length, "open deals") +
    stat(due, "due today") + stat(od, "overdue", od > 0) + "</div>";

  h += '</div><div>';

  // attention (review-phase hygiene)
  h += '<div class="card"><h3><span class="accent-r">◎</span> Needs your eyes</h3>';
  var items = hygItems("review").slice(0, 5);
  if (S.hygErr) h += '<p class="empty-note">Milton couldn\u2019t run the playbook just now.</p>';
  else if (!S.hygiene) h += skeleton(3);
  else if (!items.length) h += '<p class="empty-note">Nothing needs your eyes. Pipeline is clean.</p>';
  else h += items.map(attnRow).join("");
  h += "</div>";

  // guided checklist
  var done = S.day ? S.day.review : [];
  h += '<div class="card"><h3><span class="accent-r">✓</span> Start the day right</h3>';
  h += REVIEW_STEPS.map(function (st) {
    var on = done.indexOf(st.id) !== -1;
    return '<button class="check-row' + (on ? " on" : "") + '" data-check="' + st.id + '">' +
      '<span class="cbox">✓</span><span class="lbl">' + esc(st.label) + "</span></button>";
  }).join("");
  h += "</div>";

  var n = done.length;
  h += '<button class="cta" data-act="begin-action" ' + (n >= REVIEW_STEPS.length ? "" : "disabled") + ">" +
    (n >= REVIEW_STEPS.length ? "Begin action →" : "Begin action <span class=\"n\">" + n + " of " + REVIEW_STEPS.length + "</span>") + "</button>";
  h += "</div></div>";
  return h + "</div>";
}
function stat(v, l, warn) {
  return '<div class="stat' + (warn ? " warn" : "") + '"><b>' + esc(v) + "</b><span>" + esc(l) + "</span></div>";
}
function attnRow(it, i) {
  var sev = /stale|overdue|risk|churn/i.test(it.kind || "") ? "high" : /💡/.test(it.icon || "") ? "low" : "med";
  return '<button class="attn-row" data-attn="' + i + '" data-phase="review">' +
    '<span class="sev ' + sev + '"></span><span class="txt">' + esc(it.text) + '</span><span class="go">→</span></button>';
}

function actionHTML() {
  var h = '<div class="stagger">';
  h += '<span class="phase-tag a">Action</span>';
  h += '<div class="greet">Do the next thing.</div>';
  h += '<p class="greet-sub">One thing at a time. Milton picked the order.</p>';

  h += '<div class="split major-left"><div>';

  // next-up hero
  var next = nextUp();
  var ndeal = next.dealId ? dealById(next.dealId) : null;
  h += '<div class="hero"><div class="kicker">Next up</div><div class="what">' + esc(next.what) + "</div>" +
    (ndeal && ndeal.company_name ? '<div class="co">' + esc(ndeal.company_name) + "</div>" : "") +
    '<div class="why">' + esc(next.why) + '</div><div class="row">' +
    (next.taskId ? '<button class="pill-btn solid" data-done-task="' + next.taskId + '">Done ✓</button>' : "") +
    '<button class="pill-btn" data-log-deal="' + (next.dealId || "") + '">Log outcome</button>' +
    "</div></div>";

  // progress
  var open = S.tasks.filter(function (t) { return !t.done; });
  var doneN = S.tasks.filter(function (t) { return t.done; }).length;
  var total = S.tasks.length;
  var pct = total ? Math.round((doneN / total) * 100) : 0;
  h += '<div class="progress-lbl"><span>Today\u2019s tasks</span><span>' + doneN + " of " + total + "</span></div>" +
    '<div class="progress-line"><i style="width:' + pct + '%"></i></div>';

  // tasks
  h += '<div class="kicker-row"><h2>Tasks</h2><span class="hint">tap to complete</span></div>';
  if (S.tasksErr) h += offlineCard("exec-crm");
  else {
    var od = overdueTasks(), dt = dueTodayTasks().filter(function (t) { return od.indexOf(t) === -1; });
    var rest = S.tasks.filter(function (t) { return !t.done && od.indexOf(t) === -1 && dt.indexOf(t) === -1; });
    var openT = od.map(function (t) { return { t: t, od: true }; })
      .concat(dt.map(function (t) { return { t: t, od: false }; }))
      .concat(rest.map(function (t) { return { t: t, od: false }; }));
    var doneT = S.tasks.filter(function (t) { return t.done; }).slice(0, 5);
    if (!openT.length) h += '<p class="empty-note">No open tasks. Enjoy the quiet — or add one below.</p>';
    h += cappedList("tasks", openT, function (p) { return taskRow(p.t, p.od); });
    if (doneT.length) h += '<div class="kicker-row" style="margin-top:14px"><h2>Done</h2></div>' + doneT.map(function (t) { return taskRow(t, false); }).join("");
    h += '<form class="chat-form" id="quick-add" style="margin-top:10px"><input id="quick-add-in" type="text" placeholder="Add a task for today…" maxlength="200">' +
      '<button class="send-btn" type="submit" aria-label="Add task">+</button></form>';
  }

  h += '</div><div>';

  // milton suggests
  var suggs = hygItems("action").slice(0, 5);
  h += '<div class="kicker-row" style="margin-top:18px"><h2>Milton suggests</h2></div>';
  if (S.hygErr) h += '<p class="empty-note">Suggestions unavailable — Milton is unreachable.</p>';
  else if (!S.hygiene) h += '<div class="card">' + skeleton(3) + "</div>";
  else if (!suggs.length) h += '<p class="empty-note">Nothing suggested. You\u2019re ahead of the playbook.</p>';
  else h += suggs.map(function (s, i) {
    var did = s.ref && s.ref.deal_id ? Number(s.ref.deal_id) : 0;
    var logged = did && touchedTodayDealIds()[did];
    // Deal-less suggestions (e.g. the overdue-tasks card) get no Log button —
    // there's no deal to log an outcome against.
    var btn = did ? (logged ? '<span class="logged-chip">Logged ✓</span>'
                            : '<button class="mini-btn" data-log-deal="' + did + '">Log</button>') : "";
    return '<div class="sugg-row' + (logged ? " logged" : "") + '"><span class="txt">' + esc(s.text) + "</span>" +
      btn + "</div>";
  }).join("");

  h += '<div style="height:16px"></div><button class="cta ghost-cta" data-act="to-outcome">Continue to outcome →</button>';
  h += "</div></div>";
  return h + "</div>";
}
function taskRow(t, overdue) {
  return '<button class="task-row' + (t.done ? " done" : "") + (overdue && !t.done ? " overdue" : "") + '" data-task="' + t.id + '">' +
    '<span class="cbox' + (t.done ? " done-c" : "") + '">✓</span>' +
    '<span class="t-lbl">' + esc(t.title) +
    (t.deal_title ? '<span class="t-meta">' + esc(t.deal_title) + "</span>" : "") +
    (taskDue(t) ? '<span class="t-meta">' + (overdue && !t.done ? "overdue · " : "") + esc(taskDue(t)) + "</span>" : "") +
    "</span></button>";
}
function nextUp() {
  var touched = touchedTodayDealIds();
  var acts = hygItems("action").filter(function (it) {
    var r = it.ref;
    return !(r && r.deal_id && touched[Number(r.deal_id)]);
  });
  for (var i = 0; i < acts.length; i++) {
    var r = acts[i].ref;
    if (r && r.deal_id) {
      return { what: acts[i].text, why: "Milton's playbook flagged this as the highest-leverage touch.", dealId: Number(r.deal_id) || 0, taskId: 0 };
    }
  }
  var od = overdueTasks();
  if (od.length) return { what: od[0].title, why: "It's overdue — clearing it unblocks everything behind it.", dealId: Number(od[0].deal_id) || 0, taskId: od[0].id };
  var dt = dueTodayTasks();
  if (dt.length) return { what: dt[0].title, why: "Due today. Knock it out before it becomes overdue.", dealId: Number(dt[0].deal_id) || 0, taskId: dt[0].id };
  if (acts.length) return { what: acts[0].text, why: "From Milton's playbook.", dealId: 0, taskId: 0 };
  return { what: "Pipeline is clear.", why: "Nothing overdue, nothing due. Pick a deal and move it forward.", dealId: 0, taskId: 0 };
}

function outcomeHTML() {
  if (S.day && S.day.done) return dayCompleteHTML();
  var h = '<div class="stagger">';
  h += '<span class="phase-tag o">Outcome</span>';
  h += '<div class="greet">What came back?</div>';
  h += '<p class="greet-sub">Log what happened. Every outcome teaches Milton what to suggest next.</p>';

  h += '<div class="split"><div>';

  // composer
  var open = openDeals();
  h += '<div class="card"><h3><span class="accent-o">✎</span> Log an outcome</h3>';
  h += '<div class="f-label">Deal</div><div class="deal-pick">';
  if (!open.length) h += '<p class="empty-note">No open deals to log against.</p>';
  h += cappedList("deal-pick", open, function (d) {
    return '<button class="deal-opt' + (S.compose.dealId === d.id ? " on" : "") + '" data-pick-deal="' + d.id + '">' +
      "<span>" + esc(d.title) + "</span><span class=\"v\">" + esc(fmtMoney(d.value)) + "</span></button>";
  }) + "</div>";
  h += '<div class="f-label">Channel</div><div class="chips">' +
    S.channels.map(function (c) {
      return '<button class="chip' + (S.compose.channel === c.value ? " on" : "") + '" data-pick-channel="' + esc(c.value) + '">' + esc(c.label) + "</button>";
    }).join("") + "</div>";
  h += '<div class="f-label">Result</div><div class="chips">' +
    OUTCOMES.map(function (o) {
      return '<button class="chip' + (S.compose.outcome === o ? " on" : "") + '" data-pick-outcome="' + esc(o) + '">' + esc(o) + "</button>";
    }).join("") + "</div>";
  h += '<textarea class="note" id="oc-note" placeholder="What happened? (optional)">' + esc(S.compose.note) + "</textarea>";
  h += '<button class="cta mint" data-act="log-outcome" style="margin-top:12px">Log it</button></div>';

  h += '</div><div>';

  // today timeline
  var t = todayStr();
  var todays = S.outreach.filter(function (o) {
    var when = String(o.happened_at || o.created_at || "").slice(0, 10);
    return when === t;
  });
  h += '<div class="card"><h3><span class="accent-o">◷</span> Today</h3>';
  if (!todays.length) h += '<p class="empty-note">Nothing logged yet today. The first outcome is the hardest.</p>';
  h += cappedList("timeline", todays, function (o) {
    var when = String(o.happened_at || o.created_at || "").slice(11, 16);
    return '<div class="tl-item"><span class="tl-dot"></span><div><div>' +
      (o.deal_title ? "<strong>" + esc(o.deal_title) + "</strong> · " : "") + esc(channelLabel(o.channel)) +
      (o.outcome ? ' <span class="oc">' + esc(o.outcome) + "</span>" : "") +
      (o.note ? "<div>" + esc(o.note) + "</div>" : "") + '</div><div class="t">' + esc(when) + "</div></div></div>";
  }) + "</div>";

  // deal stepper
  h += '<div class="card"><h3><span class="accent-o">⇄</span> Move a deal</h3>';
  if (!open.length) h += '<p class="empty-note">No open deals.</p>';
  h += open.slice(0, 8).map(function (d) {
    var si = S.stages.indexOf(d.stage);
    return '<div class="deal-row"><div class="nm">' + esc(d.title) +
      '<span class="stg">' + esc(stageLabel(d.stage)) + "</span></div>" +
      '<button class="step-btn" data-stage="prev" data-deal="' + d.id + '" ' + (si <= 0 ? "disabled" : "") + ' aria-label="Move back">‹</button>' +
      '<button class="step-btn" data-stage="next" data-deal="' + d.id + '" ' + (si < 0 || si >= S.stages.length - 1 ? "disabled" : "") + ' aria-label="Move forward">›</button></div>';
  }).join("") + "</div>";

  // milton's read (outcome-phase hygiene)
  var reads = hygItems("outcome").slice(0, 4);
  h += '<div class="card"><h3><span class="accent-o">◉</span> Milton\u2019s read</h3>';
  if (S.hygErr) h += '<p class="empty-note">Milton is unreachable.</p>';
  else if (!S.hygiene) h += skeleton(3);
  else if (!reads.length) h += '<p class="empty-note">Outcomes look healthy. Keep the rhythm.</p>';
  else h += reads.map(function (r) {
    return '<div class="tl-item"><span class="tl-dot"></span><div>' + esc(r.text) + "</div></div>";
  }).join("");
  h += "</div>";

  // wrap
  h += "</div></div>";
  h += '<button class="cta mint" data-act="wrap-day">Wrap the day →</button>';
  return h + "</div>";
}
function channelLabel(v) {
  for (var i = 0; i < S.channels.length; i++) if (S.channels[i].value === v) return S.channels[i].label;
  return String(v || "").replace(/_/g, " ");
}

function settingsHTML() {
  var s = S.settings || {};
  var h = '<div class="stagger">';
  h += '<button class="ghost-btn" data-act="back" style="margin-bottom:14px">‹ Back</button>';
  h += '<div class="greet">Settings</div><p class="greet-sub">The only screen that isn\u2019t Review, Action, or Outcome.</p>';
  h += '<div class="split"><div>';
  h += '<div class="card"><h3>Connections</h3>' +
    '<div class="conn" id="conn-crm"><span class="pip"></span>exec-crm — checking…</div>' +
    '<div class="conn" id="conn-milton"><span class="pip"></span>Milton — checking…</div></div>';
  h += '</div><div>';
  h += '<div class="card"><h3>Setup</h3>' +
    setField("exec_crm_url", "exec-crm URL", s.exec_crm_url) +
    setField("milton_url", "Milton URL", s.milton_url) +
    setField("workspace_id", "Workspace ID", s.workspace_id, "e.g. 1 — blank for default") +
    setField("display_name", "Your name", s.display_name, "for greetings") +
    '<div class="toggle-row"><span>Reduce motion</span><button class="switch' + (s.reduce_motion === "1" ? " on" : "") + '" data-act="toggle-motion" aria-label="Reduce motion"></button></div>' +
    '<div class="toggle-row"><span>Theme</span><div class="seg" role="group" aria-label="Theme">' +
    [["auto", "Auto"], ["light", "Light"], ["dark", "Dark"]].map(function (o) {
      return '<button class="' + ((s.theme || "auto") === o[0] ? "on" : "") + '" data-act="set-theme" data-theme-val="' + o[0] + '">' + o[1] + "</button>";
    }).join("") + "</div></div>" +
    "</div>";
  h += '</div></div>';
  h += '<button class="cta" data-act="save-settings">Save settings</button>';
  h += '<div style="height:14px"></div><button class="ghost-btn danger" data-act="fresh-day">Start a fresh day</button>';
  return h + "</div>";
}
function setField(k, label, val, ph) {
  return '<div class="set-row"><label for="set-' + k + '">' + esc(label) + "</label>" +
    '<input class="text-in" id="set-' + k + '" data-set="' + k + '" value="' + esc(val || "") + '"' +
    (ph ? ' placeholder="' + esc(ph) + '"' : "") + "></div>";
}

/* The finished day lives inside Outcome — never as its own screen. */
function dayCompleteHTML() {
  var t = todayStr();
  var tasks = S.tasks.filter(function (x) { return x.done; }).length;
  var outcomes = S.outreach.filter(function (o) {
    return String(o.happened_at || o.created_at || "").slice(0, 10) === t;
  }).length;
  var h = '<div class="stagger">';
  h += '<span class="phase-tag o">Outcome</span>';
  h += '<div class="greet">Day complete.</div>';
  h += '<p class="greet-sub">You did the loop: reviewed, acted, logged. Milton will have a fresh brief in the morning.</p>';
  h += '<div class="card"><div class="wrap-stats">' +
    stat(tasks, "tasks done") + stat(outcomes, "outcomes logged") + stat(openDeals().length, "open deals") +
    "</div></div>";
  h += '<button class="cta ghost-cta" data-act="reopen-day">Reopen the day</button>';
  h += '<div style="height:10px"></div><button class="ghost-btn" data-act="fresh-day">Start a fresh day</button>';
  return h + "</div>";
}

/* ---------- event binding ---------- */
function bind(view, root) {
  /* onTap is delegated once at the document level in boot() — attaching it
     per mount stacked duplicate handlers on #view (a second toggle-motion
     tap, for example, flipped the value back and looked dead). */
  if (view === "settings") { checkHealth(); }
  var qa = root.querySelector("#quick-add");
  if (qa) qa.addEventListener("submit", function (e) {
    e.preventDefault();
    var inp = root.querySelector("#quick-add-in");
    var title = inp.value.trim();
    if (!title) return;
    api("/api/crm/tasks", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: title, due_date: todayStr() }),
    }).then(function (res) {
      if (res.status === 201 || res.status === 200) { toast("Task added"); loadTasks(); }
      else toast("Couldn't add the task");
    });
  });
  var note = root.querySelector("#oc-note");
  if (note) note.addEventListener("input", function () { S.compose.note = note.value; });
}
function onTap(e) {
  var t = e.target.closest("[data-go],[data-act],[data-check],[data-task],[data-done-task],[data-log-deal],[data-pick-deal],[data-pick-channel],[data-pick-outcome],[data-stage],[data-attn],[data-send]");
  if (!t) return;
  if (t.hasAttribute("data-send")) { sendChat(t.getAttribute("data-send")); return; }
  if (t.hasAttribute("data-go")) { var dest = t.getAttribute("data-go"); go(dest, PHASES.indexOf(dest) < PHASES.indexOf(S.view)); return; }
  if (t.hasAttribute("data-check")) { toggleCheck(t.getAttribute("data-check")); return; }
  if (t.hasAttribute("data-task")) { toggleTask(Number(t.getAttribute("data-task"))); return; }
  if (t.hasAttribute("data-done-task")) { toggleTask(Number(t.getAttribute("data-done-task"))); return; }
  if (t.hasAttribute("data-log-deal")) {
    var did = Number(t.getAttribute("data-log-deal")) || null;
    if (did) S.compose.dealId = did;
    go("outcome"); return;
  }
  if (t.hasAttribute("data-pick-deal")) { S.compose.dealId = Number(t.getAttribute("data-pick-deal")); mount("outcome", true); return; }
  if (t.hasAttribute("data-pick-channel")) { S.compose.channel = t.getAttribute("data-pick-channel"); mount("outcome", true); return; }
  if (t.hasAttribute("data-pick-outcome")) { S.compose.outcome = t.getAttribute("data-pick-outcome"); mount("outcome", true); return; }
  if (t.hasAttribute("data-stage")) { moveDeal(Number(t.getAttribute("data-deal")), t.getAttribute("data-stage")); return; }
  if (t.hasAttribute("data-attn")) {
    var items = hygItems("review");
    var it = items[Number(t.getAttribute("data-attn"))];
    if (it && it.ref && it.ref.deal_id) S.compose.dealId = it.ref.deal_id;
    go("action"); return;
  }
  var act = t.getAttribute("data-act");
  if (!act) return;
  if (act === "begin-action") go("action");
  else if (act === "go-settings") { enter("settings"); }
  else if (act === "back") { enter(S.day.phase); }
  else if (act === "retry-brief") { S.briefErr = false; S.brief = null; loadBrief(); }
  else if (act === "toggle-motion") {
    var on = !(S.settings.reduce_motion === "1");
    S.settings.reduce_motion = on ? "1" : "0";
    document.body.classList.toggle("reduce-motion", on);
    t.classList.toggle("on", on);
    api("/api/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reduce_motion: S.settings.reduce_motion }) });
  }
  else if (act === "set-theme") {
    var tv = t.getAttribute("data-theme-val") || "auto";
    S.settings.theme = tv;
    applyTheme();
    var seg = t.parentElement;
    if (seg && seg.querySelectorAll) Array.prototype.forEach.call(seg.querySelectorAll("button"), function (b) {
      b.classList.toggle("on", b.getAttribute("data-theme-val") === tv);
    });
    api("/api/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ theme: tv }) });
  }
  else if (act === "save-settings") saveSettings();
  else if (act === "fresh-day") freshDay();
  else if (act === "log-outcome") logOutcome();
  else if (act === "expand-list") { S.ui.expanded[t.getAttribute("data-list")] = true; render(); }
  else if (act === "wrap-day") wrapDay();
  else if (act === "finish-day") finishDay();
  else if (act === "to-outcome") go("outcome");
  else if (act === "reopen-day") reopenDay();
}
function toggleCheck(id) {
  var done = S.day.review.slice();
  var i = done.indexOf(id);
  if (i === -1) done.push(id); else done.splice(i, 1);
  api("/api/day", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ review: done }),
  }).then(function () { S.day.review = done; paintRail(); mount("review", true); });
}
function toggleTask(id) {
  api("/api/crm/tasks/" + id + "/toggle", { method: "POST" }).then(function (res) {
    if (res.status === 200) { toast("Nice."); loadTasks(); }
    else toast("Couldn't update the task");
  });
}
function moveDeal(id, dir) {
  var d = dealById(id); if (!d) return;
  var si = S.stages.indexOf(d.stage);
  var ni = dir === "next" ? si + 1 : si - 1;
  if (ni < 0 || ni >= S.stages.length) return;
  api("/api/crm/deals/" + id, {
    method: "PATCH", headers: { "content-type": "application/json" },
    body: JSON.stringify({ stage: S.stages[ni] }),
  }).then(function (res) {
    if (res.status === 200) { toast("Moved to " + stageLabel(S.stages[ni])); loadDeals(); }
    else toast("Couldn't move the deal");
  });
}
function logOutcome() {
  if (!S.compose.dealId) { toast("Pick a deal first"); return; }
  if (!S.compose.outcome) { toast("Pick a result first"); return; }
  var noteEl = document.querySelector("#oc-note");
  var note = noteEl ? noteEl.value : S.compose.note;
  api("/api/crm/outreach", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      deal_id: S.compose.dealId, channel: S.compose.channel,
      outcome: S.compose.outcome, note: note,
      happened_at: nowLocal(),
    }),
  }).then(function (res) {
    if (res.status === 200 || res.status === 201) {
      toast("Logged. Onward.");
      S.compose = { dealId: null, channel: S.channels.length ? S.channels[0].value : "call", outcome: "", note: "" };
      loadOutreach();
    } else toast("Couldn't log that");
  });
}
function wrapDay() {
  var t = todayStr();
  var tasks = S.tasks.filter(function (x) { return x.done; }).length;
  var outcomes = S.outreach.filter(function (o) {
    return String(o.happened_at || o.created_at || "").slice(0, 10) === t;
  }).length;
  S.wrap = { tasks: tasks, outcomes: outcomes, deals: 0 };
  var v = $("view");
  v.innerHTML = '<div class="stagger"><span class="phase-tag o">Outcome</span>' +
    '<div class="greet">Day in review.</div><p class="greet-sub">Here\u2019s what the loop produced today.</p>' +
    '<div class="card"><div class="wrap-stats">' +
    stat(tasks, "tasks done") + stat(outcomes, "outcomes logged") + stat(S.wrap.deals, "deals moved") +
    "</div>" +
    '<p class="greet-sub">Milton will brief you fresh in the morning. Anything left over rolls into tomorrow\u2019s Review.</p></div>' +
    '<button class="cta mint" data-act="finish-day">Finish the day ✓</button> ' +
    '<div style="height:10px"></div><button class="ghost-btn" data-act="back">Keep working</button></div>';
  v.className = "view-enter";
  /* click handling is delegated once at the document level (see boot) */
}
function finishDay() {
  api("/api/day", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ done: true }),
  }).then(function () {
    S.day.done = true; S.view = "outcome"; paintRail(); mount("outcome");
  });
}
function reopenDay() {
  api("/api/day", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ done: false }),
  }).then(function () { S.day.done = false; enter("outcome"); });
}
function freshDay() {
  api("/api/day/reset", { method: "POST" }).then(function (res) {
    if (res.status === 200) {
      S.day = res.body.day;
      S.brief = null; S.briefErr = false; S.hygiene = null; S.hygErr = false;
      S.compose = { dealId: null, channel: "call", outcome: "", note: "" };
      enter("review");
      toast("Fresh day. Fresh loop.");
    }
  });
}
function saveSettings() {
  var body = {};
  document.querySelectorAll("[data-set]").forEach(function (inp) { body[inp.getAttribute("data-set")] = inp.value; });
  api("/api/settings", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }).then(function (res) {
    if (res.status === 200) {
      S.settings = res.body.settings;
      S.brief = null; S.briefErr = false; S.hygiene = null; S.hygErr = false;
      toast("Settings saved"); checkHealth(); mount("settings", true);
    } else toast(res.body.error || "Couldn't save");
  });
}
function checkHealth() {
  api("/api/health").then(function (res) {
    if (res.status !== 200) return;
    var c = $("conn-crm"), m = $("conn-milton");
    if (c) { c.classList.add(res.body.crm ? "ok" : "bad"); c.innerHTML = '<span class="pip"></span>exec-crm — ' + (res.body.crm ? "connected" : "unreachable"); }
    if (m) { m.classList.add(res.body.milton ? "ok" : "bad"); m.innerHTML = '<span class="pip"></span>Milton — ' + (res.body.milton ? "connected" : "unreachable"); }
  });
}

/* ---------- milton chat dock ---------- */
function toggleSheet(open) {
  S.chatOpen = open === undefined ? !S.chatOpen : open;
  $("milton-sheet").classList.toggle("show", S.chatOpen);
  $("sheet-scrim").classList.toggle("show", S.chatOpen);
  if (S.chatOpen) setTimeout(function () { var i = $("chat-input"); if (i) i.focus(); }, 350);
}
/* Milton reply cards — mirrors exec-crm's dock: numbered options and confirm
   buttons send their payload back as the next message; entity cards render
   title/stats/items. Unknown shapes degrade to their text. */
function miltonCardsHtml(cards) {
  return (cards || []).map(miltonCardHtml).join("");
}
function miltonCardHtml(c) {
  c = c || {};
  var h = '<div class="mcard">';
  if (c.title) h += '<div class="mcard-title">' + esc(c.title) + "</div>";
  (c.stats || []).forEach(function (s) {
    h += '<div class="mstat"><span>' + esc(s.label) + "</span><b>" + esc(s.value) + "</b></div>";
  });
  (c.options || []).forEach(function (o) {
    h += '<button class="mopt" data-send="' + esc(String(o.n != null ? o.n : o.label)) + '"><b>' +
      esc(String(o.n != null ? o.n : "•")) + '.</b> ' + esc(o.label) +
      (o.sub ? ' <span class="sub">' + esc(o.sub) + "</span>" : "") + "</button>";
  });
  (c.items || []).forEach(function (it) {
    if (c.kind === "suggestions") {
      // "Did you mean…" command suggestions: tappable buttons that send the
      // example command ("/"-prefixed, like the suggestion chips — Milton's
      // parser strips the slash). Name + description; usage is the payload.
      var cmd = it.usage || it.name || "";
      var cmdLabel = it.name || it.label || it.title || cmd;
      if (cmd) h += '<button class="mopt" data-send="/' + esc(cmd) + '"><b>›</b> ' + esc(cmdLabel) +
        (it.description ? ' <span class="sub">' + esc(it.description) + "</span>" : "") + "</button>";
      return;
    }
    var label = it.title || it.name || it.label || it.text || "";
    var sub = it.sub || ((it.stage || it.value != null)
      ? (it.stage || "") + (it.value != null ? " · " + fmtMoney(it.value) : "") : "");
    if (label) h += '<div class="mitem">• ' + esc(String(label)) +
      (sub ? ' <span class="sub">' + esc(String(sub)) + "</span>" : "") + "</div>";
  });
  (c.rows || []).forEach(function (r) { h += miltonRowHtml(r); });
  if (c.ocrText) h += '<pre class="mocr">' + esc(c.ocrText) + "</pre>";
  return h + "</div>";
}
/* A card row can be a string, an array of cells, or an object (e.g. Milton's
   pipeline-by-stage rows: { label, count, value }). Objects never render as
   "[object Object]": label/count/value shapes become stat rows, anything else
   joins its scalar fields. */
function miltonRowHtml(r) {
  if (Array.isArray(r)) return '<div class="mitem">• ' + esc(r.join(" · ")) + "</div>";
  if (r && typeof r === "object") {
    var label = r.label || r.title || r.name || "";
    var val = [];
    if (r.count != null && r.count !== "") val.push(String(r.count));
    if (r.value != null && r.value !== "") val.push(fmtMoney(r.value));
    if (label || val.length) {
      return '<div class="mstat"><span>' + esc(label || "—") + "</span><b>" + esc(val.join(" · ")) + "</b></div>";
    }
    var parts = [];
    for (var k in r) { var v = r[k]; if (v != null && typeof v !== "object") parts.push(String(v)); }
    return '<div class="mitem">• ' + esc(parts.join(" · ") || JSON.stringify(r)) + "</div>";
  }
  return '<div class="mitem">• ' + esc(String(r)) + "</div>";
}
function paintChips(chips) {
  var el = $("chat-chips"); if (!el) return;
  el.innerHTML = (chips || []).map(function (c) {
    return '<button class="mchip" data-send="' + esc(c) + '">' + esc(c) + "</button>";
  }).join("");
}
function pushMsg(role, text, cards) {
  S.chat.push({ role: role, text: text, cards: cards || null });
  var log = $("chat-log"); if (!log) return;
  var div = document.createElement("div");
  div.className = "msg " + role;
  div.innerHTML = md(text) + miltonCardsHtml(cards);
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}
function sendChat(text) {
  text = String(text || "").trim();
  if (!text) return;
  if (!S.chatOpen) toggleSheet(true);
  pushMsg("user", text);
  paintChips([]);
  var log = $("chat-log");
  var typing = document.createElement("div");
  typing.className = "msg milton typing"; typing.innerHTML = "<i></i><i></i><i></i>";
  log.appendChild(typing); log.scrollTop = log.scrollHeight;
  api("/api/milton/chat", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: text }),
  }).then(function (res) {
    typing.remove();
    if (res.status === 200 && res.body.text) {
      pushMsg("milton", res.body.text, res.body.cards);
      paintChips(res.body.chips);
    }
    else pushMsg("milton", "Milton is unreachable right now — check Settings, then try again.");
  });
}

/* ---------- boot ---------- */
function boot() {
  var dl = $("date-line");
  if (dl) dl.textContent = new Date().toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  api("/api/state").then(function (res) {
    if (res.status !== 200) {
      $("view").innerHTML = '<div class="card offline-card"><h3>Couldn\u2019t start</h3><p>rao couldn\u2019t load its own state. Is the server running?</p><button class="ghost-btn" onclick="location.reload()">Retry</button></div>';
      return;
    }
    S.settings = res.body.settings; S.day = res.body.day;
    document.body.classList.toggle("reduce-motion", S.settings.reduce_motion === "1");
    applyTheme();
    if (S.day.done) { S.view = "outcome"; } /* finished day stays in Outcome */
    else { S.view = S.day.phase; }
    enter(S.view);
    if (S.chat.length === 0) S.chat.push({ role: "milton", text: "I'm Milton — I run the logic under this whole loop. Ask me anything, any time." }),
      renderChatSeed();
  });
  $("milton-fab").addEventListener("click", function () { toggleSheet(); });
  /* one delegated tap handler for the whole app — the topbar (settings gear)
     lives outside #view, so per-view binding never reached it. */
  document.addEventListener("click", onTap);
  $("sheet-close").addEventListener("click", function () { toggleSheet(false); });
  $("sheet-scrim").addEventListener("click", function () { toggleSheet(false); });
  $("chat-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var inp = $("chat-input");
    var v = inp.value.trim();
    if (!v) return;
    inp.value = "";
    sendChat(v);
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && S.chatOpen) toggleSheet(false);
  });
}
function renderChatSeed() {
  var log = $("chat-log"); if (!log) return;
  log.innerHTML = "";
  var lastChips = null;
  S.chat.forEach(function (m) {
    var div = document.createElement("div");
    div.className = "msg " + m.role; div.innerHTML = md(m.text) + miltonCardsHtml(m.cards);
    log.appendChild(div);
    if (m.chips) lastChips = m.chips;
  });
  paintChips(lastChips);
}

var RAO = {
  state: S, PHASES: PHASES, REVIEW_STEPS: REVIEW_STEPS,
  render: {
    reviewHTML: reviewHTML, actionHTML: actionHTML, outcomeHTML: outcomeHTML,
    settingsHTML: settingsHTML, dayCompleteHTML: dayCompleteHTML,
  },
  bind: bind, go: go, mount: mount, paintRail: paintRail, enter: enter,
  toggleCheck: toggleCheck, nextUp: nextUp, hygItems: hygItems,
  toggleSheet: toggleSheet, sendChat: sendChat, boot: boot, onTap: onTap,
  miltonCardHtml: miltonCardHtml, paintChips: paintChips,
  logOutcome: logOutcome, touchedTodayDealIds: touchedTodayDealIds,
  todayStr: todayStr, nowLocal: nowLocal, applyTheme: applyTheme,
  cappedList: cappedList, LIST_CAP: LIST_CAP, dealById: dealById,
};
if (typeof window !== "undefined") window.RAO = RAO;
if (typeof module !== "undefined" && module.exports) module.exports = RAO;

if (typeof document !== "undefined" && document.getElementById("app")) {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
}
})();
