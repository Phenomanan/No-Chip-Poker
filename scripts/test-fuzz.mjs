// Seeded randomized play against a real server. Plays many hands with random
// legal actions (fold/check/call/raise/all-in), side pots, random winner
// declarations, and between-hand churn (reorders, kicks, late joiners,
// reconnects), plus illegal moves that must be rejected. After every step it
// asserts the invariants that have to hold no matter what players do:
//   - chips are conserved (stacks + live pot == what was put into the game)
//   - the pot equals everything contributed this hand
//   - the acting player is always someone who can actually act
//   - hands never get stuck, payouts always add up to the pot
// Reproduce a failure with FUZZ_SEED=<seed> npm run test:fuzz.
import { Table, makeChecker, startServer, wait } from "./lib/test-harness.mjs";

const PORT = Number(process.env.FUZZ_PORT || 3061);
const BASE_SEED = Number(process.env.FUZZ_SEED || 20261002);
const TABLES = Number(process.env.FUZZ_TABLES || 5);
const HANDS_PER_TABLE = Number(process.env.FUZZ_HANDS || 10);
const MAX_PLAYERS = Number(process.env.FUZZ_MAX_PLAYERS || 6);
const { check, finish } = makeChecker();

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

class InvariantError extends Error {}

function assert(condition, message) {
  if (!condition) throw new InvariantError(message);
}

async function playTable(server, seed) {
  const rand = rng(seed);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));

  const playerCount = int(2, MAX_PLAYERS);
  const startingStack = pick([150, 400, 1000, 1500]);
  const bigBlind = pick([10, 20, 50]);
  const names = ["Host", ...Array.from({ length: playerCount - 1 }, (_, i) => `P${i + 2}`)];
  const t = await Table.create(server.url, names, { smallBlind: bigBlind / 2, bigBlind, startingStack });
  let expectedTotal = playerCount * startingStack;
  let nextJoiner = playerCount + 1;
  const log = [];
  const note = (line) => log.push(line);
  let handsPlayed = 0;
  let stats = { actions: 0, raises: 0, allIns: 0, sidePots: 0, kicks: 0, reorders: 0, joins: 0, reconnects: 0, rejected: 0, showdowns: 0 };

  const seated = () => t.state.players.filter((p) => !p.pendingRemoval);

  function checkConservation(label) {
    const s = t.state;
    const stacks = s.players.reduce((sum, p) => sum + p.stack, 0);
    const live = s.status === "in_hand" || s.status === "paused" ? (s.pots || []).reduce((sum, p) => sum + p.amount, 0) : 0;
    assert(stacks + live === expectedTotal, `${label}: chips not conserved — stacks ${stacks} + pot ${live} != ${expectedTotal}`);
    for (const p of s.players) {
      assert(p.stack >= 0, `${label}: ${p.displayName} has negative stack ${p.stack}`);
    }
    if (s.status === "in_hand" || s.status === "paused") {
      const contributed = s.players.reduce((sum, p) => sum + p.totalContribution, 0);
      assert(live === contributed, `${label}: pot ${live} != total contributed ${contributed}`);
    }
  }

  function checkActing(label) {
    const s = t.state;
    if (s.status !== "in_hand" || s.awaitingDeal) {
      assert(s.actingPlayerId === null, `${label}: acting player set while status is ${s.status}${s.awaitingDeal ? " (waiting for the deal)" : ""}`);
      return;
    }
    const actor = s.players.find((p) => p.id === s.actingPlayerId);
    assert(actor, `${label}: no acting player during a hand`);
    assert(actor.inHand, `${label}: acting player ${actor.displayName} has folded`);
    assert(actor.stack > 0, `${label}: acting player ${actor.displayName} has no chips`);
    assert(!actor.pendingRemoval, `${label}: acting player was removed`);
  }

  async function randomAction() {
    const s = t.state;
    const actorName = t.actingName();
    const me = s.players.find((p) => p.id === t.id(actorName));
    const need = Math.max(0, s.currentBet - me.commitment);
    const roll = rand();
    let action;
    let amount;

    if (roll < 0.14 && need > 0) {
      action = "fold";
    } else if (roll < 0.19 && me.stack > 0) {
      action = "all_in";
      stats.allIns += 1;
    } else if (roll < 0.42 && me.stack > need) {
      const lo = s.currentBet + 1;
      const hi = me.commitment + me.stack - 1;
      if (hi >= lo) {
        action = "raise";
        amount = int(lo, hi);
        stats.raises += 1;
      }
    }
    if (!action) {
      action = need > 0 ? (me.stack >= need ? "call" : "all_in") : "check";
    }

    const result = await t.act(actorName, action, amount);
    stats.actions += 1;
    assert(result.ok, `${actorName} ${action}${amount ? ` ${amount}` : ""} was rejected: ${result.error} (state: bet ${s.currentBet}, commit ${me.commitment}, stack ${me.stack})`);
    return `${actorName}:${action}${amount ? amount : ""}`;
  }

  async function illegalProbe() {
    const s = t.state;
    const actorName = t.actingName();
    const others = seated().filter((p) => t.nameOfId(p.id) !== actorName && p.inHand);
    if (others.length === 0) return;
    const other = t.nameOfId(pick(others).id);
    const before = JSON.stringify([s.actingPlayerId, s.currentBet, s.pots]);
    const result = await t.act(other, "check");
    stats.rejected += 1;
    assert(!result.ok, `${other} acted out of turn and it was accepted`);
    assert(JSON.stringify([t.state.actingPlayerId, t.state.currentBet, t.state.pots]) === before, "an out-of-turn action changed the table");
    const reorder = await t.reorder(seated().map((p) => t.nameOfId(p.id)));
    assert(!reorder.ok, "reorder was accepted during a hand");
    // Only a non-host's attempt must fail (the host removing someone is legitimate).
    const nonHostOthers = others.filter((p) => p.displayName !== "Host");
    if (nonHostOthers.length > 0) {
      const kicker = t.nameOfId(pick(nonHostOthers).id);
      const target = actorName === kicker ? other : actorName;
      const kickByPlayer = await t.kick(target, kicker);
      assert(!kickByPlayer.ok, "a non-host removed a player");
    }
  }

  async function declareRandomWinners() {
    const s = t.state;
    const pots = s.pots;
    const total = pots.reduce((sum, p) => sum + p.amount, 0);
    if (pots.length > 1) stats.sidePots += 1;
    const perPot = pots.map((pot) => {
      const eligible = pot.contributors.map((id) => t.nameOfId(id));
      assert(eligible.length > 0, "a pot has no eligible winner");
      const count = int(1, eligible.length);
      return [...eligible].sort(() => rand() - 0.5).slice(0, count);
    });
    const union = [...new Set(perPot.flat())];
    const result = await t.declare(union, pots.length > 1 ? perPot : undefined);
    assert(result.ok, `declare_winners rejected: ${result.error}`);
    assert(t.state.status === "waiting", `hand did not resolve after declaring winners (status ${t.state.status})`);
    const paid = t.state.payouts.reduce((sum, p) => sum + p.amount, 0);
    assert(paid === total, `payouts ${paid} != pot ${total}`);
    stats.showdowns += 1;
  }

  async function betweenHands() {
    const roll = rand();
    if (roll < 0.35) {
      const order = seated().map((p) => t.nameOfId(p.id)).sort(() => rand() - 0.5);
      const res = await t.reorder(order);
      assert(res.ok, `reorder between hands rejected: ${res.error}`);
      const seats = order.map((n) => t.seatOf(n));
      assert(seats.every((seat, i) => seat === i + 1), `reorder did not apply: ${seats.join()}`);
      stats.reorders += 1;
    } else if (roll < 0.5 && seated().length > 3) {
      const victims = seated().filter((p) => p.displayName !== "Host");
      const victim = pick(victims);
      expectedTotal -= victim.stack;
      const res = await t.kick(t.nameOfId(victim.id));
      assert(res.ok, `kick between hands rejected: ${res.error}`);
      stats.kicks += 1;
    } else if (roll < 0.62 && seated().length < 8) {
      const name = `P${nextJoiner++}`;
      await t.join(name);
      await wait(120);
      expectedTotal += startingStack;
      stats.joins += 1;
    } else if (roll < 0.74) {
      const who = t.nameOfId(pick(seated()).id);
      await t.reconnect(who);
      assert(t.state.players.find((p) => p.id === t.id(who))?.connected, `${who} not connected after rejoin`);
      stats.reconnects += 1;
    }
    checkConservation("after between-hand change");
  }

  try {
    for (let hand = 1; hand <= HANDS_PER_TABLE; hand += 1) {
      // Someone busted everyone else: bring in a new player so the table keeps going.
      while (seated().filter((p) => p.stack > 0).length < 2) {
        await t.join(`P${nextJoiner++}`);
        await wait(120);
        expectedTotal += startingStack;
        stats.joins += 1;
      }

      await betweenHands();
      while (seated().filter((p) => p.stack > 0).length < 2) {
        await t.join(`P${nextJoiner++}`);
        await wait(120);
        expectedTotal += startingStack;
        stats.joins += 1;
      }

      const started = await t.startHand();
      assert(started.ok, `start_hand rejected: ${started.error}`);
      handsPlayed += 1;
      // Blinds can be everyone's whole stack, in which case the hand opens at showdown.
      assert(t.state.status === "in_hand" || t.state.status === "paused", `hand did not start (status ${t.state.status})`);
      checkConservation(`hand ${hand} start`);

      const actions = [];
      let steps = 0;
      while (t.state.status === "in_hand") {
        steps += 1;
        assert(steps < 250, `hand ${hand} is stuck after ${steps} steps; last: ${actions.slice(-6).join(" ")}`);
        checkActing(`hand ${hand} step ${steps}`);
        if (rand() < 0.12 && !t.state.awaitingDeal) await illegalProbe();

        // Occasionally the host removes a non-host player mid-hand.
        if (steps > 2 && rand() < 0.04) {
          const victims = seated().filter((p) => p.displayName !== "Host" && (p.inHand || p.totalContribution > 0));
          if (victims.length > 0 && seated().filter((p) => p.inHand).length > 2) {
            const victim = pick(victims);
            expectedTotal -= victim.stack;
            const res = await t.kick(t.nameOfId(victim.id));
            assert(res.ok, `mid-hand kick rejected: ${res.error}`);
            actions.push(`KICK:${victim.displayName}`);
            stats.kicks += 1;
            checkConservation(`hand ${hand} after mid-hand kick`);
            if (t.state.status !== "in_hand") break;
            checkActing(`hand ${hand} after mid-hand kick`);
          }
        }

        if (t.state.awaitingDeal) {
          // Betting must not start until the host confirms the new cards are dealt.
          const early = await t.act(seated().find((p) => p.inHand && p.stack > 0)?.displayName ?? "Host", "check");
          assert(!early.ok, "an action was accepted while the street was waiting for the deal");
          const outsider = seated().find((p) => p.displayName !== "Host");
          if (outsider) {
            const sneaky = await t.confirmDeal(outsider.displayName);
            assert(!sneaky.ok, "a non-host confirmed the deal");
          }
          const dealt = await t.confirmDeal();
          assert(dealt.ok, `confirm_deal rejected: ${dealt.error}`);
          actions.push(`DEAL:${t.state.street}`);
          stats.deals = (stats.deals || 0) + 1;
          checkConservation(`hand ${hand} after the deal`);
          continue;
        }
        actions.push(await randomAction());
        checkConservation(`hand ${hand} after ${actions[actions.length - 1]}`);
      }

      if (t.state.status === "paused") {
        assert(t.state.street === "showdown", `paused outside showdown (${t.state.street})`);
        const reorder = await t.reorder(seated().map((p) => t.nameOfId(p.id)));
        assert(!reorder.ok, "reorder was accepted at showdown");
        await declareRandomWinners();
      }
      assert(t.state.status === "waiting", `hand ${hand} ended in status ${t.state.status}`);
      await t.waitForIdlePayout();
      checkConservation(`hand ${hand} paid out`);
      assert(t.state.players.every((p) => !p.pendingRemoval), `hand ${hand}: removed players linger after settle`);
      note(`hand ${hand}: ${actions.join(" ")}`);
    }
    check(`fuzz seed ${seed}: ${handsPlayed} hands, ${names.length} players, stack ${startingStack}, bb ${bigBlind} (${JSON.stringify(stats)})`, true);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    check(`fuzz seed ${seed}`, false, `${detail}\n  recent: ${log.slice(-3).join("\n          ")}`);
  } finally {
    await t.close();
  }
}

async function main() {
  const server = await startServer(PORT);
  try {
    for (let i = 0; i < TABLES; i += 1) {
      await playTable(server, BASE_SEED + i * 7919);
    }
  } finally {
    await server.stop();
  }
  finish("fuzz");
}

void main();
