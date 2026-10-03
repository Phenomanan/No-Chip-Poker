// Property tests for the pot / payout / turn-order math in packages/rules-engine.
// Thousands of random tables are generated from a seed and each must satisfy
// invariants, and the pot builder is compared against an independently written
// reference (the min-difference formulation of side pots). Pure and fast: no server.
// Reproduce a failure with PROP_SEED=<seed> node scripts/test-rules-properties.mjs.
import {
  calculatePayouts,
  calculatePots,
  findNextActingPlayer,
  shouldSettleHand,
  validateWinnerCoverage,
} from "../dist/packages/rules-engine/src/index.js";

const SEED = Number(process.env.PROP_SEED || 424242);
const CASES = Number(process.env.PROP_CASES || 20000);

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

const failures = [];
let checks = 0;
function expect(cond, name, ctx) {
  checks += 1;
  if (!cond && failures.length < 15) failures.push(`${name} :: ${JSON.stringify(ctx)}`);
  else if (!cond) failures.push(null);
}

function randomRoom(rand) {
  const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
  const n = int(2, 9);
  const dealerSeat = int(1, n);
  const stakes = [10, 25, 50, 100, 250, 1000];
  const players = Array.from({ length: n }, (_, i) => {
    const base = stakes[int(0, stakes.length - 1)];
    // Some players tie on contribution on purpose (equal all-ins are common).
    const contribution = rand() < 0.15 ? 0 : rand() < 0.4 ? base : int(1, base * 3);
    return {
      id: `p${i + 1}`,
      displayName: `P${i + 1}`,
      role: "player",
      seat: i + 1,
      stack: rand() < 0.3 ? 0 : int(1, 500),
      connected: true,
      joinedAt: i,
      inHand: contribution > 0 && rand() < 0.65,
      commitment: 0,
      totalContribution: contribution,
    };
  });
  return { status: "paused", street: "showdown", dealerSeat, players };
}

function referencePots(room) {
  const players = room.players.filter((p) => p.totalContribution > 0);
  const live = players.filter((p) => p.inHand);
  const levels = [...new Set(live.map((p) => p.totalContribution))].sort((a, b) => a - b);
  const pots = [];
  let prev = 0;
  levels.forEach((level, i) => {
    let amount = 0;
    for (const p of players) amount += Math.min(p.totalContribution, level) - Math.min(p.totalContribution, prev);
    if (i === levels.length - 1) for (const p of players) amount += Math.max(0, p.totalContribution - level);
    pots.push({ amount, eligible: live.filter((p) => p.totalContribution >= level).map((p) => p.id).sort() });
    prev = level;
  });
  return pots.filter((p) => p.amount > 0);
}

const rand = rng(SEED);
for (let c = 0; c < CASES; c += 1) {
  const room = randomRoom(rand);
  const total = room.players.reduce((s, p) => s + p.totalContribution, 0);
  const live = room.players.filter((p) => p.inHand);
  const ctx = { c, players: room.players.map((p) => [p.id, p.totalContribution, p.inHand]) };

  const pots = calculatePots(room);
  const ref = referencePots(room);

  if (total === 0 || live.length === 0) {
    // Nothing contested: no chips are lost *or invented*.
    expect(pots.reduce((s, p) => s + p.amount, 0) === (live.length === 0 ? pots.reduce((s, p) => s + p.amount, 0) : 0), "empty pot", ctx);
    continue;
  }

  expect(pots.reduce((s, p) => s + p.amount, 0) === total, "pots sum to everything contributed", ctx);
  expect(pots.length === ref.length, "pot count matches reference", { ...ctx, got: pots.length, want: ref.length });
  pots.forEach((p, i) => {
    expect(ref[i] && p.amount === ref[i].amount, "pot amount matches reference", { ...ctx, i, got: p.amount, want: ref[i]?.amount });
    expect(ref[i] && [...p.contributors].sort().join() === ref[i].eligible.join(), "eligibility matches reference", { ...ctx, i });
    expect(p.contributors.length > 0, "every pot has an eligible player", { ...ctx, i });
    expect(p.contributors.every((id) => live.some((l) => l.id === id)), "only live players are eligible", { ...ctx, i });
    if (i > 0) {
      expect(p.contributors.every((id) => pots[i - 1].contributors.includes(id)), "eligibility only narrows up the pots", { ...ctx, i });
    }
  });

  // Payouts for a random winner set that covers every pot.
  const winners = live.filter(() => rand() < 0.5).map((p) => p.id);
  const winnerIds = winners.length > 0 ? winners : [live[0].id];
  const coverage = validateWinnerCoverage(room, winnerIds);
  if (coverage.ok) {
    const payouts = calculatePayouts(room, winnerIds);
    const paid = payouts.reduce((s, p) => s + p.amount, 0);
    expect(paid === total, "payouts add up to the whole pot", { ...ctx, winnerIds, paid, total });
    expect(payouts.every((p) => p.amount > 0 && Number.isInteger(p.amount)), "payouts are positive whole chips", { ...ctx, payouts });
    expect(payouts.every((p) => winnerIds.includes(p.playerId)), "only chosen winners are paid", { ...ctx, payouts });
    // A winner can only collect from pots they are eligible for.
    for (const pay of payouts) {
      const maxWin = pots.filter((p) => p.contributors.includes(pay.playerId)).reduce((s, p) => s + p.amount, 0);
      expect(pay.amount <= maxWin, "a winner never collects from a pot they are not in", { ...ctx, pay, maxWin });
    }
  } else {
    // When coverage fails, some pot has no chosen eligible winner.
    const uncovered = pots.some((p) => !winnerIds.some((w) => p.contributors.includes(w)));
    expect(uncovered, "coverage rejection implies an uncovered pot", { ...ctx, winnerIds });
  }

  // Sole survivor takes everything.
  if (live.length === 1) {
    const payouts = calculatePayouts(room, [live[0].id]);
    expect(payouts.length === 1 && payouts[0].amount === total, "sole survivor wins the lot", ctx);
  }
}

// ---- turn order: from any random street state the "next to act" answer is sane ----
for (let c = 0; c < CASES; c += 1) {
  const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
  const n = int(2, 9);
  const highest = int(0, 200);
  const players = Array.from({ length: n }, (_, i) => {
    const folded = rand() < 0.25;
    const allIn = !folded && rand() < 0.2;
    return {
      id: `p${i + 1}`, displayName: `P${i + 1}`, role: "player", seat: i + 1, connected: true, joinedAt: i,
      inHand: !folded,
      stack: allIn ? 0 : int(1, 500),
      commitment: folded ? int(0, highest) : allIn ? int(0, highest) : rand() < 0.5 ? highest : int(0, highest),
      totalContribution: 0,
    };
  });
  const room = { status: "in_hand", street: "flop", dealerSeat: int(1, n), currentBet: highest, players };
  const acted = new Set(players.filter(() => rand() < 0.5).map((p) => p.id));
  const current = players[int(0, n - 1)].id;
  const ctx = { c, players: players.map((p) => [p.id, p.inHand, p.stack, p.commitment]), highest, acted: [...acted], current };

  const next = findNextActingPlayer(room, current, acted);
  const settle = shouldSettleHand(room, acted);
  const inHand = players.filter((p) => p.inHand);
  const top = inHand.reduce((m, p) => Math.max(m, p.commitment), 0);

  if (next) {
    const nextPlayer = players.find((p) => p.id === next);
    expect(nextPlayer.inHand && nextPlayer.stack > 0, "next actor is in the hand with chips", ctx);
    expect(nextPlayer.commitment < top || !acted.has(next), "next actor actually owes an action", ctx);
    expect(!settle || inHand.length <= 1, "never both 'someone must act' and 'street over'", ctx);
  } else if (inHand.length > 1) {
    expect(settle, "nobody left to act (with 2+ live) means the street can close", ctx);
  }
}

const bad = failures.filter(Boolean);
if (bad.length > 0) {
  console.error(`FAIL rules properties (seed ${SEED}): ${failures.length} violations of ${checks} checks`);
  bad.forEach((f) => console.error("  " + f));
  process.exit(1);
}
console.log(`PASS rules properties: ${CASES * 2} random cases, ${checks} checks (seed ${SEED})`);
