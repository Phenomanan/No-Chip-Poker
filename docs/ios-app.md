# iOS app

Status: scaffolded (2026-10-02). Builds nothing yet on this Mac: **Xcode is not installed** and the Apple Developer
account is not set up. Everything below the "Next steps" list works today without them.

## The one rule: the web app is never touched

`apps/web` is the live site (GitHub Pages) and stays exactly as it is. The iOS app is its own project in
`apps/ios` and is built from a **copy** of the web files plus an iOS-only overlay:

```
apps/web/                 unchanged, deployed by .github/workflows/deploy-pages.yml
apps/ios/
  overlay/                iOS-only files layered over a copy of apps/web
    bootstrap.js          replaces the web bootstrap: no CDN, loads the bundled Socket.IO client
    native.js             haptics on your turn, keep-awake during a hand, reconnect on resume
    native.css            bundled fonts, safe-area (notch/home bar), no text selection/rubber-banding
    fonts/ vendor/        Fraunces / Manrope / IBM Plex Mono (woff2), socket.io client
  scripts/build-web.mjs   copies apps/web -> apps/ios/www (read-only on apps/web) and applies the overlay
  scripts/test-ios-build.mjs   guard: apps/web unchanged, shared files copied verbatim, no third-party hosts
  scripts/test-ios-web.mjs     browser smoke test of the iOS bundle (Playwright + Chrome, not in CI)
  scripts/make-assets.mjs      renders assets/icon.svg + splash.svg into the Xcode asset catalog
  capacitor.config.json   app id/name, hostname, status bar, splash
  ios/                    the Xcode project (Capacitor 8, Swift Package Manager, no CocoaPods)
  www/                    generated, git-ignored
```

Improvements made to the web app later (new UI, rules, fixes) flow into the iOS app automatically on the next
`npm run sync`. If the iOS app ever needs to diverge a lot, the overlay can grow into a real fork; the build
guard test makes sure that choice is deliberate.

The page is served inside the app from `capacitor://app.nochippoker` (not `localhost`), which is why the unmodified
`app.js` talks to the configured game server (`SERVER_URL` in `apps/web/src/config.js`) instead of itself.
**Server requirement:** add `capacitor://app.nochippoker` to the backend's `CORS_ORIGINS` before the app can connect.

## Commands

```bash
cd apps/ios
npm install
npm run build:web      # assemble www/
npm run sync           # build:web + cap sync ios (copies www into the Xcode project, updates plugins)
npm run open           # opens Xcode (needs Xcode installed)
npm run test:build     # fast guard (also runs in CI via the root `npm run test:ios-build`)
npm run test:web       # browser smoke test of the bundle (needs Playwright + Chrome)
```

## Configured for the App Store
- iPhone only (`TARGETED_DEVICE_FAMILY = 1`, so no iPad screenshots), portrait only, iOS 16+.
- `ITSAppUsesNonExemptEncryption = false` (HTTPS only, no custom crypto).
- Real icon (1024px, no alpha) and splash, generated from `assets/*.svg`.
- Placeholder bundle id `com.nochippoker.app` and version 1.0 (1). **Change the bundle id** in
  `capacitor.config.json` and in Xcode once your Apple account exists (it must be unique to you).

## Next steps (need you)
1. Enroll in the Apple Developer Program; install Xcode; pick the real bundle id.
2. Backend: always-on hosting with a persistent disk, add the app origin to `CORS_ORIGINS`.
3. In Xcode: sign with your team, run on the Simulator and a real iPhone, then upload to TestFlight.
4. Push notifications, practice bots, chat report/block, privacy policy and App Store listing (see the plan:
   `/Users/naan/.claude/plans/iridescent-hugging-heron.md`).

## Accounts and money: decisions

Agreed with the owner (2026-10-02):
- **Guest play is the default; sign-in is optional** (Sign in with Apple first).
- **Money:** a **tip jar** and a **one-time "Pro" purchase** that unlocks **saved table settings** (blind structures,
  stack sizes, etc.) and **stats**. No ads at the table. The web app stays free, guest-only and ad-free.
- Neither accounts nor purchases block the first release; they ship in v1.1 (see the sequence at the bottom).

Pro and the tip jar are native in-app purchases (StoreKit), so they need the Apple Developer account and App Store
Connect products. Saved settings and stats must follow the player across devices, which is what the optional account is for
(guests can use Pro on one device; signing in syncs it, and "Restore Purchases" is required either way).

The reasoning behind those choices, for reference:

### Accounts / login
- Keep **guest play as the default**: join by room code, type a name, play. That is the whole appeal at a game night.
- Offer an **optional account with Sign in with Apple** (Apple requires it as soon as you offer any other social
  login; it is also the lowest-friction option and hides the user's email). Add email or Google later if needed.
- What an account buys: a stable name/avatar, hand and session history, "my tables", friends, restoring purchases
  on a new phone, and a way to ban abusive users (which also helps with Apple's user-generated-content rules).
- What it costs: a real database (the server today is in-memory plus a JSON file), session tokens, a privacy policy,
  and **in-app account deletion** (required by Apple). It is a server feature, so the web app could use it too;
  the web app stays guest-only unless you decide otherwise.

### Making money
- Reality check: this is a utility for a friend group. Ad income at that scale is tiny, and banner or video ads
  on a live poker table hurt exactly the thing people like about the app.
- Rules to plan around: digital unlocks must use Apple in-app purchase (15% fee under the Small Business Program),
  personalized ads need the App Tracking Transparency prompt and EU consent, the app will rate 17+ (simulated
  gambling) which limits ad categories, and chips here have no cash value so there is nothing sensible to sell as
  "chips".
- Recommendation, in order:
  1. **Free, no ads at the table.** The web app stays free and ad-free.
  2. **One-time "Pro" in-app purchase** (non-consumable): extra felt/chip themes, hand history and session stats,
     saved blind structures, larger tables, export of the night's results. Optional tip jar.
  3. If ads are wanted at all: a small banner on the lobby/home screen only, or an opt-in "watch an ad for a
     cosmetic". Test it after launch, not before.

### Sequence
1. TestFlight with friends: guest only, no purchases.
2. v1.0 on the App Store: free, guest, push notifications, practice table, report/block.
3. v1.1: optional Sign in with Apple + accounts backend; "Pro" one-time purchase (saved table settings, stats) and a tip jar.
4. Ads are off the table unless that changes.
