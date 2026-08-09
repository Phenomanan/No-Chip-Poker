# No-Chip Poker

Browser-based no-chip poker companion app for in-person games. Players play real cards at
the table; this app tracks stacks, blinds, betting, pots (including side pots), and payouts
in realtime across everyone's phones so no physical chips are needed. It does not deal cards
or evaluate hands — the host declares winner(s) at showdown and the app computes payouts
from there, including correct side-pot splits when players are all-in for different amounts.

## Workspace

- `apps/server`: Realtime Socket.IO server (authoritative room state)
- `apps/web`: Static frontend (GitHub Pages-compatible)
- `packages/shared-types`: Shared event and domain types
- `packages/rules-engine`: Server-side action validation and pot/payout calculation

## Local development

1. Install dependencies:
   `npm ci`
2. Start server + local web client:
   `npm run dev:server`
3. Open:
   `http://localhost:3001`

Notes:
- In non-production mode, the server also serves the frontend from `apps/web`.
- Localhost uses same-origin Socket.IO (`/socket.io/socket.io.js`).
- Server snapshots room/session state to disk (`STATE_FILE_PATH`, default `./data/state.json`)
  and restores on restart. `data/` is gitignored — it's local runtime state, not source.
- Idle rooms are cleaned up automatically with TTL controls (`ROOM_TTL_MS`, `ROOM_CLEANUP_INTERVAL_MS`).
- Security middleware (`helmet`, CORS allowlist, rate limiting) is always on, including
  locally. Helmet's default Content-Security-Policy blocks inline `<script>`/`<style>` tags —
  any new frontend script must ship as an external file under `apps/web/src/` (see
  `apps/web/src/theme.js` for the pattern), not an inline `<script>` block in `index.html`.

## Testing

`npm run test:pot-regression` builds the server and runs `scripts/test-pot-regression.mjs`,
an end-to-end suite that spins up a real server instance and drives it over real
Socket.IO connections (no mocks) to verify:
- Basic hand resolution and the payout acknowledge → animate → idle lifecycle.
- Side-pot formation and coverage validation.
- Explicit per-pot winner selection (what the showdown UI sends when a side pot is
  contested by different players than the main pot).
- The exact uneven-stack all-in payout scenario (e.g. a 766-stack player and a
  1234-stack player both all-in) — the short stack must win the *entire* main pot, not
  a 50/50 split with the side-pot contributor.

This suite also runs in CI (`.github/workflows/ci.yml`) on every push and PR to `main`.

## Production runbook (GitHub Pages + Render)

Current production split:
- Frontend: GitHub Pages (static files from `apps/web`), deployed by
  `.github/workflows/deploy-pages.yml` on every push to `main`.
- Backend: Render Web Service (Node + Socket.IO)

### 1) Deploy backend on Render

Create a **Web Service** from this repository with:

- Build command (one line):
  `npm ci && npm run build:server`
- Start command:
  `node dist/apps/server/src/index.js`
- Health check path:
  `/health`

Set environment variables (see `.env.example`):
- `CORS_ORIGINS=https://<your-username>.github.io,https://<your-username>.github.io/No-Chip-Poker,http://localhost:3001`
- `RATE_LIMIT_WINDOW_MS=60000`
- `RATE_LIMIT_MAX=200`
- `STATE_FILE_PATH=/opt/render/project/src/data/state.json`
- `ROOM_TTL_MS=86400000`
- `ROOM_CLEANUP_INTERVAL_MS=300000`
- `NODE_ENV=production`

Render provides `PORT` automatically.

### 2) Point frontend to Render backend

`apps/web/src/config.js` holds the deployed backend URL as `SERVER_URL`.

Optional runtime override still works:
- Open the app with `?server=https://your-backend.onrender.com`
- The value is cached in `localStorage` under `chipless-server-url`

### 3) Deploy frontend on GitHub Pages

1. Push to `main` (or run the `Deploy GitHub Pages` workflow manually).
2. In GitHub repo settings, configure Pages source as **GitHub Actions**.
3. The workflow publishes `apps/web` directly — no build step needed, it's static.

### 4) Post-deploy smoke check

1. Open the Pages URL.
2. Create a room and copy the room code.
3. Join from a second tab/device.
4. Confirm realtime sync and action log updates.
5. Confirm `<your-render-url>/health` returns `{ ok: true }`.

## Current feature set

- Anonymous create/join/rejoin flow (no auth), with per-room session restore via
  browser `localStorage` and a reconnect/rejoin flow that survives refresh.
- Full street progression (preflop → flop → turn → river → showdown) with server-side
  action validation (check/call/raise/all-in/fold).
- Side-pot support: correct multi-pot splitting when players are all-in for different
  amounts, with a per-pot winner picker in the showdown UI for cases where a side pot is
  contested by different players than the main pot.
- Payout lifecycle with a host/any-player acknowledgment step and an animated chip
  distribution sequence (`payoutState`: `pending_ack` → `animating` → `idle`).
- Blind management: host-editable blinds, an optional auto-increasing blind schedule
  (configurable level duration, start/pause/reset), and a player-initiated majority vote
  to double blinds.
- Dealer/small-blind seat tracking, chip-stack visuals with denomination breakdown, a
  pot visual showing main/side pot piles, and a color-coded "table flow" turn-order
  visual (acting/called/betting/folded/winner).
- In-room chat with delivery reconciliation for messages sent while reconnecting, plus a
  connection status indicator and message timestamps.
- Host controls: update blinds, manage blind schedule, transfer host, room settings panel.
- Dark mode toggle with persisted preference (`no-chip-theme` in `localStorage`).
- Mobile-friendly controls and touch target sizing.
- Server-side room/session TTL cleanup, disk snapshot + restore, rate limiting, CORS
  allowlist, and security headers (helmet).

Note: this app does not model cards or evaluate hands — there is no dealt-card state
anywhere in `packages/shared-types`. Winner declaration at showdown is a host action;
the rules engine's job is validating actions and computing correct pot/payout splits
from contributions, not poker hand strength.

## Remaining backlog

Priority 1 (stability + reliability):
- Replace the JSON-file state snapshot with persistent storage (Postgres and/or Redis)
  for durability beyond a single disk/host.
- Add structured server logging and error tracking (currently plain `console.log`/`console.error`).
- Add an automated backup/rotation strategy for the state snapshot.

Priority 2 (operational hardening):
- Add load/concurrency smoke tests for multi-player room updates.
- Add a basic admin-only room reset endpoint (or internal script) for stuck rooms.

Priority 3 (product polish):
- Optional hand history export (JSON/CSV).
- Improve spectator UX for large tables (spectator role exists today but has no
  dedicated UX beyond read-only join).
- Continue the UX/UI pass described in `docs/ux-ui-improvement-plan.md` — see that doc
  for the current status of each item.
