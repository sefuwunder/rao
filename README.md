# rao — review · action · outcome

A tight, mobile-first CRM that runs your selling day as a guided loop instead of
a database with menus. Every screen outside Settings belongs to exactly one of
three phases, and each phase hand-holds you into the next:

- **Review** — Milton's morning brief, pipeline stats, what needs your eyes, and
  a three-step checklist that gates the day. Nothing starts until you've looked.
- **Action** — the next thing to do (Milton picks the order), today's tasks,
  Milton's suggestions, and an explicit hand-off into Outcome.
- **Outcome** — log what came back (deal · channel · result), today's timeline,
  deal stage stepper, Milton's read. Wrapping the day finishes it *inside*
  Outcome — a finished day is never a fourth screen.

Milton is the logic engine (brief, phase-tagged hygiene/playbook findings,
suggestions, chat). exec-crm is the system of record (deals, stages, tasks,
outreach). rao keeps no business data of its own — just settings and today's
loop state in a local SQLite file.

## Run it

Bun only, zero npm dependencies.

```sh
bun src/server.ts        # http://127.0.0.1:3010
```

On first boot rao creates a gitignored `data/` directory for its SQLite db.

| env | default | what |
|---|---|---|
| `RAO_PORT` | `3010` | port to listen on |

Point rao at your backends in Settings (or leave the defaults):

- exec-crm → `http://127.0.0.1:3001`
- Milton → `http://127.0.0.1:3009`
- Workspace ID → blank for default; changing it drops rao's Milton session so a
  fresh one binds to the new workspace.

Milton chat runs through one server-side session per workspace — the Milton URL
never leaves the server. Backend health is checked with 4s timeouts; when a
backend is down, each phase degrades to an explicit offline card with a retry
instead of a spinner.

## The loop, precisely

- Day state (phase, checklist, done) resets on local-calendar-day rollover.
- Review's **Begin action** stays disabled until all three checklist steps are
  checked; the checklist persists via `/api/day`.
- Action ends with **Continue to outcome →** — the guided transition.
- Logging an outcome advances the loop: deals touched today are skipped by the
  Action recommendation and marked **Logged ✓** in Milton's suggestion list.
  The composer records `happened_at` in local wall-clock time — exec-crm stamps
  `created_at` in UTC, which would otherwise date evening entries "tomorrow" and
  hide them from today's timeline.
- Outcome's **Wrap the day** shows the day's totals, then **Finish the day ✓**
  marks the day done. The completed-day panel renders inside Outcome with the
  Outcome phase tag; **Reopen the day** un-does it, **Start a fresh day** resets.
- Reduce motion: honors the OS `prefers-reduced-motion` setting and has an
  explicit toggle in Settings (persisted server-side).

## API (all same-origin; backends are proxied, never exposed)

- `GET /api/state` — settings + today's day state
- `POST /api/settings` — urls, workspace, display name, reduce_motion
- `POST /api/day` — `{ phase, review[], done }` (phase must be a real phase)
- `POST /api/day/reset` — start a fresh day
- `GET /api/health` — exec-crm / Milton reachability
- `GET /api/milton/hygiene` → Milton `/api/hygiene`
- `POST /api/milton/chat` → Milton `/api/chat` (workspace-bound session)
- `/api/crm/*` → exec-crm `/api/*` (workspace param attached)

## Tests

```sh
bun test                      # server: state, proxying, milton sessions, static
node tests/ui.test.js         # render: phases, gating, escaping, offline states
node tests/regression-logged-deal.test.js # the full "Log it." path: POST, refresh, recommendation advance, timeline
```

94 checks total, all green.
