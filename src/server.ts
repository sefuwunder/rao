// rao — Review · Action · Outcome. A tight, mobile-first CRM shell.
// Milton is the logic engine (brief, hygiene, suggestions, chat);
// exec-crm is the system of record (deals, tasks, contacts, outreach).
// Every user-facing screen outside Settings belongs to one R.A.O. phase.
import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";

export const PORT = Number(process.env.RAO_PORT || 3010);
export const PHASES = ["review", "action", "outcome"] as const;
export type Phase = (typeof PHASES)[number];

export interface DayState {
  date: string; // local YYYY-MM-DD
  phase: Phase;
  review: string[]; // checked review-step ids
  done: boolean;
}

const DEFAULTS: Record<string, string> = {
  exec_crm_url: "http://127.0.0.1:3001",
  milton_url: "http://127.0.0.1:3009",
  workspace_id: "",
  display_name: "",
  reduce_motion: "0",
};

export function todayStr(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function createApp(dataDir?: string) {
  const dir = dataDir || join(import.meta.dir, "..", "data");
  mkdirSync(dir, { recursive: true });
  const db = new Database(join(dir, "rao.db"));
  db.run("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)");

  const get = (k: string): string | null => {
    const r = db.query("SELECT v FROM kv WHERE k = ?").get(k) as { v: string } | null;
    return r ? r.v : null;
  };
  const set = (k: string, v: string) => {
    db.run("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", k, v);
  };

  const settings = (): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const k of Object.keys(DEFAULTS)) out[k] = get("s:" + k) ?? DEFAULTS[k];
    return out;
  };

  function dayState(): DayState {
    const today = todayStr();
    const stored = get("day:date");
    if (stored !== today) {
      const fresh: DayState = { date: today, phase: "review", review: [], done: false };
      set("day:date", today);
      set("day:phase", fresh.phase);
      set("day:review", "[]");
      set("day:done", "0");
      return fresh;
    }
    const phase = get("day:phase");
    return {
      date: today,
      phase: (PHASES as readonly string[]).includes(phase || "") ? (phase as Phase) : "review",
      review: JSON.parse(get("day:review") || "[]"),
      done: get("day:done") === "1",
    };
  }

  function saveDay(patch: Partial<DayState>) {
    const d = dayState();
    const next = { ...d, ...patch };
    set("day:date", next.date);
    set("day:phase", next.phase);
    set("day:review", JSON.stringify(next.review));
    set("day:done", next.done ? "1" : "0");
    return next;
  }

  const wsId = (): string => (get("s:workspace_id") ?? "").trim();

  function withWs(url: string): string {
    const w = wsId();
    if (!w) return url;
    const u = new URL(url);
    if (!u.searchParams.get("workspace")) u.searchParams.set("workspace", w);
    return u.toString();
  }

  async function proxyTo(base: string, path: string, req: Request): Promise<Response> {
    const target = withWs(base.replace(/\/$/, "") + path);
    const init: RequestInit = { method: req.method, headers: { "content-type": "application/json" } };
    if (req.method !== "GET" && req.method !== "HEAD") {
      const raw = await req.text().catch(() => "");
      if (raw.trim()) {
        try { init.body = JSON.stringify(JSON.parse(raw)); }
        catch { return json({ error: "invalid JSON" }, 400); }
      } else {
        delete (init.headers as Record<string, string>)["content-type"];
      }
    }
    let r: Response;
    try { r = await fetch(target, init); }
    catch { return json({ error: "backend unreachable", target: base }, 502); }
    const text = await r.text();
    return new Response(text, {
      status: r.status,
      headers: { "content-type": r.headers.get("content-type") || "application/json" },
    });
  }

  // Milton chat with a server-side session bound to the workspace.
  async function miltonChat(message: string): Promise<Response> {
    const s = settings();
    const base = s.milton_url.replace(/\/$/, "");
    const w = wsId();
    let sid = get("milton_session");
    const wsKey = "milton_session_ws";
    if (!sid || get(wsKey) !== w) {
      // (re)bind a fresh session to the workspace
      try {
        const r = await fetch(base + "/api/chat-sessions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "rao", workspace_id: w === "" ? null : Number(w) }),
        });
        if (r.ok) {
          const j = (await r.json()) as { session?: { id?: string } };
          if (j.session?.id) { sid = j.session.id; set("milton_session", sid); set(wsKey, w); }
        }
      } catch { /* fall through to direct chat */ }
      if (!sid) { sid = "rao-" + (w || "default"); set("milton_session", sid); set(wsKey, w); }
    }
    try {
      const r = await fetch(base + "/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session: sid, message }),
      });
      const text = await r.text();
      return new Response(text, {
        status: r.status,
        headers: { "content-type": r.headers.get("content-type") || "application/json" },
      });
    } catch {
      return json({ error: "milton unreachable", target: base }, 502);
    }
  }

  const publicDir = join(import.meta.dir, "..", "public");
  const MIME: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
  };
  function serveStatic(path: string): Response | null {
    const file = path === "/" ? "/index.html" : path;
    if (file.includes("..")) return json({ error: "not found" }, 404);
    const full = join(publicDir, file);
    if (!existsSync(full)) return null;
    const ext = file.slice(file.lastIndexOf("."));
    return new Response(readFileSync(full), {
      headers: { "content-type": MIME[ext] || "application/octet-stream" },
    });
  }

  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    if (method === "GET" && (path === "/" || path.startsWith("/public/") || /\.(html|js|css|svg|png)$/.test(path))) {
      const r = serveStatic(path === "/" ? "/" : path);
      if (r) return r;
    }

    if (path === "/api/state" && method === "GET") {
      return json({ settings: settings(), day: dayState() });
    }

    if (path === "/api/settings" && method === "POST") {
      let b: Record<string, string> = {};
      try { b = await req.json(); } catch { return json({ error: "invalid JSON" }, 400); }
      const prevWs = wsId();
      for (const k of Object.keys(DEFAULTS)) {
        if (typeof b[k] !== "string") continue;
        let v = b[k].trim();
        if ((k === "exec_crm_url" || k === "milton_url") && v && !/^https?:\/\//.test(v)) {
          return json({ error: `${k} must start with http:// or https://` }, 400);
        }
        if (k === "reduce_motion") v = v === "1" ? "1" : "0";
        set("s:" + k, v);
      }
      if (wsId() !== prevWs) { set("milton_session", ""); set("milton_session_ws", ""); }
      return json({ settings: settings() });
    }

    if (path === "/api/day" && method === "POST") {
      let b: Partial<DayState> = {};
      try { b = await req.json(); } catch { return json({ error: "invalid JSON" }, 400); }
      const patch: Partial<DayState> = {};
      if (b.phase !== undefined) {
        if (!(PHASES as readonly string[]).includes(b.phase)) return json({ error: "bad phase" }, 400);
        patch.phase = b.phase as Phase;
      }
      if (b.review !== undefined) {
        if (!Array.isArray(b.review) || !b.review.every((x) => typeof x === "string")) {
          return json({ error: "bad review checklist" }, 400);
        }
        patch.review = b.review.slice(0, 16);
      }
      if (b.done !== undefined) patch.done = !!b.done;
      return json({ day: saveDay(patch) });
    }

    if (path === "/api/day/reset" && method === "POST") {
      set("day:date", "");
      return json({ day: dayState() });
    }

    if (path === "/api/health" && method === "GET") {
      const s = settings();
      const ping = async (base: string) => {
        try {
          const ctl = new AbortController();
          const t = setTimeout(() => ctl.abort(), 4000);
          const r = await fetch(base.replace(/\/$/, "") + "/", { signal: ctl.signal });
          clearTimeout(t);
          await r.text().catch(() => {});
          return true;
        } catch { return false; }
      };
      const [crm, milton] = await Promise.all([ping(s.exec_crm_url), ping(s.milton_url)]);
      return json({ crm, milton });
    }

    if (path === "/api/milton/hygiene" && method === "GET") {
      const s = settings();
      return proxyTo(s.milton_url, "/api/hygiene" + url.search, req);
    }

    if (path === "/api/milton/chat" && method === "POST") {
      let b: { message?: string } = {};
      try { b = await req.json(); } catch { return json({ error: "invalid JSON" }, 400); }
      const message = String(b.message || "").slice(0, 2000).trim();
      if (!message) return json({ error: "empty message" }, 400);
      return miltonChat(message);
    }

    if (path.startsWith("/api/crm/") && ["GET", "POST", "PATCH", "DELETE"].includes(method)) {
      const s = settings();
      return proxyTo(s.exec_crm_url, "/api" + path.slice("/api/crm".length) + url.search, req);
    }

    return json({ error: "not found" }, 404);
  }

  return { fetch: handle, db, settings, dayState, saveDay, todayStr };
}

if (import.meta.main) {
  const app = createApp();
  Bun.serve({ port: PORT, fetch: app.fetch });
  console.log(`rao on http://127.0.0.1:${PORT}`);
}
