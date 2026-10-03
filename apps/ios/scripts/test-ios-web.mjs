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
        Plugins: { Haptics: { impact: (o) => window.__haptics.push(o.style) }, KeepAwake: { keepAwake() { window.__awake = true; }, allowSleep() { window.__awake = false; } } },
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
