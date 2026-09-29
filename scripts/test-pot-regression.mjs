import { io } from "socket.io-client";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const PORT = Number(process.env.POT_TEST_PORT || 3021);
const SERVER_URL = `http://127.0.0.1:${PORT}`;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sumPot(room) {
  return (room.pots || []).reduce((sum, pot) => sum + (Number(pot.amount) || 0), 0);
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
      env: {
        ...process.env,
        PORT: String(PORT),
        STATE_FILE_PATH: path.join(stateDir, "state.json"),
      },
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
    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
    });
  });
}

async function stopServer(child) {
  if (!child || child.killed) {
    return;
  }

  await new Promise((resolve) => {
    const finish = () => resolve();
    child.once("exit", finish);
    child.kill("SIGTERM");
    setTimeout(() => {
      if (!child.killed) {
        child.kill("SIGKILL");
      }
    }, 2000);
  });
}

async function runScenario() {
  const hostSocket = io(SERVER_URL, { transports: ["websocket"] });
  const p2Socket = io(SERVER_URL, { transports: ["websocket"] });

  try {
    await new Promise((resolve, reject) => {
      let connected = 0;
      const timer = setTimeout(() => reject(new Error("Connect timeout")), 4000);
      const onConnect = () => {
        connected += 1;
        if (connected === 2) {
          clearTimeout(timer);
          resolve();
        }
      };
      const onErr = (err) => {
        clearTimeout(timer);
        reject(err);
      };

      hostSocket.on("connect", onConnect);
      p2Socket.on("connect", onConnect);
      hostSocket.on("connect_error", onErr);
      p2Socket.on("connect_error", onErr);
    });

    hostSocket.emit("event", {
      type: "create_room",
      payload: {
        name: "pot-regression",
        displayName: "Host",
        smallBlind: 10,
        bigBlind: 20,
        startingStack: 500,
      },
    });

    const created = await waitForEvent(hostSocket, "room_created");
    const roomId = created.room.id;
    const roomCode = created.room.code;
    const hostId = created.playerId;

    p2Socket.emit("event", {
      type: "join_room",
      payload: {
        roomCode,
        displayName: "P2",
        role: "player",
      },
    });

    const joined = await waitForEvent(p2Socket, "joined_room");
    const p2Id = joined.playerId;

    const hostState = trackRoomState(hostSocket);
    const p2State = trackRoomState(p2Socket);

    hostSocket.emit("event", { type: "start_hand", roomId, actorPlayerId: hostId });
    await wait(220);

    const snapshots = [];
    const snapshot = (label) => {
      const room = hostState() || p2State();
      if (!room) {
        throw new Error(`Missing room_state at ${label}`);
      }

      snapshots.push({
        label,
        street: room.street,
        pot: sumPot(room),
        currentBet: room.currentBet,
        actingPlayerId: room.actingPlayerId,
      });

      return room;
    };

    let state = snapshot("after_start");
    const preflopStartPot = sumPot(state);

    // Preflop: call/check into flop.
    for (let i = 0; i < 6 && state.street === "preflop"; i += 1) {
      const actorId = state.actingPlayerId;
      if (!actorId) {
        throw new Error("No acting player during preflop");
      }

      const actor = state.players.find((player) => player.id === actorId);
      if (!actor) {
        throw new Error("Acting player not found during preflop");
      }

      const action = actor.commitment < state.currentBet ? "call" : "check";
      const socket = actorId === hostId ? hostSocket : p2Socket;

      socket.emit("event", {
        type: "submit_action",
        roomId,
        actorPlayerId: actorId,
        action,
      });

      await wait(180);
      state = snapshot(`preflop_${i}_${action}`);
    }

    if (state.street !== "flop") {
      throw new Error("Did not advance to flop");
    }

    if (sumPot(state) < preflopStartPot) {
      throw new Error("Pot decreased when advancing to flop");
    }

    // Flop: both check into turn.
    for (let i = 0; i < 4 && state.street === "flop"; i += 1) {
      const actorId = state.actingPlayerId;
      if (!actorId) {
        throw new Error("No acting player during flop");
      }

      const socket = actorId === hostId ? hostSocket : p2Socket;
      socket.emit("event", {
        type: "submit_action",
        roomId,
        actorPlayerId: actorId,
        action: "check",
      });

      await wait(180);
      state = snapshot(`flop_${i}_check`);
    }

    if (state.street !== "turn") {
      throw new Error("Did not advance to turn");
    }

    const turnStartPot = sumPot(state);

    // Turn: bet 50 and call.
    const firstTurnActor = state.actingPlayerId;
    if (!firstTurnActor) {
      throw new Error("No acting player on turn");
    }

    const firstTurnSocket = firstTurnActor === hostId ? hostSocket : p2Socket;
    firstTurnSocket.emit("event", {
      type: "submit_action",
      roomId,
      actorPlayerId: firstTurnActor,
      action: "raise",
      amount: 50,
    });

    await wait(180);
    state = snapshot("turn_raise_50");

    const secondTurnActor = state.actingPlayerId;
    if (!secondTurnActor) {
      throw new Error("No responding actor after turn raise");
    }

    const secondTurnSocket = secondTurnActor === hostId ? hostSocket : p2Socket;
    secondTurnSocket.emit("event", {
      type: "submit_action",
      roomId,
      actorPlayerId: secondTurnActor,
      action: "call",
    });

    await wait(220);
    state = snapshot("turn_call");

    const turnEndPot = sumPot(state);
    if (turnEndPot < turnStartPot + 100) {
      throw new Error(`Turn pot did not grow correctly: start=${turnStartPot}, end=${turnEndPot}`);
    }

    // River: one player folds so hand resolves immediately and payout lifecycle begins.
    const riverActor = state.actingPlayerId;
    if (!riverActor) {
      throw new Error("No acting player on river");
    }

    const riverActorSocket = riverActor === hostId ? hostSocket : p2Socket;
    riverActorSocket.emit("event", {
      type: "submit_action",
      roomId,
      actorPlayerId: riverActor,
      action: "fold",
    });

    await wait(220);
    state = snapshot("river_fold_resolve");

    // Payout is no longer gated behind a separate player "acknowledge" step:
    // the host declaring the winner is the only decision required, and chips
    // are credited to the winner's stack immediately. "animating" is purely a
    // cosmetic window for the client-side chip animation.
    if (state.status !== "waiting" || state.payoutState !== "animating") {
      throw new Error("Expected payout to start animating immediately after hand resolution");
    }

    const winnerPayout = state.payouts[0];
    if (!winnerPayout) {
      throw new Error("Expected payout entry after hand resolution");
    }

    const winnerStackAfterResolve = state.players.find((player) => player.id === winnerPayout.playerId)?.stack;
    if (!Number.isFinite(winnerStackAfterResolve)) {
      throw new Error("Winner stack not found after resolution");
    }

    // Start hand should be blocked until the (purely cosmetic) animation finishes.
    hostSocket.emit("event", {
      type: "start_hand",
      roomId,
      actorPlayerId: hostId,
    });
    const blockedStart = await waitForEvent(hostSocket, "error");
    if (!String(blockedStart.message || "").toLowerCase().includes("payout")) {
      throw new Error("Expected start hand to be blocked by payout state");
    }

    // Wait beyond animation duration; it should clear on its own, no player
    // action required.
    await wait(2200);
    state = snapshot("payout_completed");

    if (state.payoutState !== "idle") {
      throw new Error("Expected payout state to return to idle after animation, with no acknowledgment needed");
    }

    const winnerStackAfterAnimation = state.players.find((player) => player.id === winnerPayout.playerId)?.stack;
    if (winnerStackAfterAnimation !== winnerStackAfterResolve) {
      throw new Error("Winner stack should not change again once the cosmetic animation completes");
    }

    for (let i = 1; i < snapshots.length; i += 1) {
      if (snapshots[i].pot < snapshots[i - 1].pot) {
        throw new Error(`Pot decreased between ${snapshots[i - 1].label} and ${snapshots[i].label}`);
      }
    }

    console.log("PASS pot regression");
    console.log(JSON.stringify({ snapshots }, null, 2));
  } finally {
    hostSocket.disconnect();
    p2Socket.disconnect();
  }
}

async function runSidePotScenario() {
  const hostSocket = io(SERVER_URL, { transports: ["websocket"] });
  const p2Socket = io(SERVER_URL, { transports: ["websocket"] });
  const p3Socket = io(SERVER_URL, { transports: ["websocket"] });

  try {
    await new Promise((resolve, reject) => {
      let connected = 0;
      const timer = setTimeout(() => reject(new Error("Connect timeout for side-pot scenario")), 5000);
      const onConnect = () => {
        connected += 1;
        if (connected === 3) {
          clearTimeout(timer);
          resolve();
        }
      };
      const onErr = (err) => {
        clearTimeout(timer);
        reject(err);
      };

      hostSocket.on("connect", onConnect);
      p2Socket.on("connect", onConnect);
      p3Socket.on("connect", onConnect);
      hostSocket.on("connect_error", onErr);
      p2Socket.on("connect_error", onErr);
      p3Socket.on("connect_error", onErr);
    });

    hostSocket.emit("event", {
      type: "create_room",
      payload: {
        name: "side-pot-regression",
        displayName: "Host",
        smallBlind: 10,
        bigBlind: 20,
        startingStack: 120,
      },
    });

    const created = await waitForEvent(hostSocket, "room_created");
    const roomId = created.room.id;
    const roomCode = created.room.code;
    const hostId = created.playerId;

    p2Socket.emit("event", {
      type: "join_room",
      payload: { roomCode, displayName: "P2", role: "player" },
    });
    const joined2 = await waitForEvent(p2Socket, "joined_room");
    const p2Id = joined2.playerId;

    p3Socket.emit("event", {
      type: "join_room",
      payload: { roomCode, displayName: "P3", role: "player" },
    });
    const joined3 = await waitForEvent(p3Socket, "joined_room");
    const p3Id = joined3.playerId;

    const getState = (() => {
      let latest = null;
      const handler = (evt) => {
        if (evt && evt.type === "room_state") {
          latest = evt.room;
        }
      };
      hostSocket.on("event", handler);
      p2Socket.on("event", handler);
      p3Socket.on("event", handler);
      return () => latest;
    })();

    hostSocket.emit("event", { type: "start_hand", roomId, actorPlayerId: hostId });
    await wait(260);

    let state = getState();
    if (!state) {
      throw new Error("Missing initial state for side-pot scenario");
    }

    // Preflop: short stack host jams, other two call.
    for (let i = 0; i < 12 && state.street === "preflop"; i += 1) {
      const actorId = state.actingPlayerId;
      if (!actorId) {
        throw new Error("No acting player during side-pot preflop");
      }

      const actor = state.players.find((player) => player.id === actorId);
      if (!actor) {
        throw new Error("Acting player not found in side-pot preflop");
      }

      let action = "check";
      if (actorId === hostId && actor.stack > 0) {
        action = "all_in";
      } else if (actor.commitment < state.currentBet) {
        action = "call";
      }

      const socket = actorId === hostId ? hostSocket : actorId === p2Id ? p2Socket : p3Socket;
      socket.emit("event", { type: "submit_action", roomId, actorPlayerId: actorId, action });
      await wait(200);
      state = getState();
      if (!state) {
        throw new Error("Missing updated state during side-pot preflop");
      }
    }

    if (state.street !== "flop") {
      throw new Error("Did not reach flop in side-pot scenario");
    }

    let sideBetPlaced = false;
    let sideBetCalled = false;

    // Flop onwards: create side pot between deep stacks.
    for (let i = 0; i < 24 && !(state.status === "paused" && state.street === "showdown"); i += 1) {
      const actorId = state.actingPlayerId;
      if (!actorId) {
        break;
      }

      const actor = state.players.find((player) => player.id === actorId);
      if (!actor) {
        throw new Error("Missing actor during side-pot postflop");
      }

      let action = "check";
      let amount;

      if (!sideBetPlaced && actorId !== hostId && state.currentBet === 0) {
        action = "raise";
        amount = 50;
        sideBetPlaced = true;
      } else if (sideBetPlaced && !sideBetCalled && actorId !== hostId && actor.commitment < state.currentBet) {
        action = "call";
        sideBetCalled = true;
      } else if (actor.commitment < state.currentBet) {
        action = actor.stack > 0 ? "all_in" : "fold";
      }

      const socket = actorId === hostId ? hostSocket : actorId === p2Id ? p2Socket : p3Socket;
      socket.emit("event", {
        type: "submit_action",
        roomId,
        actorPlayerId: actorId,
        action,
        ...(typeof amount === "number" ? { amount } : {}),
      });

      await wait(210);
      state = getState();
      if (!state) {
        throw new Error("Missing state while building side pot");
      }
    }

    if (!(state.status === "paused" && state.street === "showdown")) {
      throw new Error("Expected paused showdown in side-pot scenario");
    }

    if (!Array.isArray(state.pots) || state.pots.length < 2) {
      throw new Error("Expected at least two pots (main + side)");
    }

    const expectedTotal = sumPot(state);

    // Try invalid declaration that does not cover side pot; should error.
    hostSocket.emit("event", {
      type: "declare_winners",
      roomId,
      actorPlayerId: hostId,
      winnerIds: [hostId],
    });

    const invalidDeclare = await waitForEvent(hostSocket, "error");
    if (!String(invalidDeclare.message || "").toLowerCase().includes("cover")) {
      throw new Error("Expected side-pot winner coverage error");
    }

    // Valid declaration covering both pots.
    hostSocket.emit("event", {
      type: "declare_winners",
      roomId,
      actorPlayerId: hostId,
      winnerIds: [hostId, p2Id],
    });

    await wait(220);
    state = getState();
    if (!state || state.status !== "waiting" || state.payoutState !== "animating") {
      throw new Error("Expected waiting state with payout already credited after valid side-pot declaration");
    }

    const payoutTotal = (state.payouts || []).reduce((sum, payout) => sum + (Number(payout.amount) || 0), 0);
    if (payoutTotal !== expectedTotal) {
      throw new Error(`Payout total mismatch for side-pot scenario: expected ${expectedTotal}, got ${payoutTotal}`);
    }

    // Let the cosmetic animation window finish on its own; no acknowledgment needed.
    await wait(2300);
  } finally {
    hostSocket.disconnect();
    p2Socket.disconnect();
    p3Socket.disconnect();
  }
}

// Exercises the same wire contract the new per-pot winner picker UI uses: a
// main pot and a side pot that go to two *different* players, declared via
// explicit potWinnerIds rather than relying on server-side auto-resolution.
// This is the scenario the flat winner checklist could never express (main
// pot winner isn't even eligible for the side pot, and the side pot itself
// is contested between two players who are NOT the main pot winner).
async function runContestedSidePotScenario() {
  const hostSocket = io(SERVER_URL, { transports: ["websocket"] });
  const p2Socket = io(SERVER_URL, { transports: ["websocket"] });
  const p3Socket = io(SERVER_URL, { transports: ["websocket"] });

  try {
    await new Promise((resolve, reject) => {
      let connected = 0;
      const timer = setTimeout(() => reject(new Error("Connect timeout for contested side-pot scenario")), 5000);
      const onConnect = () => {
        connected += 1;
        if (connected === 3) {
          clearTimeout(timer);
          resolve();
        }
      };
      const onErr = (err) => {
        clearTimeout(timer);
        reject(err);
      };

      hostSocket.on("connect", onConnect);
      p2Socket.on("connect", onConnect);
      p3Socket.on("connect", onConnect);
      hostSocket.on("connect_error", onErr);
      p2Socket.on("connect_error", onErr);
      p3Socket.on("connect_error", onErr);
    });

    hostSocket.emit("event", {
      type: "create_room",
      payload: {
        name: "contested-side-pot-regression",
        displayName: "Host",
        smallBlind: 10,
        bigBlind: 20,
        startingStack: 120,
      },
    });

    const created = await waitForEvent(hostSocket, "room_created");
    const roomId = created.room.id;
    const roomCode = created.room.code;
    const hostId = created.playerId;

    p2Socket.emit("event", {
      type: "join_room",
      payload: { roomCode, displayName: "P2", role: "player" },
    });
    const joined2 = await waitForEvent(p2Socket, "joined_room");
    const p2Id = joined2.playerId;

    p3Socket.emit("event", {
      type: "join_room",
      payload: { roomCode, displayName: "P3", role: "player" },
    });
    const joined3 = await waitForEvent(p3Socket, "joined_room");
    const p3Id = joined3.playerId;

    const getState = (() => {
      let latest = null;
      const handler = (evt) => {
        if (evt && evt.type === "room_state") {
          latest = evt.room;
        }
      };
      hostSocket.on("event", handler);
      p2Socket.on("event", handler);
      p3Socket.on("event", handler);
      return () => latest;
    })();

    const socketFor = (playerId) => (playerId === hostId ? hostSocket : playerId === p2Id ? p2Socket : p3Socket);

    hostSocket.emit("event", { type: "start_hand", roomId, actorPlayerId: hostId });
    await wait(260);

    let state = getState();
    if (!state) {
      throw new Error("Missing initial state for contested side-pot scenario");
    }

    // Preflop: short stack host jams, other two call, leaving host with a
    // sole-eligible main pot contest and p2/p3 free to build a side pot.
    for (let i = 0; i < 12 && state.street === "preflop"; i += 1) {
      const actorId = state.actingPlayerId;
      if (!actorId) {
        throw new Error("No acting player during contested side-pot preflop");
      }

      const actor = state.players.find((player) => player.id === actorId);
      let action = "check";
      if (actorId === hostId && actor.stack > 0) {
        action = "all_in";
      } else if (actor.commitment < state.currentBet) {
        action = "call";
      }

      socketFor(actorId).emit("event", { type: "submit_action", roomId, actorPlayerId: actorId, action });
      await wait(200);
      state = getState();
      if (!state) {
        throw new Error("Missing updated state during contested side-pot preflop");
      }
    }

    if (state.street !== "flop") {
      throw new Error("Did not reach flop in contested side-pot scenario");
    }

    let raiserId = null;
    let callerId = null;

    // Flop onwards: whichever of p2/p3 acts first raises to build a side pot;
    // the other calls it. Track who's who so we can declare an explicit,
    // asymmetric winner per pot below.
    for (let i = 0; i < 24 && !(state.status === "paused" && state.street === "showdown"); i += 1) {
      const actorId = state.actingPlayerId;
      if (!actorId) {
        break;
      }

      const actor = state.players.find((player) => player.id === actorId);
      let action = "check";
      let amount;

      if (!raiserId && actorId !== hostId && state.currentBet === 0) {
        action = "raise";
        amount = 50;
        raiserId = actorId;
      } else if (raiserId && !callerId && actorId !== hostId && actor.commitment < state.currentBet) {
        action = "call";
        callerId = actorId;
      } else if (actor.commitment < state.currentBet) {
        action = actor.stack > 0 ? "all_in" : "fold";
      }

      socketFor(actorId).emit("event", {
        type: "submit_action",
        roomId,
        actorPlayerId: actorId,
        action,
        ...(typeof amount === "number" ? { amount } : {}),
      });

      await wait(210);
      state = getState();
      if (!state) {
        throw new Error("Missing state while building contested side pot");
      }
    }

    if (!(state.status === "paused" && state.street === "showdown")) {
      throw new Error("Expected paused showdown in contested side-pot scenario");
    }

    if (!Array.isArray(state.pots) || state.pots.length < 2) {
      throw new Error(`Expected a main pot and a side pot, got ${JSON.stringify(state.pots)}`);
    }
    if (!raiserId || !callerId) {
      throw new Error("Failed to identify side-pot raiser/caller");
    }

    const mainPotAmount = state.pots[0].amount;
    const sidePotAmount = state.pots[1].amount;
    const expectedTotal = sumPot(state);

    // Host wins the main pot outright; the side-pot aggressor (raiser) wins
    // the side pot, NOT the caller and NOT the host (who isn't even eligible
    // for it). This is exactly what the per-pot picker UI now sends.
    hostSocket.emit("event", {
      type: "declare_winners",
      roomId,
      actorPlayerId: hostId,
      winnerIds: [hostId, raiserId],
      potWinnerIds: [[hostId], [raiserId]],
    });

    await wait(220);
    state = getState();
    if (!state || state.status !== "waiting" || state.payoutState !== "animating") {
      throw new Error("Expected waiting state with payout already credited after contested side-pot declaration");
    }

    const payouts = state.payouts || [];
    const payoutTotal = payouts.reduce((sum, payout) => sum + (Number(payout.amount) || 0), 0);
    if (payoutTotal !== expectedTotal) {
      throw new Error(`Payout total mismatch for contested side-pot scenario: expected ${expectedTotal}, got ${payoutTotal}`);
    }

    const hostPayout = payouts.find((p) => p.playerId === hostId)?.amount ?? 0;
    const raiserPayout = payouts.find((p) => p.playerId === raiserId)?.amount ?? 0;
    const callerPayout = payouts.find((p) => p.playerId === callerId)?.amount ?? 0;

    if (hostPayout !== mainPotAmount) {
      throw new Error(
        `Host should win the entire main pot (${mainPotAmount}) uncontaminated by the side pot, got ${hostPayout}.`
      );
    }
    if (raiserPayout !== sidePotAmount) {
      throw new Error(`Side-pot winner should get the entire side pot (${sidePotAmount}), got ${raiserPayout}.`);
    }
    if (callerPayout !== 0) {
      throw new Error(`Side-pot loser should receive nothing, got ${callerPayout}.`);
    }

    // Let the cosmetic animation window finish on its own; no acknowledgment needed.
    await wait(2300);

    console.log("PASS contested side-pot explicit per-pot winners");
  } finally {
    hostSocket.disconnect();
    p2Socket.disconnect();
    p3Socket.disconnect();
  }
}

// Regression test for the exact bug reported: two heads-up players with uneven
// stacks (766 vs 1234) both go all-in. The winner of the smaller stack must win
// the *entire* main pot (double their stack), while the larger stack gets back
// only their uncalled excess as an uncontested side pot. A prior bug conflated
// the side-pot auto-winner into the main pot's fallback winner resolution,
// causing the pot to be chopped 50/50 instead.
async function runHeadsUpUnevenStacksAllInScenario() {
  const hostSocket = io(SERVER_URL, { transports: ["websocket"] });
  const p2Socket = io(SERVER_URL, { transports: ["websocket"] });

  try {
    await new Promise((resolve, reject) => {
      let connected = 0;
      const timer = setTimeout(() => reject(new Error("Connect timeout for uneven-stacks scenario")), 4000);
      const onConnect = () => {
        connected += 1;
        if (connected === 2) {
          clearTimeout(timer);
          resolve();
        }
      };
      const onErr = (err) => {
        clearTimeout(timer);
        reject(err);
      };

      hostSocket.on("connect", onConnect);
      p2Socket.on("connect", onConnect);
      hostSocket.on("connect_error", onErr);
      p2Socket.on("connect_error", onErr);
    });

    hostSocket.emit("event", {
      type: "create_room",
      payload: {
        name: "uneven-stacks-regression",
        displayName: "Host",
        smallBlind: 10,
        bigBlind: 20,
        startingStack: 1000,
      },
    });

    const created = await waitForEvent(hostSocket, "room_created");
    const roomId = created.room.id;
    const roomCode = created.room.code;
    const hostId = created.playerId;

    p2Socket.emit("event", {
      type: "join_room",
      payload: { roomCode, displayName: "P2", role: "player" },
    });
    const joined = await waitForEvent(p2Socket, "joined_room");
    const p2Id = joined.playerId;

    const getState = (() => {
      let latest = null;
      const handler = (evt) => {
        if (evt && evt.type === "room_state") {
          latest = evt.room;
        }
      };
      hostSocket.on("event", handler);
      p2Socket.on("event", handler);
      return () => latest;
    })();

    const socketFor = (playerId) => (playerId === hostId ? hostSocket : p2Socket);

    // Hand 1: create uneven stacks. Whoever acts first raises to 234, the other
    // calls, then folds on the river so the raiser wins the 468 pot outright,
    // leaving stacks of 1234 (winner) and 766 (loser) -- the user's exact numbers.
    hostSocket.emit("event", { type: "start_hand", roomId, actorPlayerId: hostId });
    await wait(220);
    let state = getState();
    if (!state) {
      throw new Error("Missing state after starting hand 1");
    }

    const raiserId = state.actingPlayerId;
    socketFor(raiserId).emit("event", {
      type: "submit_action",
      roomId,
      actorPlayerId: raiserId,
      action: "raise",
      amount: 234,
    });
    await wait(200);
    state = getState();

    const callerId = state.actingPlayerId;
    socketFor(callerId).emit("event", { type: "submit_action", roomId, actorPlayerId: callerId, action: "call" });
    await wait(200);
    state = getState();

    for (const street of ["flop", "turn"]) {
      if (state.street !== street) continue;
      for (let i = 0; i < 2 && state.street === street; i += 1) {
        const actorId = state.actingPlayerId;
        socketFor(actorId).emit("event", { type: "submit_action", roomId, actorPlayerId: actorId, action: "check" });
        await wait(200);
        state = getState();
      }
    }

    if (state.street !== "river") {
      throw new Error(`Expected river before fold, got ${state.street}`);
    }

    const folderId = state.actingPlayerId;
    socketFor(folderId).emit("event", { type: "submit_action", roomId, actorPlayerId: folderId, action: "fold" });
    await wait(220);
    state = getState();

    if (state.payoutState !== "animating") {
      throw new Error("Expected payout to be credited (and animating) after hand 1 fold");
    }

    // Let the cosmetic animation window finish on its own; no acknowledgment needed.
    await wait(2300);
    state = getState();

    const hostStack = state.players.find((p) => p.id === hostId)?.stack;
    const p2Stack = state.players.find((p) => p.id === p2Id)?.stack;
    const stacks = { [hostId]: hostStack, [p2Id]: p2Stack };
    const shortStackId = hostStack < p2Stack ? hostId : p2Id;
    const bigStackId = shortStackId === hostId ? p2Id : hostId;

    if (![766, 1234].includes(stacks[shortStackId]) || ![766, 1234].includes(stacks[bigStackId])) {
      throw new Error(`Expected stacks of 766/1234 after hand 1, got ${JSON.stringify(stacks)}`);
    }

    // Hand 2: both go all-in. The short stack wins at showdown.
    hostSocket.emit("event", { type: "start_hand", roomId, actorPlayerId: hostId });
    await wait(220);
    state = getState();

    for (let i = 0; i < 4 && !(state.status === "paused" && state.street === "showdown"); i += 1) {
      const actorId = state.actingPlayerId;
      if (!actorId) break;
      const actor = state.players.find((p) => p.id === actorId);
      const action = actor.stack > 0 ? "all_in" : "check";
      socketFor(actorId).emit("event", { type: "submit_action", roomId, actorPlayerId: actorId, action });
      await wait(200);
      state = getState();
      // Both players are all-in with no more decisions possible; run the board out.
      for (let j = 0; j < 4 && state.status === "in_hand"; j += 1) {
        await wait(200);
        state = getState();
      }
    }

    if (!(state.status === "paused" && state.street === "showdown")) {
      throw new Error("Expected showdown after both players all-in in hand 2");
    }

    if (!Array.isArray(state.pots) || state.pots.length < 2) {
      throw new Error(`Expected a main pot and a side pot, got ${JSON.stringify(state.pots)}`);
    }

    // Host declares only the actual winner (short stack) -- exactly what the real
    // UI does: a single flat winner checklist, no per-pot selection.
    hostSocket.emit("event", {
      type: "declare_winners",
      roomId,
      actorPlayerId: hostId,
      winnerIds: [shortStackId],
    });

    await wait(220);
    state = getState();
    if (!state || state.payoutState !== "animating") {
      throw new Error("Expected payout to be credited (and animating) after hand 2 showdown declaration");
    }

    const shortStackPayout = state.payouts.find((p) => p.playerId === shortStackId)?.amount ?? 0;
    const bigStackPayout = state.payouts.find((p) => p.playerId === bigStackId)?.amount ?? 0;

    if (shortStackPayout !== 1532) {
      throw new Error(
        `Short stack (766) should win the entire main pot (1532), got ${shortStackPayout}. ` +
          `This is the exact bug reported: the winner only won back their own contribution.`
      );
    }
    if (bigStackPayout !== 468) {
      throw new Error(`Big stack should only get back their uncalled excess (468), got ${bigStackPayout}.`);
    }

    // Let the cosmetic animation window finish on its own; no acknowledgment needed.
    await wait(2300);

    console.log("PASS heads-up uneven-stacks all-in payout");
  } finally {
    hostSocket.disconnect();
    p2Socket.disconnect();
  }
}

async function main() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "no-chip-pot-test-"));
  let serverProcess;

  try {
    serverProcess = await startIsolatedServer(tempDir);
    await runScenario();
    await runSidePotScenario();
    await runContestedSidePotScenario();
    await runHeadsUpUnevenStacksAllInScenario();
  } catch (error) {
    console.error("FAIL pot regression");
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  } finally {
    await stopServer(serverProcess);
    await rm(tempDir, { recursive: true, force: true });
  }
}

void main();
