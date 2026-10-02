// Rules for the host's two table-management powers, tested end to end:
//  - Reordering seats is allowed only between hands (never while a hand is
//    being played OR waiting on the host to declare a showdown winner).
//  - Removing a player is allowed at any time, and must never create or
//    destroy chips other than the removed player's own remaining stack: what
//    they already put in the pot stays in the pot as dead money.
import { Table, makeChecker, startServer, wait } from "./lib/test-harness.mjs";

const PORT = Number(process.env.KICK_TEST_PORT || 3051);
const { check, finish } = makeChecker();

async function scenario(name, fn) {
  try {
    await fn();
  } catch (error) {
    check(`${name}: ran to completion`, false, error instanceof Error ? error.message : String(error));
  }
}

async function main() {
  const server = await startServer(PORT);

  try {
    // ------------------------------------------------------------------
    await scenario("reorder", async () => {
      const t = await Table.create(server.url, ["Ann", "Ben", "Cy", "Di"]);
      try {
        const before = ["Ann", "Ben", "Cy", "Di"].map((n) => t.seatOf(n));
        check("reorder: initial seats follow join order", before.join() === "1,2,3,4", before.join());

        const ok = await t.reorder(["Cy", "Ann", "Di", "Ben"]);
        check("reorder: host can reorder between hands", ok.ok, ok.error);
        const after = ["Cy", "Ann", "Di", "Ben"].map((n) => t.seatOf(n));
        check("reorder: seats follow the requested order", after.join() === "1,2,3,4", after.join());

        const byNonHost = await t.reorder(["Ann", "Ben", "Cy", "Di"], "Ben");
        check("reorder: a non-host cannot reorder", !byNonHost.ok, JSON.stringify(byNonHost));

        const incomplete = await t.reorder(["Ann", "Ben"]);
        check("reorder: an order missing seated players is rejected", !incomplete.ok);

        await t.startHand();
        const midHand = await t.reorder(["Ann", "Ben", "Cy", "Di"]);
        check("reorder: rejected while a hand is in progress", !midHand.ok, JSON.stringify(midHand));

        // Check the hand down to the showdown pause, where the host still has to pick winners.
        await t.passiveUntil((s) => s.status === "paused");
        const atShowdown = await t.reorder(["Ann", "Ben", "Cy", "Di"]);
        check("reorder: rejected while a showdown is waiting for a winner", !atShowdown.ok, JSON.stringify(atShowdown));

        await t.declare(["Ann"]);
        await t.waitForIdlePayout();
        const afterHand = await t.reorder(["Di", "Cy", "Ben", "Ann"]);
        check("reorder: allowed again once the hand is paid out", afterHand.ok, afterHand.error);
        check("reorder: chips conserved across the whole sequence", t.totalStacks() === 2000, String(t.totalStacks()));
      } finally {
        await t.close();
      }
    });

    // ------------------------------------------------------------------
    await scenario("kick mid-hand keeps dead money", async () => {
      const t = await Table.create(server.url, ["Ann", "Ben", "Cy"]);
      try {
        await t.startHand();
        const first = t.actingName();
        await t.act(first, "raise", 100);
        const second = t.actingName();
        await t.act(second, "call");
        const third = t.actingName();
        check("kick-mid-hand: the third player now faces the raise", third && third !== first && third !== second, String(third));

        // The host cannot be removed, so remove the first non-host player in the hand.
        const victim = [first, second, third].find((n) => n !== "Ann");
        const victimStack = t.stackOf(victim);
        const total = 1500;
        const res = await t.kick(victim);
        check("kick-mid-hand: host can remove a player during a hand", res.ok, res.error);
        check(
          "kick-mid-hand: removed player is gone from the room",
          !t.state.players.some((p) => p.displayName === victim && !p.pendingRemoval),
        );

        await t.passiveUntil((s) => s.status !== "in_hand");
        if (t.state.status === "paused") {
          const live = t.state.players.filter((p) => p.inHand).map((p) => t.nameOfId(p.id));
          await t.declare([live[0]]);
        }
        await t.waitForIdlePayout();
        const remaining = t.state.players.reduce((s, p) => s + p.stack, 0);
        check(
          "kick-mid-hand: only the removed player's own stack left the table",
          remaining === total - victimStack,
          `expected ${total - victimStack}, got ${remaining}`,
        );
        check(
          "kick-mid-hand: removed player no longer listed after the hand",
          t.state.players.every((p) => p.displayName !== victim),
        );
      } finally {
        await t.close();
      }
    });

    // ------------------------------------------------------------------
    await scenario("kick during showdown pause", async () => {
      const t = await Table.create(server.url, ["Ann", "Ben", "Cy"]);
      try {
        await t.startHand();
        const first = t.actingName();
        await t.act(first, "raise", 60);
        await t.passiveUntil((s) => s.street === "flop");
        await t.passiveUntil((s) => s.status === "paused");
        check("kick-showdown: reached the showdown pause", t.state.status === "paused");

        const live = t.state.players.filter((p) => p.inHand).map((p) => t.nameOfId(p.id));
        const victim = live[live.length - 1];
        const winner = live[0];
        const victimStack = t.stackOf(victim);
        const res = await t.kick(victim);
        check("kick-showdown: host can remove a player waiting at showdown", res.ok, res.error);

        if (t.state.status === "paused") {
          const candidates = t.state.players.filter((p) => p.inHand).map((p) => p.displayName);
          check("kick-showdown: removed player is not offered as a winner", !candidates.includes(victim), candidates.join());
          const declared = await t.declare([winner]);
          check("kick-showdown: host can still declare a winner", declared.ok, declared.error);
        }
        await t.waitForIdlePayout();
        const remaining = t.totalStacks();
        check(
          "kick-showdown: pot (including the removed player's chips) was paid out",
          remaining === 1500 - victimStack,
          `expected ${1500 - victimStack}, got ${remaining}`,
        );
      } finally {
        await t.close();
      }
    });

    // ------------------------------------------------------------------
    await scenario("kick the acting player", async () => {
      const t = await Table.create(server.url, ["Ann", "Ben", "Cy", "Di"]);
      try {
        await t.startHand();
        // The host cannot be removed: if the host is up first, just call and move on.
        while (t.actingName() === "Ann") {
          await t.act("Ann", "call");
        }
        const acting = t.actingName();
        await t.kick(acting);
        const next = t.actingName();
        check("kick-acting: turn passes to someone else", !!next && next !== acting, String(next));
        const nextRec = t.state.players.find((p) => p.id === t.state.actingPlayerId);
        check("kick-acting: the new acting player is still seated in the hand", !!nextRec && nextRec.inHand);
        await t.passiveUntil((s) => s.status !== "in_hand");
        check("kick-acting: hand still resolves", t.state.status !== "in_hand");
      } finally {
        await t.close();
      }
    });

    // ------------------------------------------------------------------
    await scenario("kick in a heads-up hand", async () => {
      const t = await Table.create(server.url, ["Ann", "Ben"]);
      try {
        await t.startHand();
        const benBlind = t.state.players.find((p) => p.id === t.id("Ben")).commitment;
        const res = await t.kick("Ben");
        check("kick-heads-up: removal accepted", res.ok, res.error);
        check("kick-heads-up: the remaining player wins immediately", t.state.status === "waiting", t.state.status);
        const ann = t.state.players.find((p) => p.id === t.id("Ann"));
        check("kick-heads-up: winner collects the removed player's blind", ann && ann.stack === 500 + benBlind, `stack ${ann?.stack}, blind ${benBlind}`);
      } finally {
        await t.close();
      }
    });

    // ------------------------------------------------------------------
    await scenario("kick the dealer, then deal", async () => {
      const t = await Table.create(server.url, ["Ann", "Ben", "Cy", "Di"]);
      try {
        await t.startHand();
        await t.passiveUntil((s) => s.status === "paused");
        await t.declare(["Ann"]);
        await t.waitForIdlePayout();

        const dealerSeat = t.state.dealerSeat;
        const dealerName = t.state.players.find((p) => p.seat === dealerSeat)?.displayName;
        if (dealerName === "Ann") {
          check("kick-dealer: setup (dealer is not the host)", false, "dealer was the host; cannot kick");
          return;
        }
        await t.kick(dealerName);
        await t.startHand();
        const seats = t.state.players.map((p) => p.seat).sort((a, b) => a - b);
        const expected = seats.find((s) => s > dealerSeat) ?? seats[0];
        check(
          "kick-dealer: the button moves to the next seat clockwise, not back to seat 1",
          t.state.dealerSeat === expected,
          `old dealer seat ${dealerSeat}, got ${t.state.dealerSeat}, expected ${expected}`,
        );
      } finally {
        await t.close();
      }
    });

    // ------------------------------------------------------------------
    await scenario("kick permissions and aftermath", async () => {
      const t = await Table.create(server.url, ["Ann", "Ben", "Cy"]);
      try {
        const nonHost = await t.kick("Cy", "Ben");
        check("kick-rules: a non-host cannot remove anyone", !nonHost.ok);
        const self = await t.kick("Ann");
        check("kick-rules: the host cannot remove themselves", !self.ok);

        const cy = t.p("Cy");
        const res = await t.kick("Cy");
        check("kick-rules: host removes a player between hands", res.ok, res.error);
        await wait(100);
        check("kick-rules: the removed player was told why", cy.errors.some((m) => /removed/i.test(m)), cy.errors.join("|"));

        const actAfter = await t.act("Cy", "check");
        check("kick-rules: a removed player cannot act", !actAfter.ok);

        cy.socket.emit("event", { type: "rejoin_room", payload: { roomCode: t.roomCode, sessionId: cy.sessionId } });
        await wait(250);
        check("kick-rules: a removed player cannot rejoin with their old session", cy.errors.some((m) => /expired|not part/i.test(m)), cy.errors.join("|"));
        check("kick-rules: remaining players are unaffected", t.state.players.length === 2);
      } finally {
        await t.close();
      }
    });

    // ------------------------------------------------------------------
    await scenario("a disconnected player does not freeze the table", async () => {
      const t = await Table.create(server.url, ["Ann", "Ben", "Cy"]);
      try {
        await t.startHand();
        const acting = t.actingName();
        t.p(acting).socket.disconnect();
        await wait(300);
        const next = t.actingName();
        check("disconnect: the turn moves on from a player who dropped", !!next && next !== acting, String(next));

        // Host can clear the dropped player out; the hand still finishes.
        if (acting !== "Ann") {
          await t.kick(acting);
        }
        const everyone = t.state.players.filter((p) => !p.pendingRemoval);
        check("disconnect: table still has live players", everyone.length >= 2);
      } finally {
        await t.close();
      }
    });
  } finally {
    await server.stop();
  }

  finish("kick and reorder rules");
}

void main();
