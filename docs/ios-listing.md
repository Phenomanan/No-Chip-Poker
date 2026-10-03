# App Store listing (draft, ready to paste into App Store Connect)

Everything here matches what the app actually does. Items marked **YOU** need your input.

## Basics
| Field | Value |
| --- | --- |
| App name (30 max) | No-Chip Poker |
| Subtitle (30 max) | Poker night chip tracker |
| Bundle ID | com.phenomanan.nochippoker |
| SKU | nochippoker-ios-1 |
| Primary category | Entertainment (alternative: Utilities) |
| Secondary category | Utilities |
| Price | Free |
| Version / build | 1.0 (1) |
| Copyright | 2026 **YOU** (your legal name) |
| Support URL | https://phenomanan.github.io/No-Chip-Poker/legal/support.html |
| Marketing URL | https://phenomanan.github.io/No-Chip-Poker/ |
| Privacy Policy URL | https://phenomanan.github.io/No-Chip-Poker/legal/privacy.html |
| Support email (reachable contact, recommended) | **YOU** |

## Promotional text (170 max)
Play poker with a real deck and no physical chips. Track stacks, blinds and pots for your whole table, live on everyone's phone.

## Keywords (100 max, comma separated, no spaces after commas)
`texas,holdem,blinds,home game,bank,pot,stack,dealer,cash game,tournament,friends,table,bet,raise`

## Description
No-Chip Poker keeps score for poker night so you can play with a real deck and no physical chips.

One person creates a table, everyone else joins with a 6-letter code, and every phone shows the same live table: stacks, bets, pots, blinds and whose turn it is.

- Fold, check, call, raise or go all in with a tap, with correct turn order, the big blind's option and side pots
- "Cards dealt" confirmation for the flop, turn and river, so betting waits for the real cards
- Host tools: set blinds, an optional blind timer and blind-doubling votes, drag players to reorder the table, remove players, and declare winners (including split pots)
- Practice Table: play a full hand on your own against practice players
- Optional alerts when it's your turn
- Rejoin automatically if you lose your connection
- Table chat with report, block and mute tools
- No accounts, no ads, no tracking

No real money: chips in No-Chip Poker have no cash value. The app does not deal cards or move money. It only keeps score for your game.

## What's New (1.0)
First release.

## Age rating questionnaire (answer honestly; Apple computes the rating)
- Simulated gambling (poker with play chips): **Frequent/Intense**. Expect a high rating (17+/18+).
- Real-money gambling / contests: None.
- User-generated content (table chat): Yes. Moderation: report, block, mute, word filter.
- Unrestricted web access: No. Violence, sexual content, profanity authored by us: None.

## App Privacy ("nutrition label")
- Data used to track you: **No**.
- Data collected, **not linked to you**, **not used for tracking**, purpose *App Functionality*:
  - Other User Content (chat messages)
  - Identifiers > Device ID (the push notification token; only if you allow notifications)
  - Contact Info > Name (the display name you type; it is a nickname, not an account)
- No analytics, advertising, location, contacts or purchases data.
- Mirrors `apps/ios/ios/App/App/PrivacyInfo.xcprivacy` and the privacy policy page.

## Export compliance
Uses only standard HTTPS. `ITSAppUsesNonExemptEncryption` is set to `false`, so no extra paperwork.

## App Review notes (paste into "Notes")
No login is needed. To try everything on your own:
1. Open the app and tap **Start Practice Table**, enter any name. (Allow or decline notifications; both work.)
2. Tap **Start Hand**. You act with the buttons at the bottom (Fold/Check/Call/Raise/All In); the practice players act by themselves.
3. After each betting round the host (you) deals the flop/turn/river with a real deck in real life; in the app, tap the gold button "Flop dealt ... start betting".
4. At showdown choose the winner(s) and tap **Declare Winner(s)**; the chips are paid out.
5. Chat safety: practice players post a welcome message. Tap the "..." next to it to **Report** or **Block** (as host you also see **Mute**).
The app does not deal cards or handle real money; chips have no cash value. Privacy policy, terms and support are linked at the bottom of the first screen.

## Screenshots
Ready in `apps/ios/store/screenshots/6.9in/` (1320x2868, JPEG, no transparency: the required 6.9" iPhone size; Apple scales it
down for smaller phones). Upload them in this order:
1. `01-front-screen.jpg`: front screen with the Practice Table card
2. `02-live-table.jpg`: live table with chip stacks around the pot
3. `03-your-turn.jpg`: your turn (acting glow, bet pill, Call/Raise/All In)
4. `04-deal-gate.jpg`: the host's "Flop dealt" confirmation
5. `05-showdown.jpg`: showdown winner picker
6. `06-payout.jpg`: payout complete ("Tester wins 800!")

They were captured on the iPhone 18 Pro simulator (6.3", originals in `6.3in-native/`) with a 9:41 status bar and scaled to the
6.9" size. If you want pixel-perfect 6.9" captures, approve the "iPhone 18 Pro Max" simulator in the simulator panel and ask for a re-capture.
