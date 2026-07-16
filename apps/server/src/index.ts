import cors from "cors";
import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { customAlphabet } from "nanoid";
import { Server } from "socket.io";

import { calculatePayouts, calculatePots, canStartHand, validateAction, validateBlinds } from "../../../packages/rules-engine/src/index.js";
import type {
  ActionEvent,
  BlindScheduleState,
  BlindVoteState,
  BlindSettings,
  ClientToServerEvents,
  CreateRoomInput,
  JoinRoomInput,
  Player,
  RejoinInput,
  Role,
  RoomState,
  ServerToClientEvents,
} from "../../../packages/shared-types/src/index.js";

const corsOrigins = (process.env.CORS_ORIGINS ?? "*")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const allowAllOrigins = corsOrigins.includes("*");

function isAllowedOrigin(origin?: string): boolean {
  if (allowAllOrigins || !origin) {
    return true;
  }

  return corsOrigins.includes(origin);
}

const app = express();
app.set("trust proxy", 1);
app.use(
  helmet({
    // Keep static cross-origin asset loading permissive for CDN/socket client.
    crossOriginResourcePolicy: false,
  })
);
const rateWindowMs = Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60000);
const rateMax = Number(process.env.RATE_LIMIT_MAX ?? 200);
app.use(
  rateLimit({
    windowMs: Number.isFinite(rateWindowMs) ? rateWindowMs : 60000,
    max: Number.isFinite(rateMax) ? rateMax : 200,
    standardHeaders: true,
    legacyHeaders: false,
  })
);
app.use(
  cors({
    origin: (origin, callback) => {
      if (isAllowedOrigin(origin)) {
        callback(null, true);
        return;
      }

      callback(new Error("Not allowed by CORS"));
    },
  })
);

const currentFilePath = fileURLToPath(import.meta.url);
const currentDir = path.dirname(currentFilePath);
const webDir = path.resolve(currentDir, "../../web");

if (process.env.NODE_ENV !== "production") {
  app.use(express.static(webDir));
  app.get("/", (_req, res) => {
    res.sendFile(path.join(webDir, "index.html"));
  });
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "no-chip-server" });
});

const httpServer = createServer(app);
const io = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer, {
  cors: {
    origin: (origin, callback) => {
      if (isAllowedOrigin(origin)) {
        callback(null, true);
        return;
      }

      callback(new Error("Not allowed by CORS"));
    },
  },
});

const roomById = new Map<string, RoomState>();
const roomCodeToId = new Map<string, string>();
const sessionToPlayerId = new Map<string, string>();
const playerIdToRoomId = new Map<string, string>();
const socketToPlayerId = new Map<string, string>();
const roomStreetActionState = new Map<string, { street: RoomState["street"]; actedPlayerIds: Set<string> }>();

const stateFilePath = process.env.STATE_FILE_PATH ?? path.resolve(process.cwd(), "data", "state.json");
const roomTtlMs = Number(process.env.ROOM_TTL_MS ?? 1000 * 60 * 60 * 24);
const roomCleanupIntervalMs = Number(process.env.ROOM_CLEANUP_INTERVAL_MS ?? 1000 * 60 * 5);
let persistTimer: ReturnType<typeof setTimeout> | null = null;

const createRoomCode = customAlphabet("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", 6);
const createId = customAlphabet("abcdefghijklmnopqrstuvwxyz0123456789", 12);

interface PersistedActionState {
  street: RoomState["street"];
  actedPlayerIds: string[];
}

interface PersistedState {
  rooms: RoomState[];
  roomCodeToId: Array<[string, string]>;
  sessionToPlayerId: Array<[string, string]>;
  playerIdToRoomId: Array<[string, string]>;
  roomStreetActionState: Array<[string, PersistedActionState]>;
}

const DEFAULT_BLIND_LEVEL_DURATION_SECONDS = 15 * 60;

function createDefaultBlindSchedule(): BlindScheduleState {
  return {
    enabled: false,
    levelDurationSeconds: DEFAULT_BLIND_LEVEL_DURATION_SECONDS,
    levelNumber: 1,
    nextLevelAt: null,
  };
}

function normalizeRoomState(room: RoomState): RoomState {
  room.blindVote = room.blindVote ?? null;

  const schedule = room.blindSchedule;
  if (!schedule || typeof schedule !== "object") {
    room.blindSchedule = createDefaultBlindSchedule();
    return room;
  }

  room.blindSchedule = {
    enabled: Boolean(schedule.enabled),
    levelDurationSeconds:
      Number.isFinite(schedule.levelDurationSeconds) && schedule.levelDurationSeconds >= 60
        ? Math.floor(schedule.levelDurationSeconds)
        : DEFAULT_BLIND_LEVEL_DURATION_SECONDS,
    levelNumber: Number.isFinite(schedule.levelNumber) && schedule.levelNumber >= 1 ? Math.floor(schedule.levelNumber) : 1,
    nextLevelAt: Number.isFinite(schedule.nextLevelAt) ? Number(schedule.nextLevelAt) : null,
  };

  return room;
}

function serializeState(): PersistedState {
  return {
    rooms: [...roomById.values()],
    roomCodeToId: [...roomCodeToId.entries()],
    sessionToPlayerId: [...sessionToPlayerId.entries()],
    playerIdToRoomId: [...playerIdToRoomId.entries()],
    roomStreetActionState: [...roomStreetActionState.entries()].map(([roomId, state]) => [
      roomId,
      {
        street: state.street,
        actedPlayerIds: [...state.actedPlayerIds],
      },
    ]),
  };
}

function hydrateState(snapshot: PersistedState): void {
  roomById.clear();
  roomCodeToId.clear();
  sessionToPlayerId.clear();
  playerIdToRoomId.clear();
  roomStreetActionState.clear();

  snapshot.rooms.forEach((room) => {
    roomById.set(room.id, normalizeRoomState(room));
  });

  snapshot.roomCodeToId.forEach(([code, roomId]) => {
    if (roomById.has(roomId)) {
      roomCodeToId.set(code, roomId);
    }
  });

  snapshot.sessionToPlayerId.forEach(([sessionId, playerId]) => {
    sessionToPlayerId.set(sessionId, playerId);
  });

  snapshot.playerIdToRoomId.forEach(([playerId, roomId]) => {
    if (roomById.has(roomId)) {
      playerIdToRoomId.set(playerId, roomId);
    }
  });

  snapshot.roomStreetActionState.forEach(([roomId, state]) => {
    if (roomById.has(roomId)) {
      roomStreetActionState.set(roomId, {
        street: state.street,
        actedPlayerIds: new Set(state.actedPlayerIds),
      });
    }
  });
}

async function persistStateNow(): Promise<void> {
  const dir = path.dirname(stateFilePath);
  await mkdir(dir, { recursive: true });
  await writeFile(stateFilePath, JSON.stringify(serializeState()), "utf8");
}

function scheduleStatePersistence(): void {
  if (persistTimer) {
    clearTimeout(persistTimer);
  }

  persistTimer = setTimeout(() => {
    void persistStateNow().catch((error) => {
      console.error("[persist] Failed to write state snapshot", error);
    });
    persistTimer = null;
  }, 250);
}

async function restoreStateFromDisk(): Promise<void> {
  try {
    const raw = await readFile(stateFilePath, "utf8");
    const parsed = JSON.parse(raw) as PersistedState;
    if (!parsed || !Array.isArray(parsed.rooms)) {
      return;
    }

    hydrateState(parsed);
    console.log(`[persist] Restored ${roomById.size} room(s) from ${stateFilePath}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error("[persist] Failed to restore state", error);
    }
  }
}

function removeRoom(roomId: string): void {
  const room = roomById.get(roomId);
  if (!room) {
    return;
  }

  roomById.delete(roomId);
  roomCodeToId.delete(room.code);
  roomStreetActionState.delete(roomId);

  room.players.forEach((player) => {
    playerIdToRoomId.delete(player.id);
    socketToPlayerId.forEach((mappedPlayerId, socketId) => {
      if (mappedPlayerId === player.id) {
        socketToPlayerId.delete(socketId);
      }
    });
  });

  sessionToPlayerId.forEach((playerId, sessionId) => {
    if (room.players.some((player) => player.id === playerId)) {
      sessionToPlayerId.delete(sessionId);
    }
  });
}

function cleanupExpiredRooms(): void {
  if (!Number.isFinite(roomTtlMs) || roomTtlMs <= 0) {
    return;
  }

  const now = Date.now();
  let removed = 0;
  roomById.forEach((room) => {
    if (room.status === "in_hand") {
      return;
    }

    if (now - room.updatedAt > roomTtlMs) {
      removeRoom(room.id);
      removed += 1;
    }
  });

  if (removed > 0) {
    console.log(`[cleanup] Removed ${removed} expired room(s)`);
    scheduleStatePersistence();
  }
}

function emitRoomState(roomId: string): void {
  const room = roomById.get(roomId);
  if (!room) {
    console.log(`[emitRoomState] Room ${roomId} not found`);
    return;
  }

  room.updatedAt = Date.now();
  console.log(`[emitRoomState] Broadcasting room ${room.code} with ${room.players.length} players to room namespace ${roomId}`);
  room.players.forEach(p => console.log(`  - ${p.displayName} (${p.id})`));
  io.to(roomId).emit("event", { type: "room_state", room });
  scheduleStatePersistence();
}

function sanitizeRole(role: Role | undefined): Role {
  if (role === "host" || role === "player" || role === "spectator") {
    return role;
  }

  return "player";
}

function nextSeat(room: RoomState): number {
  if (room.players.length === 0) {
    return 1;
  }

  return Math.max(...room.players.map((p) => p.seat)) + 1;
}

function findNextActingPlayer(room: RoomState, currentPlayerId: string): string | null {
  const playersInHand = room.players
    .filter((p) => p.inHand && p.role !== "spectator")
    .sort((a, b) => a.seat - b.seat);
  const highestCommitment = playersInHand.reduce((max, p) => Math.max(max, p.commitment), 0);
  const playersNeedingAction = playersInHand.filter((p) => p.stack > 0 && p.commitment < highestCommitment);

  if (playersNeedingAction.length === 0) {
    return null;
  }

  const sorted = playersNeedingAction;
  const index = sorted.findIndex((p) => p.id === currentPlayerId);
  if (index < 0) {
    return sorted[0]?.id ?? null;
  }

  const nextIndex = (index + 1) % sorted.length;
  return sorted[nextIndex]?.id ?? null;
}

function findFirstPostflopActingPlayer(room: RoomState): string | null {
  const playersInHand = room.players
    .filter((p) => p.inHand && p.role !== "spectator" && p.stack > 0)
    .sort((a, b) => a.seat - b.seat);

  if (playersInHand.length === 0) {
    return null;
  }

  const firstLeftOfDealer = playersInHand.find((p) => p.seat > room.dealerSeat) ?? playersInHand[0];
  return firstLeftOfDealer?.id ?? null;
}

function shouldSettleHand(room: RoomState): boolean {
  const playersInHand = room.players.filter((p) => p.inHand && p.role !== "spectator");
  if (playersInHand.length <= 1) {
    return true;
  }

  const playersWithChips = playersInHand.filter((p) => p.stack > 0);
  if (playersWithChips.length === 0) {
    return true;
  }

  const actionState = roomStreetActionState.get(room.id);
  if (room.currentBet === 0) {
    if (!actionState || actionState.street !== room.street) {
      return false;
    }

    return playersWithChips.every((p) => actionState.actedPlayerIds.has(p.id));
  }

  const highestCommitment = playersInHand.reduce((max, p) => Math.max(max, p.commitment), 0);
  const hasPendingAction = playersInHand.some((p) => p.stack > 0 && p.commitment < highestCommitment);
  return !hasPendingAction;
}

function resetStreetActionState(room: RoomState): void {
  roomStreetActionState.set(room.id, {
    street: room.street,
    actedPlayerIds: new Set<string>(),
  });
}

function markPlayerActedThisStreet(room: RoomState, playerId: string): void {
  const existing = roomStreetActionState.get(room.id);
  if (!existing || existing.street !== room.street) {
    roomStreetActionState.set(room.id, {
      street: room.street,
      actedPlayerIds: new Set<string>([playerId]),
    });
    return;
  }

  existing.actedPlayerIds.add(playerId);
}

function settleHand(room: RoomState, winnerIds: string[]): void {
  room.street = "showdown";
  room.pots = calculatePots(room);

  room.payouts = calculatePayouts(room, winnerIds);

  for (const payout of room.payouts) {
    const winner = room.players.find((p) => p.id === payout.playerId);
    if (winner) {
      winner.stack += payout.amount;
    }
  }

  for (const player of room.players) {
    player.inHand = false;
    player.commitment = 0;
  }

  room.status = "waiting";
  room.street = "resolved";
  room.actingPlayerId = null;
  room.currentBet = 0;
}

function moveToShowdown(room: RoomState): void {
  room.status = "paused";
  room.street = "showdown";
  room.actingPlayerId = null;
  room.pots = calculatePots(room);
}

function advanceStreetOrShowdown(room: RoomState): void {
  const streetOrder: RoomState["street"][] = ["preflop", "flop", "turn", "river"];
  const streetIndex = streetOrder.indexOf(room.street);

  if (streetIndex === -1 || streetIndex === streetOrder.length - 1) {
    moveToShowdown(room);
    return;
  }

  room.street = streetOrder[streetIndex + 1];
  room.currentBet = 0;
  for (const player of room.players) {
    if (player.inHand) {
      player.commitment = 0;
    }
  }

  room.pots = calculatePots(room);
  resetStreetActionState(room);
  room.actingPlayerId = findFirstPostflopActingPlayer(room);

  // If all remaining players are all-in, immediately continue streets until showdown.
  while (room.actingPlayerId === null && room.street !== "showdown") {
    const currentIndex = streetOrder.indexOf(room.street);
    if (currentIndex === -1 || currentIndex === streetOrder.length - 1) {
      moveToShowdown(room);
      return;
    }

    room.street = streetOrder[currentIndex + 1];
    resetStreetActionState(room);
  }

  if (room.street !== "showdown") {
    room.actingPlayerId = findFirstPostflopActingPlayer(room);
  }

  if (room.actingPlayerId === null) {
    moveToShowdown(room);
  }
}

function createHostPlayer(input: CreateRoomInput): Player {
  return {
    id: createId(),
    displayName: input.displayName.trim(),
    role: "host",
    seat: 1,
    stack: input.startingStack,
    connected: true,
    joinedAt: Date.now(),
    inHand: false,
    commitment: 0,
  };
}

function createRoom(input: CreateRoomInput, host: Player): RoomState {
  const roomId = createId();
  const roomCode = createRoomCode();
  return {
    id: roomId,
    code: roomCode,
    name: input.name.trim() || "Poker Night",
    status: "waiting",
    street: "resolved",
    hostPlayerId: host.id,
    dealerSeat: host.seat,
    smallBlindSeat: host.seat,
    actingPlayerId: null,
    pots: [],
    currentBet: 0,
    blinds: {
      smallBlind: input.smallBlind,
      bigBlind: input.bigBlind,
    },
    players: [host],
    actionLog: [],
    payouts: [],
    messages: [],
    blindVote: null,
    blindSchedule: createDefaultBlindSchedule(),
    updatedAt: Date.now(),
  };
}

function eligibleBlindVotePlayerIds(room: RoomState): string[] {
  return room.players.filter((p) => p.role !== "spectator").map((p) => p.id);
}

function majorityThreshold(totalVoters: number): number {
  return Math.floor(totalVoters / 2) + 1;
}

function resolveBlindVoteIfPossible(room: RoomState): void {
  const vote = room.blindVote;
  if (!vote || vote.status !== "open") {
    return;
  }

  const totalVoters = vote.eligiblePlayerIds.length;
  const threshold = majorityThreshold(totalVoters);
  const yesCount = vote.yesVotes.length;
  const noCount = vote.noVotes.length;
  const remainingVotes = totalVoters - yesCount - noCount;

  if (yesCount >= threshold) {
    vote.status = "passed";
    vote.resolvedAt = Date.now();
    room.blinds = {
      smallBlind: room.blinds.smallBlind * vote.multiplier,
      bigBlind: room.blinds.bigBlind * vote.multiplier,
    };
    return;
  }

  if (yesCount + remainingVotes < threshold) {
    vote.status = "failed";
    vote.resolvedAt = Date.now();
  }
}

function scheduleNextBlindLevel(room: RoomState): void {
  room.blindSchedule.nextLevelAt = Date.now() + room.blindSchedule.levelDurationSeconds * 1000;
}

function tickBlindSchedules(): void {
  const now = Date.now();
  roomById.forEach((room) => {
    const schedule = room.blindSchedule;
    if (!schedule.enabled || room.status === "ended") {
      return;
    }

    if (!schedule.nextLevelAt) {
      scheduleNextBlindLevel(room);
      emitRoomState(room.id);
      return;
    }

    if (now < schedule.nextLevelAt) {
      return;
    }

    room.blinds = {
      smallBlind: room.blinds.smallBlind * 2,
      bigBlind: room.blinds.bigBlind * 2,
    };
    schedule.levelNumber += 1;
    scheduleNextBlindLevel(room);

    if (room.blindVote?.status === "open") {
      room.blindVote.status = "failed";
      room.blindVote.resolvedAt = Date.now();
    }

    emitRoomState(room.id);
  });
}

function appendAction(room: RoomState, playerId: string, action: ActionEvent["action"], amount?: number): void {
  room.actionLog.push({
    id: createId(),
    roomId: room.id,
    playerId,
    action,
    amount,
    at: Date.now(),
  });

  if (room.actionLog.length > 200) {
    room.actionLog = room.actionLog.slice(-200);
  }
}

function markDisconnected(playerId: string): void {
  const roomId = playerIdToRoomId.get(playerId);
  if (!roomId) {
    return;
  }

  const room = roomById.get(roomId);
  if (!room) {
    return;
  }

  const player = room.players.find((p) => p.id === playerId);
  if (!player) {
    return;
  }

  player.connected = false;
  if (room.actingPlayerId === playerId) {
    room.actingPlayerId = findNextActingPlayer(room, playerId);
  }

  emitRoomState(roomId);
}

function joinRoom(socketId: string, payload: JoinRoomInput): { room: RoomState; player: Player; sessionId: string } | { error: string } {
  const roomId = roomCodeToId.get(payload.roomCode.trim().toUpperCase());
  if (!roomId) {
    return { error: "Room code not found." };
  }

  const room = roomById.get(roomId);
  if (!room) {
    return { error: "Room is no longer active." };
  }

  if (room.status === "ended") {
    return { error: "Room has ended." };
  }

  const requestedSession = payload.sessionId?.trim();
  if (requestedSession) {
    const existingPlayerId = sessionToPlayerId.get(requestedSession);
    if (existingPlayerId) {
      const existingPlayer = room.players.find((p) => p.id === existingPlayerId);
      if (existingPlayer) {
        existingPlayer.connected = true;
        socketToPlayerId.set(socketId, existingPlayer.id);
        return { room, player: existingPlayer, sessionId: requestedSession };
      }
    }
  }

  const role = sanitizeRole(payload.role);
  const player: Player = {
    id: createId(),
    displayName: payload.displayName.trim(),
    role,
    seat: role === "spectator" ? 0 : nextSeat(room),
    stack: role === "spectator" ? 0 : 1000,
    connected: true,
    joinedAt: Date.now(),
    inHand: false,
    commitment: 0,
  };

  const sessionId = createId();
  room.players.push(player);
  console.log(`[joinRoom] Added ${player.displayName} to room ${room.code}. Room now has ${room.players.length} players`);
  sessionToPlayerId.set(sessionId, player.id);
  playerIdToRoomId.set(player.id, room.id);
  socketToPlayerId.set(socketId, player.id);
  return { room, player, sessionId };
}

function rejoinRoom(socketId: string, payload: RejoinInput): { room: RoomState; player: Player } | { error: string } {
  const roomId = roomCodeToId.get(payload.roomCode.trim().toUpperCase());
  if (!roomId) {
    return { error: "Room code not found." };
  }

  const room = roomById.get(roomId);
  if (!room) {
    return { error: "Room is no longer active." };
  }

  const playerId = sessionToPlayerId.get(payload.sessionId.trim());
  if (!playerId) {
    return { error: "Session expired. Join again with display name." };
  }

  const player = room.players.find((p) => p.id === playerId);
  if (!player) {
    return { error: "Player is not part of this room." };
  }

  player.connected = true;
  socketToPlayerId.set(socketId, player.id);
  return { room, player };
}

io.on("connection", (socket) => {
  socket.on("event", (event) => {
    if (event.type === "create_room") {
      const payload = event.payload;
      const blindValidation = validateBlinds(payload.smallBlind, payload.bigBlind);
      if (!blindValidation.ok) {
        socket.emit("event", { type: "error", message: blindValidation.message ?? "Invalid blinds." });
        return;
      }

      if (!payload.displayName.trim()) {
        socket.emit("event", { type: "error", message: "Display name is required." });
        return;
      }

      const host = createHostPlayer(payload);
      const room = createRoom(payload, host);
      const sessionId = createId();

      roomById.set(room.id, room);
      roomCodeToId.set(room.code, room.id);
      sessionToPlayerId.set(sessionId, host.id);
      playerIdToRoomId.set(host.id, room.id);
      socketToPlayerId.set(socket.id, host.id);

      socket.join(room.id);
      console.log(`[CREATE_ROOM] Host ${host.displayName} created room ${room.code} (${room.id}), socket ${socket.id} joined namespace`);
      socket.emit("event", { type: "room_created", room, sessionId, playerId: host.id });
      emitRoomState(room.id);
      return;
    }

    if (event.type === "join_room") {
      const result = joinRoom(socket.id, event.payload);
      if ("error" in result) {
        socket.emit("event", { type: "error", message: result.error });
        return;
      }

      console.log(`[JOIN_ROOM] Player joined: ${result.player.displayName}, Room has ${result.room.players.length} players now`);
      socket.join(result.room.id);
      console.log(`[JOIN_ROOM] Socket ${socket.id} joined room namespace ${result.room.id}`);
      socket.emit("event", {
        type: "joined_room",
        room: result.room,
        sessionId: result.sessionId,
        playerId: result.player.id,
      });
      console.log(`[EMIT_ROOM_STATE] Broadcasting to room ${result.room.id} with ${result.room.players.length} players`);
      emitRoomState(result.room.id);
      return;
    }

    if (event.type === "rejoin_room") {
      const result = rejoinRoom(socket.id, event.payload);
      if ("error" in result) {
        socket.emit("event", { type: "error", message: result.error });
        return;
      }

      socket.join(result.room.id);
      socket.emit("event", {
        type: "rejoined_room",
        room: result.room,
        playerId: result.player.id,
      });
      emitRoomState(result.room.id);
      return;
    }

    if (event.type === "start_hand") {
      const room = roomById.get(event.roomId);
      if (!room) {
        socket.emit("event", { type: "error", message: "Room not found." });
        return;
      }

      const permission = canStartHand(room, event.actorPlayerId);
      if (!permission.ok) {
        socket.emit("event", { type: "error", message: permission.message ?? "Cannot start hand." });
        return;
      }

      room.status = "in_hand";
      room.street = "preflop";
      room.pots = [];
      room.payouts = [];
      room.currentBet = 0;
      resetStreetActionState(room);

      const players = room.players
        .filter((p) => p.role !== "spectator" && p.stack > 0)
        .sort((a, b) => a.seat - b.seat);

      for (const player of room.players) {
        player.inHand = player.role !== "spectator" && player.stack > 0;
        player.commitment = 0;
      }

      if (players.length >= 2) {
        // Rotate dealer button to next active player
        const currentDealerIndex = players.findIndex((p) => p.seat === room.dealerSeat);
        const nextDealerIndex = (currentDealerIndex + 1) % players.length;
        room.dealerSeat = players[nextDealerIndex].seat;

        // Heads-up: dealer is small blind
        const isHeadsUp = players.length === 2;
        let sbIndex: number, bbIndex: number;

        if (isHeadsUp) {
          sbIndex = nextDealerIndex;
          bbIndex = (nextDealerIndex + 1) % players.length;
        } else {
          sbIndex = (nextDealerIndex + 1) % players.length;
          bbIndex = (nextDealerIndex + 2) % players.length;
        }

        room.smallBlindSeat = players[sbIndex].seat;
        const sb = players[sbIndex];
        const bb = players[bbIndex];

        sb.commitment = room.blinds.smallBlind;
        sb.stack -= room.blinds.smallBlind;
        bb.commitment = room.blinds.bigBlind;
        bb.stack -= room.blinds.bigBlind;
        room.currentBet = room.blinds.bigBlind;
        room.pots.push({
          amount: room.blinds.smallBlind + room.blinds.bigBlind,
          contributors: [sb.id, bb.id],
        });

        // First to act: after big blind (heads-up: SB acts first preflop)
        const firstToActIndex = isHeadsUp ? sbIndex : (bbIndex + 1) % players.length;
        room.actingPlayerId = players[firstToActIndex].id;
      }

      appendAction(room, event.actorPlayerId, "check");
      if (room.blindVote?.status === "open") {
        room.blindVote = null;
      }
      if (room.blindSchedule.enabled && !room.blindSchedule.nextLevelAt) {
        scheduleNextBlindLevel(room);
      }
      emitRoomState(room.id);
      return;
    }

    if (event.type === "update_blinds") {
      const room = roomById.get(event.roomId);
      if (!room) {
        socket.emit("event", { type: "error", message: "Room not found." });
        return;
      }

      if (room.hostPlayerId !== event.actorPlayerId) {
        socket.emit("event", { type: "error", message: "Only host can update blinds." });
        return;
      }

      const validity = validateBlinds(event.blinds.smallBlind, event.blinds.bigBlind);
      if (!validity.ok) {
        socket.emit("event", { type: "error", message: validity.message ?? "Invalid blinds." });
        return;
      }

      room.blinds = event.blinds;
      if (room.blindVote?.status === "open") {
        room.blindVote.status = "failed";
        room.blindVote.resolvedAt = Date.now();
      }
      emitRoomState(room.id);
      return;
    }

    if (event.type === "configure_blind_schedule") {
      const room = roomById.get(event.roomId);
      if (!room) {
        socket.emit("event", { type: "error", message: "Room not found." });
        return;
      }

      if (room.hostPlayerId !== event.actorPlayerId) {
        socket.emit("event", { type: "error", message: "Only host can configure blind schedule." });
        return;
      }

      const seconds = Number(event.levelDurationSeconds);
      if (!Number.isFinite(seconds) || seconds < 60) {
        socket.emit("event", { type: "error", message: "Blind level duration must be at least 60 seconds." });
        return;
      }

      room.blindSchedule.levelDurationSeconds = Math.floor(seconds);
      if (room.blindSchedule.enabled) {
        scheduleNextBlindLevel(room);
      }

      emitRoomState(room.id);
      return;
    }

    if (event.type === "toggle_blind_schedule") {
      const room = roomById.get(event.roomId);
      if (!room) {
        socket.emit("event", { type: "error", message: "Room not found." });
        return;
      }

      if (room.hostPlayerId !== event.actorPlayerId) {
        socket.emit("event", { type: "error", message: "Only host can toggle blind schedule." });
        return;
      }

      room.blindSchedule.enabled = event.enabled;
      room.blindSchedule.nextLevelAt = event.enabled
        ? Date.now() + room.blindSchedule.levelDurationSeconds * 1000
        : null;

      emitRoomState(room.id);
      return;
    }

    if (event.type === "reset_blind_schedule") {
      const room = roomById.get(event.roomId);
      if (!room) {
        socket.emit("event", { type: "error", message: "Room not found." });
        return;
      }

      if (room.hostPlayerId !== event.actorPlayerId) {
        socket.emit("event", { type: "error", message: "Only host can reset blind schedule." });
        return;
      }

      room.blindSchedule.levelNumber = 1;
      room.blindSchedule.nextLevelAt = room.blindSchedule.enabled
        ? Date.now() + room.blindSchedule.levelDurationSeconds * 1000
        : null;

      emitRoomState(room.id);
      return;
    }

    if (event.type === "request_double_blinds_vote") {
      const room = roomById.get(event.roomId);
      if (!room) {
        socket.emit("event", { type: "error", message: "Room not found." });
        return;
      }

      if (room.status !== "waiting") {
        socket.emit("event", { type: "error", message: "You can only start a blind vote between hands." });
        return;
      }

      const proposer = room.players.find((p) => p.id === event.actorPlayerId);
      if (!proposer || proposer.role === "spectator") {
        socket.emit("event", { type: "error", message: "Only players can start a blind vote." });
        return;
      }

      if (room.blindVote?.status === "open") {
        socket.emit("event", { type: "error", message: "A blind vote is already in progress." });
        return;
      }

      const eligiblePlayerIds = eligibleBlindVotePlayerIds(room);
      if (eligiblePlayerIds.length < 2) {
        socket.emit("event", { type: "error", message: "At least two players are required for a vote." });
        return;
      }

      const vote: BlindVoteState = {
        proposedByPlayerId: event.actorPlayerId,
        multiplier: 2,
        createdAt: Date.now(),
        status: "open",
        eligiblePlayerIds,
        yesVotes: [event.actorPlayerId],
        noVotes: [],
      };

      room.blindVote = vote;
      resolveBlindVoteIfPossible(room);
      emitRoomState(room.id);
      return;
    }

    if (event.type === "cast_double_blinds_vote") {
      const room = roomById.get(event.roomId);
      if (!room) {
        socket.emit("event", { type: "error", message: "Room not found." });
        return;
      }

      if (!room.blindVote || room.blindVote.status !== "open") {
        socket.emit("event", { type: "error", message: "No active blind vote to vote on." });
        return;
      }

      const vote = room.blindVote;
      if (!vote.eligiblePlayerIds.includes(event.actorPlayerId)) {
        socket.emit("event", { type: "error", message: "Only active players can vote." });
        return;
      }

      if (vote.yesVotes.includes(event.actorPlayerId) || vote.noVotes.includes(event.actorPlayerId)) {
        socket.emit("event", { type: "error", message: "You have already voted." });
        return;
      }

      if (event.approve) {
        vote.yesVotes.push(event.actorPlayerId);
      } else {
        vote.noVotes.push(event.actorPlayerId);
      }

      resolveBlindVoteIfPossible(room);
      emitRoomState(room.id);
      return;
    }

    if (event.type === "transfer_host") {
      const room = roomById.get(event.roomId);
      if (!room) {
        socket.emit("event", { type: "error", message: "Room not found." });
        return;
      }

      if (room.hostPlayerId !== event.actorPlayerId) {
        socket.emit("event", { type: "error", message: "Only host can transfer hosting." });
        return;
      }

      const newHost = room.players.find(p => p.id === event.newHostPlayerId);
      if (!newHost) {
        socket.emit("event", { type: "error", message: "Player not found." });
        return;
      }

      room.hostPlayerId = event.newHostPlayerId;
      emitRoomState(room.id);
      return;
    }

    if (event.type === "send_message") {
      const room = roomById.get(event.roomId);
      if (!room) {
        socket.emit("event", { type: "error", message: "Room not found." });
        return;
      }

      const player = room.players.find((p) => p.id === event.playerId);
      if (!player) {
        socket.emit("event", { type: "error", message: "Player not found." });
        return;
      }

      const messageText = event.text.trim().slice(0, 500); // Max 500 chars
      if (!messageText) {
        return;
      }

      const clientMessageId = event.clientMessageId?.trim().slice(0, 80);
      if (
        clientMessageId &&
        room.messages.some((message) => message.playerId === event.playerId && message.clientMessageId === clientMessageId)
      ) {
        emitRoomState(room.id);
        return;
      }

      const message = {
        id: createId(),
        playerId: event.playerId,
        playerName: player.displayName,
        text: messageText,
        at: Date.now(),
        clientMessageId,
      };

      room.messages.push(message);
      if (room.messages.length > 100) {
        room.messages.shift(); // Keep last 100 messages
      }

      emitRoomState(room.id);
      return;
    }

    if (event.type === "submit_action") {
      const room = roomById.get(event.roomId);
      if (!room) {
        socket.emit("event", { type: "error", message: "Room not found." });
        return;
      }

      const validation = validateAction(room, event.actorPlayerId, event.action, event.amount);
      if (!validation.ok) {
        socket.emit("event", { type: "error", message: validation.message ?? "Invalid action." });
        return;
      }

      const currentPlayer = room.players.find((p) => p.id === event.actorPlayerId);
      if (!currentPlayer) {
        socket.emit("event", { type: "error", message: "Player not found." });
        return;
      }

      appendAction(room, event.actorPlayerId, event.action, event.amount);
      markPlayerActedThisStreet(room, event.actorPlayerId);

      if (event.action === "fold") {
        currentPlayer.inHand = false;
      } else if (event.action === "call") {
        const callAmount = room.currentBet - currentPlayer.commitment;
        currentPlayer.stack -= callAmount;
        currentPlayer.commitment = room.currentBet;
      } else if (event.action === "raise" && typeof event.amount === "number") {
        const addAmount = event.amount - currentPlayer.commitment;
        currentPlayer.stack -= addAmount;
        currentPlayer.commitment = event.amount;
        room.currentBet = event.amount;
      } else if (event.action === "all_in") {
        currentPlayer.commitment += currentPlayer.stack;
        currentPlayer.stack = 0;
        room.currentBet = Math.max(room.currentBet, currentPlayer.commitment);
      }

      room.pots = calculatePots(room);

      const playersInHand = room.players.filter((p) => p.inHand && p.role !== "spectator").sort((a, b) => a.seat - b.seat);
      if (playersInHand.length === 1) {
        settleHand(room, [playersInHand[0].id]);
      } else if (shouldSettleHand(room)) {
        advanceStreetOrShowdown(room);
      } else {
        room.actingPlayerId = findNextActingPlayer(room, event.actorPlayerId);
      }

      emitRoomState(room.id);
      return;
    }

    if (event.type === "declare_winners") {
      const room = roomById.get(event.roomId);
      if (!room) {
        socket.emit("event", { type: "error", message: "Room not found." });
        return;
      }

      if (room.hostPlayerId !== event.actorPlayerId) {
        socket.emit("event", { type: "error", message: "Only host can declare winners." });
        return;
      }

      if (!(room.status === "paused" && room.street === "showdown")) {
        socket.emit("event", { type: "error", message: "Room is not waiting for showdown winners." });
        return;
      }

      const eligibleWinnerIds = new Set(
        room.players.filter((p) => p.inHand && p.role !== "spectator").map((p) => p.id)
      );
      const winnerIds = [...new Set(event.winnerIds)].filter((id) => eligibleWinnerIds.has(id));
      if (winnerIds.length === 0) {
        socket.emit("event", { type: "error", message: "Select at least one eligible winner." });
        return;
      }

      settleHand(room, winnerIds);
      emitRoomState(room.id);
      return;
    }
  });

  socket.on("disconnect", () => {
    const playerId = socketToPlayerId.get(socket.id);
    if (!playerId) {
      return;
    }

    socketToPlayerId.delete(socket.id);
    markDisconnected(playerId);
  });
});

const port = Number(process.env.PORT ?? 3001);

setInterval(cleanupExpiredRooms, Number.isFinite(roomCleanupIntervalMs) ? roomCleanupIntervalMs : 1000 * 60 * 5);
setInterval(tickBlindSchedules, 1000);

async function startServer(): Promise<void> {
  await restoreStateFromDisk();
  httpServer.listen(port, () => {
    console.log(`No-Chip Poker server listening on port ${port}`);
  });
}

void startServer();

