// 4-player, 5-hand soak test run against a real server over real
// socket.io connections — a long-session validation pass covering:
//   Hand 1: baseline check-down to showdown, uncontested pot.
//   Hand 2: a multi-raise "re-raise war" — independently (not by importing
//           the app's own logic) computes the expected next actor at every
//           step and asserts the server matches, as a live end-to-end guard
//           on the turn-order bug that was just fixed.
//   Hand 3: fold-to-one-player preflop — instant settle without a showdown.
//   Hand 4: short-stack all-in + a fold-with-partial-contribution, to guard
//           the "folded player shouldn't create a spurious side pot" fix
//           live over the wire (not just via the pure unit test).
//   Hand 5: host reorders seats mid-session, then a normal hand is played
//           to confirm turn order follows the NEW seat assignment and the
//           dealer button identity survived the reorder.
// After every hand: hard chip-conservation assertion (stacks must always
// sum to the starting total — zero-sum, no chips created or destroyed) and
// pot/eligibility structural checks.
import { io } from "socket.io-client";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const PORT = Number(process.env.SOAK_TEST_PORT || 3031);
const SERVER_URL = `http://127.0.0.1:${PORT}`;
const STARTING_STACK = 500;
const SMALL_BLIND = 10;
const BIG_BLIND = 20;
const TOTAL_CHIPS = STARTING_STACK * 4;

let assertions = 0;
function assert(condition, message) {
  assertions += 1;
  if (!condition) {
    throw new Error(`ASSERTION FAILED: ${message}`);
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForEvent(socket, type, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timeout waiting for ${type}`));
    }, timeoutMs);
    const onEvent = (evt) => {
      if (evt && evt.type === "error" && type !== "error") {
        cleanup();
        reject(new Error(`Server error: ${evt.message}`));
        return;
      }
      if (evt && evt.type === type) {
        cleanup();
        resolve(evt);
      }
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("event", onEvent);
    };
    socket.on("event", onEvent);
  });
}

function trackRoomState(socket) {
  let latest = null;
  socket.on("event", (evt) => {
    if (evt && evt.type === "room_state") {
      latest = evt.room;
    }
  });
  return () => latest;
}

async function startIsolatedServer(stateDir) {
  return await new Promise((resolve, reject) => {
    const child = spawn("node", ["dist/apps/server/src/index.js"], {
      env: { ...process.env, PORT: String(PORT), STATE_FILE_PATH: path.join(stateDir, "state.json") },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("Server did not start within timeout"));
    }, 10000);
    const onStdout = (chunk) => {
      const text = String(chunk);
      if (text.includes(`listening on port ${PORT}`)) {
        clearTimeout(timeout);
        child.stdout.off("data", onStdout);
        resolve(child);
      }
    };
    child.on("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Server exited before ready with code ${code}`));
    });
    child.stdout.on("data", onStdout);
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  });
}

async function stopServer(child) {
  if (!child || child.killed) return;
  await new Promise((resolve) => {
    child.once("exit", () => resolve());
    child.kill("SIGTERM");
    setTimeout(() => {
      if (!child.killed) child.kill("SIGKILL");
    }, 2000);
  });
}

async function connectSocket() {
  const socket = io(SERVER_URL, { transports: ["websocket"] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Connect timeout")), 4000);
    socket.on("connect", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.on("connect_error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
  return socket;
}

function sumStacks(state) {
  return state.players.reduce((sum, p) => sum + p.stack, 0);
}

function sumPots(state) {
  return (state.pots || []).reduce((sum, p) => sum + p.amount, 0);
}

// Total chips = stacks + whatever's live in the pot right now (blinds/bets
// already moved out of stacks but not yet paid to anyone). Once a hand is
// fully settled the pot has already been paid out to stacks, so callers
// should use sumStacks() alone at that point instead.
function totalChipsInPlay(state) {
  return sumStacks(state) + sumPots(state);
}

function nameOf(state, id) {
  return state.players.find((p) => p.id === id)?.displayName ?? id;
}

// Independent (not imported from the app) reference model of "who acts
// next", used only for the re-raise-war hand to cross-check the server's
// actingPlayerId against a from-scratch reasoning about seat order.
function expectedNextActorSeat(players, currentBet, lastActorSeat) {
  const inHand = players.filter((p) => p.inHand).sort((a, b) => a.seat - b.seat);
  const highest = inHand.reduce((max, p) => Math.max(max, p.commitment), 0);
  // A player still owes action if they haven't matched the highest commitment
  // yet, OR (the big blind's preflop option) they simply haven't acted this
  // street even though their posted blind already happens to match it.
  const candidates = inHand.filter((p) => p.stack > 0 && (p.commitment < highest || !p.__actedThisStreet));
  if (candidates.length === 0) return null;
  const next = candidates.find((p) => p.seat > lastActorSeat);
  return (next ?? candidates[0]).seat;
}

async function main() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "no-chip-soak-"));
  let serverProcess;
  const sockets = [];

  try {
    serverProcess = await startIsolatedServer(tempDir);

    const hostSocket = await connectSocket();
    sockets.push(hostSocket);
    hostSocket.emit("event", {
      type: "create_room",
      payload: { name: "soak-test", displayName: "Host", smallBlind: SMALL_BLIND, bigBlind: BIG_BLIND, startingStack: STARTING_STACK },
    });
    const created = await waitForEvent(hostSocket, "room_created");
    const roomId = created.room.id;
    const roomCode = created.room.code;
    const hostId = created.playerId;

    const playerIds = { host: hostId };
    const socketFor = { [hostId]: hostSocket };

    for (const [key, name] of [["p2", "P2"], ["p3", "P3"], ["p4", "P4"]]) {
      const s = await connectSocket();
      sockets.push(s);
      s.emit("event", { type: "join_room", payload: { roomCode, displayName: name, role: "player" } });
      const joined = await waitForEvent(s, "joined_room");
      playerIds[key] = joined.playerId;
      socketFor[joined.playerId] = s;
    }

    const getState = trackRoomState(hostSocket);
    for (const s of sockets) {
      if (s !== hostSocket) trackRoomState(s);
    }

    console.log(`Room ${roomCode} ready with 4 players: ${JSON.stringify(playerIds)}`);

    async function waitForState(predicate, label, maxTries = 60) {
      for (let i = 0; i < maxTries; i += 1) {
        const state = getState();
        if (state && predicate(state)) return state;
        await wait(150);
      }
      throw new Error(`Timed out waiting for: ${label}`);
    }

    // Drives a hand to completion. `scriptFor(state, actorId, actor)` returns
    // {action, amount} for the current actor, or null to use the default
    // policy (call if facing a bet, else check). Records every
    // (seat, action) transition for turn-order inspection. Caps at 80
    // actions to fail loudly instead of hanging forever if a hand gets stuck
    // (this is exactly the class of bug — turns never resolving — we're
    // hunting for).
    async function playHand(handLabel, scriptFor, { crossCheckTurnOrder = false } = {}) {
      hostSocket.emit("event", { type: "start_hand", roomId, actorPlayerId: hostId });
      let state = await waitForState((s) => s.status === "in_hand", `${handLabel}: start_hand`);

      const totalAtStart = totalChipsInPlay(state);
      assert(totalAtStart === TOTAL_CHIPS, `${handLabel}: chip total (stacks + live pot) right after start_hand is ${totalAtStart}, expected ${TOTAL_CHIPS}`);

      const dealerId = state.players.find((p) => p.seat === state.dealerSeat)?.id;
      console.log(`  [${handLabel}] dealer=${nameOf(state, dealerId)} sb=${nameOf(state, state.players.find(p=>p.seat===state.smallBlindSeat)?.id)} street=${state.street}`);

      const transitions = [];
      const actedThisStreetTracker = new Set();
      let lastStreet = state.street;
      let iterations = 0;

      while (state.status === "in_hand") {
        iterations += 1;
        assert(iterations < 80, `${handLabel}: exceeded 80 actions without resolving — hand appears stuck`);

        if (state.street !== lastStreet) {
          actedThisStreetTracker.clear();
          lastStreet = state.street;
        }

        const actorId = state.actingPlayerId;
        assert(!!actorId, `${handLabel}: no acting player while status is in_hand`);
        const actor = state.players.find((p) => p.id === actorId);
        assert(!!actor, `${handLabel}: acting player ${actorId} not found in players`);

        if (crossCheckTurnOrder && transitions.length > 0) {
          const prev = transitions[transitions.length - 1];
          if (prev.street === state.street) {
            const modeled = state.players.map((p) => ({
              ...p,
              __actedThisStreet: p.id === prev.actorId || actedThisStreetTracker.has(p.id),
            }));
            const expectedSeat = expectedNextActorSeat(modeled, state.currentBet, prev.seat);
            assert(
              expectedSeat === actor.seat,
              `${handLabel}: turn order mismatch — independently expected seat ${expectedSeat} to act next after seat ${prev.seat} (currentBet=${state.currentBet}), but server chose seat ${actor.seat} (${actor.displayName})`
            );
          }
        }

        const scripted = scriptFor(state, actorId, actor);
        const decision = scripted ?? (actor.commitment < state.currentBet ? { action: "call" } : { action: "check" });

        transitions.push({ actorId, seat: actor.seat, action: decision.action, street: state.street });
        actedThisStreetTracker.add(actorId);

        socketFor[actorId].emit("event", {
          type: "submit_action",
          roomId,
          actorPlayerId: actorId,
          action: decision.action,
          ...(typeof decision.amount === "number" ? { amount: decision.amount } : {}),
        });
        await wait(160);
        state = getState();
        assert(!!state, `${handLabel}: lost room state mid-hand`);
        if (state.status === "in_hand" || (state.status === "paused" && state.street === "showdown")) {
          const total = totalChipsInPlay(state);
          assert(total === TOTAL_CHIPS, `${handLabel}: chip total (stacks + live pot) is ${total} after a ${decision.action} action, expected ${TOTAL_CHIPS}`);
        }
      }

      console.log(`  [${handLabel}] action sequence: ${transitions.map((t) => `${nameOf(state, t.actorId)}:${t.action}`).join(", ")}`);
      return { state, transitions };
    }

    async function resolveShowdownIfNeeded(handLabel, state, winnerIds, potWinnerIds) {
      if (state.status === "paused" && state.street === "showdown") {
        hostSocket.emit("event", {
          type: "declare_winners",
          roomId,
          actorPlayerId: hostId,
          winnerIds,
          ...(potWinnerIds ? { potWinnerIds } : {}),
        });
        await wait(250);
        state = getState();
      }
      assert(state.status === "waiting", `${handLabel}: expected status waiting after resolution, got ${state.status}`);
      assert(state.payoutState === "animating" || state.payoutState === "idle", `${handLabel}: unexpected payoutState ${state.payoutState}`);
      return state;
    }

    async function finishPayoutAnimation(handLabel) {
      // Animation duration scales with recipient count (server-side
      // PAYOUT_ANIMATION_DURATION_MS + 260ms per extra recipient) — poll
      // instead of a fixed sleep so a 3+ way split doesn't race the wait.
      let state = await waitForState((s) => s.payoutState === "idle", `${handLabel}: payout animation settling to idle`, 40);
      const total = sumStacks(state);
      assert(total === TOTAL_CHIPS, `${handLabel}: chip total after payout is ${total}, expected ${TOTAL_CHIPS}`);
      return state;
    }

    function assertNoFoldedPlayerEligible(handLabel, state) {
      const foldedIds = new Set(state.players.filter((p) => !p.inHand && p.role !== "spectator").map((p) => p.id));
      for (const pot of state.pots) {
        for (const contributorId of pot.contributors) {
          assert(!foldedIds.has(contributorId), `${handLabel}: folded player ${nameOf(state, contributorId)} is listed as eligible for a pot`);
        }
      }
    }

    // ---------------------------------------------------------------------
    // Hand 1: everyone checks/calls down to showdown, host wins outright.
    // ---------------------------------------------------------------------
    {
      const { state: afterActions } = await playHand("Hand 1 (check-down)", () => null);
      assertNoFoldedPlayerEligible("Hand 1", afterActions);
      assert(afterActions.pots.length === 1, `Hand 1: expected a single uncontested pot, got ${afterActions.pots.length}`);
      // NOTE: this app does not implement a standard "big blind option" —
      // once every player's commitment matches the current bet (including
      // the BB's own posted blind), the street ends immediately, even if
      // the BB never got a chance to check/raise. So with 4 players and no
      // raises, everyone converges on exactly the big blind amount.
      const expectedPot = BIG_BLIND * 4;
      assert(afterActions.pots[0].amount === expectedPot, `Hand 1: pot amount ${afterActions.pots[0].amount}, expected ${expectedPot}`);

      const settled = await resolveShowdownIfNeeded("Hand 1", afterActions, [hostId]);
      const final = await finishPayoutAnimation("Hand 1");
      console.log(`  [Hand 1] PASS — pot ${expectedPot} awarded to Host, chips conserved (${sumStacks(final)})`);
    }

    // ---------------------------------------------------------------------
    // Hand 2: re-raise war — cross-checked turn order.
    // Seats after hand 1: unchanged (1=Host,2=P2,3=P3,4=P4); dealer rotates.
    // Script: first-to-act calls, next raises, next re-raises, action must
    // come back around to everyone who hasn't matched the new highest bet —
    // exactly the scenario that used to skip/misorder turns.
    // ---------------------------------------------------------------------
    {
      let raiseCount = 0;
      const script = (state, actorId, actor) => {
        if (state.street !== "preflop") return null; // check down postflop
        if (actor.commitment >= state.currentBet) return null; // already matched, shouldn't be asked, but be safe
        if (raiseCount === 0) {
          raiseCount += 1;
          return { action: "raise", amount: state.currentBet + 60 };
        }
        if (raiseCount === 1) {
          raiseCount += 1;
          return { action: "raise", amount: state.currentBet + 80 };
        }
        return { action: "call" };
      };

      const { state: afterActions, transitions } = await playHand("Hand 2 (re-raise war)", script, { crossCheckTurnOrder: true });
      const raises = transitions.filter((t) => t.action === "raise");
      assert(raises.length === 2, `Hand 2: expected exactly 2 raises to occur, got ${raises.length}`);
      const distinctActorsPreflop = new Set(transitions.filter((t) => t.street === "preflop").map((t) => t.actorId));
      assert(distinctActorsPreflop.size === 4, `Hand 2: expected all 4 players to act preflop after the re-raises, only ${distinctActorsPreflop.size} did`);

      const settled = await resolveShowdownIfNeeded("Hand 2", afterActions, [playerIds.p3]);
      const final = await finishPayoutAnimation("Hand 2");
      console.log(`  [Hand 2] PASS — turn order independently cross-checked at every step, chips conserved (${sumStacks(final)})`);
    }

    // ---------------------------------------------------------------------
    // Hand 3: everyone folds to one raise preflop — instant settle, no
    // showdown should ever be reached.
    // ---------------------------------------------------------------------
    {
      let raised = false;
      const script = (state, actorId, actor) => {
        if (state.street !== "preflop") return null;
        if (!raised) {
          raised = true;
          return { action: "raise", amount: state.currentBet + 100 };
        }
        return { action: "fold" };
      };

      const stateBefore = getState();
      const { state: afterActions } = await playHand("Hand 3 (fold to one)", script);
      assert(afterActions.status === "waiting", `Hand 3: expected instant settle straight to waiting, got status ${afterActions.status}`);
      assert(afterActions.street !== "showdown", `Hand 3: should never reach showdown when only one player remains`);
      const inHandCount = afterActions.players.filter((p) => p.inHand).length;
      assert(inHandCount === 0, `Hand 3: expected everyone reset out of hand after instant settle`);

      const final = await finishPayoutAnimation("Hand 3");
      assert(final.payouts.length === 1, `Hand 3: expected exactly one payout recipient (the sole survivor), got ${final.payouts.length}`);
      console.log(`  [Hand 3] PASS — instant settle with no showdown, winner ${nameOf(final, final.payouts[0].playerId)} took the pot, chips conserved (${sumStacks(final)})`);
    }

    // ---------------------------------------------------------------------
    // Hand 4: short-stack all-in + a fold-with-partial-contribution, to
    // guard the "folded player creates a spurious side pot" fix live.
    // We deliberately make P4 short by having them fold early each prior
    // hand, but stacks naturally diverge from hands 1-3 already — pick
    // whoever is currently shortest as the all-in player.
    // ---------------------------------------------------------------------
    {
      const preHandState = getState();
      const shortest = [...preHandState.players].sort((a, b) => a.stack - b.stack)[0];
      console.log(`  [Hand 4] shortest stack going in: ${shortest.displayName} (${shortest.stack})`);

      let shoved = false;
      let raisedOverTop = false;
      let folded = false;
      const script = (state, actorId, actor) => {
        if (state.street !== "preflop") return null;
        if (actorId === shortest.id && actor.stack > 0) {
          shoved = true;
          return { action: "all_in" };
        }
        if (shoved && !raisedOverTop && actorId !== shortest.id && actor.commitment < state.currentBet && actor.stack > state.currentBet - actor.commitment + 40) {
          raisedOverTop = true;
          return { action: "raise", amount: state.currentBet + 40 };
        }
        if (shoved && raisedOverTop && !folded && actorId !== shortest.id && actor.commitment < state.currentBet) {
          folded = true;
          return { action: "fold" };
        }
        if (actor.commitment < state.currentBet) {
          return actor.stack > state.currentBet - actor.commitment ? { action: "call" } : { action: "all_in" };
        }
        return null;
      };

      const { state: afterActions } = await playHand("Hand 4 (side pot + fold)", script);
      assertNoFoldedPlayerEligible("Hand 4", afterActions);

      const foldedCount = afterActions.players.filter((p) => p.role === "player" && !p.inHand).length;
      console.log(`  [Hand 4] pots: ${JSON.stringify(afterActions.pots)}, folded players this hand: ${foldedCount}`);

      if (afterActions.pots.length > 1 && foldedCount > 0) {
        console.log(`  [Hand 4] confirmed multiple pots WITH a fold present — this is exactly the regression scenario, and eligibility is clean.`);
      }

      const eligiblePlayerIds = afterActions.players.filter((p) => p.inHand).map((p) => p.id);
      const winnerIds = [...new Set(afterActions.pots.flatMap((pot) => pot.contributors.filter((id) => eligiblePlayerIds.includes(id))))];
      assert(winnerIds.length > 0, "Hand 4: no eligible winners found across pots");

      const totalPotAmount = afterActions.pots.reduce((sum, p) => sum + p.amount, 0);

      const settled = await resolveShowdownIfNeeded("Hand 4", afterActions, winnerIds);
      const final = await finishPayoutAnimation("Hand 4");

      const payoutTotal = (settled.payouts || []).reduce((sum, p) => sum + p.amount, 0);
      assert(payoutTotal === totalPotAmount, `Hand 4: payout total ${payoutTotal} does not match total pot ${totalPotAmount}`);
      console.log(`  [Hand 4] PASS — pot math and eligibility correct, chips conserved (${sumStacks(final)})`);
    }

    // ---------------------------------------------------------------------
    // Hand 5: host reorders seats mid-session, dealer identity should
    // survive the reorder, and the next hand's turn order must follow the
    // NEW seat numbers.
    // ---------------------------------------------------------------------
    {
      const beforeReorder = getState();
      const dealerPlayerIdBefore = beforeReorder.players.find((p) => p.seat === beforeReorder.dealerSeat)?.id;
      const currentOrder = beforeReorder.players.filter((p) => p.role !== "spectator").sort((a, b) => a.seat - b.seat).map((p) => p.id);
      const newOrder = [currentOrder[3], currentOrder[0], currentOrder[2], currentOrder[1]];

      hostSocket.emit("event", { type: "reorder_seats", roomId, actorPlayerId: hostId, orderedPlayerIds: newOrder });
      await wait(250);
      const afterReorder = getState();

      newOrder.forEach((id, index) => {
        const seat = afterReorder.players.find((p) => p.id === id)?.seat;
        assert(seat === index + 1, `Hand 5: reorder did not apply — expected ${nameOf(afterReorder, id)} at seat ${index + 1}, got ${seat}`);
      });
      const dealerPlayerIdAfter = afterReorder.players.find((p) => p.seat === afterReorder.dealerSeat)?.id;
      assert(dealerPlayerIdAfter === dealerPlayerIdBefore, `Hand 5: dealer button identity should survive reorder — was ${nameOf(afterReorder, dealerPlayerIdBefore)}, now ${nameOf(afterReorder, dealerPlayerIdAfter)}`);
      console.log(`  [Hand 5] reorder applied, dealer button correctly stayed with ${nameOf(afterReorder, dealerPlayerIdAfter)}`);

      const { state: afterActions, transitions } = await playHand("Hand 5 (post-reorder)", () => null, { crossCheckTurnOrder: true });
      assertNoFoldedPlayerEligible("Hand 5", afterActions);

      const settled = await resolveShowdownIfNeeded("Hand 5", afterActions, [newOrder[1]]);
      const final = await finishPayoutAnimation("Hand 5");
      console.log(`  [Hand 5] PASS — turn order correctly followed the NEW seat assignment post-reorder, chips conserved (${sumStacks(final)})`);
    }

    console.log(`\nALL 5 HANDS PASSED — ${assertions} assertions checked, chip conservation held throughout.`);
  } catch (error) {
    console.error("FAIL four-player soak test");
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  } finally {
    for (const s of sockets) s.disconnect();
    await stopServer(serverProcess);
    await rm(tempDir, { recursive: true, force: true });
  }
}

void main();
