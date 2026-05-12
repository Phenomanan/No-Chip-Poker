# No-Chip Poker

Browser-based no-chip poker companion app for in-person games.

## Workspace

- `apps/server`: Realtime Socket.IO server (authoritative room state)
- `apps/web`: Static frontend (GitHub Pages-compatible)
- `packages/shared-types`: Shared event and domain types
- `packages/rules-engine`: Server-side action validation helpers

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

## Production runbook (GitHub Pages + Render)

Current production split:
- Frontend: GitHub Pages (static files from `apps/web`)
- Backend: Render Web Service (Node + Socket.IO)

### 1) Deploy backend on Render

Create a **Web Service** from this repository with:

- Build command (one line):
  `npm ci && npm run build:server`
- Start command:
  `node dist/apps/server/src/index.js`
- Health check path:
  `/health`

Set environment variables:
- `CORS_ORIGINS=https://phenomanan.github.io,https://phenomanan.github.io/No-Chip-Poker,http://localhost:3001`
- `RATE_LIMIT_WINDOW_MS=60000`
- `RATE_LIMIT_MAX=200`
- `NODE_ENV=production`

Render provides `PORT` automatically.

### 2) Point frontend to Render backend

`apps/web/src/config.js` is preconfigured with:
- `SERVER_URL: "https://poker-chip-tracker-server.onrender.com"`

Optional runtime override still works:
- Open the app with `?server=https://your-backend.onrender.com`
- The value is cached in `localStorage` under `chipless-server-url`

### 3) Deploy frontend on GitHub Pages

This repository includes a workflow at `.github/workflows/deploy-pages.yml`.

Steps:
1. Push to `main` (or run workflow manually).
2. In GitHub repo settings, configure Pages source as **GitHub Actions**.
3. Workflow publishes `apps/web` directly.

### 4) Post-deploy smoke check

1. Open the Pages URL.
2. Create a room and copy the room code.
3. Join from a second tab/device.
4. Confirm realtime sync and action log updates.
5. Confirm `https://poker-chip-tracker-server.onrender.com/health` returns `{ ok: true }`.

## Current MVP behavior

- Anonymous create/join/rejoin flow (no auth required)
- Per-room session restore in browser localStorage
- Street progression through preflop/flop/turn/river/showdown
- Mobile-friendly controls and touch target sizing
- Dark mode toggle with persisted preference (`no-chip-theme`)

## Remaining todos (post-MVP backlog)

Priority 1 (stability + reliability):
- Replace in-memory room state with persistent storage (Postgres and/or Redis)
- Add room/session TTL cleanup for abandoned rooms
- Add structured server logging and error tracking
- Add automated backups or snapshot strategy for persisted room data

Priority 2 (game correctness):
- Implement full 7-card hand evaluation on server
- Expand showdown validation and split-pot edge case handling
- Add deterministic regression tests for street/action progression

Priority 3 (operational hardening):
- Add CI test workflow for backend + shared rules engine
- Add load/concurrency smoke tests for multi-player room updates
- Add basic admin-only room reset endpoint (or internal script)

Priority 4 (product polish):
- Add optional hand history export (JSON/CSV)
- Improve spectator UX and host controls for large tables
- Finalize production domain/branding cleanup after repo rename migration
