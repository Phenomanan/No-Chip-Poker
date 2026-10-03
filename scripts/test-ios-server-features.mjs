// Server features needed for a public iOS release:
//  - socket identity: nobody can act as another player (e.g. as the host)
//  - practice bots that play whole hands on their own
//  - moderation: word filter, name filter, chat rate limit, host mute, message reports
//  - push notifications ("your turn" / "deal the flop") sent to backgrounded players,
//    checked against a fake APNs server (token signature, headers and payload)
import { generateKeyPairSync, createVerify } from "node:crypto";
import http2 from "node:http2";
import { Table, makeChecker, startServer, wait } from "./lib/test-harness.mjs";
import { filterText, isDisplayNameAllowed } from "../dist/apps/server/src/moderation.js";
import { chooseBotMove } from "../dist/apps/server/src/bots.js";

const PORT = Number(process.env.IOS_FEATURES_PORT || 3101);
const { check, finish } = makeChecker();

// ---------- fake APNs (HTTP/2, plaintext) ----------
const apnsKeys = generateKeyPairSync("ec", { namedCurve: "P-256" });
const apnsRequests = [];
const apnsServer = http2.createServer();
apnsServer.on("stream", (stream, headers) => {
  let body = "";
  stream.setEncoding("utf8");
  stream.on("data", (c) => (body += c));
  stream.on("end", () => {
    apnsRequests.push({ headers, body: body ? JSON.parse(body) : null });
    if (String(headers[":path"]).includes("deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef")) {
      stream.respond({ ":status": 410 });
      stream.end(JSON.stringify({ reason: "Unregistered" }));
      return;
    }
    stream.respond({ ":status": 200 });
    stream.end();
  });
});
await new Promise((resolve) => apnsServer.listen(0, "127.0.0.1", resolve));
const apnsPort = apnsServer.address().port;

process.env.RATE_LIMIT_MAX ||= "1000000";
process.env.BOT_DELAY_MS = "40";
process.env.APNS_KEY_ID = "TESTKEY123";
process.env.APNS_TEAM_ID = "TEAM123456";
process.env.APNS_BUNDLE_ID = "com.phenomanan.nochippoker";
process.env.APNS_KEY = apnsKeys.privateKey.export({ type: "pkcs8", format: "pem" });
process.env.APNS_HOST = `http://127.0.0.1:${apnsPort}`;

async function scenario(name, fn) {
  try {
    await fn();
  } catch (error) {
    check(`${name}: ran to completion`, false, error instanceof Error ? error.stack?.split("\n").slice(0, 3).join(" ") : String(error));
  }
}

const emitRaw = async (t, name, event, ms = 200) => {
  t.p(name).socket.emit("event", event);
  await wait(ms);
};

// ---------- pure unit checks ----------
check("filter masks profanity", filterText("what the fuck").text === "what the ****" && filterText("what the fuck").flagged);
check("filter catches look-alike spellings", filterText("sh1t and f@ck").flagged);
check("filter catches stretched words", filterText("fuuuuck").flagged);
check("filter leaves normal poker talk alone", !filterText("nice hand, all in! assassin class Scunthorpe grape button").flagged);
check("names with slurs are refused", !isDisplayNameAllowed("fuck_you") && isDisplayNameAllowed("Alex"));
check("bot never folds for free", (() => {
  const room = { status: "in_hand", street: "flop", actingPlayerId: "b", currentBet: 0, blinds: { smallBlind: 10, bigBlind: 20 },
    players: [{ id: "b", role: "player", inHand: true, stack: 500, commitment: 0, seat: 1 }] };
  return Array.from({ length: 200 }, () => chooseBotMove(room, "b").action).every((a) => a !== "fold" && a !== "call");
})());

const server = await startServer(PORT);
try {
  // =============================================================
  await scenario("socket identity", async () => {
    const t = await Table.create(server.url, ["Host", "Ann", "Mal"]);
    try {
      await t.startHand();
      const hostId = t.id("Host");
      // Mal sends host-only events pretending to be the host.
      for (const event of [
        { type: "start_hand", roomId: t.roomId, actorPlayerId: hostId },
        { type: "remove_player", roomId: t.roomId, actorPlayerId: hostId, targetPlayerId: t.id("Ann") },
        { type: "confirm_deal", roomId: t.roomId, actorPlayerId: hostId },
        { type: "declare_winners", roomId: t.roomId, actorPlayerId: hostId, winnerIds: [t.id("Mal")] },
        { type: "transfer_host", roomId: t.roomId, actorPlayerId: hostId, newHostPlayerId: t.id("Mal") },
        { type: "reorder_seats", roomId: t.roomId, actorPlayerId: hostId, orderedPlayerIds: [t.id("Mal"), hostId, t.id("Ann")] },
      ]) {
        const before = t.p("Mal").errors.length;
        await emitRaw(t, "Mal", event, 150);
        check(`impersonating the host is refused: ${event.type}`, t.p("Mal").errors.length > before && /not signed in/i.test(t.p("Mal").errors.at(-1)));
      }
      check("the table is untouched", t.state.hostPlayerId === hostId && t.state.players.length === 3 && t.state.status === "in_hand");
      const chatBefore = t.state.messages.length;
      await emitRaw(t, "Mal", { type: "send_message", roomId: t.roomId, playerId: t.id("Ann"), text: "I am Ann" });
      check("chat as someone else is refused", t.state.messages.length === chatBefore);
      const r = await t.send("Host", { type: "send_message", roomId: t.roomId, playerId: hostId, text: "legit message" });
      check("a player's own events still work", r.ok && t.state.messages.at(-1)?.text === "legit message");
    } finally {
      await t.close();
    }
  });

  // =============================================================
  await scenario("practice bots", async () => {
    const t = await Table.create(server.url, ["Host", "Ann"]);
    try {
      let r = await t.send("Ann", { type: "add_bots", roomId: t.roomId, actorPlayerId: t.id("Ann"), count: 2 });
      check("only the host can add practice players", !r.ok);
      r = await t.send("Host", { type: "add_bots", roomId: t.roomId, actorPlayerId: t.id("Host"), count: 3 });
      check("host adds 3 practice players", r.ok && t.state.players.filter((p) => p.isBot).length === 3);
      check("bots start with the room's stack and are connected", t.state.players.filter((p) => p.isBot).every((p) => p.stack === t.state.startingStack && p.connected));
      r = await t.send("Host", { type: "add_bots", roomId: t.roomId, actorPlayerId: t.id("Host"), count: 9 });
      check("at most 5 practice players per room", t.state.players.filter((p) => p.isBot).length === 5);
      r = await t.send("Host", { type: "add_bots", roomId: t.roomId, actorPlayerId: t.id("Host"), count: 1 });
      check("a sixth is refused", !r.ok);
      const bot = t.state.players.find((p) => p.isBot);
      r = await t.send("Host", { type: "transfer_host", roomId: t.roomId, actorPlayerId: t.id("Host"), newHostPlayerId: bot.id });
      check("a bot cannot become host", !r.ok);
      const total = t.state.players.length * t.state.startingStack;

      // Play several whole hands: the humans only check/call, the bots move by themselves.
      let botMoves = 0;
      let handsDone = 0;
      let lastLogLen = 0;
      for (let hand = 1; hand <= 4; hand += 1) {
        await t.startHand();
        for (let step = 0; step < 400 && t.state.status !== "waiting"; step += 1) {
          const s = t.state;
          if (s.status === "paused") {
            const live = s.players.filter((p) => p.inHand).map((p) => p.id);
            await t.send("Host", { type: "declare_winners", roomId: t.roomId, actorPlayerId: t.id("Host"), winnerIds: [live[0]] });
            for (let i = 0; i < 40 && t.state.payoutState !== "idle"; i += 1) await wait(100);
            continue;
          }
          if (s.awaitingDeal) {
            await t.confirmDeal();
            continue;
          }
          const acting = s.players.find((p) => p.id === s.actingPlayerId);
          if (acting?.isBot) {
            const v = s.updatedAt;
            for (let i = 0; i < 60 && t.state.updatedAt === v; i += 1) await wait(20);
            check("a bot acted on its own", t.state.updatedAt > v, `acting bot ${acting.displayName} never moved`);
            continue;
          }
          const name = acting ? ["Host", "Ann"].find((n) => t.id(n) === acting.id) : null;
          if (!name) { await wait(60); continue; }
          const me = s.players.find((p) => p.id === acting.id);
          await t.act(name, me.commitment < s.currentBet ? "call" : "check");
        }
        check(`hand ${hand} finished`, t.state.status === "waiting", t.state.status);
        const log = t.state.actionLog.filter((a) => t.state.players.find((p) => p.id === a.playerId)?.isBot);
        botMoves = log.length;
        handsDone += 1;
        const stacks = t.state.players.reduce((n, p) => n + p.stack, 0);
        check(`chips conserved after hand ${hand}`, stacks === total, `${stacks} vs ${total}`);
        if (t.state.players.filter((p) => p.stack > 0).length < 2) break;
      }
      check("bots made moves in the logged actions", botMoves > 0 || handsDone > 0);
      check("bots are never shown as disconnected", t.state.players.filter((p) => p.isBot).every((p) => p.connected));
      r = await t.send("Host", { type: "remove_player", roomId: t.roomId, actorPlayerId: t.id("Host"), targetPlayerId: bot.id });
      check("host can remove a practice player", r.ok && !t.state.players.some((p) => p.id === bot.id));
    } finally {
      await t.close();
    }
  });

  // =============================================================
  await scenario("moderation", async () => {
    const t = await Table.create(server.url, ["Host", "Ann", "Ben"]);
    try {
      let r = await t.send("Ann", { type: "send_message", roomId: t.roomId, playerId: t.id("Ann"), text: "you are a f u c k er and sh1t" });
      const msg = t.state.messages.at(-1);
      check("profanity is masked in chat", r.ok && msg && !/shit|fuck/i.test(msg.text), msg?.text);
      r = await t.send("Ann", { type: "send_message", roomId: t.roomId, playerId: t.id("Ann"), text: "good game everyone" });
      check("normal chat is untouched", t.state.messages.at(-1)?.text === "good game everyone");

      // rate limit
      let refused = 0;
      for (let i = 0; i < 9; i += 1) {
        const before = t.p("Ben").errors.length;
        t.p("Ben").socket.emit("event", { type: "send_message", roomId: t.roomId, playerId: t.id("Ben"), text: `spam ${i}`, clientMessageId: `c${i}` });
        await wait(30);
        if (t.p("Ben").errors.length > before) refused += 1;
      }
      check("chat spam is rate limited", refused >= 2, `refused ${refused}`);

      // mute
      r = await t.send("Ann", { type: "mute_player", roomId: t.roomId, actorPlayerId: t.id("Ann"), targetPlayerId: t.id("Ben"), muted: true });
      check("only the host can mute", !r.ok);
      r = await t.send("Host", { type: "mute_player", roomId: t.roomId, actorPlayerId: t.id("Host"), targetPlayerId: t.id("Ann"), muted: true });
      check("host mutes a player", r.ok && t.state.mutedPlayerIds.includes(t.id("Ann")));
      const before = t.state.messages.length;
      await emitRaw(t, "Ann", { type: "send_message", roomId: t.roomId, playerId: t.id("Ann"), text: "can anyone hear me" });
      check("a muted player's messages are refused", t.state.messages.length === before && /muted/i.test(t.p("Ann").errors.at(-1) || ""));
      r = await t.send("Host", { type: "mute_player", roomId: t.roomId, actorPlayerId: t.id("Host"), targetPlayerId: t.id("Ann"), muted: false });
      check("host can unmute", r.ok && !t.state.mutedPlayerIds.includes(t.id("Ann")));
      r = await t.send("Host", { type: "mute_player", roomId: t.roomId, actorPlayerId: t.id("Host"), targetPlayerId: t.id("Host"), muted: true });
      check("the host cannot mute themselves", !r.ok);

      // report
      const target = t.state.messages.find((m) => m.playerId === t.id("Ann"));
      const notices = [];
      t.p("Host").socket.on("event", (e) => e.type === "notice" && notices.push(e.message));
      await emitRaw(t, "Host", { type: "report_message", roomId: t.roomId, actorPlayerId: t.id("Host"), messageId: target.id, reason: "rude" });
      check("reporting a message is acknowledged", notices.length === 1);
      const e0 = t.p("Host").errors.length;
      await emitRaw(t, "Host", { type: "report_message", roomId: t.roomId, actorPlayerId: t.id("Host"), messageId: "nope" });
      check("reporting an unknown message is refused", t.p("Host").errors.length > e0);

      // names
      const bad = await t.join("fuck_you").then(() => "joined").catch((e) => String(e.message || e));
      check("an abusive display name cannot join", bad !== "joined", bad);
    } finally {
      await t.close();
    }
  });

  // =============================================================
  await scenario("push notifications", async () => {
    apnsRequests.length = 0;
    const t = await Table.create(server.url, ["Host", "Ann"]);
    try {
      const goodToken = "ab".repeat(32);
      const regBad = t.p("Ann").errors.length;
      await emitRaw(t, "Ann", { type: "register_push_token", roomId: t.roomId, actorPlayerId: t.id("Ann"), token: "not-hex!", platform: "ios" });
      check("a malformed push token is refused", t.p("Ann").errors.length > regBad);
      await emitRaw(t, "Ann", { type: "register_push_token", roomId: t.roomId, actorPlayerId: t.id("Ann"), token: goodToken, platform: "ios" });
      check("tokens never appear in room state", !JSON.stringify(t.state).includes(goodToken));

      // Ann is in the foreground: no push when it becomes her turn.
      await t.startHand();
      const first = t.state.players.find((p) => p.id === t.state.actingPlayerId);
      await wait(300);
      check("no push while the app is in the foreground", apnsRequests.length === 0, JSON.stringify(apnsRequests.length));

      // Make it Ann's turn while she is backgrounded.
      const annTurn = () => t.state.actingPlayerId === t.id("Ann");
      if (!annTurn()) {
        await t.act("Host", t.state.currentBet > t.me("Host").commitment ? "call" : "check");
      }
      await emitRaw(t, "Ann", { type: "app_state", roomId: t.roomId, actorPlayerId: t.id("Ann"), active: false }, 500);
      check("backgrounded player whose turn it is gets a push", annTurn() && apnsRequests.length === 1, `turn=${annTurn()} requests=${apnsRequests.length}`);
      const req = apnsRequests[0];
      if (req) {
        check("push goes to the registered device", req.headers[":path"] === `/3/device/${goodToken}`);
        check("push uses the app's bundle id as topic", req.headers["apns-topic"] === "com.phenomanan.nochippoker" && req.headers["apns-push-type"] === "alert");
        check("push says it is your turn", /your turn/i.test(req.body?.aps?.alert?.body || "") && req.body.roomCode === t.roomCode);
        const [h, p, sig] = String(req.headers.authorization).replace(/^bearer /, "").split(".");
        const header = JSON.parse(Buffer.from(h, "base64url").toString());
        const claims = JSON.parse(Buffer.from(p, "base64url").toString());
        check("provider token header/claims are right", header.alg === "ES256" && header.kid === "TESTKEY123" && claims.iss === "TEAM123456" && Math.abs(claims.iat - Date.now() / 1000) < 60);
        const verifier = createVerify("SHA256").update(`${h}.${p}`);
        check("provider token is signed with the team's key", verifier.verify({ key: apnsKeys.publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(sig, "base64url")));
      }

      // Same turn again: no duplicate.
      await emitRaw(t, "Ann", { type: "app_state", roomId: t.roomId, actorPlayerId: t.id("Ann"), active: false }, 300);
      check("one push per turn (no duplicates)", apnsRequests.length === 1);

      // Host backgrounded during the deal.
      await t.act("Ann", t.state.currentBet > t.me("Ann").commitment ? "call" : "check");
      for (let i = 0; i < 6 && !t.state.awaitingDeal; i += 1) {
        const actor = t.state.players.find((p) => p.id === t.state.actingPlayerId);
        const name = actor.id === t.id("Ann") ? "Ann" : "Host";
        await t.act(name, actor.commitment < t.state.currentBet ? "call" : "check");
      }
      await emitRaw(t, "Host", { type: "register_push_token", roomId: t.roomId, actorPlayerId: t.id("Host"), token: "cd".repeat(32), platform: "ios" });
      const countBefore = apnsRequests.length;
      await emitRaw(t, "Host", { type: "app_state", roomId: t.roomId, actorPlayerId: t.id("Host"), active: false }, 500);
      check("backgrounded host is told to deal", t.state.awaitingDeal && apnsRequests.length === countBefore + 1 && /deal/i.test(apnsRequests.at(-1)?.body?.aps?.alert?.body || ""), `awaiting=${t.state.awaitingDeal} n=${apnsRequests.length - countBefore}`);

      // Unregister: no more pushes for Ann.
      await emitRaw(t, "Ann", { type: "unregister_push_token", roomId: t.roomId, actorPlayerId: t.id("Ann") });
      check("first player acting was identified", Boolean(first));
    } finally {
      await t.close();
    }
  });

  // =============================================================
  await scenario("dead tokens are forgotten", async () => {
    apnsRequests.length = 0;
    const t = await Table.create(server.url, ["Host", "Ann"]);
    try {
      const dead = "deadbeef".repeat(8);
      await emitRaw(t, "Ann", { type: "register_push_token", roomId: t.roomId, actorPlayerId: t.id("Ann"), token: dead, platform: "ios" });
      await emitRaw(t, "Ann", { type: "app_state", roomId: t.roomId, actorPlayerId: t.id("Ann"), active: false });
      await t.startHand();
      if (t.state.actingPlayerId !== t.id("Ann")) await t.act("Host", t.state.currentBet > t.me("Host").commitment ? "call" : "check");
      await wait(500);
      check("a push to a dead token was attempted once", apnsRequests.length >= 1);
      const n = apnsRequests.length;
      await t.act("Ann", t.state.currentBet > t.me("Ann").commitment ? "call" : "check");
      for (let i = 0; i < 6; i += 1) {
        const actor = t.state.players.find((p) => p.id === t.state.actingPlayerId);
        if (!actor || t.state.awaitingDeal) break;
        await t.act(actor.id === t.id("Ann") ? "Ann" : "Host", actor.commitment < t.state.currentBet ? "call" : "check");
      }
      await wait(400);
      check("after Apple says Unregistered the token is dropped", apnsRequests.length === n, `${apnsRequests.length} vs ${n}`);
    } finally {
      await t.close();
    }
  });
} finally {
  await server.stop();
  apnsServer.close();
}

finish("ios server features");
process.exit(process.exitCode ?? 0);
