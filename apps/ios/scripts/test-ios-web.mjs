// Browser smoke test of the iOS web bundle (apps/ios/www), served the way Capacitor
// will serve it: from an origin that is NOT localhost, talking to a separate game
// server. Uses a stubbed Capacitor haptics plugin to check the native hooks.
// Needs Playwright + Google Chrome (not run in CI):  node apps/ios/scripts/test-ios-web.mjs
import { chromium } from "playwright";
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer, wait } from "../../../scripts/lib/test-harness.mjs";
import { buildIosWeb } from "./build-web.mjs";

process.env.RATE_LIMIT_MAX ||= "1000000";
process.env.BOT_DELAY_MS ||= "60";
const here = path.dirname(fileURLToPath(import.meta.url));
const API_PORT = Number(process.env.IOS_API_PORT || 3097);
const WWW_PORT = Number(process.env.IOS_WWW_PORT || 3098);

let passed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) passed += 1;
  else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".json": "application/json" };
async function serveStatic(dir, port) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    let rel = decodeURIComponent(url.pathname);
    if (rel === "/") rel = "/index.html";
    try {
      const body = await readFile(path.join(dir, rel));
      res.writeHead(200, { "content-type": types[path.extname(rel)] || "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end("not found");
    }
  });
  await new Promise((resolve) => server.listen(port, resolve));
  return server;
}

// A page that pretends to be the native shell (Capacitor + haptics/keep-awake/push stubs) and
// records the Socket.IO events it sends.
async function stubbedPage(browser, origin, name) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const errors = [];
  const sent = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("response", (r) => r.status() >= 400 && !/favicon/.test(r.url()) && errors.push(`${r.status()} ${r.url()}`));
  page.on("websocket", (ws) =>
    ws.on("framesent", ({ payload }) => {
      const text = typeof payload === "string" ? payload : payload.toString();
      if (!text.startsWith("42")) return;
      try { sent.push(JSON.parse(text.slice(2))[1]); } catch { /* not an event */ }
    })
  );
  await page.addInitScript(() => {
    window.__haptics = [];
    window.__push = {};
    window.Capacitor = {
      isNativePlatform: () => true,
      Plugins: {
        Haptics: { impact: (o) => window.__haptics.push(o.style) },
        KeepAwake: { keepAwake() { window.__awake = true; }, allowSleep() { window.__awake = false; } },
        SplashScreen: { hide() { window.__splashHidden = true; } },
        PushNotifications: {
          addListener: (n, cb) => { window.__push[n] = cb; },
          requestPermissions: async () => ({ receive: "granted" }),
          register: () => setTimeout(() => window.__push.registration?.({ value: "ab".repeat(32) }), 30),
        },
      },
    };
  });
  await page.goto(origin);
  return { name, page, errors, sent, context };
}

const www = await buildIosWeb();
const api = await startServer(API_PORT);
const staticServer = await serveStatic(www, WWW_PORT);
const browser = await chromium.launch({ channel: "chrome", headless: true });

try {
  const origin = `http://app.localhost:${WWW_PORT}/?server=${encodeURIComponent(`http://localhost:${API_PORT}`)}`;
  const requests = new Set();
  const pages = [];
  for (const name of ["Host", "Ann"]) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    // (Browsers ask for /favicon.ico on their own; that 404 is not an app error.)
    page.on("response", (r) => r.status() >= 400 && !/favicon/.test(r.url()) && errors.push(`${r.status()} ${r.url()}`));
    page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
    page.on("request", (r) => requests.add(new URL(r.url()).host));
    // Pretend to be the native shell and record haptics calls.
    await page.addInitScript(() => {
      window.__haptics = [];
      window.Capacitor = {
        isNativePlatform: () => true,
        Plugins: { Haptics: { impact: (o) => window.__haptics.push(o.style) }, KeepAwake: { keepAwake() { window.__awake = true; }, allowSleep() { window.__awake = false; } }, SplashScreen: { hide() { window.__splashHidden = true; } } },
      };
    });
    await page.goto(origin);
    pages.push({ name, page, errors });
  }
  const [host, ann] = pages;

  await host.page.fill("#create-display-name", "Host");
  await host.page.click("#create-room-button");
  await host.page.waitForSelector("#room-panel:not(.hidden)", { timeout: 10000 });
  const code = (await host.page.textContent("#room-code")).trim();
  await ann.page.fill("#join-room-code", code);
  await ann.page.fill("#join-display-name", "Ann");
  await ann.page.click("#join-room-button");
  await ann.page.waitForSelector("#room-panel:not(.hidden)", { timeout: 10000 });
  check("rooms work from a non-localhost origin (uses the configured game server)", true);

  const native = await host.page.evaluate(() => ({
    cls: document.documentElement.className,
    vp: document.querySelector('meta[name="viewport"]').content,
    fonts: [...document.fonts].filter((f) => f.status === "loaded").map((f) => f.family.replace(/"/g, "")),
    sel: getComputedStyle(document.body).userSelect,
  }));
  check("native classes applied", /native-app/.test(native.cls) && /native-ios/.test(native.cls), native.cls);
  check("viewport covers the notch area", /viewport-fit=cover/.test(native.vp));
  check("bundled fonts loaded from the app", ["Manrope", "Fraunces", "IBM Plex Mono"].every((f) => native.fonts.includes(f)), native.fonts.join());
  check("text selection is off on the table", native.sel === "none");

  await host.page.click("#start-hand-button");
  await wait(800);
  const hostBuzz = await host.page.evaluate(() => window.__haptics.slice());
  const annBuzz = await ann.page.evaluate(() => window.__haptics.slice());
  check("the player whose turn it is gets a haptic tap", hostBuzz.length + annBuzz.length >= 1, `host ${hostBuzz} ann ${annBuzz}`);
  check("screen is kept awake during a hand", (await host.page.evaluate(() => window.__awake)) === true);

  // Everyone checks/calls down to the flop: the host gets a "cards due" haptic.
  for (let i = 0; i < 8; i += 1) {
    if (await host.page.isVisible("#confirm-deal-button")) break;
    for (const p of [host, ann]) {
      const btn = await p.page.$("#actions-container button[data-action='call'], #actions-container button[data-action='check']");
      if (btn) {
        await btn.click();
        break;
      }
    }
    await wait(500);
  }
  check("host sees the deal button in the iOS bundle too", await host.page.isVisible("#confirm-deal-button"));
  check("host gets a haptic when cards are due", (await host.page.evaluate(() => window.__haptics.includes("MEDIUM"))));

  // ---------- native additions ----------
  check("splash screen is hidden once the page has painted", await host.page.evaluate(() => window.__splashHidden === true));
  check("footer links to privacy, terms and support", (await host.page.$$eval("#native-links a", (as) => as.map((a) => a.getAttribute("href")))).every((h) => /\/legal\/(privacy|terms|support)\.html$/.test(h)));

  // Practice table: one person, a whole table.
  {
    const me = await stubbedPage(browser, origin, "Practice");
    await me.page.fill("#native-practice-name", "Tester");
    await me.page.click("#native-practice-start");
    await me.page.waitForSelector("#room-panel:not(.hidden)", { timeout: 10000 });
    for (let i = 0; i < 40 && (await me.page.$$(".turn-seat")).length < 4; i += 1) await wait(150);
    const seats = await me.page.$$eval(".turn-seat-name", (els) => els.map((e) => e.textContent.trim()));
    check("practice table has the player plus 3 practice players", seats.length === 4 && seats.includes("Tester"), seats.join());
    check("practice room asked the server for bots", me.sent.some((e) => e.type === "add_bots" && e.count === 3));
    for (let i = 0; i < 30 && !me.sent.some((e) => e.type === "register_push_token"); i += 1) await wait(100);
    check("push token was registered after entering the room", me.sent.some((e) => e.type === "register_push_token" && /^[0-9a-f]{64}$/.test(e.token)));
    await me.page.click("#start-hand-button");
    // The human plays; practice players act on their own; the host gets the deal button.
    let dealt = false;
    for (let i = 0; i < 60 && !dealt; i += 1) {
      if (await me.page.isVisible("#confirm-deal-button")) { dealt = true; break; }
      const btn = await me.page.$("#actions-container button[data-action='call'], #actions-container button[data-action='check']");
      if (btn) await btn.click();
      await wait(300);
    }
    check("a practice hand reaches the flop with bots acting by themselves", dealt);

    // Backgrounding the app tells the server.
    await me.page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await wait(200);
    check("going to the background is reported (app_state active=false)", me.sent.some((e) => e.type === "app_state" && e.active === false));
    await me.page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await wait(200);
    check("coming back is reported (app_state active=true)", me.sent.some((e) => e.type === "app_state" && e.active === true));
    check(`no errors on the practice page`, me.errors.length === 0, me.errors.join(" | "));
    await me.context.close();
  }

  // Chat safety tools: report, block, unblock, mute.
  {
    const h = await stubbedPage(browser, origin, "ChatHost");
    await h.page.fill("#create-display-name", "ChatHost");
    await h.page.click("#create-room-button");
    await h.page.waitForSelector("#room-panel:not(.hidden)", { timeout: 10000 });
    const code2 = (await h.page.textContent("#room-code")).trim();
    const a = await stubbedPage(browser, origin, "Ann");
    await a.page.fill("#join-room-code", code2);
    await a.page.fill("#join-display-name", "Ann");
    await a.page.click("#join-room-button");
    await a.page.waitForSelector("#room-panel:not(.hidden)", { timeout: 10000 });
    await a.page.fill("#chat-input", "hello from Ann");
    await a.page.click("#chat-send-button");
    await h.page.waitForSelector("#chat-messages >> text=hello from Ann", { timeout: 8000 });
    await wait(300);
    const actionBtn = h.page.locator("#chat-messages .native-msg-action").first();
    check("other players' messages get an options button", await actionBtn.count() === 1);
    check("your own messages do not", await a.page.locator("#chat-messages .native-msg-action").count() === 0);

    await actionBtn.click();
    const labels = await h.page.$$eval(".native-sheet button", (bs) => bs.map((b) => b.textContent.trim()));
    check("the sheet offers report, block, and (for the host) mute", labels.includes("Report this message") && labels.includes("Block Ann") && labels.some((l) => /^Mute Ann/.test(l)), labels.join(" | "));
    await h.page.click("text=Report this message");
    await h.page.waitForSelector(".native-toast >> text=report was sent", { timeout: 5000 });
    check("reporting confirms with a toast", true);

    await actionBtn.click();
    await h.page.click("text=Block Ann");
    await wait(200);
    const rowHidden = await h.page.$eval("#chat-messages > div", (el) => getComputedStyle(el).display === "none");
    check("a blocked player's messages are hidden", rowHidden);
    check("the blocked list is reachable", await h.page.isVisible("#native-blocked-link"));
    await h.page.click("#native-blocked-link");
    await h.page.click("text=Unblock ann");
    await wait(200);
    check("unblocking brings the messages back", await h.page.$eval("#chat-messages > div", (el) => getComputedStyle(el).display !== "none"));

    await actionBtn.click();
    await h.page.click("text=/^Mute Ann/");
    await wait(300);
    await a.page.fill("#chat-input", "am I muted?");
    await a.page.click("#chat-send-button");
    await wait(600);
    const feedback = (await a.page.textContent("#feedback")) || "";
    check("a muted player is told they are muted", /muted/i.test(feedback), feedback);
    check("no errors on the chat pages", h.errors.length === 0 && a.errors.length === 0, [...h.errors, ...a.errors].join(" | "));
    await h.context.close();
    await a.context.close();
  }

  const hosts = [...requests];
  check("only the app origin and the game server were contacted", hosts.every((h) => h === `app.localhost:${WWW_PORT}` || h === `localhost:${API_PORT}`), hosts.join(", "));
  for (const p of pages) check(`no console errors on ${p.name}`, p.errors.length === 0, p.errors.slice(0, 3).join(" | "));
} catch (error) {
  check("ios web smoke ran to completion", false, error.stack?.split("\n").slice(0, 3).join(" "));
} finally {
  await browser.close();
  staticServer.close();
  await api.stop();
}

console.log(`\nios web: ${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exitCode = 1;
