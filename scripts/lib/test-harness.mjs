// Shared helpers for integration tests: spawn an isolated server, connect
// named players over real socket.io connections, and drive/inspect a table.
import { io } from "socket.io-client";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function startServer(port) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "no-chip-int-"));
  const child = await new Promise((resolve, reject) => {
    const proc = spawn("node", ["dist/apps/server/src/index.js"], {
      env: { ...process.env, PORT: String(port), STATE_FILE_PATH: path.join(stateDir, "state.json") },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timeout = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(new Error("Server did not start within timeout"));
    }, 10000);
    proc.on("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Server exited before ready with code ${code}`));
    });
    proc.stdout.on("data", (chunk) => {
      if (String(chunk).includes(`listening on port ${port}`)) {
        clearTimeout(timeout);
        resolve(proc);
      }
    });
    proc.stderr.on("data", (chunk) => process.stderr.write(chunk));
  });

  return {
    url: `http://127.0.0.1:${port}`,
    async stop() {
      await new Promise((resolve) => {
        child.once("exit", () => resolve());
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 2000);
      });
      await rm(stateDir, { recursive: true, force: true });
    },
  };
}

function connect(url) {
  const socket = io(url, { transports: ["websocket"] });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Connect timeout")), 4000);
    socket.on("connect", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.on("connect_error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function nextEvent(socket, type, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off("event", onEvent);
      reject(new Error(`Timeout waiting for ${type}`));
    }, timeoutMs);
    const onEvent = (evt) => {
      if (evt?.type === type) {
        clearTimeout(timer);
        socket.off("event", onEvent);
        resolve(evt);
      } else if (evt?.type === "error" && type !== "error") {
        clearTimeout(timer);
        socket.off("event", onEvent);
        reject(new Error(`Server error: ${evt.message}`));
      }
    };
    socket.on("event", onEvent);
  });
}

export class Table {
  // names[0] is the host.
  static async create(serverUrl, names, options = {}) {
    const table = new Table(serverUrl);
    const settings = { smallBlind: 10, bigBlind: 20, startingStack: 500, ...options };
    const [hostName, ...others] = names;

    const hostSocket = await connect(serverUrl);
    hostSocket.emit("event", {
      type: "create_room",
      payload: { name: "int-test", displayName: hostName, ...settings },
    });
    const created = await nextEvent(hostSocket, "room_created");
    table.roomId = created.room.id;
    table.roomCode = created.room.code;
    table.#register(hostName, hostSocket, created.playerId, created.sessionId);

    for (const name of others) {
      await table.join(name);
    }
    await wait(150);
    return table;
  }

  constructor(serverUrl) {
    this.serverUrl = serverUrl;
    this.players = new Map();
    this.latest = null;
    this.hostKey = null;
  }

  #register(name, socket, id, sessionId) {
    const record = { name, socket, id, sessionId, errors: [], kicked: false };
    socket.on("event", (evt) => {
      if (evt?.type === "room_state") {
        if (!this.latest || evt.room.updatedAt >= this.latest.updatedAt) this.latest = evt.room;
      }
      if (evt?.type === "error") record.errors.push(evt.message);
    });
    this.players.set(name, record);
    if (!this.hostKey) this.hostKey = name;
    return record;
  }

  async join(name, role = "player") {
    const socket = await connect(this.serverUrl);
    socket.emit("event", { type: "join_room", payload: { roomCode: this.roomCode, displayName: name, role } });
    const joined = await nextEvent(socket, "joined_room");
    return this.#register(name, socket, joined.playerId, joined.sessionId);
  }

  // Drop a player's connection and bring it back with their saved session.
  async reconnect(name) {
    const record = this.p(name);
    record.socket.disconnect();
    await wait(80);
    const socket = await connect(this.serverUrl);
    socket.on("event", (evt) => {
      if (evt?.type === "room_state") {
        if (!this.latest || evt.room.updatedAt >= this.latest.updatedAt) this.latest = evt.room;
      }
      if (evt?.type === "error") record.errors.push(evt.message);
    });
    record.socket = socket;
    socket.emit("event", { type: "rejoin_room", payload: { roomCode: this.roomCode, sessionId: record.sessionId } });
    await nextEvent(socket, "rejoined_room");
    await wait(60);
  }

  p(name) {
    const record = this.players.get(name);
    if (!record) throw new Error(`Unknown player ${name}`);
    return record;
  }

  id(name) {
    return this.p(name).id;
  }

  get state() {
    return this.latest;
  }

  seatOf(name) {
    return this.state.players.find((x) => x.id === this.id(name))?.seat;
  }

  stackOf(name) {
    return this.state.players.find((x) => x.id === this.id(name))?.stack;
  }

  nameOfId(id) {
    for (const [name, rec] of this.players) if (rec.id === id) return name;
    return id;
  }

  actingName() {
    return this.state.actingPlayerId ? this.nameOfId(this.state.actingPlayerId) : null;
  }

  // Emits an event as `name` and resolves once the server either answered with
  // an error or published a newer room_state. Returns { ok, error }.
  async send(name, event) {
    const record = this.p(name);
    const before = this.state?.updatedAt ?? 0;
    const errorsBefore = record.errors.length;
    record.socket.emit("event", event);
    for (let i = 0; i < 30; i += 1) {
      await wait(30);
      if (record.errors.length > errorsBefore) {
        return { ok: false, error: record.errors[record.errors.length - 1] };
      }
      if ((this.state?.updatedAt ?? 0) > before) {
        await wait(30);
        return { ok: true };
      }
    }
    return { ok: true, unchanged: true };
  }

  startHand(name = this.hostKey) {
    return this.send(name, { type: "start_hand", roomId: this.roomId, actorPlayerId: this.id(name) });
  }

  act(name, action, amount) {
    return this.send(name, {
      type: "submit_action",
      roomId: this.roomId,
      actorPlayerId: this.id(name),
      action,
      ...(typeof amount === "number" ? { amount } : {}),
    });
  }

  confirmDeal(name = this.hostKey) {
    return this.send(name, { type: "confirm_deal", roomId: this.roomId, actorPlayerId: this.id(name) });
  }

  kick(targetName, byName = this.hostKey) {
    return this.send(byName, {
      type: "remove_player",
      roomId: this.roomId,
      actorPlayerId: this.id(byName),
      targetPlayerId: this.id(targetName),
    });
  }

  reorder(orderNames, byName = this.hostKey) {
    return this.send(byName, {
      type: "reorder_seats",
      roomId: this.roomId,
      actorPlayerId: this.id(byName),
      orderedPlayerIds: orderNames.map((n) => this.id(n)),
    });
  }

  declare(winnerNames, potWinnerNames, byName = this.hostKey) {
    return this.send(byName, {
      type: "declare_winners",
      roomId: this.roomId,
      actorPlayerId: this.id(byName),
      winnerIds: winnerNames.map((n) => this.id(n)),
      ...(potWinnerNames ? { potWinnerIds: potWinnerNames.map((group) => group.map((n) => this.id(n))) } : {}),
    });
  }

  // Check/call whoever is acting until `until(state)` is true. Throws if stuck.
  async passiveUntil(until, maxSteps = 60) {
    for (let i = 0; i < maxSteps; i += 1) {
      if (until(this.state)) return;
      if (this.state.awaitingDeal) {
        const dealt = await this.confirmDeal();
        if (!dealt.ok) throw new Error(`confirm_deal rejected: ${dealt.error}`);
        continue;
      }
      const actor = this.actingName();
      if (!actor) throw new Error(`No acting player while waiting (status=${this.state.status}, street=${this.state.street})`);
      const me = this.state.players.find((x) => x.id === this.id(actor));
      const action = me.commitment < this.state.currentBet ? "call" : "check";
      const result = await this.act(actor, action);
      if (!result.ok) throw new Error(`${actor} ${action} rejected: ${result.error}`);
    }
    throw new Error("passiveUntil exceeded max steps");
  }

  async waitForIdlePayout() {
    for (let i = 0; i < 60; i += 1) {
      if (this.state.payoutState === "idle") return;
      await wait(100);
    }
    throw new Error("payout never went idle");
  }

  totalStacks() {
    return this.state.players.reduce((sum, x) => sum + x.stack, 0);
  }

  totalPot() {
    return (this.state.pots || []).reduce((sum, x) => sum + x.amount, 0);
  }

  async close() {
    for (const rec of this.players.values()) rec.socket.disconnect();
    await wait(50);
  }
}

export function makeChecker() {
  let passed = 0;
  const failures = [];
  return {
    check(name, condition, detail) {
      if (condition) {
        passed += 1;
        console.log(`PASS ${name}`);
      } else {
        failures.push(name);
        console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
      }
    },
    finish(label) {
      console.log(`\n${label}: ${passed} passed, ${failures.length} failed`);
      if (failures.length > 0) process.exitCode = 1;
    },
  };
}
