# iOS release runbook

Do these in order once you have the paid Apple Developer account. Current status of everything else: `docs/ios-app.md`.

## 1. Developer portal (developer.apple.com > Certificates, Identifiers & Profiles)
1. **Identifiers > +** > App IDs > App: description "No-Chip Poker", explicit bundle ID `com.phenomanan.nochippoker`,
   enable the **Push Notifications** capability.
2. **Keys > +**: name "No-Chip Poker APNs", tick **Apple Push Notifications service (APNs)**, continue, download the `.p8`
   (you can download it only once: keep it safe). Note the **Key ID** and your **Team ID** (Membership page).

## 2. Render (poker-chip-tracker-server > Environment)
Add: `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_BUNDLE_ID=com.phenomanan.nochippoker`, `APNS_KEY` (the whole `.p8` text, or its base64:
`base64 -i AuthKey_XXXX.p8`). For development builds also set `APNS_HOST=https://api.sandbox.push.apple.com`; remove it for TestFlight/App Store builds
(those use production). Logs show `[push] APNs not configured` until these are set.

## 3. Xcode
1. `cd apps/ios && npm run sync && npm run open`.
2. Select the **App** target > **Signing & Capabilities**: tick *Automatically manage signing*, choose your Team.
3. **+ Capability > Push Notifications** (this adds `App.entitlements` with `aps-environment`; commit it).
4. Run on your iPhone (plug in, trust the computer, select it as the destination) and on the Simulator.
5. Check on the phone: practice table, haptic buzz on your turn, notification prompt, and a background push
   (join a room from the Mac/browser, background the app, wait for your turn; needs the Render env above).

## 4. App Store Connect (appstoreconnect.apple.com)
1. **Apps > + > New App**: iOS, name *No-Chip Poker*, language English, bundle ID from the list, SKU `nochippoker-ios-1`.
2. Fill the listing from `docs/ios-listing.md` (subtitle, description, keywords, URLs, categories, age rating, App Privacy).
3. Screenshots: upload the 6.9" set from `apps/ios/store/screenshots/`.
4. Add the review notes and your contact details under **App Review Information**.

## 5. Build and upload
1. In Xcode choose **Any iOS Device (arm64)** and **Product > Archive**.
2. In the Organizer: **Distribute App > App Store Connect > Upload**.
3. In App Store Connect: **TestFlight** tab: add yourself as an internal tester, install via the TestFlight app, test again.
   For friends: create an external group (needs a short Beta App Review) and share the public link.
4. When happy: **App Store** tab > add the build > **Submit for Review**. Review usually takes 1-2 days.

## 6. After release
- Web changes ship instantly through GitHub Pages; the iOS app picks them up on the next `npm run sync` + new build.
- Server changes (Render) apply to web and iOS immediately.
- Bump `MARKETING_VERSION` / `CURRENT_PROJECT_VERSION` in Xcode for every new upload.
