# Poker Chip Tracker

A better Chipless-style poker companion app for in-person games.

## Workspace

- apps/server: Realtime Socket.IO server (authoritative room state)
- apps/web: Frontend app (placeholder for now)
- packages/shared-types: Shared event and domain types
- packages/rules-engine: Server-side action validation helpers

## Quick start

1. Install dependencies for all packages:
   npm run install:all
2. Build shared modules and server:
   npm run build:server
3. Run server:
   npm run dev:server

The server starts on http://localhost:3001 by default.

Open http://localhost:3001 to use the web client.

## Temporary production hosting

This app is split into:

- Frontend static files in apps/web (can be hosted on GitHub Pages)
- Realtime Socket.IO backend in apps/server (must be hosted on a Node runtime)

### 1) Deploy backend (Render example)

- Create a Render Web Service from this repository.
- Build command:
   npm ci
   npm run build:server
- Start command:
   node dist/apps/server/src/index.js
- Environment variables:
   - CORS_ORIGINS=https://<your-username>.github.io
   - RATE_LIMIT_WINDOW_MS=60000
   - RATE_LIMIT_MAX=200
   - PORT is provided by Render automatically

If your repo is under a project path, add that full Pages origin to CORS_ORIGINS.

### 2) Point frontend to backend

Edit apps/web/src/config.js and set SERVER_URL to your backend URL, for example:

- https://your-app.onrender.com

Local development still uses same-origin Socket.IO on localhost.

### 3) Deploy frontend to GitHub Pages

This repo includes a Pages workflow in .github/workflows/deploy-pages.yml.

- Push to main (or run the workflow manually).
- In GitHub repo settings, enable Pages and select GitHub Actions as source.

The workflow publishes apps/web directly.
