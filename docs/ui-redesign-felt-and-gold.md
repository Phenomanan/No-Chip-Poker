# UI redesign: felt and gold

Status as of 2026-10-02. This records the direction agreed with the project owner,
what has been implemented on branch `felt-and-gold-redesign`, and what is still open.
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

## Not done yet

1. **Live verification of the new table interactions.** Static rendering was checked at
   375px with a 2-player room (auth screen, header, table oval). Drag-to-reorder, the
   acting glow, and the 3+ seat layout were not yet exercised in a browser. Test with
   separate browser profiles (not two tabs of one profile: tabs share `localStorage` and
   the session auto-rejoin will evict one of them, see `architecture.md`).
2. **Pot medallion sizing.** It is a rounded rectangle, not the circular chip in the
   mockup, because real pots render variable-width side-pile stacks. Needs a decision.
3. **Secondary panels** (chat, action log, players list, blind vote and schedule forms,
   modals) only inherit the new colors and fonts. No bespoke layout pass. The mockup's
   bottom-sheet pattern for Table Settings and modals is not built.
4. **Native `confirm()` dialogs** (leave room, remove player, declare winners) are still
   browser-native. Replacing them with in-app sheets would complete the app feel.
5. **Day felt** variant has not been reviewed visually at all.
6. Some stack-meter and chip-preview styles still carry pre-redesign colors.

## Reviewing this branch

Run `npm run dev:server`, open `http://localhost:3001`, and use the browser's mobile
viewport (about 375px wide). Server logic and the rules engine are untouched by the
redesign; `npm test` should be unaffected.
