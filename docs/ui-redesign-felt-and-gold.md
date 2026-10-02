# UI redesign: felt and gold

Status as of 2026-10-02. This records the direction agreed with the project owner,
what has been implemented, and what is still open.
It supersedes the visual direction in `docs/ux-ui-improvement-plan.md`.

## Why

Weekend playtesting with friends showed the app reading like a web dashboard rather than
a phone app: stacked stat cards all competing for attention, a linear "Table Flow" list
instead of anything that looked like a table, and no sense of where the thumb should go.
The goal: look and feel like a professional iPhone/Android app, with a nicer frontend to
match.

## Agreed direction

- **Theme**: premium casino / poker table. Felt green surfaces, brass-gold accents, ivory
  text. Night felt (dark) is the default; a lighter "day felt" variant sits behind the theme
  toggle. Only an explicit saved `light` choice opts out of dark (`theme.js`).
- **Scope**: visuals *and* layout restructuring, mobile-first.
- **Table order**: the host must still be able to set seat order, ideally directly on the
  table. Both are provided: drag seats on the table, or use the list in Table Settings.
  Both emit the same `reorder_seats` event, so server rules are unchanged (host only,
  locked while a hand is in progress).
- **Validation**: mocked up before building. Concept mockup (private artifact, owner's
  account): https://claude.ai/artifact/AjdhJfL83CSJBG6z3CvrGn — three phone frames:
  waiting, your turn (big blind option), and a live draggable table-order editor.

## Design tokens

Defined in `apps/web/src/styles.css` (`:root` = day felt, `[data-theme="dark"]` = night
felt). The existing stylesheet was already token-driven, so swapping token values
re-themed most components without per-rule edits.

| Token | Role |
| --- | --- |
| `--bg`, `--bg-elev`, `--chrome` | page felt, card surface, raised chrome |
| `--felt`, `--felt-deep` | table oval gradient stops |
| `--accent` (gold), `--on-accent` | primary actions, acting highlight; dark text on gold |
| `--accent-2`, `--safe` (emerald) | call/check, connected |
| `--danger` (ruby) | fold, to-call ring |
| `--font-display` Fraunces, `--font-body` Manrope, `--font-mono` IBM Plex Mono | headings and the Start Hand CTA, UI text, numbers/codes |

## What is implemented

- Token swap, fonts, dark-by-default theme, gold primary buttons with dark text.
- **Table oval** (`.table-oval`): the pot (`#pot-visual-button`) is a gold medallion in the
  center and seats sit around it. `renderTableTurnVisual` in `app.js` places seats by angle
  (`seatSlotPosition`, clockwise from 12 o'clock) so it generalizes to any player count.
  Seat order is the real `player.seat` order and never rotates with whose turn it is.
  Each seat shows an initial, name, bet-or-stack, an order badge, and D/SB badges; the
  acting seat pulses; called, to-call, folded, and winner seats are ringed or dimmed.
- **Drag to reorder on the table** (`startTableSeatDrag`): host only, not during a hand.
  Pointer Events with `setPointerCapture` so mouse and touch share one path; on drop the
  seat takes the nearest slot and `reorder_seats` is emitted. The next `room_state`
  re-renders everything into its final slots.
- **Sticky action sheet**: `.control-grid` (Your Actions and showdown resolution) is
  `position: sticky` at the bottom of the screen with a blurred backdrop.
- Chip-denomination SVG text moved from Space Grotesk to IBM Plex Mono; feedback text uses
  theme tokens instead of fixed hex.

## Table nits (2026-10-02, follow-up)

- **Deal gate**: after betting, the next street shows "Deal 3 community cards (the flop)" and
  nobody is highlighted or asked to act. The host gets a gold "Flop dealt (3 cards) — start
  betting" button in the action sheet; everyone else sees "Waiting for the host to deal…".
  Same for turn (1) and river (1). Server rule: see `docs/architecture.md`.
- **Static pot**: `#pot-visual-button` is a fixed 112px brass-rimmed chip, centered with
  `inset: 0; margin: auto` instead of `transform` (the global `button:hover` transform used to
  override the centering transform, which made it jump). Its label is always "Pot"/"Paid"
  and it holds one fixed-height chip pile. Tap for the breakdown: chip denominations plus
  what each player has put in this hand.
- **Chip stacks in front of players**: each seat has a separate `.seat-chips` element (chip
  pile + stack amount) placed 40% of the way from the seat toward the pot. Tap to see that
  player's denomination breakdown. Seat and chip elements persist between renders, keyed by
  player id, so they animate between slots.
- **Dragging**: only the player's icon and name follow the pointer. Chip stacks stay in their
  slots and slide to the new ones once the server confirms the new order.

## Verified (2026-10-02)

Driven by hand in two separate browser profiles plus scripted bots, at 375px: drag to
reorder on the table and in the Host Controls list, host kick (between hands and mid-hand),
raise controls, per-pot winner picker, split and side-pot payouts, in-app confirm sheets,
blind vote/schedule/update, transfer host, chat, modals, spectator, leave, and refresh
mid-hand. Fixed along the way: oversized winner checkboxes, player names squeezed out of
Host Controls rows on phones, action sheet that did not dock to the bottom, native
`confirm()` popups (now an in-app sheet), seat numbers showing gaps after removals.

## Still open

1. Day felt (light) variant has not been reviewed visually.
2. Chat, action log, and players list only inherit the new tokens; some stack-meter and
   chip-preview styles still use pre-redesign colors.
3. No rebuy or stack reset: when most players bust, the room has to be recreated.
4. A player who is offline when their turn comes stalls the table until they return or the
   host removes them.

## Reviewing this branch

Run `npm run dev:server`, open `http://localhost:3001`, and use the browser's mobile
viewport (about 375px wide). Server logic and the rules engine are untouched by the
redesign; `npm test` should be unaffected.
