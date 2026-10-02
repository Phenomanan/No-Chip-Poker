# Architecture

Status as of 2026-10-02. This describes the app as it currently exists, not an initial
implementation plan — see `README.md` for the full feature list and `docs/ux-ui-improvement-plan.md`
for earlier frontend work and `docs/ui-redesign-felt-and-gold.md` for the current visual
redesign.

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

## Betting round completion (turn order)

`findNextActingPlayer` and `shouldSettleHand` (both in `rules-engine`) share one rule for
"has this street's betting finished": every player still in the hand with chips must both
match the table's highest commitment for the street *and* have actually acted this street.
The second clause matters specifically for the big blind (and, heads-up, the small blind
acting as dealer): their posted blind can already equal the highest commitment before
they've ever chosen an action, so without tracking "has acted" separately, the street would
end the instant everyone else's calls caught up to the blind — skipping the blind's own
option to check or raise. `roomStreetActionState` (server-side, persisted) is what tracks
"acted this street" per player; it resets on every street transition.

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
(`validateWinnerCoverage`). This is the *only* decision required to pay out a hand — chips
are credited to winners' stacks synchronously in the same `settleHand` call; `payoutState`
briefly goes to `"animating"` purely so the client can play a cosmetic chip-push animation,
then flips back to `"idle"` on its own (`tickPayoutAnimations`). There used to be a separate
player "acknowledge" step gating this; it was removed after playtesting found it just added
friction without adding a decision, since the host declaring winners was already final.

Side-pot tiers are derived only from contribution levels of players still `inHand` — a
folded player's chips are dead money folded into the existing tier(s), never a tier
boundary of their own. Before this was fixed, any fold-then-raise sequence could produce a
spurious extra "side pot" with the exact same eligible players as the main pot.

## Admin (host) controls

The host can remove any other player from the room (`remove_player`) at any time, including
mid-hand — if the target is still `inHand`, they're auto-folded first (so the hand can
still resolve normally) before being deleted from `players` and evicted (their session is
invalidated and their socket is kicked from the room channel). This is for the "someone
left and needs to be cleared out of the lobby" case. The host can also set strict seat/table
order (`reorder_seats`) between hands — turn order, dealer rotation, and the "Table Flow"
display all key off `Player.seat`, so this directly controls play order. Reordering is
blocked while `status === "in_hand"` since `dealerSeat`/`smallBlindSeat`/`actingPlayerId`
are only meaningful relative to a stable seat assignment mid-hand.

## Session/reconnect model

There's no auth. A player's identity is a `playerId` tied to a `sessionId` stored in
`localStorage` (`sessionToPlayerId` map, server-side). Rejoining sends the saved
`sessionId`; the server maps it back to the existing `playerId` and re-attaches the
player's live socket, so state (stack, cards-in-hand status, chat history) survives a
refresh or a dropped connection without any credential.

The client resumes automatically: on every socket `connect` (a fresh page load, or the
socket.io client's own reconnect after a network blip) it sends `rejoin_room` with the saved
session, so players never need to press "Rejoin Last Session". A "Leave Room" button clears
the saved session and forces a fresh connection.

A player has exactly one authoritative socket. `joinRoom`/`rejoinRoom` call
`evictOtherSocketsForPlayer`, which removes any other socket's `socketToPlayerId` entry
*before* disconnecting it, so the stale socket's later `disconnect` event is a no-op instead
of flipping a still-connected player to `connected: false` (which hides their action buttons
on their own turn). The evicted client gets `io server disconnect`, which socket.io never
auto-reconnects from, so the frontend sends it back to the auth screen with an explanation.
Consequence for manual testing: two tabs of one browser profile share `localStorage`, so the
second tab auto-rejoins as the first tab's player and evicts it. Use separate profiles or
devices to simulate separate players.

Each room stores `startingStack` (from `create_room`); joining players get that stack, not
a fixed amount.

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
  `scripts/test-pot-regression.mjs` and `scripts/test-admin-controls.mjs`.

## Testing

`npm test` runs five suites: `scripts/test-rules-engine.mjs` (pure, synchronous unit tests
against the compiled `rules-engine` module — no server, no sockets; pot-splitting, turn-order,
big-blind-option, and admin-permission edge cases) plus four integration suites that spawn a
real server on an isolated port and drive it over real `socket.io-client` connections the way
the frontend does: `test-pot-regression.mjs`, `test-admin-controls.mjs`,
`test-session-handling.mjs` (stale-socket eviction), and `test-four-player-soak.mjs`. The soak
test plays five hands with four players (check-down, a multi-raise hand whose turn order is
cross-checked against an independent reference model, a fold-out, a short-stack all-in with a
fold, and a mid-session seat reorder) and asserts chips are conserved after every action.
`findNextActingPlayer`/`shouldSettleHand` (the turn-order/street-advancement logic) live in
`rules-engine` so they're covered by the fast unit layer rather than only reachable through a
full hand played out over sockets.

Betting rounds follow one rule: a street ends only when every player with chips has matched
the highest commitment *and* acted this street. The second clause gives the big blind their
preflop option. Tests that need a short stack must create it through play (a priming hand),
because every player now starts with the same configured stack.

The frontend has no automated tests; UI changes are verified by hand in a browser.
