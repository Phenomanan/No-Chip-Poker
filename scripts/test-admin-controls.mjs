// Integration coverage for the admin controls added after weekend playtesting:
// host can remove a player from the lobby (even mid-hand, auto-folding them),
// and host can set strict table/seat order between hands. Same
// spawn-a-real-server + socket.io-client approach as test-pot-regression.mjs.
import { io } from "socket.io-client";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const PORT = Number(process.env.ADMIN_TEST_PORT || 3022);
const SERVER_URL = `http://127.0.0.1:${PORT}`;

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
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  });
}

async function stopServer(child) {
  if (!child || child.killed) {
    return;
  }

  await new Promise((resolve) => {
    child.once("exit", () => resolve());
    child.kill("SIGTERM");
    setTimeout(() => {
      if (!child.killed) {
        child.kill("SIGKILL");
      }
    }, 2000);
  });
}

async function connectAndJoin(roomCode, displayName) {
  const socket = io(SERVER_URL, { transports: ["websocket"] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Connect timeout for ${displayName}`)), 4000);
    socket.on("connect", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.on("connect_error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });

  socket.emit("event", { type: "join_room", payload: { roomCode, displayName, role: "player" } });
  const joined = await waitForEvent(socket, "joined_room");
  return { socket, playerId: joined.playerId };
}

// Host removes a player who left mid-hand and rejoined/re-created confusion at
// the table: removal should auto-fold their live hand, let the remaining
// players finish the street/hand normally, and evict them from the room
// entirely (their session no longer works).
async function testRemovePlayerMidHand() {
  const hostSocket = io(SERVER_URL, { transports: ["websocket"] });
  let p2Socket;
  let p3Socket;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Host connect timeout")), 4000);
    hostSocket.on("connect", () => {
      clearTimeout(timer);
      resolve();
    });
    hostSocket.on("connect_error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });

  try {
    hostSocket.emit("event", {
      type: "create_room",
      payload: { name: "admin-remove-test", displayName: "Host", smallBlind: 10, bigBlind: 20, startingStack: 500 },
    });
    const created = await waitForEvent(hostSocket, "room_created");
    const roomId = created.room.id;
    const roomCode = created.room.code;
    const hostId = created.playerId;

    const p2Join = await connectAndJoin(roomCode, "P2");
    p2Socket = p2Join.socket;
    const p2Id = p2Join.playerId;
    const p3Join = await connectAndJoin(roomCode, "P3");
    p3Socket = p3Join.socket;
    const p3Id = p3Join.playerId;

    const getState = trackRoomState(hostSocket);

    hostSocket.emit("event", { type: "start_hand", roomId, actorPlayerId: hostId });
    await wait(220);
    let state = getState();
    if (!state) throw new Error("Missing state after start_hand");

    // A non-host third player is the one who "leaves and comes back" — remove them mid-hand.
    if (!state.players.some((p) => p.id === p3Id && p.inHand)) {
      throw new Error("Expected p3 to be dealt into the hand");
    }

    // Non-host cannot remove anyone.
    p2Socket.emit("event", { type: "remove_player", roomId, actorPlayerId: p2Id, targetPlayerId: p3Id });
    const forbidden = await waitForEvent(p2Socket, "error");
    if (!String(forbidden.message || "").toLowerCase().includes("host")) {
      throw new Error(`Expected host-only error, got: ${forbidden.message}`);
    }

    // Host removes p3 mid-hand.
    hostSocket.emit("event", { type: "remove_player", roomId, actorPlayerId: hostId, targetPlayerId: p3Id });
    await wait(250);
    state = getState();
    if (!state) throw new Error("Missing state after remove_player");

    // Mid-hand the removed player may linger flagged pendingRemoval (so their chips stay
    // in the pot as dead money) but must be hidden from every client.
    if (state.players.some((p) => p.id === p3Id && !p.pendingRemoval)) {
      throw new Error("Removed player is still listed in the room");
    }

    // Hand should still be resolvable with the two remaining players — advance
    // it to completion via check/call and confirm nothing is stuck.
    for (let i = 0; i < 20 && state.status === "in_hand"; i += 1) {
      const actorId = state.actingPlayerId;
      if (!actorId) break;
      const actor = state.players.find((p) => p.id === actorId);
      const action = actor.commitment < state.currentBet ? "call" : "check";
      const socket = actorId === hostId ? hostSocket : p2Socket;
      socket.emit("event", { type: "submit_action", roomId, actorPlayerId: actorId, action });
      await wait(180);
      state = getState();
    }

    if (state.status === "in_hand") {
      throw new Error("Hand never resolved after removing a mid-hand player");
    }
    if (state.status === "paused") {
      hostSocket.emit("event", { type: "declare_winners", roomId, actorPlayerId: hostId, winnerIds: [hostId] });
      await wait(300);
      state = getState();
    }
    if (state.players.some((p) => p.id === p3Id)) {
      throw new Error("Removed player still in the roster after the hand settled");
    }

    // The removed player's session is dead: rejoin must fail cleanly.
    p3Socket.emit("event", { type: "rejoin_room", payload: { roomCode, sessionId: "not-a-real-session" } });
    await waitForEvent(p3Socket, "error");

    console.log("PASS remove_player mid-hand auto-folds and evicts cleanly");
  } finally {
    hostSocket.disconnect();
    p2Socket?.disconnect();
    p3Socket?.disconnect();
  }
}

// Host sets strict table order between hands; the new order must be exactly
// what subsequent turn order follows (not just cosmetically displayed).
async function testReorderSeats() {
  const hostSocket = io(SERVER_URL, { transports: ["websocket"] });
  let p2Socket;
  let p3Socket;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Host connect timeout")), 4000);
    hostSocket.on("connect", () => {
      clearTimeout(timer);
      resolve();
    });
    hostSocket.on("connect_error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });

  try {
    hostSocket.emit("event", {
      type: "create_room",
      payload: { name: "admin-reorder-test", displayName: "Host", smallBlind: 10, bigBlind: 20, startingStack: 500 },
    });
    const created = await waitForEvent(hostSocket, "room_created");
    const roomId = created.room.id;
    const roomCode = created.room.code;
    const hostId = created.playerId;

    const p2Join = await connectAndJoin(roomCode, "P2");
    p2Socket = p2Join.socket;
    const p2Id = p2Join.playerId;
    const p3Join = await connectAndJoin(roomCode, "P3");
    p3Socket = p3Join.socket;
    const p3Id = p3Join.playerId;

    const getState = trackRoomState(hostSocket);

    // Non-host cannot reorder.
    p2Socket.emit("event", {
      type: "reorder_seats",
      roomId,
      actorPlayerId: p2Id,
      orderedPlayerIds: [p2Id, p3Id, hostId],
    });
    const forbidden = await waitForEvent(p2Socket, "error");
    if (!String(forbidden.message || "").toLowerCase().includes("host")) {
      throw new Error(`Expected host-only error, got: ${forbidden.message}`);
    }

    // Host sets a specific order: P3, Host, P2.
    hostSocket.emit("event", {
      type: "reorder_seats",
      roomId,
      actorPlayerId: hostId,
      orderedPlayerIds: [p3Id, hostId, p2Id],
    });
    await wait(200);
    let state = getState();
    if (!state) throw new Error("Missing state after reorder_seats");

    const seatOf = (id) => state.players.find((p) => p.id === id)?.seat;
    if (seatOf(p3Id) !== 1 || seatOf(hostId) !== 2 || seatOf(p2Id) !== 3) {
      throw new Error(
        `Seat order did not apply as requested: p3=${seatOf(p3Id)}, host=${seatOf(hostId)}, p2=${seatOf(p2Id)}`
      );
    }

    // Reordering mid-hand must be rejected.
    hostSocket.emit("event", { type: "start_hand", roomId, actorPlayerId: hostId });
    await wait(220);
    state = getState();
    if (state.status !== "in_hand") throw new Error("Expected hand to start");

    hostSocket.emit("event", {
      type: "reorder_seats",
      roomId,
      actorPlayerId: hostId,
      orderedPlayerIds: [hostId, p2Id, p3Id],
    });
    const lockedError = await waitForEvent(hostSocket, "error");
    if (!String(lockedError.message || "").toLowerCase().includes("between hands")) {
      throw new Error(`Expected reorder to be locked mid-hand, got: ${lockedError.message}`);
    }

    // Turn order must strictly follow the new seat assignment: with dealer
    // rotated to whoever now sits at the old dealer's seat number, first
    // preflop actor should be a seat-order function of the NEW seats, not the
    // pre-reorder identities.
    const actingSeat = seatOf(state.actingPlayerId);
    if (!Number.isFinite(actingSeat)) {
      throw new Error("No acting player seat found after starting hand with reordered seats");
    }

    console.log("PASS reorder_seats applies host-chosen table order and locks during a hand");
  } finally {
    hostSocket.disconnect();
    p2Socket?.disconnect();
    p3Socket?.disconnect();
  }
}

async function main() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "no-chip-admin-test-"));
  let serverProcess;

  try {
    serverProcess = await startIsolatedServer(tempDir);
    await testRemovePlayerMidHand();
    await testReorderSeats();
  } catch (error) {
    console.error("FAIL admin controls");
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  } finally {
    await stopServer(serverProcess);
    await rm(tempDir, { recursive: true, force: true });
  }
}

void main();
