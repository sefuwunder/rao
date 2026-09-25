// rao smoke — fresh boot over real HTTP against stubbed exec-crm + milton.
import { rmSync, existsSync } from "fs";
import { join } from "path";

const DIR = join(import.meta.dir, "..");
const RAO_PORT = 3110, CRM_PORT = 3111, MILTON_PORT = 3112;

// ---- stub exec-crm ----
const crm = Bun.serve({
  port: CRM_PORT,
  fetch(req) {
    const u = new URL(req.url);
    const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });
    if (u.pathname === "/api/deals") return J({ deals: [{ id: 5, title: "Acme", stage: "negotiation", value: 50000 }], stages: ["discovery", "negotiation", "won"], labels: {} });
    if (u.pathname === "/api/tasks") return J({ tasks: [{ id: 1, title: "Call Acme", due_date: "2026-09-24", done: false }] });
    if (u.pathname === "/api/tasks/1/toggle" && req.method === "POST") return J({ ok: true, done: true });
    if (u.pathname === "/api/outreach" && req.method === "POST") return J({ ok: true }, 201);
    if (u.pathname === "/api/deals/5" && req.method === "PATCH") return J({ ok: true });
    if (u.pathname === "/api/outreach") return J({ outreach: [], channels: [{ value: "call", label: "Call" }] });
    if (u.pathname === "/") return new Response("crm ok");
    return J({ error: "nope" }, 404);
  },
});

// ---- stub milton ----
const milton = Bun.serve({
  port: MILTON_PORT,
  fetch(req) {
    const u = new URL(req.url);
    const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });
    if (u.pathname === "/api/chat-sessions" && req.method === "POST") return J({ session: { id: "s-smoke" } }, 201);
    if (u.pathname === "/api/chat" && req.method === "POST") return J({ text: "**Morning brief.** 1 deal needs you." });
    if (u.pathname === "/api/hygiene") return J({ items: [{ text: "Acme stale", kind: "stale", phase: "review" }] });
    if (u.pathname === "/") return new Response("milton ok");
    return J({ error: "nope" }, 404);
  },
});

// fresh data dir
rmSync(join(DIR, "data"), { recursive: true, force: true });

const proc = Bun.spawn(["bun", "src/server.ts"], {
  cwd: DIR,
  env: { ...process.env, RAO_PORT: String(RAO_PORT) },
  stdout: "ignore", stderr: "ignore",
});
async function waitUp() {
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(`http://127.0.0.1:${RAO_PORT}/api/state`); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("rao never came up");
}

let n = 0, fails = 0;
async function check(name, fn) {
  n++;
  try { await fn(); console.log("ok " + n + " - " + name); }
  catch (e) { fails++; console.log("FAIL " + n + " - " + name + ": " + e.message); }
}
const J = (o) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(o) });
const eq = (a, b, m) => { if (a !== b) throw new Error(m + " (got " + JSON.stringify(a) + ")"); };

try {
  await waitUp();
  await check("fresh boot creates data dir", () => {
    if (!existsSync(join(DIR, "data", "rao.db"))) throw new Error("no db");
  });
  // point rao at the stubs
  await fetch(`http://127.0.0.1:${RAO_PORT}/api/settings`, J({ exec_crm_url: `http://127.0.0.1:${CRM_PORT}`, milton_url: `http://127.0.0.1:${MILTON_PORT}` }));

  await check("state", async () => {
    const r = await (await fetch(`http://127.0.0.1:${RAO_PORT}/api/state`)).json();
    eq(r.day.phase, "review", "starts in review");
  });
  await check("milton brief", async () => {
    const r = await fetch(`http://127.0.0.1:${RAO_PORT}/api/milton/chat`, J({ message: "morning brief" }));
    const b = await r.json();
    eq(r.status, 200, "status"); eq(b.text.includes("Morning brief"), true, "brief text");
  });
  await check("milton hygiene", async () => {
    const b = await (await fetch(`http://127.0.0.1:${RAO_PORT}/api/milton/hygiene`)).json();
    eq(b.items.length, 1, "one item");
  });
  await check("deals", async () => {
    const b = await (await fetch(`http://127.0.0.1:${RAO_PORT}/api/crm/deals`)).json();
    eq(b.deals[0].title, "Acme", "deal proxied");
  });
  await check("task toggle (empty POST body)", async () => {
    const r = await fetch(`http://127.0.0.1:${RAO_PORT}/api/crm/tasks/1/toggle`, { method: "POST" });
    eq(r.status, 200, "status");
  });
  await check("outreach POST", async () => {
    const r = await fetch(`http://127.0.0.1:${RAO_PORT}/api/crm/outreach`, J({ deal_id: 5, channel: "call", outcome: "Connected" }));
    eq(r.status, 201, "status");
  });
  await check("stage PATCH", async () => {
    const r = await fetch(`http://127.0.0.1:${RAO_PORT}/api/crm/deals/5`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ stage: "won" }) });
    eq(r.status, 200, "status");
  });
  await check("phase update + finish day", async () => {
    let b = await (await fetch(`http://127.0.0.1:${RAO_PORT}/api/day`, J({ phase: "outcome" }))).json();
    eq(b.day.phase, "outcome", "phase persisted");
    b = await (await fetch(`http://127.0.0.1:${RAO_PORT}/api/day`, J({ done: true }))).json();
    eq(b.day.done, true, "done persisted");
    const st = await (await fetch(`http://127.0.0.1:${RAO_PORT}/api/state`)).json();
    eq(st.day.phase, "outcome", "finished day stays in the outcome phase server-side");
  });
  await check("static shell", async () => {
    const r = await fetch(`http://127.0.0.1:${RAO_PORT}/`);
    const t = await r.text();
    eq(r.status, 200, "status");
    if (!t.includes('id="app"')) throw new Error("no app shell");
  });
} finally {
  proc.kill(); crm.stop(); milton.stop();
  await new Promise((r) => setTimeout(r, 300));
  rmSync(join(DIR, "data"), { recursive: true, force: true });
}

console.log(fails ? `\nsmoke: ${n - fails}/${n} passed, ${fails} FAILED` : `\nsmoke: ${n}/${n} passed`);
process.exit(fails ? 1 : 0);
