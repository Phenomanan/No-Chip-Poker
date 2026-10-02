// Pure unit tests for packages/rules-engine — no server, no sockets. These run
// directly against the compiled rules-engine module so they're fast enough to
// run on every change and can pin down exact regressions (turn-order skipping,
// spurious side pots from folded players) with minimal, readable fixtures.
import {
  calculatePayouts,
  calculatePots,
  canRemovePlayer,
  canReorderSeats,
  canStartHand,
  findNextActingPlayer,
  shouldSettleHand,
  validateAction,
  validateWinnerCoverage,
} from "../dist/packages/rules-engine/src/index.js";

let passCount = 0;
let failCount = 0;

function check(name, condition, detail) {
  if (condition) {
    passCount += 1;
    console.log(`PASS ${name}`);
  } else {
    failCount += 1;
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function makePlayer(overrides) {
  return {
    id: overrides.id,
    displayName: overrides.displayName ?? overrides.id,
    role: overrides.role ?? "player",
    seat: overrides.seat,
    stack: overrides.stack ?? 0,
    connected: true,
    joinedAt: 0,
    inHand: overrides.inHand ?? true,
    commitment: overrides.commitment ?? 0,
    totalContribution: overrides.totalContribution ?? overrides.commitment ?? 0,
  };
}

function makeRoom(overrides) {
  return {
    id: "room-1",
    code: "ABCDEF",
    name: "Test Room",
    status: overrides.status ?? "in_hand",
    street: overrides.street ?? "preflop",
    hostPlayerId: overrides.hostPlayerId ?? overrides.players[0].id,
    dealerSeat: overrides.dealerSeat ?? 1,
    smallBlindSeat: overrides.smallBlindSeat ?? 1,
    actingPlayerId: overrides.actingPlayerId ?? null,
    pots: overrides.pots ?? [],
    currentBet: overrides.currentBet ?? 0,
    blinds: overrides.blinds ?? { smallBlind: 5, bigBlind: 10 },
    players: overrides.players,
    actionLog: [],
    payouts: overrides.payouts ?? [],
    payoutState: overrides.payoutState ?? "idle",
    payoutAnimationEndsAt: null,
    messages: [],
    blindVote: null,
    blindSchedule: { enabled: false, levelDurationSeconds: 900, levelNumber: 1, nextLevelAt: null },
    updatedAt: Date.now(),
  };
}

// --- calculatePots -----------------------------------------------------

(function testCalculatePotsSimpleCase() {
  const room = makeRoom({
    players: [
      makePlayer({ id: "p1", seat: 1, stack: 100, commitment: 50 }),
      makePlayer({ id: "p2", seat: 2, stack: 100, commitment: 50 }),
    ],
  });

  const pots = calculatePots(room);
  check("calculatePots: two equal live contributors form a single pot", pots.length === 1, JSON.stringify(pots));
  check("calculatePots: single pot amount is the sum of both commitments", pots[0]?.amount === 100, JSON.stringify(pots));
  check(
    "calculatePots: both live players are eligible for the single pot",
    new Set(pots[0]?.contributors).size === 2,
    JSON.stringify(pots)
  );
})();

(function testCalculatePotsAllInSidePot() {
  const room = makeRoom({
    players: [
      makePlayer({ id: "short", seat: 1, stack: 0, commitment: 100 }),
      makePlayer({ id: "deep", seat: 2, stack: 200, commitment: 300 }),
    ],
  });

  const pots = calculatePots(room);
  check("calculatePots: all-in short stack creates main + side pot", pots.length === 2, JSON.stringify(pots));
  check("calculatePots: main pot is capped at the short stack's contribution", pots[0]?.amount === 200, JSON.stringify(pots));
  check(
    "calculatePots: main pot is contested by both players",
    new Set(pots[0]?.contributors).size === 2,
    JSON.stringify(pots)
  );
  check("calculatePots: side pot is the deep stack's uncalled excess", pots[1]?.amount === 200, JSON.stringify(pots));
  check(
    "calculatePots: side pot is only eligible to the deep stack",
    pots[1]?.contributors.length === 1 && pots[1].contributors[0] === "deep",
    JSON.stringify(pots)
  );
})();

// Regression: a player folding after committing chips must NOT create its own
// side-pot tier. Before the fix, calculatePots treated every distinct
// contribution level (including folded players') as a tier boundary, so any
// fold-then-raise sequence produced a spurious "side pot" with the exact same
// eligible players as the main pot.
(function testCalculatePotsFoldDoesNotCreateSidePot() {
  const room = makeRoom({
    players: [
      makePlayer({ id: "folder", seat: 1, stack: 400, commitment: 100, totalContribution: 100, inHand: false }),
      makePlayer({ id: "p2", seat: 2, stack: 200, commitment: 300 }),
      makePlayer({ id: "p3", seat: 3, stack: 200, commitment: 300 }),
    ],
  });

  const pots = calculatePots(room);
  check(
    "calculatePots: a folded player's contribution does not create a spurious side pot",
    pots.length === 1,
    `expected 1 pot, got ${JSON.stringify(pots)}`
  );
  check("calculatePots: the single pot includes the folded player's dead money", pots[0]?.amount === 700, JSON.stringify(pots));
  check(
    "calculatePots: the folded player is not eligible to win",
    !pots[0]?.contributors.includes("folder"),
    JSON.stringify(pots)
  );
  check(
    "calculatePots: both live players are eligible",
    new Set(pots[0]?.contributors).size === 2,
    JSON.stringify(pots)
  );
})();

(function testCalculatePotsFoldBetweenTwoLiveAllInTiers() {
  // folder commits 150 and folds; p2 is all-in for 100; p3 covers everyone at 300.
  // Tiers must come only from the live players' levels (100, 300) — the
  // folder's 150 must be absorbed into the existing tiers, not create a third.
  const room = makeRoom({
    players: [
      makePlayer({ id: "folder", seat: 1, stack: 50, commitment: 150, totalContribution: 150, inHand: false }),
      makePlayer({ id: "shortAllIn", seat: 2, stack: 0, commitment: 100 }),
      makePlayer({ id: "cover", seat: 3, stack: 200, commitment: 300 }),
    ],
  });

  const pots = calculatePots(room);
  const total = pots.reduce((sum, pot) => sum + pot.amount, 0);
  check("calculatePots: fold between two live tiers still produces exactly 2 pots", pots.length === 2, JSON.stringify(pots));
  check("calculatePots: total pot amount conserves all contributed chips", total === 550, `expected 550, got ${total}`);
})();

// --- calculatePayouts ----------------------------------------------------

(function testCalculatePayoutsRemainderDistribution() {
  const room = makeRoom({
    players: [
      makePlayer({ id: "p1", seat: 1, stack: 0, commitment: 100 }),
      makePlayer({ id: "p2", seat: 2, stack: 0, commitment: 100 }),
      makePlayer({ id: "p3", seat: 3, stack: 0, commitment: 100 }),
    ],
  });

  const payouts = calculatePayouts(room, ["p1", "p2", "p3"]);
  const total = payouts.reduce((sum, payout) => sum + payout.amount, 0);
  check("calculatePayouts: odd remainder chips are fully distributed", total === 300, `expected 300, got ${total}`);
  check(
    "calculatePayouts: remainder chips go to at most one extra winner each",
    payouts.every((payout) => payout.amount === 100 || payout.amount === 101),
    JSON.stringify(payouts)
  );
})();

// --- findNextActingPlayer (turn-order regression) -------------------------

// Regression: previously, once the current actor was matched/removed from the
// "still needs to act" set, the fallback picked the LOWEST-SEAT player in that
// set rather than the next seat clockwise from the actor. With seats
// 1(commit 25),2(commit 50),3(raises to 200),4(commit 0), the old code sent
// action back to seat 1 after seat 3's raise — skipping seat 4 entirely out of
// its natural turn order (seat 4 would still eventually act, but far out of
// order, which is exactly what testers reported as "turns getting skipped").
(function testFindNextActingPlayerFollowsSeatOrderAfterRaise() {
  const room = makeRoom({
    currentBet: 200,
    players: [
      makePlayer({ id: "seat1", seat: 1, stack: 500, commitment: 25 }),
      makePlayer({ id: "seat2", seat: 2, stack: 500, commitment: 50 }),
      makePlayer({ id: "seat3", seat: 3, stack: 500, commitment: 200 }),
      makePlayer({ id: "seat4", seat: 4, stack: 500, commitment: 0 }),
    ],
  });

  // seat3 (the raiser) has acted; the others haven't, and matter regardless
  // of the acted-set since their commitment is still behind the raise.
  const next = findNextActingPlayer(room, "seat3", new Set(["seat3"]));
  check(
    "findNextActingPlayer: acts on the next seat clockwise from the raiser, not the lowest pending seat",
    next === "seat4",
    `expected seat4, got ${next}`
  );
})();

(function testFindNextActingPlayerWrapsAroundTheTable() {
  // seat4 just acted (now matches 200); seat1 and seat2 still owe action and
  // must be visited in seat order, wrapping past the table from seat4 -> seat1.
  const room = makeRoom({
    currentBet: 200,
    players: [
      makePlayer({ id: "seat1", seat: 1, stack: 500, commitment: 25 }),
      makePlayer({ id: "seat2", seat: 2, stack: 500, commitment: 50 }),
      makePlayer({ id: "seat3", seat: 3, stack: 500, commitment: 200 }),
      makePlayer({ id: "seat4", seat: 4, stack: 500, commitment: 200 }),
    ],
  });

  const next = findNextActingPlayer(room, "seat4", new Set(["seat3", "seat4"]));
  check("findNextActingPlayer: wraps around the table in seat order", next === "seat1", `expected seat1, got ${next}`);
})();

// Regression: the big blind's posted commitment can already equal the
// table's highest commitment without them ever having acted this street —
// they must still get their option to check or raise before the street ends.
(function testFindNextActingPlayerGivesBigBlindTheOption() {
  const room = makeRoom({
    currentBet: 20,
    players: [
      makePlayer({ id: "utg", seat: 1, stack: 500, commitment: 20 }),
      makePlayer({ id: "sb", seat: 2, stack: 500, commitment: 20 }),
      makePlayer({ id: "bb", seat: 3, stack: 500, commitment: 20 }),
    ],
  });

  // UTG and SB have both called up to the big blind's amount and acted; the
  // big blind itself has not acted yet, so it must still be their turn.
  const next = findNextActingPlayer(room, "sb", new Set(["utg", "sb"]));
  check(
    "findNextActingPlayer: gives the big blind their option when everyone just calls",
    next === "bb",
    `expected bb, got ${next}`
  );

  // Once the big blind has also acted (checked), the street is done.
  const afterBbActs = findNextActingPlayer(room, "bb", new Set(["utg", "sb", "bb"]));
  check(
    "findNextActingPlayer: returns null once the big blind has taken their option",
    afterBbActs === null,
    `expected null, got ${afterBbActs}`
  );
})();

(function testFindNextActingPlayerChecksAroundOnCurrentBetZero() {
  const room = makeRoom({
    currentBet: 0,
    players: [
      makePlayer({ id: "p1", seat: 1, stack: 500 }),
      makePlayer({ id: "p2", seat: 2, stack: 500 }),
      makePlayer({ id: "p3", seat: 3, stack: 500 }),
    ],
  });

  const acted = new Set(["p1"]);
  const next = findNextActingPlayer(room, "p1", acted);
  check("findNextActingPlayer: check-around picks the next unacted seat", next === "p2", `expected p2, got ${next}`);

  const allActed = new Set(["p1", "p2", "p3"]);
  const done = findNextActingPlayer(room, "p3", allActed);
  check("findNextActingPlayer: returns null once everyone has acted", done === null, `expected null, got ${done}`);
})();

// --- shouldSettleHand ------------------------------------------------------

(function testShouldSettleHand() {
  const pendingRoom = makeRoom({
    currentBet: 100,
    players: [
      makePlayer({ id: "p1", seat: 1, stack: 500, commitment: 100 }),
      makePlayer({ id: "p2", seat: 2, stack: 500, commitment: 50 }),
    ],
  });
  check("shouldSettleHand: false while a live player still owes chips", shouldSettleHand(pendingRoom, new Set()) === false);

  const matchedRoom = makeRoom({
    currentBet: 100,
    players: [
      makePlayer({ id: "p1", seat: 1, stack: 500, commitment: 100 }),
      makePlayer({ id: "p2", seat: 2, stack: 500, commitment: 100 }),
    ],
  });
  check(
    "shouldSettleHand: true once every live player has matched the bet AND acted",
    shouldSettleHand(matchedRoom, new Set(["p1", "p2"])) === true
  );

  // Regression: the big blind's posted commitment can already equal the
  // table's highest commitment (nobody raised) without the blind ever having
  // acted this street — the street must NOT end until they get their option.
  check(
    "shouldSettleHand: false when a matched player (e.g. the big blind) hasn't acted yet",
    shouldSettleHand(matchedRoom, new Set(["p1"])) === false
  );

  const checkedAroundRoom = makeRoom({
    currentBet: 0,
    players: [
      makePlayer({ id: "p1", seat: 1, stack: 500 }),
      makePlayer({ id: "p2", seat: 2, stack: 500 }),
    ],
  });
  check(
    "shouldSettleHand: false on a check-around street until everyone has acted",
    shouldSettleHand(checkedAroundRoom, new Set(["p1"])) === false
  );
  check(
    "shouldSettleHand: true on a check-around street once everyone has acted",
    shouldSettleHand(checkedAroundRoom, new Set(["p1", "p2"])) === true
  );

  const soleSurvivorRoom = makeRoom({
    players: [
      makePlayer({ id: "p1", seat: 1, stack: 500 }),
      makePlayer({ id: "p2", seat: 2, stack: 500, inHand: false }),
    ],
  });
  check("shouldSettleHand: true when only one player remains in the hand", shouldSettleHand(soleSurvivorRoom, new Set()) === true);
})();

// --- canStartHand: no ack step should ever block it -------------------------

(function testCanStartHandOnlyBlocksOnAnimating() {
  const idleRoom = makeRoom({ status: "waiting", players: [makePlayer({ id: "host", seat: 1, stack: 500 }), makePlayer({ id: "p2", seat: 2, stack: 500 })], payoutState: "idle" });
  check("canStartHand: allowed when payoutState is idle", canStartHand(idleRoom, "host").ok === true);

  const animatingRoom = makeRoom({ status: "waiting", players: [makePlayer({ id: "host", seat: 1, stack: 500 }), makePlayer({ id: "p2", seat: 2, stack: 500 })], payoutState: "animating" });
  check("canStartHand: blocked while the cosmetic payout animation runs", canStartHand(animatingRoom, "host").ok === false);
})();

// --- canRemovePlayer / canReorderSeats (admin controls) ---------------------

(function testCanRemovePlayer() {
  const room = makeRoom({
    status: "waiting",
    players: [
      makePlayer({ id: "host", seat: 1, stack: 500 }),
      makePlayer({ id: "p2", seat: 2, stack: 500 }),
    ],
  });

  check("canRemovePlayer: host can remove another player", canRemovePlayer(room, "host", "p2").ok === true);
  check("canRemovePlayer: non-host cannot remove anyone", canRemovePlayer(room, "p2", "host").ok === false);
  check("canRemovePlayer: host cannot remove themselves", canRemovePlayer(room, "host", "host").ok === false);
  check("canRemovePlayer: rejects an unknown target", canRemovePlayer(room, "host", "ghost").ok === false);
})();

(function testCanReorderSeats() {
  const waitingRoom = makeRoom({
    status: "waiting",
    players: [
      makePlayer({ id: "host", seat: 1, stack: 500 }),
      makePlayer({ id: "p2", seat: 2, stack: 500 }),
      makePlayer({ id: "spec", seat: 0, stack: 0, role: "spectator" }),
    ],
  });

  check(
    "canReorderSeats: host can reorder seated players between hands",
    canReorderSeats(waitingRoom, "host", ["p2", "host"]).ok === true
  );
  check(
    "canReorderSeats: non-host cannot reorder",
    canReorderSeats(waitingRoom, "p2", ["p2", "host"]).ok === false
  );
  check(
    "canReorderSeats: rejects an order missing a seated player",
    canReorderSeats(waitingRoom, "host", ["p2"]).ok === false
  );
  check(
    "canReorderSeats: rejects an order with a duplicate",
    canReorderSeats(waitingRoom, "host", ["p2", "p2"]).ok === false
  );

  const inHandRoom = makeRoom({
    status: "in_hand",
    players: [
      makePlayer({ id: "host", seat: 1, stack: 500 }),
      makePlayer({ id: "p2", seat: 2, stack: 500 }),
    ],
  });
  check(
    "canReorderSeats: locked while a hand is in progress",
    canReorderSeats(inHandRoom, "host", ["p2", "host"]).ok === false
  );
})();

// --- validateAction / validateWinnerCoverage sanity ------------------------

(function testValidateActionBasics() {
  const room = makeRoom({
    currentBet: 100,
    actingPlayerId: "p1",
    players: [
      makePlayer({ id: "p1", seat: 1, stack: 500, commitment: 0 }),
      makePlayer({ id: "p2", seat: 2, stack: 500, commitment: 100 }),
    ],
  });

  check("validateAction: rejects a check when facing a bet", validateAction(room, "p1", "check").ok === false);
  check("validateAction: allows a call when facing a bet", validateAction(room, "p1", "call").ok === true);
  check("validateAction: rejects acting out of turn", validateAction(room, "p2", "call").ok === false);
})();

(function testValidateWinnerCoverage() {
  const room = makeRoom({
    players: [
      makePlayer({ id: "short", seat: 1, stack: 0, commitment: 100 }),
      makePlayer({ id: "deep", seat: 2, stack: 200, commitment: 300 }),
    ],
  });

  check("validateWinnerCoverage: rejects an empty selection", validateWinnerCoverage(room, []).ok === false);
  check(
    "validateWinnerCoverage: rejects a selection that leaves the side pot uncovered",
    validateWinnerCoverage(room, ["short"]).ok === false
  );
  check("validateWinnerCoverage: accepts a selection covering every pot", validateWinnerCoverage(room, ["deep"]).ok === true);
})();

console.log(`\n${passCount} passed, ${failCount} failed`);
if (failCount > 0) {
  process.exitCode = 1;
}
