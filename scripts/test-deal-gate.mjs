// The "deal gate": when betting finishes and the street advances (flop, turn, river),
// nobody is asked to act until the host confirms the new community cards were dealt.
import { Table, makeChecker, startServer } from "./lib/test-harness.mjs";

const PORT = Number(process.env.DEAL_TEST_PORT || 3071);
const { check, finish } = makeChecker();

async function scenario(name, fn) {
  try {
    await fn();
  } catch (error) {
    check(`${name}: ran to completion`, false, error instanceof Error ? error.message : String(error));
  }
}

// Check/call whoever is acting until the street changes or something is waiting on the host.
async function bettingUntilStreetChanges(t, street) {
  for (let i = 0; i < 40; i += 1) {
    const s = t.state;
    if (s.street !== street || s.awaitingDeal || s.status !== "in_hand") return;
    const actor = t.actingName();
    const me = s.players.find((p) => p.id === t.id(actor));
    await t.act(actor, me.commitment < s.currentBet ? "call" : "check");
  }
  throw new Error(`betting on ${street} never finished`);
}

async function main() {
  const server = await startServer(PORT);
  try {
    await scenario("each street waits for the host", async () => {
      const t = await Table.create(server.url, ["Ann", "Ben", "Cy"]);
      try {
        check("gate: confirm_deal is rejected when nothing is waiting", !(await t.confirmDeal()).ok);
        await t.startHand();
        check("gate: preflop starts straight into betting", !t.state.awaitingDeal && !!t.state.actingPlayerId);
        const dealtCards = { flop: 3, turn: 1, river: 1 };

        let street = "preflop";
        for (const next of ["flop", "turn", "river"]) {
          await bettingUntilStreetChanges(t, street);
          check(`gate: ${next} opens waiting for the host`, t.state.street === next && t.state.awaitingDeal === true, `${t.state.street} awaiting=${t.state.awaitingDeal}`);
          check(`gate: nobody is asked to act on the ${next} yet`, t.state.actingPlayerId === null);

          const early = await t.act(t.nameOfId(t.state.players.find((p) => p.inHand).id), "check");
          check(`gate: an action before the ${next} is dealt is rejected`, !early.ok, JSON.stringify(early));
          const sneaky = await t.confirmDeal("Ben");
          check(`gate: a non-host cannot confirm the ${next}`, !sneaky.ok);

          const ok = await t.confirmDeal();
          check(`gate: host confirms ${dealtCards[next]} card(s) for the ${next}`, ok.ok, ok.error);
          check(`gate: betting starts after the ${next} is confirmed`, !t.state.awaitingDeal && !!t.state.actingPlayerId);
          street = next;
        }

        await bettingUntilStreetChanges(t, "river");
        check("gate: after the river betting the hand goes to showdown", t.state.status === "paused" && t.state.street === "showdown" && !t.state.awaitingDeal);
        await t.declare(["Ann"]);
        await t.waitForIdlePayout();
        await t.startHand();
        check("gate: a new hand starts with no pending deal", !t.state.awaitingDeal && t.state.street === "preflop");
      } finally {
        await t.close();
      }
    });

    await scenario("all-in runout still deals every street", async () => {
      const t = await Table.create(server.url, ["Ann", "Ben", "Cy"], { startingStack: 200 });
      try {
        await t.startHand();
        for (let i = 0; i < 6 && t.state.status === "in_hand" && !t.state.awaitingDeal; i += 1) {
          const actor = t.actingName();
          await t.act(actor, "all_in");
        }
        check("runout: flop is waiting for the host", t.state.awaitingDeal && t.state.street === "flop", `${t.state.street} awaiting=${t.state.awaitingDeal}`);
        let confirms = 0;
        const seen = [];
        while (t.state.status === "in_hand" && t.state.awaitingDeal && confirms < 5) {
          seen.push(t.state.street);
          check(`runout: nobody acts while the ${t.state.street} is dealt`, t.state.actingPlayerId === null);
          const res = await t.confirmDeal();
          check(`runout: host confirms the ${t.state.street === "flop" ? "flop" : "next card"}`, res.ok, res.error);
          confirms += 1;
        }
        check("runout: flop, turn and river each needed a confirmation", seen.join() === "flop,turn,river", seen.join());
        check("runout: then straight to showdown", t.state.status === "paused" && t.state.street === "showdown");
        check("runout: chips conserved", t.totalStacks() + t.totalPot() === 600, String(t.totalStacks() + t.totalPot()));
      } finally {
        await t.close();
      }
    });

    await scenario("removing players while a street is waiting for the deal", async () => {
      const t = await Table.create(server.url, ["Ann", "Ben", "Cy", "Di"]);
      try {
        await t.startHand();
        await bettingUntilStreetChanges(t, "preflop");
        check("kick-gate: flop is waiting", t.state.awaitingDeal && t.state.street === "flop");
        await t.kick("Cy");
        check("kick-gate: still waiting for the host after a removal", t.state.awaitingDeal && t.state.street === "flop" && t.state.actingPlayerId === null);
        await t.confirmDeal();
        const acting = t.state.players.find((p) => p.id === t.state.actingPlayerId);
        check("kick-gate: after the deal the next actor is a live player", !!acting && acting.inHand && acting.displayName !== "Cy");

        // Leave only one player standing during a deal wait: the hand settles.
        await bettingUntilStreetChanges(t, "flop");
        check("kick-gate: turn is waiting", t.state.awaitingDeal && t.state.street === "turn");
        await t.kick("Di");
        check("kick-gate: removing down to two players keeps the hand going", t.state.status === "in_hand" && t.state.awaitingDeal);
        await t.kick("Ben");
        check("kick-gate: removing the second-to-last player settles the hand", t.state.status === "waiting" && !t.state.awaitingDeal, `${t.state.status} awaiting=${t.state.awaitingDeal}`);
      } finally {
        await t.close();
      }
    });
  } finally {
    await server.stop();
  }
  finish("deal gate");
}

void main();
