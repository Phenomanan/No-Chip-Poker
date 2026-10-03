// Regression coverage for session/reconnect handling: a player must only
// ever have one *authoritative* live socket. Found while browser-testing the
// big-blind-option fix — opening a second tab/socket for the same saved
// session (which the client's own auto-rejoin-on-connect can now trigger far
// more easily than before) left two sockets mapped to the same player. When
// the OLDER of the two later disconnected (e.g. a tab closing or reloading),
// the server flipped the player to "offline" even though their newer socket
// was still live and well — silently locking them out of acting on their own
// turn (the frontend hides action buttons for a disconnected player) despite
// nothing actually being wrong with their connection.
import { io } from "socket.io-client";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const PORT = Number(process.env.SESSION_TEST_PORT || 3041);
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

async function runStaleSocketEvictionScenario() {
  const socketA = await connectSocket();
  let socketB;
  let p2Socket;

  try {
    socketA.emit("event", {
      type: "create_room",
      payload: { name: "session-handling-regression", displayName: "Alice", smallBlind: 10, bigBlind: 20, startingStack: 500 },
    });
    const created = await waitForEvent(socketA, "room_created");
    const roomId = created.room.id;
    const roomCode = created.room.code;
    const aliceId = created.playerId;
    const aliceSessionId = created.sessionId;

    p2Socket = await connectSocket();
    p2Socket.emit("event", { type: "join_room", payload: { roomCode, displayName: "P2", role: "player" } });
    const joined = await waitForEvent(p2Socket, "joined_room");
    const p2Id = joined.playerId;

    const getStateA = trackRoomState(socketA);
    const getStateP2 = trackRoomState(p2Socket);

    // Simulate a second tab/socket for Alice re-attaching with her saved
    // session WHILE her original socket (socketA) is still fully connected —
    // exactly what the client's auto-rejoin-on-connect can trigger from a
    // second tab sharing the same localStorage, or an overlapping
    // reconnect window.
    socketB = await connectSocket();
    socketB.emit("event", { type: "rejoin_room", payload: { roomCode, sessionId: aliceSessionId } });
    const rejoined = await waitForEvent(socketB, "rejoined_room");
    if (rejoined.playerId !== aliceId) {
      throw new Error("rejoin_room from the second socket did not resolve to the same player");
    }

    await wait(200);
    let state = getStateP2();
    const aliceAfterSecondSocket = state.players.find((p) => p.id === aliceId);
    if (!aliceAfterSecondSocket?.connected) {
      throw new Error("Alice should still be marked connected right after the second socket rejoins");
    }

    // The OLDER socket (A) now disconnects — e.g. the original tab was
    // closed or reloaded. Because the server evicted A's mapping when B
    // rejoined, this disconnect must be a no-op for Alice's connection
    // status: her authoritative live socket is now B.
    socketA.disconnect();
    await wait(300);

    state = getStateP2();
    const aliceAfterStaleDisconnect = state.players.find((p) => p.id === aliceId);
    if (!aliceAfterStaleDisconnect?.connected) {
      throw new Error(
        "Alice was incorrectly marked disconnected when her STALE socket dropped, even though her current socket (B) is still live — " +
          "this is exactly the bug that silently locks a player out of acting on their own turn."
      );
    }

    // And Alice must still actually be able to act through socket B.
    socketA.disconnect(); // already disconnected, harmless no-op call guard
    socketB.emit("event", { type: "start_hand", roomId, actorPlayerId: aliceId });
    await wait(250);
    state = getStateP2();
    if (state.status !== "in_hand") {
      throw new Error("Expected hand to start");
    }

    const actorId = state.actingPlayerId;
    const actorSocket = actorId === aliceId ? socketB : p2Socket;
    actorSocket.emit("event", { type: "submit_action", roomId, actorPlayerId: actorId, action: "call" });
    const errorOrState = await Promise.race([
      waitForEvent(actorSocket, "error", 1500).then((evt) => ({ error: evt })),
      wait(600).then(() => ({ error: null })),
    ]);
    if (errorOrState.error) {
      throw new Error(`Acting through the surviving socket was rejected: ${errorOrState.error.message}`);
    }

    console.log("PASS stale-socket eviction keeps the surviving connection authoritative");
  } finally {
    socketA.disconnect();
    socketB?.disconnect();
    p2Socket?.disconnect();
  }
}

async function main() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "no-chip-session-test-"));
  let serverProcess;

  try {
    serverProcess = await startIsolatedServer(tempDir);
    await runStaleSocketEvictionScenario();
  } catch (error) {
    console.error("FAIL session handling regression");
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  } finally {
    await stopServer(serverProcess);
    await rm(tempDir, { recursive: true, force: true });
  }
}

void main();
