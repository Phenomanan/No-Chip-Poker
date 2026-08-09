# Architecture

Status as of 2026-08-01. This describes the app as it currently exists, not an initial
implementation plan — see `README.md` for the full feature list and `docs/ux-ui-improvement-plan.md`
for in-progress frontend work.

## Shape of the system

- **Monorepo, npm workspaces.** `apps/server`, `apps/web`, `packages/shared-types`,
  `packages/rules-engine`.
- **`apps/server`**: an Express + Socket.IO server that owns all room state in memory
  (`Map<roomId, RoomState>`), snapshots it to a JSON file on disk periodically and on
  change, and restores it on startup. In non-production mode it also serves `apps/web`
  as static files (same origin, so no CORS/Socket.IO cross-origin config is needed
  locally). Security middleware — `helmet` (default CSP included), a CORS allowlist, and
  rate limiting — is applied unconditionally, in dev and prod alike.
- **`apps/web`**: a static, framework-free frontend (`index.html` + `src/app.js` +
  `src/styles.css`, no build step) that talks to the server exclusively over a single
  Socket.IO connection. All game state lives server-side; the client renders whatever
  `room_state` events it receives and never computes pot/payout logic itself. On GitHub
  Pages, it's uploaded as-is (`actions/upload-pages-artifact`) — there is nothing to
  build.
- **`packages/shared-types`**: the `ClientEvent`/`ServerEvent` union types and `RoomState`/
  `Player`/`Pot`/`Payout` shapes. Both the server and (indirectly, by convention — the
  frontend is untyped JS) the frontend are written against this contract.
- **`packages/rules-engine`**: pure functions with no I/O — `validateAction`,
  `calculatePots`, `calculatePayouts`, `validateWinnerCoverage`, etc. The server is the
  only caller. Kept dependency-free specifically so `scripts/test-pot-regression.mjs` and
  future unit tests can exercise pot/payout math without spinning up a server.

## Request flow

The client never mutates state directly. Every action (`submit_action`, `declare_winners`,
`start_hand`, blind changes, chat, …) is a `ClientEvent` emitted over the single `event`
Socket.IO channel; the server validates it against `RoomState` (via `rules-engine`),
mutates its in-memory copy, and broadcasts the new `RoomState` to everyone in the room via
`room_state`. The frontend has no local optimistic state — every UI update is a reaction to
a server-authoritative `room_state` broadcast. This keeps every client, including one that
just reconnected mid-hand, trivially consistent: render whatever the server last sent.

## Pot/payout model

`calculatePots` walks each player's total contribution for the hand (`totalContribution`,
tracked across streets — `commitment` resets each street, `totalContribution` doesn't) and
splits it into tiers: the lowest common contribution level forms the main pot (every
contributor at or above it is eligible), and each higher contribution level still in play
forms a side pot (only the players who contributed that much are eligible). This is what
allows two players with different-sized stacks to both go all-in and have the payout come
out correct (see `docs/ux-ui-improvement-plan.md`'s history and
`scripts/test-pot-regression.mjs` for the regression coverage of a bug that briefly broke
this — a short-stack winner not being fully paid).

At showdown, the host declares winner(s). If there's more than one pot, the frontend shows
a per-pot picker (each pot's checkbox group scoped to only that pot's still-in-hand
contributors) instead of one flat list, and sends `potWinnerIds` alongside `winnerIds`.
The server auto-resolves any pot with exactly one eligible contributor (nothing to decide)
and validates that every pot has an eligible winner before accepting the declaration
(`validateWinnerCoverage`).

## Session/reconnect model

There's no auth. A player's identity is a `playerId` tied to a `sessionId` stored in
`localStorage` (`sessionToPlayerId` map, server-side). Rejoining sends the saved
`sessionId`; the server maps it back to the existing `playerId` and re-attaches the
player's live socket, so state (stack, cards-in-hand status, chat history) survives a
refresh or a dropped connection without any credential.

## What's intentionally out of scope

There is no card or hand-strength modeling anywhere in `shared-types` — players hold and
read real cards at the table (or in another app); this app tracks chips, not cards.
"Full hand evaluation" was an early aspiration in this doc's first draft that no longer
matches the product's direction as a chip-tracking companion rather than a full poker
engine — see the note in `README.md`'s feature list.

## Known architectural gaps (see README backlog for the full list)

- Room state persistence is a single JSON file snapshot (`STATE_FILE_PATH`), not a real
  database — durable across restarts on one host, not across hosts or a crash mid-write.
- Logging is `console.log`/`console.error`; no structured logging or error tracking.
- No automated load/concurrency testing beyond the single-room, few-player scenarios in
  `scripts/test-pot-regression.mjs`.
