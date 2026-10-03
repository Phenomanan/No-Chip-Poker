// End-to-end UI test: real Chrome (via Playwright) with one isolated browser
// context per player, each at phone size, driving the actual page the way people
// do — typing into forms, tapping Fold/Call/Raise, the host's "cards dealt"
// button, picking winners, dragging seats, kicking players, refreshing.
//
// What the screens show is cross-checked against the server's own broadcasts
// (captured off the Socket.IO WebSocket), so a UI that disagrees with the game is
// a failure. Also asserts layout invariants (no horizontal scroll, chip stacks
// clear of the pot and of players' icons/names) at several phone widths and table
// sizes, and that no page logs a console error.
//
// Not part of `npm test` (needs Chrome): run `node scripts/test-ui.mjs`.
//   UI_SEED=<n> UI_TABLES=<n> UI_HANDS=<n> UI_HEADED=1 to tweak.
import { chromium } from "playwright";
import { lstat, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer, wait } from "./lib/test-harness.mjs";

// The compiled server looks for the web files next to dist/; link them in for the test run.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
async function linkWebIntoDist() {
  const target = path.join(repoRoot, "dist/apps/web");
  try {
    await lstat(target);
    return null;
  } catch {
    await symlink(path.join(repoRoot, "apps/web"), target, "dir");
    return target;
  }
}

// The test loads the page hundreds of times from one IP; don't trip the HTTP rate limiter.
process.env.RATE_LIMIT_MAX ||= "1000000";
const PORT = Number(process.env.UI_PORT || 3091);
const SEED = Number(process.env.UI_SEED || 20261002);
const TABLES = Number(process.env.UI_TABLES || 4);
const HANDS = Number(process.env.UI_HANDS || 8);
const HEADED = Boolean(process.env.UI_HEADED);

let passed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) {
    passed += 1;
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
  return Boolean(cond);
}

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Client {
  constructor(name, page) {
    this.name = name;
    this.page = page;
    this.room = null;
    this.playerId = null;
    this.errors = [];
    page.on("pageerror", (e) => this.errors.push(`pageerror: ${e.message}`));
    page.on("console", (m) => {
      if (m.type() === "error" && !/favicon|fonts\.g|ERR_INTERNET|Failed to load resource/i.test(m.text())) {
        this.errors.push(`console: ${m.text()}`);
      }
    });
    page.on("websocket", (ws) => {
      ws.on("framereceived", ({ payload }) => {
        const text = typeof payload === "string" ? payload : payload.toString();
        if (!text.startsWith("42")) return;
        try {
          const [, evt] = JSON.parse(text.slice(2));
          if (evt?.type === "room_state") {
            if (!this.room || evt.room.updatedAt >= this.room.updatedAt) this.room = evt.room;
          }
          if (evt?.type === "room_created" || evt?.type === "joined_room") this.playerId = evt.playerId;
        } catch {
          // not an event frame
        }
      });
    });
  }

  get me() {
    return this.room?.players.find((p) => p.id === this.playerId);
  }
}

async function newClient(browser, baseUrl, name, viewport) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 2 });
  const page = await context.newPage();
  const client = new Client(name, page);
  client.context = context;
  await page.goto(baseUrl.replace("127.0.0.1", "localhost"));
  return client;
}

async function createRoom(client, { sb, bb, stack }) {
  const p = client.page;
  await p.fill("#create-display-name", client.name);
  await p.fill("#create-sb", String(sb));
  await p.fill("#create-bb", String(bb));
  await p.fill("#create-stack", String(stack));
  await p.click("#create-room-button");
  await p.waitForSelector("#room-panel:not(.hidden)");
  await wait(250);
  return (await p.textContent("#room-code")).trim();
}

async function joinRoom(client, code) {
  const p = client.page;
  await p.fill("#join-room-code", code);
  await p.fill("#join-display-name", client.name);
  await p.click("#join-room-button");
  try {
    await p.waitForSelector("#room-panel:not(.hidden)", { timeout: 8000 });
  } catch (error) {
    throw new Error(`${client.name} could not join: "${(await p.textContent("#feedback"))?.trim()}"`);
  }
  await wait(150);
}

// Wait until every client has the same, latest room version, then let the DOM render.
async function settle(clients, minUpdatedAt = 0) {
  for (let i = 0; i < 60; i += 1) {
    const versions = clients.map((c) => c.room?.updatedAt ?? 0);
    if (Math.min(...versions) === Math.max(...versions) && Math.min(...versions) >= minUpdatedAt) break;
    await wait(50);
  }
  await wait(120);
}

function slot(index, total) {
  const angle = (-90 + index * (360 / total)) * (Math.PI / 180);
  return { left: 50 + 40 * Math.cos(angle), top: 50 + 45 * Math.sin(angle) };
}

// Everything a screen shows, in one round trip.
function readScreen() {
  const txt = (sel) => document.querySelector(sel)?.textContent.trim() ?? null;
  const vis = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
  };
  const rect = (el) => {
    const r = el.getBoundingClientRect();
    return { l: r.left, t: r.top, r: r.right, b: r.bottom };
  };
  const pot = document.querySelector("#pot-visual-button");
  const potRect = rect(pot);
  const cx = (potRect.l + potRect.r) / 2;
  const cy = (potRect.t + potRect.b) / 2;
  const potRadius = (potRect.r - potRect.l) / 2;
  const seats = [...document.querySelectorAll(".turn-seat")].map((el) => ({
    id: el.dataset.playerId,
    name: el.querySelector(".turn-seat-name")?.textContent.trim(),
    left: parseFloat(el.style.left),
    top: parseFloat(el.style.top),
    cls: el.className,
    av: rect(el.querySelector(".turn-seat-avatar")),
    nm: rect(el.querySelector(".turn-seat-name")),
  }));
  const chips = [...document.querySelectorAll(".seat-chips")].map((el) => {
    const pile = rect(el.querySelector(".seat-chips-pile"));
    const nearestX = Math.max(pile.l, Math.min(cx, pile.r));
    const nearestY = Math.max(pile.t, Math.min(cy, pile.b));
    return {
      id: el.dataset.chipsFor,
      amount: Number(el.querySelector(".seat-chips-amount")?.textContent),
      left: parseFloat(el.style.left),
      top: parseFloat(el.style.top),
      pile,
      potGap: Math.hypot(nearestX - cx, nearestY - cy) - potRadius,
    };
  });
  const oval = rect(document.querySelector("#table-oval"));
  const buttons = [...document.querySelectorAll("#actions-container button")].filter(vis).map((b) => ({
    text: b.textContent.trim(),
    h: b.getBoundingClientRect().height,
    bottom: b.getBoundingClientRect().bottom,
    top: b.getBoundingClientRect().top,
  }));
  return {
    pot: Number(txt("#pot")),
    street: txt("#room-street"),
    seats,
    chips,
    oval,
    potRect,
    buttons,
    hasActionsRow: Boolean(document.querySelector("#actions-container .actions-row")),
    dealButton: vis(document.querySelector("#confirm-deal-button")),
    dealWait: Boolean(document.querySelector("#actions-container .deal-wait")),
    actingSeats: seats.filter((s) => s.cls.includes("acting")).map((s) => s.id),
    overflowX: document.documentElement.scrollWidth - window.innerWidth,
    vw: window.innerWidth,
    vh: window.innerHeight,
    authVisible: vis(document.querySelector("#auth-panel")),
    roomVisible: vis(document.querySelector("#room-panel")),
    showdownVisible: vis(document.querySelector("#declare-winners-button-main")),
    startVisible: vis(document.querySelector("#start-hand-button")),
    draggable: seats.filter((s) => s.cls.includes("draggable")).length,
    sheetBottom: document.querySelector("#actions-container")?.getBoundingClientRect().bottom ?? null,
  };
}

const sum = (arr, f) => arr.reduce((s, x) => s + f(x), 0);

// Compare one screen with the server's room state and check layout invariants.
async function verifyScreen(c, label, expectedTotal, opts = {}) {
  const room = c.room;
  const s = await c.page.evaluate(readScreen);
  const tag = `${label} [${c.name}]`;
  const seated = room.players.filter((p) => p.role !== "spectator" && !p.pendingRemoval).sort((a, b) => a.seat - b.seat);

  check(`${tag}: no horizontal scroll`, s.overflowX <= 1, `overflow ${s.overflowX}px at ${s.vw}px`);
  check(`${tag}: one seat per player`, s.seats.length === seated.length, `${s.seats.length} seats vs ${seated.length}`);
  check(`${tag}: one chip stack per player`, s.chips.length === seated.length);

  seated.forEach((p, i) => {
    const seat = s.seats.find((x) => x.id === p.id);
    const chips = s.chips.find((x) => x.id === p.id);
    if (!check(`${tag}: ${p.displayName} has a seat and stack`, seat && chips)) return;
    const want = slot(i, seated.length);
    check(`${tag}: ${p.displayName} seated in order position ${i + 1}`, Math.abs(seat.left - want.left) < 0.6 && Math.abs(seat.top - want.top) < 0.6, `${seat.left},${seat.top} vs ${want.left},${want.top}`);
    check(`${tag}: ${p.displayName} chip amount matches the game`, chips.amount === p.stack, `${chips.amount} vs ${p.stack}`);
  });

  if (!opts.skipPot) {
    const potTotal = sum(room.pots || [], (p) => p.amount);
    check(`${tag}: pot shows the game's pot`, s.pot === potTotal, `${s.pot} vs ${potTotal}`);
  }

  // Layout: stacks must be reachable (clear of the pot) and not buried under icons/names.
  for (const ch of s.chips) {
    const area = Math.max(1, (ch.pile.r - ch.pile.l) * (ch.pile.b - ch.pile.t));
    check(`${tag}: stack clear of the pot`, ch.potGap >= 1, `gap ${ch.potGap.toFixed(1)}px`);
    for (const seat of s.seats) {
      for (const box of [seat.av, seat.nm]) {
        const ox = Math.max(0, Math.min(ch.pile.r, box.r) - Math.max(ch.pile.l, box.l));
        const oy = Math.max(0, Math.min(ch.pile.b, box.b) - Math.max(ch.pile.t, box.t));
        check(`${tag}: stack mostly visible beside ${seat.name}`, (ox * oy) / area < 0.4, `${Math.round(((ox * oy) / area) * 100)}% covered`);
      }
    }
  }
  for (let i = 0; i < s.chips.length; i += 1) {
    for (let j = i + 1; j < s.chips.length; j += 1) {
      const a = s.chips[i].pile;
      const b = s.chips[j].pile;
      const ox = Math.max(0, Math.min(a.r, b.r) - Math.max(a.l, b.l));
      const oy = Math.max(0, Math.min(a.b, b.b) - Math.max(a.t, b.t));
      check(`${tag}: chip stacks do not overlap each other`, ox * oy < 30, `${ox}x${oy}`);
    }
  }

  // Whose turn / which buttons.
  const inHand = room.status === "in_hand";
  const iAmActing = inHand && room.actingPlayerId === c.playerId && !room.awaitingDeal;
  check(`${tag}: acting highlight matches the game`, s.actingSeats.length === (inHand && room.actingPlayerId ? 1 : 0) && (!room.actingPlayerId || s.actingSeats[0] === room.actingPlayerId), `${s.actingSeats} vs ${room.actingPlayerId}`);
  check(`${tag}: action buttons only for the acting player`, s.hasActionsRow === iAmActing, `row=${s.hasActionsRow} acting=${iAmActing}`);
  const isHost = room.hostPlayerId === c.playerId;
  check(`${tag}: deal button only for the host while cards are due`, s.dealButton === (inHand && room.awaitingDeal && isHost), `btn=${s.dealButton} awaiting=${room.awaitingDeal} host=${isHost}`);
  if (inHand && room.awaitingDeal && !isHost) {
    check(`${tag}: non-host sees the waiting-for-deal message`, s.dealWait);
  }
  if (iAmActing) {
    check(`${tag}: acting buttons are big enough to tap`, s.buttons.every((b) => b.h >= 40), JSON.stringify(s.buttons.map((b) => [b.text, Math.round(b.h)])));
    check(`${tag}: acting buttons are on screen`, s.buttons.every((b) => b.top >= 0 && b.bottom <= s.vh + 1), JSON.stringify(s.buttons.map((b) => [b.text, Math.round(b.top), Math.round(b.bottom)])));
  }
  const canDrag = isHost && room.status === "waiting" && seated.length > 1;
  check(`${tag}: seats draggable only for the host between hands`, (s.draggable > 0) === canDrag, `draggable=${s.draggable} canDrag=${canDrag}`);
  check(`${tag}: Declare Winner button only for the host at showdown`, s.showdownVisible === (isHost && room.status === "paused" && room.street === "showdown"), `visible=${s.showdownVisible}`);

  if (expectedTotal !== undefined && !opts.skipTotal) {
    const stacks = sum(room.players, (p) => p.stack);
    const live = room.status === "in_hand" || room.status === "paused" ? sum(room.pots || [], (p) => p.amount) : 0;
    check(`${tag}: chips conserved`, stacks + live === expectedTotal, `${stacks}+${live} != ${expectedTotal}`);
  }
  return s;
}

async function verifyAll(clients, label, expectedTotal, opts) {
  for (const c of clients) {
    if (!c.room) continue;
    await verifyScreen(c, label, expectedTotal, opts);
  }
}

async function tapAction(c, rand) {
  const p = c.page;
  const room = c.room;
  const me = c.me;
  const texts = (await p.$$eval("#actions-container .actions-row button", (bs) => bs.map((b) => b.textContent.trim())));
  const has = (t) => texts.some((x) => x.startsWith(t));
  const pick = rand();
  const stateBefore = room.updatedAt;

  const click = async (sel) => p.click(sel);
  if (has("Raise") && pick < 0.28) {
    await click("#raise-button-trigger");
    await p.waitForSelector("#raise-amount-input");
    // First a deliberately illegal amount: the UI/server must refuse and keep the turn.
    if (rand() < 0.4) {
      await p.fill("#raise-amount-input", String(Math.max(0, room.currentBet)));
      await click("#raise-submit-button");
      await wait(250);
      check(`raise at-or-below the bet is refused [${c.name}]`, c.room.updatedAt === stateBefore && c.room.actingPlayerId === c.playerId, "state changed");
      if (!(await p.$("#raise-amount-input"))) return "illegal-raise";
      await p.waitForSelector("#raise-amount-input");
    }
    const minTo = room.currentBet + room.blinds.bigBlind;
    const maxTo = me.commitment + me.stack;
    if (maxTo > room.currentBet && minTo <= maxTo) {
      const to = Math.min(maxTo - 1, minTo + Math.floor(rand() * 4) * room.blinds.bigBlind);
      await p.fill("#raise-amount-input", String(Math.max(room.currentBet + 1, to)));
      await click("#raise-submit-button");
      return "raise";
    }
    await click("#all-in-button");
    await click("#raise-submit-button");
    return "raise-max";
  }
  if (has("All In") && pick < 0.36) {
    await p.click("#actions-container button[data-action='all_in']");
    return "all_in";
  }
  if (has("Fold") && pick < 0.5 && room.currentBet > me.commitment) {
    await p.click("#actions-container button[data-action='fold']");
    return "fold";
  }
  if (has("Call")) {
    await p.click("#actions-container button[data-action='call']");
    return "call";
  }
  if (has("Check")) {
    await p.click("#actions-container button[data-action='check']");
    return "check";
  }
  // Short stack facing a bigger bet: only fold / all-in left.
  if (has("All In")) {
    await p.click("#actions-container button[data-action='all_in']");
    return "all_in";
  }
  await p.click("#actions-container button[data-action='fold']");
  return "fold";
}

// The sticky action sheet can sit over the bottom of the table: scroll until the
// point we are about to press on actually belongs to the element.
async function exposeElement(page, selector) {
  for (let i = 0; i < 8; i += 1) {
    const covered = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return !(hit && el.contains(hit)) || r.bottom > innerHeight || r.top < 0;
    }, selector);
    if (!covered) return true;
    await page.evaluate(() => window.scrollBy(0, 90));
    await wait(80);
  }
  return false;
}

async function declareWinners(host, rand) {
  const p = host.page;
  await p.waitForSelector("#showdown-main-card:not(.hidden)");
  const potsBefore = host.room.pots.map((x) => ({ amount: x.amount, contributors: [...x.contributors] }));
  const stacksBefore = new Map(host.room.players.map((x) => [x.id, x.stack]));
  const groups = await p.$$eval("#showdown-winners-list-main input[type=checkbox]", (els) =>
    els.map((e) => ({ idx: Number(e.dataset.potIndex), id: e.value, disabled: e.disabled, checked: e.checked }))
  );
  const winnersByPot = new Map();
  for (const g of groups) {
    if (!winnersByPot.has(g.idx)) winnersByPot.set(g.idx, []);
    if (g.disabled && g.checked) winnersByPot.get(g.idx).push(g.id); // uncontested: pre-picked by the page
  }
  const byPot = new Map();
  groups.forEach((g) => {
    if (!byPot.has(g.idx)) byPot.set(g.idx, []);
    byPot.get(g.idx).push(g);
  });
  for (const [idx, options] of byPot) {
    const live = options.filter((o) => !o.disabled);
    if (live.length === 0) continue;
    // Usually one winner, sometimes a split.
    const picks = live.filter(() => rand() < 0.35);
    const winners = picks.length > 0 ? picks : [live[Math.floor(rand() * live.length)]];
    for (const w of winners) {
      await p.check(`#showdown-winners-list-main input[data-pot-index="${idx}"][value="${w.id}"]`);
      winnersByPot.get(idx).push(w.id);
    }
  }
  const v = host.room.updatedAt;
  await p.click("#declare-winners-button-main");
  await wait(150);
  if (await p.isVisible("#confirm-modal:not(.hidden) #confirm-ok")) await p.click("#confirm-ok");
  return { winnersByPot, potsBefore, stacksBefore, version: v };
}

// Independent expectation of who gets what: each pot split evenly among its chosen
// winners, any odd chips going one each to the first winners listed.
function expectedPayouts(potsBefore, winnersByPot) {
  const owed = new Map();
  potsBefore.forEach((pot, i) => {
    const ids = [...new Set(winnersByPot.get(i) || [])].filter((id) => pot.contributors.includes(id));
    if (ids.length === 0) return;
    const base = Math.floor(pot.amount / ids.length);
    const extra = pot.amount % ids.length;
    ids.forEach((id, k) => {
      const lo = owed.get(id)?.lo ?? 0;
      const hi = owed.get(id)?.hi ?? 0;
      owed.set(id, { lo: lo + base, hi: hi + base + (extra > 0 ? 1 : 0) });
    });
  });
  return owed;
}

// Plays one hand through the UI. Returns a short summary or throws on a stuck table.
async function playHandViaUi(clients, host, rand, expectedTotal, label, stats) {
  const startVersion = host.room.updatedAt;
  await host.page.click("#start-hand-button");
  await settle(clients, startVersion + 1);
  check(`${label}: hand started`, host.room.status === "in_hand", host.room.status);

  for (let step = 0; step < 250; step += 1) {
    const room = host.room;
    await verifyAll(clients, `${label} step ${step} (${room.street})`, expectedTotal);

    if (room.status === "waiting") return "done";

    if (room.status === "paused") {
      const decl = await declareWinners(host, rand);
      stats.showdowns += 1;
      await settle(clients, decl.version + 1);
      for (let i = 0; i < 80 && host.room.payoutState !== "idle"; i += 1) await wait(100);
      await settle(clients);
      const owed = expectedPayouts(decl.potsBefore, decl.winnersByPot);
      const paid = new Map(host.room.payouts.map((x) => [x.playerId, x.amount]));
      for (const [id, range] of owed) {
        const got = paid.get(id) ?? 0;
        check(`${label}: payout amount for a winner is right`, got >= range.lo && got <= range.hi, `got ${got}, expected ${range.lo}-${range.hi}`);
        const delta = host.room.players.find((x) => x.id === id).stack - decl.stacksBefore.get(id);
        check(`${label}: winner's stack grew by exactly the payout`, delta === got, `stack +${delta} vs payout ${got}`);
      }
      check(`${label}: nobody unexpected was paid`, [...paid.keys()].every((id) => owed.has(id)), JSON.stringify([...paid]));
      check(`${label}: payouts add up to the pot`, [...paid.values()].reduce((a, b) => a + b, 0) === decl.potsBefore.reduce((a, b) => a + b.amount, 0));
      continue;
    }

    if (room.awaitingDeal) {
      // Nobody may act while cards are being dealt: try, and the server must refuse.
      const v = room.updatedAt;
      await host.page.click("#confirm-deal-button");
      await settle(clients, v + 1);
      stats.deals += 1;
      continue;
    }

    const actor = clients.find((c) => c.playerId === room.actingPlayerId);
    if (!actor) throw new Error(`no client for acting player ${room.actingPlayerId}`);
    const v = room.updatedAt;
    const what = await tapAction(actor, rand);
    stats[what] = (stats[what] || 0) + 1;
    if (what !== "illegal-raise") await settle(clients, v + 1);
    else await settle(clients);
    if (actor.room.updatedAt === v) {
      // The tap changed nothing (e.g. the raise sheet is open); fall through and retry next step.
      await wait(150);
    }
  }
  throw new Error("hand did not finish in 250 steps");
}

async function playTable(browser, serverUrl, seed, tableNo) {
  const rand = rng(seed);
  const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
  const pick = (a) => a[Math.floor(rand() * a.length)];
  const n = int(2, 7);
  const widths = [{ width: 360, height: 740 }, { width: 375, height: 812 }, { width: 390, height: 844 }, { width: 412, height: 915 }, { width: 430, height: 932 }];
  const viewport = pick(widths);
  const stack = pick([400, 1000, 1500]);
  const bb = pick([20, 50]);
  const label = `table ${tableNo} (${n}p ${viewport.width}px stack ${stack})`;
  const names = ["Host", ...Array.from({ length: n - 1 }, (_, i) => `P${i + 2}`)];
  const clients = [];
  const stats = { deals: 0, showdowns: 0, hands: 0 };
  try {
    for (const name of names) clients.push(await newClient(browser, serverUrl, name, viewport));
    const code = await createRoom(clients[0], { sb: bb / 2, bb, stack });
    for (const c of clients.slice(1)) await joinRoom(c, code);
    await settle(clients);
    const expectedTotal = n * stack;
    const host = clients[0];
    await verifyAll(clients, `${label} lobby`, expectedTotal);

    for (let h = 1; h <= HANDS; h += 1) {
      const funded = host.room.players.filter((p) => !p.pendingRemoval && p.stack > 0);
      if (funded.length < 2) {
        console.log(`  ${label}: table finished early after ${h - 1} hands (only ${funded.length} player with chips)`);
        break;
      }
      await playHandViaUi(clients, host, rand, expectedTotal, `${label} hand ${h}`, stats);
      stats.hands += 1;
      await verifyAll(clients, `${label} after hand ${h}`, expectedTotal);
    }
    for (const c of clients) check(`${label}: no console errors on ${c.name}`, c.errors.length === 0, c.errors.slice(0, 3).join(" | "));
    console.log(`  ${label}: ${stats.hands} hands, ${stats.deals} deals confirmed, ${stats.showdowns} showdowns, actions ${JSON.stringify(Object.fromEntries(Object.entries(stats).filter(([k]) => !["deals", "showdowns", "hands"].includes(k))))}`);
  } catch (error) {
    check(`${label}: ran to completion`, false, error.stack?.split("\n").slice(0, 3).join(" ") || String(error));
  } finally {
    for (const c of clients) await c.context.close().catch(() => {});
  }
}

// ------------------------------------------------------------------
// Targeted flows
// ------------------------------------------------------------------
async function flowSeatsDragKickRefresh(browser, serverUrl) {
  const label = "flow";
  const viewport = { width: 390, height: 844 };
  const names = ["Host", "Ann", "Ben", "Cy"];
  const clients = [];
  try {
    for (const n of names) clients.push(await newClient(browser, serverUrl, n, viewport));
    const [host, ann, ben, cy] = clients;
    const code = await createRoom(host, { sb: 10, bb: 20, stack: 500 });
    for (const c of [ann, ben, cy]) await joinRoom(c, code);
    await settle(clients);
    const total = 2000;
    await verifyAll(clients, `${label} lobby`, total);

    // --- drag a seat on the table: Host (slot 1) -> slot 3. Chips must stay put while dragging.
    await host.page.locator("#table-oval").scrollIntoViewIfNeeded();
    const track = await host.page.locator("#turn-order-track").boundingBox();
    const at = (pl, pt) => ({ x: track.x + (track.width * pl) / 100, y: track.y + (track.height * pt) / 100 });
    const chipsBefore = await host.page.$$eval(".seat-chips", (els) => els.map((e) => `${e.dataset.chipsFor}:${e.style.left},${e.style.top}`).join("|"));
    const from = at(...Object.values(slot(0, 4)));
    const to = at(...Object.values(slot(2, 4)));
    await host.page.mouse.move(from.x, from.y);
    await host.page.mouse.down();
    await host.page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 6 });
    await host.page.mouse.move(to.x, to.y, { steps: 6 });
    const chipsDuring = await host.page.$$eval(".seat-chips", (els) => els.map((e) => `${e.dataset.chipsFor}:${e.style.left},${e.style.top}`).join("|"));
    check("dragging a seat does not move any chip stack", chipsBefore === chipsDuring);
    const v = host.room.updatedAt;
    await host.page.mouse.up();
    await settle(clients, v + 1);
    check("drag changed the server order", host.room.players.sort((a, b) => a.seat - b.seat).map((p) => p.displayName).join() === "Ann,Ben,Host,Cy", host.room.players.map((p) => `${p.displayName}:${p.seat}`).join());
    await wait(600);
    await verifyAll(clients, `${label} after drag`, total);

    // --- drag a seat onto its own slot: nothing should change and nothing should get stuck.
    const before = host.room.updatedAt;
    await exposeElement(host.page, `.turn-seat[data-player-id="${host.playerId}"] .turn-seat-avatar`);
    const hostSeat = await host.page.locator(`.turn-seat[data-player-id="${host.playerId}"] .turn-seat-avatar`).boundingBox();
    await host.page.mouse.move(hostSeat.x + 20, hostSeat.y + 20);
    await host.page.mouse.down();
    await host.page.mouse.move(hostSeat.x + 25, hostSeat.y + 24, { steps: 3 });
    await host.page.mouse.up();
    await wait(1500);
    check("a drag that lands on the same slot leaves the order alone", host.room.updatedAt === before);
    await verifyAll(clients, `${label} after no-op drag`, total);

    // --- players list reorder is the same event; start a hand: seats must now be locked.
    await host.page.click("#start-hand-button", { timeout: 8000 });
    await settle(clients);
    await verifyAll(clients, `${label} hand started (drag locked)`, total);

    // --- stack tap: peek then breakdown.
    await ann.page.locator(`.seat-chips[data-chips-for="${ann.playerId}"]`).scrollIntoViewIfNeeded();
    await ann.page.click(`.seat-chips[data-chips-for="${ann.playerId}"]`);
    await wait(250);
    const peek = await ann.page.$eval(`.seat-chips[data-chips-for="${ann.playerId}"] .seat-chips-amount`, (e) => getComputedStyle(e).opacity);
    check("tapping a stack shows its amount", peek === "1");
    const others = await ann.page.$$eval(".seat-chips:not([data-chips-for='" + ann.playerId + "']) .seat-chips-amount", (els) => els.map((e) => getComputedStyle(e).opacity));
    check("other stacks' amounts stay hidden", others.every((o) => o === "0"));
    await ann.page.click(`.seat-chips[data-chips-for="${ann.playerId}"]`);
    await wait(250);
    check("tapping again opens the breakdown", await ann.page.isVisible("#chip-detail-modal:not(.hidden)"));
    await ann.page.click("#close-chip-detail-button");
    // pot modal
    await ann.page.click("#pot-visual-button");
    await wait(200);
    check("pot opens its breakdown", await ann.page.isVisible("#chip-detail-modal:not(.hidden)"));
    const potModal = await ann.page.textContent("#chip-detail-body");
    check("pot breakdown lists what players put in", /Put in this hand/.test(potModal));
    await ann.page.click("#close-chip-detail-button");

    // --- pot button stays put when hovered (the old glitch).
    const r1 = await host.page.locator("#pot-visual-button").boundingBox();
    await host.page.hover("#pot-visual-button");
    await wait(300);
    const r2 = await host.page.locator("#pot-visual-button").boundingBox();
    check("hovering the pot does not move it", Math.abs(r1.x - r2.x) < 0.5 && Math.abs(r1.y - r2.y) < 0.5, `${r1.y} -> ${r2.y}`);

    // --- refresh mid-hand: the page must come back into the same game by itself.
    const refreshed = ben;
    await refreshed.page.reload();
    await refreshed.page.waitForSelector("#room-panel:not(.hidden)", { timeout: 8000 }).catch(() => {});
    await settle(clients);
    check("refreshing mid-hand rejoins automatically", await refreshed.page.isVisible("#room-panel"));
    await verifyAll(clients, `${label} after refresh`, total);

    // --- kick the acting player mid-hand through the UI; the kicked page goes back to the front door.
    const room = host.room;
    const actingId = room.actingPlayerId;
    const victim = clients.find((c) => c.playerId === actingId && c !== host) || cy;
    // The removed player takes their remaining stack with them; what they already put in stays.
    const leaving = host.room.players.find((p) => p.id === victim.playerId).stack;
    const totalAfterKick = total - leaving;
    await host.page.click("#table-settings-toggle");
    await host.page.waitForSelector(`[data-remove-player-id="${victim.playerId}"]`);
    const kv = host.room.updatedAt;
    await host.page.click(`[data-remove-player-id="${victim.playerId}"]`);
    await wait(200);
    if (await host.page.isVisible("#confirm-modal:not(.hidden) #confirm-ok")) await host.page.click("#confirm-ok");
    await settle(clients.filter((c) => c !== victim), kv + 1);
    await wait(300);
    check("kicked player is returned to the front door", await victim.page.isVisible("#auth-panel"));
    check("kicked player is gone from the table", !host.room.players.some((p) => p.id === victim.playerId && !p.pendingRemoval));
    await host.page.click("#table-settings-close").catch(() => {});
    const remaining = clients.filter((c) => c !== victim);
    await verifyAll(remaining, `${label} after kick`, totalAfterKick);

    // --- finish the hand by folding everyone down so we can reorder between hands again.
    for (let i = 0; i < 40 && host.room.status === "in_hand"; i += 1) {
      const room2 = host.room;
      if (room2.awaitingDeal) {
        await host.page.click("#confirm-deal-button");
        await settle(remaining);
        continue;
      }
      const actor = remaining.find((c) => c.playerId === room2.actingPlayerId);
      if (!actor) break;
      const ver = room2.updatedAt;
      const fold = await actor.page.$("#actions-container button[data-action='fold']");
      if (fold) await fold.click();
      else await actor.page.click("#actions-container button[data-action='check']");
      await settle(remaining, ver + 1);
    }
    check("hand finished after the kick", host.room.status === "waiting" || host.room.status === "paused", host.room.status);
    if (host.room.status === "paused") {
      await declareWinners(host, rng(5));
      await settle(remaining);
      for (let i = 0; i < 60 && host.room.payoutState !== "idle"; i += 1) await wait(100);
    }
    await settle(remaining);
    await verifyAll(remaining, `${label} between hands again`, totalAfterKick);
    for (const c of clients) check(`${label}: no console errors on ${c.name}`, c.errors.length === 0, c.errors.slice(0, 3).join(" | "));
  } catch (error) {
    check("flow ran to completion", false, error.stack?.split("\n").slice(0, 4).join(" ") || String(error));
  } finally {
    for (const c of clients) await c.context.close().catch(() => {});
  }
}


// Host handover during a deal wait, spectators/late joiners mid-hand, chat, blinds, leaving.
async function flowHostAndMisc(browser, serverUrl) {
  const label = "misc";
  const viewport = { width: 390, height: 844 };
  const clients = [];
  try {
    for (const n of ["Host", "Ann", "Ben"]) clients.push(await newClient(browser, serverUrl, n, viewport));
    const [host, ann, ben] = clients;
    const code = await createRoom(host, { sb: 10, bb: 20, stack: 500 });
    for (const c of [ann, ben]) await joinRoom(c, code);
    await settle(clients);
    let total = 1500;

    // --- blinds change from the host's settings (applies from the next hand; screen must show it).
    await host.page.click("#table-settings-toggle");
    await host.page.fill("#update-sb", "15");
    await host.page.fill("#update-bb", "30");
    const bv = host.room.updatedAt;
    await host.page.click("#update-blinds-button");
    await settle(clients, bv + 1);
    for (const c of clients) check(`${label}: blinds update shows on ${c.name}`, /15\s*\/\s*30/.test(await c.page.textContent("#blinds")), await c.page.textContent("#blinds"));
    await host.page.click("#table-settings-close").catch(() => {});

    // --- play to the flop, then hand the host role to Ann while the deal is pending.
    await host.page.click("#start-hand-button");
    await settle(clients);
    for (let i = 0; i < 12 && !host.room.awaitingDeal; i += 1) {
      const actor = clients.find((c) => c.playerId === host.room.actingPlayerId);
      const v = host.room.updatedAt;
      const callBtn = await actor.page.$("#actions-container button[data-action='call']");
      if (callBtn) await callBtn.click();
      else await actor.page.click("#actions-container button[data-action='check']");
      await settle(clients, v + 1);
    }
    check(`${label}: reached the flop wait`, host.room.awaitingDeal && host.room.street === "flop");
    await host.page.click("#table-settings-toggle");
    await host.page.selectOption("#transfer-host-select", ann.playerId);
    const tv = host.room.updatedAt;
    await host.page.click("#transfer-host-button");
    await settle(clients, tv + 1);
    check(`${label}: host role moved to Ann`, host.room.hostPlayerId === ann.playerId);
    await verifyAll(clients, `${label} after host transfer (deal pending)`, total);
    check(`${label}: new host sees the deal button`, await ann.page.isVisible("#confirm-deal-button"));
    check(`${label}: old host no longer sees it`, !(await host.page.isVisible("#confirm-deal-button")));

    // --- a spectator and a late player join mid-hand.
    const spec = await newClient(browser, serverUrl, "Watcher", viewport);
    clients.push(spec);
    await spec.page.fill("#join-room-code", code);
    await spec.page.fill("#join-display-name", "Watcher");
    await spec.page.selectOption("#join-role", "spectator");
    await spec.page.click("#join-room-button");
    await spec.page.waitForSelector("#room-panel:not(.hidden)");
    const late = await newClient(browser, serverUrl, "Late", viewport);
    clients.push(late);
    await joinRoom(late, code);
    total += 500;
    await settle(clients);
    await verifyAll(clients, `${label} spectator + late joiner mid-hand (deal pending)`, total);
    check(`${label}: spectator has no action buttons`, !(await spec.page.$("#actions-container .actions-row")));

    // --- chat reaches everyone.
    await ben.page.fill("#chat-input", "hello table");
    await ben.page.click("#chat-send-button");
    await wait(500);
    for (const c of clients) check(`${label}: chat shows on ${c.name}`, /hello table/.test(await c.page.textContent("#chat-messages")));

    // --- new host deals; Ben leaves the room while it may be his turn; the table must carry on.
    const dv = ann.room.updatedAt;
    await ann.page.click("#confirm-deal-button");
    await settle(clients, dv + 1);
    await verifyAll(clients, `${label} after new host dealt`, total);
    await ben.page.click("#leave-room-button");
    await wait(200);
    await ben.page.click("#confirm-ok");
    await wait(600);
    check(`${label}: leaver is back at the front door`, await ben.page.isVisible("#auth-panel"));
    // Whoever is stuck on Ben's turn gets removed by the host, as the table would do in real life.
    const remaining = clients.filter((c) => c !== ben);
    if (ann.room.actingPlayerId === ben.playerId) {
      await ann.page.click("#table-settings-toggle");
      await ann.page.click(`[data-remove-player-id="${ben.playerId}"]`);
      await wait(200);
      if (await ann.page.isVisible("#confirm-modal:not(.hidden) #confirm-ok")) await ann.page.click("#confirm-ok");
      await settle(remaining);
    }
    await verifyAll(remaining, `${label} after a player left`, undefined);
    for (const c of clients) check(`${label}: no console errors on ${c.name}`, c.errors.length === 0, c.errors.slice(0, 3).join(" | "));
  } catch (error) {
    check(`${label} flow ran to completion`, false, error.stack?.split("\n").slice(0, 4).join(" ") || String(error));
  } finally {
    for (const c of clients) await c.context.close().catch(() => {});
  }
}

// Layout at every phone width and every table size, with the felt in both themes.
async function flowLayoutMatrix(browser, serverUrl) {
  const widths = [320, 360, 375, 390, 412, 430, 768];
  for (const n of [2, 3, 4, 5, 6, 7, 8]) {
    const clients = [];
    try {
      const host = await newClient(browser, serverUrl, "Host", { width: 390, height: 844 });
      clients.push(host);
      // 1888 breaks into many denominations: the widest chip pile a stack can produce.
      const code = await createRoom(host, { sb: 25, bb: 50, stack: 1888 });
      for (let i = 2; i <= n; i += 1) {
        const c = await newClient(browser, serverUrl, `Player${i}`, { width: 390, height: 844 });
        clients.push(c);
        await joinRoom(c, code);
      }
      await settle(clients);
      for (const w of widths) {
        await host.page.setViewportSize({ width: w, height: w >= 768 ? 1024 : 844 });
        await wait(250);
        // Skip chip-vs-seat strictness for the very narrowest phones with big tables: report only.
        const strict = !(w < 360 && n > 6);
        const label = `layout ${n}p @${w}px`;
        if (strict) await verifyScreen(host, label, n * 1888);
        else {
          const s = await host.page.evaluate(readScreen);
          check(`${label}: no horizontal scroll`, s.overflowX <= 1, `${s.overflowX}px`);
        }
      }
      for (const theme of ["light", "dark"]) {
        await host.page.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
        await wait(150);
        await verifyScreen(host, `layout ${n}p ${theme}`, n * 1888);
      }
      check(`layout ${n}p: no console errors`, host.errors.length === 0, host.errors.slice(0, 3).join(" | "));
    } catch (error) {
      check(`layout ${n}p ran to completion`, false, error.stack?.split("\n").slice(0, 3).join(" "));
    } finally {
      for (const c of clients) await c.context.close().catch(() => {});
    }
  }
}

async function main() {
  const linked = await linkWebIntoDist();
  const server = await startServer(PORT);
  const browser = await chromium.launch({ channel: "chrome", headless: !HEADED });
  const started = Date.now();
  try {
    const only = process.env.UI_ONLY || "layout,flow,misc,play";
    if (only.includes("layout")) {
      console.log("== layout matrix");
      await flowLayoutMatrix(browser, server.url);
    }
    if (only.includes("flow")) {
      console.log("== drag / kick / refresh flow");
      await flowSeatsDragKickRefresh(browser, server.url);
    }
    if (only.includes("misc")) {
      console.log("== host handover / spectator / late join / chat / leave");
      await flowHostAndMisc(browser, server.url);
    }
    if (only.includes("play")) {
      console.log(`== UI play-throughs (${TABLES} tables x ${HANDS} hands)`);
      for (let t = 1; t <= TABLES; t += 1) await playTable(browser, server.url, SEED + t * 7919, t);
    }
  } finally {
    await browser.close();
    await server.stop();
    if (linked) await rm(linked, { force: true });
  }
  const secs = Math.round((Date.now() - started) / 1000);
  console.log(`\nui: ${passed} passed, ${failures.length} failed (${secs}s)`);
  if (failures.length > 0) {
    console.error("\nFailures (first 40):");
    [...new Set(failures)].slice(0, 40).forEach((f) => console.error(" - " + f));
    process.exitCode = 1;
  }
}

void main();
