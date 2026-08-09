# UX/UI Improvement Plan

Status as of 2026-08-01. Findings below come from reading `apps/web/src/{app.js,styles.css}`
and `apps/web/index.html`, and from actually running the app end-to-end in a real browser
(Playwright, both light and dark mode, host + second player, in-hand state) rather than
static code review alone. Two players, a full hand start, and both themes were exercised
before writing this.

The app already has a real design system worth keeping: a warm gradient hero, dark mode
tokens, card hover states, a chip-stack visual with denomination breakdown, a payout
animation sequence, and a color-coded "table flow" legend. This plan builds on that
foundation rather than replacing it — most of the work below is targeted fixes and
hierarchy changes, not a rewrite.

## Findings, in priority order

### P0 — Bug: dark mode does not work at all

`apps/web/index.html` applies the saved theme and wires up `#theme-toggle`'s click handler
from an **inline** `<script>` block. `apps/server/src/index.ts` calls `helmet()` with only
`crossOriginResourcePolicy` overridden, so Helmet's default Content-Security-Policy
(`script-src 'self'`) applies and silently blocks that inline script. Verified with
Playwright: after `page.click("#theme-toggle")`, `document.documentElement`'s `data-theme`
attribute never changes, in either direction. Since the app is always served through this
server (locally and via the documented Render deploy), dark mode — a feature the README
explicitly advertises — is dead for every real user.

Fix: move the theme bootstrap + toggle logic out of the inline `<script>` into an external,
same-origin file (e.g. `apps/web/src/theme.js`), loaded the same way `config.js` and
`bootstrap.js` already are. No CSP changes needed; `'self'` already permits it.

### P1 — The controls you need most require the most scrolling to reach

Measured on a 430×900 viewport (a typical phone): the acting player's Fold/Call/Raise/All-In
buttons sit roughly 900–950px down the page — past the hero copy, room status pills, the
blinds card, a full-width "Table Settings" button, the pot visual, the table-flow legend, and
a 4-tile stats grid. On a real phone's visible viewport (usually 650–750px after browser
chrome), that's a full screen of scrolling before the person whose turn it is can even see
their options. This is a live, synchronous, "someone is waiting on you" app — that scroll
distance is a real cost paid every single turn, not a one-time cost.

Contributing factors:
- The stats grid (`Your Stack` / `Your Bet` / `Current Bet` / `Acting Player`) duplicates
  information already shown on the player's own row further down in the Players list
  (`stack 950`, `bet 50`).
- "Table Settings" is a full-width, high-contrast button that outranks the actual action
  buttons visually, despite being used far less often.
- The pot visual and table-flow visual are both large, tall cards positioned above the
  actions card.

Fix direction: reorder so the action buttons render directly under the room header on
mobile (or add a sticky/floating action bar pinned to the bottom of the viewport whenever
it's the current player's turn), and drop the redundant stat tiles in favor of the
already-present player row.

### P2 — Action buttons don't communicate what they do

Confirmed visually: Fold, Call, and Raise render as the exact same flat dark navy
(`#374151`); only All-In gets a distinct color (red). Stacked vertically on mobile, that's
three visually identical buttons in a row differentiated only by label text. The app
already has a working color-semantics pattern elsewhere (the table-flow legend color-codes
Acting/Called/Betting/Folded) — extending that same language to the action buttons is
consistent with existing intent, not a new idea.

Fix: give each action family a distinct, purposeful color — a neutral/outlined treatment for
Fold (low commitment), a safe/confirmatory color for Check/Call, the warm accent for Raise
(the "big decision"), red stays for All-In.

### P3 — The pot — the single most important number on the page — is the least visible

The "Table Pot" button's background (`radial-gradient` over `color-mix(accent 24%, white
76%)`) sits on top of an already-tinted, noise-textured page background, and the combination
renders as a dull, muddy brownish-gray rather than a focal highlight. In every screenshot
taken, it was the lowest-contrast large element on the screen despite being the number
players care about most.

Fix: increase saturation/contrast of the pot card independent of the ambient background
tint, and consider treating it as the visual anchor of the page (larger, higher elevation,
possibly the first thing rendered) rather than one card among several similarly-styled ones.

### P4 — One accent color is used for nearly everything

`--accent-2` (teal) is currently used for Table Settings, Hand Rankings, Send (chat), vote
buttons, and most "ghost" buttons throughout the app. When one color means "settings,"
"help," "send message," and "cast vote" simultaneously, it stops signaling anything
specific. Establish a small hierarchy: one color for primary/affirmative actions, a distinct
(visually quieter) treatment for secondary/utility actions (settings, rankings, chat), and
keep the warm accent reserved for the highest-stakes actions (Start Hand, Raise).

### P5 — No cue when it becomes your turn and you're not looking at the screen

No sound, no tab-title change, no vibration. Combined with P1's scroll depth, a player could
easily miss that action is on them until someone at the table says something. A tab-title
ping (`● Your turn — No-Chip Poker`) is a small, low-risk addition; a stronger in-page pulse
on the acting-player's own action card is also cheap and framework-free.

### P6 — Minor polish items found while testing

- The pot visual's empty state reuses the player-stack "busted" label
  (`renderStackPreview` in `app.js`) for an empty pot before any hand has been played. "You
  are busted" is a confusing thing to imply about a pot that simply hasn't opened yet. Give
  the pot visual its own empty-state copy.
- Stat tiles, pot card, and table-flow card all use similar card chrome (border + soft
  shadow) at a similar size, so nothing but color hints at which is more important —
  reinforces P3/P4.
- `data/state.json` (real local room/session state from dev testing) is currently untracked
  but not gitignored, so a routine `git add -A` would commit it. Add `data/` to
  `.gitignore`.
- Found only after fixing P0 (dark mode never actually rendered before, so this was
  invisible): `input`/`select` elements have no explicit background set, so they render as
  the browser's default bright white in dark mode — jarring, glowing rectangles against an
  otherwise dark UI. Needs an explicit theme-aware background/text/border.

## Implementation phases

1. **Fix the dark-mode CSP bug** (P0). Isolated, high-value, low-risk.
2. **Layout hierarchy**: reorder so actions are reachable without a full scroll on mobile;
   remove the duplicated stat tiles; de-emphasize Table Settings relative to Start
   Hand/actions. (P1)
3. **Color system**: semantic colors for Fold/Check/Call/Raise/All-In; distinguish
   primary vs. secondary/utility button treatment; fix pot-visual contrast. (P2, P3, P4)
4. **Turn-attention cues**: tab title ping + stronger in-page pulse for "it's your turn."
   (P5)
5. **Polish pass**: empty-state copy fixes, spacing/consistency pass, `.gitignore` fix.
   (P6)
6. **Verification**: re-screenshot every changed view (light + dark, waiting/in-hand/
   showdown states) with Playwright before calling this done.
7. **Docs**: update `README.md` and `docs/architecture.md` to describe the app as it
   actually exists today (current feature set, accurate backlog, current CI setup),
   since both are currently describing a much earlier version of the app.

Each phase will be verified against a running instance of the app (not just read as code)
before moving to the next.

## Status: implemented (2026-08-01/02)

All seven phases above shipped in this pass and were re-verified with Playwright
screenshots (light + dark, waiting + in-hand + host-controls states) after implementation,
plus a clean run of `npm run test:pot-regression` to confirm no functional regressions
(the pot/payout logic itself was untouched — only `apps/web/*` changed).

- **P0 (dark mode CSP bug)**: fixed. Theme bootstrap/toggle logic moved from an inline
  `<script>` in `index.html` to `apps/web/src/theme.js`, loaded via `<script src>`. Verified
  `data-theme` actually toggles now; previously it never did under the server's default CSP.
- **Dark-mode input contrast** (found only after P0 unblocked real dark-mode testing):
  fixed. `input`/`select` now use theme tokens instead of the browser-default white
  background. While auditing for the same class of bug, also fixed several other
  hardcoded light-mode-only colors that would have looked broken in dark mode:
  `.player-badge` (dealer/SB/payout), `.status-online`, `.vote-yes`/`.vote-no`, and
  `.vote-pill.open`.
- **P1 (scroll distance to actions)**: fixed. Reordered `apps/web/index.html` so the
  stats row and the Your Actions/Showdown Resolution card render immediately after the
  room header and payout banner, ahead of the blinds/Start Hand strip and the pot/table-flow
  visuals (previously the last things above the actions card). On a 430×900 viewport the
  action buttons are now visible without scrolling at all in the common case.
- **P2 (action button colors)**: fixed. Fold is now a quiet outlined button, Check/Call is
  solid green (`--safe`, matching the existing "called" color language elsewhere in the
  app), Raise is the warm accent, All-In stays red. New `--safe`/`--safe-ink` tokens added
  to both themes.
- **P3 (pot visual contrast)**: fixed. The pot card is now a saturated accent-colored
  gradient (matching the Start Hand button's treatment) instead of a pale tint that blended
  into the page background.
- **P4 (accent overuse)**: fixed for the two clearest offenders — Table Settings (now a
  quiet outlined button so Start Hand reads as the primary action in that row) and Hand
  Rankings (now a quiet link-style button under the action buttons instead of a full-weight
  CTA above them).
- **P5 (your-turn attention)**: fixed. The acting player's own row gets a distinct pulsing
  green ring (`li.my-turn`, separate from the quieter `li.active` used for "someone else is
  acting") plus a "▶ Your turn" badge, and the document title pings
  `● Your turn — No-Chip Poker` while it's your turn. All new animations respect
  `prefers-reduced-motion`.
- **P6 (polish)**: fixed. Pot visual empty state now says "no pot yet" instead of reusing
  the player-stack "busted" copy; `data/` added to `.gitignore`.
- **Docs**: `README.md` and `docs/architecture.md` rewritten to describe the app as it
  exists today (see those files directly).

### Not done in this pass

- P4's broader point — one accent color used for many unrelated things — was addressed for
  the two most visible cases, not swept across every remaining "ghost" button in the app.
  Revisit if teal starts feeling overloaded again as more features are added.
- No audio/vibration cue for turn attention (P5 only covers tab title + in-page pulse) —
  deliberately left out to avoid unrequested autoplay-audio complexity; revisit if the
  visual/title cues turn out to be insufficient in practice.
