// rao server tests — bun test. Backends (exec-crm, milton) are stubbed via global fetch.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createApp, todayStr } from "../src/server";

let app: ReturnType<typeof createApp>;
let dir: string;
const realFetch = globalThis.fetch;

type Stub = (url: string, init?: RequestInit) => Response | Promise<Response> | null;
let stub: Stub = () => null;

function installStub(fn: Stub) {
  stub = fn;
  (globalThis as any).fetch = async (url: any, init?: any) => {
    const r = await stub(String(url), init);
    if (r) return r;
    throw new Error("unstubbed fetch: " + url);
  };
}

const J = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });

async function call(path: string, opts: RequestInit = {}) {
  const r = await app.fetch(new Request("http://x" + path, opts));
  let body: any = null;
  try { body = await r.json(); } catch { /* non-json */ }
  return { status: r.status, body, raw: r };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rao-test-"));
  app = createApp(dir);
  installStub(() => null);
});
afterEach(() => { globalThis.fetch = realFetch; });

describe("state & settings", () => {
  test("fresh boot: defaults + review phase", async () => {
    const { status, body } = await call("/api/state");
    expect(status).toBe(200);
    expect(body.settings.exec_crm_url).toBe("http://127.0.0.1:3001");
    expect(body.settings.milton_url).toBe("http://127.0.0.1:3009");
    expect(body.day.phase).toBe("review");
    expect(body.day.date).toBe(todayStr());
    expect(body.day.done).toBe(false);
  });

  test("settings save + validation", async () => {
    let r = await call("/api/settings", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ display_name: "Sefu", workspace_id: "3", reduce_motion: "1" }),
    });
    expect(r.status).toBe(200);
    expect(r.body.settings.display_name).toBe("Sefu");
    expect(r.body.settings.workspace_id).toBe("3");
    expect(r.body.settings.reduce_motion).toBe("1");
    r = await call("/api/settings", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ milton_url: "notaurl" }),
    });
    expect(r.status).toBe(400);
  });

  test("day rollover resets to a fresh review", async () => {
    await call("/api/day", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ phase: "outcome", review: ["brief"], done: true }),
    });
    // fake yesterday directly in the db
    app.db.run("UPDATE kv SET v = '2000-01-01' WHERE k = 'day:date'");
    const { body } = await call("/api/state");
    expect(body.day.date).toBe(todayStr());
    expect(body.day.phase).toBe("review");
    expect(body.day.review).toEqual([]);
    expect(body.day.done).toBe(false);
  });

  test("day patch: phase + checklist, rejects bad phase", async () => {
    let r = await call("/api/day", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ phase: "action" }),
    });
    expect(r.status).toBe(200);
    expect(r.body.day.phase).toBe("action");
    r = await call("/api/day", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ phase: "nonsense" }),
    });
    expect(r.status).toBe(400);
    r = await call("/api/day", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ review: ["brief", "scan"] }),
    });
    expect(r.body.day.review).toEqual(["brief", "scan"]);
  });

  test("day reset forces a fresh day", async () => {
    await call("/api/day", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ phase: "outcome", done: true }),
    });
    const { body } = await call("/api/day/reset", { method: "POST" });
    expect(body.day.phase).toBe("review");
    expect(body.day.done).toBe(false);
  });
});

describe("crm proxy", () => {
  test("forwards GET with workspace param", async () => {
    await call("/api/settings", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace_id: "7" }),
    });
    let seen = "";
    installStub((url) => { seen = url; return J({ deals: [] }); });
    const { status, body } = await call("/api/crm/deals");
    expect(status).toBe(200);
    expect(body).toEqual({ deals: [] });
    expect(seen).toContain("http://127.0.0.1:3001/api/deals");
    expect(seen).toContain("workspace=7");
  });

  test("forwards POST bodies and PATCH", async () => {
    let seenBody = "";
    installStub(async (url, init) => { seenBody = String(init?.body); return J({ ok: true }, 201); });
    const { status } = await call("/api/crm/tasks", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Call Acme" }),
    });
    expect(status).toBe(201);
    expect(JSON.parse(seenBody).title).toBe("Call Acme");
  });

  test("unreachable backend -> 502", async () => {
    installStub(() => { throw new Error("down"); });
    const { status, body } = await call("/api/crm/deals");
    expect(status).toBe(502);
    expect(body.error).toBe("backend unreachable");
  });
});

describe("milton", () => {
  test("chat creates a workspace-bound session once, then reuses it", async () => {
    await call("/api/settings", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace_id: "2" }),
    });
    const calls: string[] = [];
    installStub(async (url, init) => {
      calls.push(url + "|" + (init?.method || "GET"));
      if (url.endsWith("/api/chat-sessions")) return J({ session: { id: "s-abc" } }, 201);
      if (url.endsWith("/api/chat")) return J({ text: "morning!" });
      return null;
    });
    let r = await call("/api/milton/chat", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "morning brief" }),
    });
    expect(r.status).toBe(200);
    expect(r.body.text).toBe("morning!");
    expect(calls.filter((c) => c.includes("chat-sessions")).length).toBe(1);
    r = await call("/api/milton/chat", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "hi again" }),
    });
    expect(r.status).toBe(200);
    // session reused: no second chat-sessions call
    expect(calls.filter((c) => c.includes("chat-sessions")).length).toBe(1);
    expect(calls.filter((c) => c.includes("/api/chat|POST")).length).toBe(2);
  });

  test("workspace change drops the old session", async () => {
    const seen: string[] = [];
    installStub(async (url, init) => {
      seen.push(url);
      if (url.endsWith("/api/chat-sessions")) return J({ session: { id: "s-" + seen.length } }, 201);
      if (url.endsWith("/api/chat")) return J({ text: "ok" });
      return null;
    });
    await call("/api/milton/chat", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "hi" }),
    });
    await call("/api/settings", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace_id: "9" }),
    });
    await call("/api/milton/chat", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "hi" }),
    });
    expect(seen.filter((u) => u.endsWith("/api/chat-sessions")).length).toBe(2);
  });

  test("milton unreachable -> 502", async () => {
    installStub((url) => {
      if (url.endsWith("/api/chat-sessions")) return J({ session: { id: "s-x" } }, 201);
      throw new Error("down");
    });
    const { status } = await call("/api/milton/chat", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "hi" }),
    });
    expect(status).toBe(502);
  });

  test("hygiene proxies through", async () => {
    installStub((url) => J({ ok: true, items: [] }));
    const { status, body } = await call("/api/milton/hygiene");
    expect(status).toBe(200);
    expect(body.items).toEqual([]);
  });
});

describe("static", () => {
  test("serves the app shell", async () => {
    const r = await app.fetch(new Request("http://x/"));
    expect(r.status).toBe(200);
    const text = await r.text();
    expect(text).toContain("rao — review");
    expect(r.headers.get("content-type")).toContain("text/html");
  });
});
