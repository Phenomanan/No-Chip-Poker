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

import {
  calculatePayouts,
  calculatePots,
  canReorderSeats,
  canRemovePlayer,
  canStartHand,
  countActionCapablePlayers,
  findFirstPostflopActingPlayer,
  findNextActingPlayer,
  shouldSettleHand,
  validateAction,
  validateBlinds,
  validateWinnerCoverage,
} from "../../../packages/rules-engine/src/index.js";
import { BOT_NAMES, MAX_BOTS_PER_ROOM, chooseBotMove } from "./bots.js";
import { ChatRateLimiter, ReportLog, filterText, isDisplayNameAllowed } from "./moderation.js";
import { ApnsClient, loadApnsConfigFromEnv } from "./push.js";
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

// Practice-bot timers, push tokens and moderation helpers (all server-side only: never
// part of the broadcast room state, so other players cannot see device tokens).
const botTimers = new Map<string, ReturnType<typeof setTimeout>>();
const pushTokens = new Map<string, string>();
const playerAppActive = new Map<string, boolean>();
const lastPushKey = new Map<string, string>();
const chatLimiter = new ChatRateLimiter();
const reportLog = new ReportLog();
const apnsConfig = loadApnsConfigFromEnv();
const apns = apnsConfig ? new ApnsClient(apnsConfig) : null;
if (!apns) {
  console.log("[push] APNs not configured (set APNS_KEY_ID, APNS_TEAM_ID, APNS_BUNDLE_ID, APNS_KEY to enable push)");
}

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
  pushTokens?: Array<[string, string]>;
}

const DEFAULT_BLIND_LEVEL_DURATION_SECONDS = 15 * 60;
const PAYOUT_ANIMATION_DURATION_MS = 1800;

function payoutAnimationDurationMs(room: RoomState): number {
  const recipientCount = Math.max(1, room.payouts.length);
  return PAYOUT_ANIMATION_DURATION_MS + (recipientCount - 1) * 260;
}

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
  room.awaitingDeal = Boolean(room.awaitingDeal);
  room.mutedPlayerIds = Array.isArray(room.mutedPlayerIds) ? room.mutedPlayerIds : [];
  // Older persisted snapshots may still have the retired "pending_ack" state
  // from the removed payout-acknowledgment step; treat anything but a known
  // value as idle (payouts are applied to stacks synchronously now, so there's
  // nothing left pending to resume).
  room.payoutState = room.payoutState === "animating" ? "animating" : "idle";
  room.payoutAnimationEndsAt = Number.isFinite(room.payoutAnimationEndsAt) ? Number(room.payoutAnimationEndsAt) : null;
  // Older persisted rooms predate startingStack; fall back to the host's
  // current stack as the closest available guess so joinRoom has something
  // sane to hand new players.
  if (!Number.isFinite(room.startingStack) || room.startingStack <= 0) {
    room.startingStack = room.players.find((p) => p.id === room.hostPlayerId)?.stack || 1000;
  }
  room.players.forEach((player) => {
    if (!Number.isFinite(player.totalContribution)) {
      player.totalContribution = Math.max(0, player.commitment ?? 0);
    }
  });

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
    pushTokens: [...pushTokens.entries()],
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

  pushTokens.clear();
  (snapshot.pushTokens ?? []).forEach(([playerId, token]) => {
    if (playerIdToRoomId.has(playerId)) {
      pushTokens.set(playerId, token);
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
    roomById.forEach((room) => scheduleBotTurn(room));
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
  clearBotTimer(roomId);
  lastPushKey.delete(roomId);
  room.players.forEach((player) => {
    pushTokens.delete(player.id);
    playerAppActive.delete(player.id);
    chatLimiter.forget(player.id);
  });

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

function tickPayoutAnimations(): void {
  const now = Date.now();

  for (const room of roomById.values()) {
    if (room.payoutState !== "animating" || !room.payoutAnimationEndsAt || now < room.payoutAnimationEndsAt) {
      continue;
    }

    // Stacks were already credited in settleHand; this just clears the purely
    // cosmetic "animating" window once it's played out client-side.
    room.payoutState = "idle";
    room.payoutAnimationEndsAt = null;
    emitRoomState(room.id);
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
  scheduleBotTurn(room);
  notifyAwaitedPlayers(room);
}


// ---------------------------------------------------------------------------
// Practice bots
// ---------------------------------------------------------------------------
function clearBotTimer(roomId: string): void {
  const timer = botTimers.get(roomId);
  if (timer) {
    clearTimeout(timer);
    botTimers.delete(roomId);
  }
}

function botDelayMs(): number {
  const base = Number(process.env.BOT_DELAY_MS ?? 900);
  return base <= 0 ? 0 : base + Math.floor(Math.random() * base * 0.8);
}

// If it is a bot's turn, make it act after a short, human-looking pause.
function scheduleBotTurn(room: RoomState): void {
  const actingId = room.actingPlayerId;
  const actor = actingId ? room.players.find((p) => p.id === actingId) : undefined;
  if (!actor?.isBot || room.status !== "in_hand" || room.awaitingDeal || botTimers.has(room.id)) {
    return;
  }

  const timer = setTimeout(() => {
    botTimers.delete(room.id);
    const current = roomById.get(room.id);
    if (!current || current.status !== "in_hand" || current.awaitingDeal || current.actingPlayerId !== actor.id) {
      return;
    }
    const move = chooseBotMove(current, actor.id);
    const result = applyPlayerAction(current, actor.id, move.action, move.amount);
    if (!result.ok) {
      console.log(`[bots] ${actor.displayName} could not ${move.action}: ${result.message}`);
    }
  }, botDelayMs());
  botTimers.set(room.id, timer);
}

function addBots(room: RoomState, count: number): Player[] {
  const existingBots = room.players.filter((p) => p.isBot).length;
  const toAdd = Math.max(0, Math.min(Math.floor(count), MAX_BOTS_PER_ROOM - existingBots));
  const added: Player[] = [];
  for (let i = 0; i < toAdd; i += 1) {
    const taken = new Set(room.players.map((p) => p.displayName));
    const name = BOT_NAMES.find((candidate) => !taken.has(candidate)) ?? `Bot ${existingBots + i + 1}`;
    const bot: Player = {
      id: createId(),
      displayName: name,
      role: "player",
      seat: nextSeat(room),
      stack: room.startingStack,
      connected: true,
      joinedAt: Date.now(),
      inHand: false,
      commitment: 0,
      totalContribution: 0,
      isBot: true,
    };
    room.players.push(bot);
    playerIdToRoomId.set(bot.id, room.id);
    added.push(bot);
  }
  return added;
}

// ---------------------------------------------------------------------------
// Push notifications ("it's your turn" while the app is in the background)
// ---------------------------------------------------------------------------
function isAway(player: Player): boolean {
  return !player.connected || playerAppActive.get(player.id) === false;
}

function sendPushTo(player: Player, room: RoomState, title: string, body: string, key: string): void {
  const token = pushTokens.get(player.id);
  if (!apns || !token || player.isBot || lastPushKey.get(player.id) === key) {
    return;
  }
  lastPushKey.set(player.id, key);
  void apns.send(token, { title, body, roomCode: room.code }).then((result) => {
    if (!result.ok) {
      console.log(`[push] ${player.displayName}: ${result.status} ${result.reason ?? ""}`);
      // Token no longer valid on Apple's side: forget it.
      if (result.status === 410 || result.reason === "BadDeviceToken" || result.reason === "Unregistered") {
        pushTokens.delete(player.id);
        scheduleStatePersistence();
      }
    }
  });
}

function notifyAwaitedPlayers(room: RoomState): void {
  if (!apns || room.status !== "in_hand") {
    return;
  }

  if (room.awaitingDeal) {
    const host = room.players.find((p) => p.id === room.hostPlayerId);
    if (host && isAway(host)) {
      sendPushTo(host, room, room.name, `Deal the ${room.street} — the table is waiting.`, `${room.id}:deal:${room.street}:${room.actionLog.length}`);
    }
    return;
  }

  const actor = room.actingPlayerId ? room.players.find((p) => p.id === room.actingPlayerId) : undefined;
  if (actor && isAway(actor)) {
    sendPushTo(actor, room, room.name, "It's your turn.", `${room.id}:turn:${actor.id}:${room.street}:${room.actionLog.length}`);
  }
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

function currentActedPlayerIds(room: RoomState): Set<string> {
  const actionState = roomStreetActionState.get(room.id);
  if (!actionState || actionState.street !== room.street) {
    return new Set<string>();
  }

  return actionState.actedPlayerIds;
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

function settleHand(room: RoomState, winnerIds: string[], potWinnerIds?: string[][]): void {
  room.street = "showdown";
  room.pots = calculatePots(room);

  room.payouts = calculatePayouts(room, winnerIds, potWinnerIds);

  // The host declaring winners is the only decision required — chips are paid
  // out immediately (no separate player "acknowledge" gate). "animating" is
  // purely a cosmetic window for the client-side chip animation.
  for (const payout of room.payouts) {
    const winner = room.players.find((p) => p.id === payout.playerId);
    if (winner) {
      winner.stack += payout.amount;
    }
  }

  room.payoutState = room.payouts.length > 0 ? "animating" : "idle";
  room.payoutAnimationEndsAt = room.payouts.length > 0 ? Date.now() + payoutAnimationDurationMs(room) : null;

  for (const player of room.players) {
    player.inHand = false;
    player.commitment = 0;
    player.totalContribution = 0;
  }

  // Players removed mid-hand were only kept so their chips stayed in the pot.
  room.players = room.players.filter((player) => !player.pendingRemoval);

  room.status = "waiting";
  room.street = "resolved";
  room.actingPlayerId = null;
  room.awaitingDeal = false;
  room.currentBet = 0;
}

function moveToShowdown(room: RoomState): void {
  room.status = "paused";
  room.street = "showdown";
  room.actingPlayerId = null;
  room.awaitingDeal = false;
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

  // The physical dealer puts the new community cards down first. Nobody is asked to
  // act until the host confirms that (see confirm_deal), even if nobody can bet
  // because everyone left is all-in — the board still has to be dealt out.
  room.awaitingDeal = true;
  room.actingPlayerId = null;
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
    totalContribution: 0,
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
    awaitingDeal: false,
    pots: [],
    currentBet: 0,
    blinds: {
      smallBlind: input.smallBlind,
      bigBlind: input.bigBlind,
    },
    startingStack: input.startingStack,
    players: [host],
    actionLog: [],
    payouts: [],
    payoutState: "idle",
    payoutAnimationEndsAt: null,
    messages: [],
    blindVote: null,
    blindSchedule: createDefaultBlindSchedule(),
    mutedPlayerIds: [],
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

/**
 * A player should only ever have one live socket. Without this, a stale
 * connection re-joining/re-attaching a player (e.g. a second browser tab, or
 * the client's own auto-rejoin-on-reconnect firing from more than one place)
 * would leave two sockets mapped to the same playerId — and the moment
 * either one later disconnects, markDisconnected would flip the player to
 * "offline" even though their other, genuinely live socket is still
 * connected and playing fine. Evicting older sockets up front — removing
 * their mapping before disconnecting them — means that disconnect becomes a
 * no-op for connection status instead of clobbering the real one.
 */
function evictOtherSocketsForPlayer(playerId: string, keepSocketId: string): void {
  const staleSocketIds: string[] = [];
  socketToPlayerId.forEach((mappedPlayerId, socketId) => {
    if (mappedPlayerId === playerId && socketId !== keepSocketId) {
      staleSocketIds.push(socketId);
    }
  });

  for (const staleSocketId of staleSocketIds) {
    socketToPlayerId.delete(staleSocketId);
    const staleSocket = io.sockets.sockets.get(staleSocketId);
    staleSocket?.disconnect(true);
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
  if (!player || player.isBot) {
    return;
  }

  player.connected = false;
  if (room.actingPlayerId === playerId) {
    room.actingPlayerId = findNextActingPlayer(room, playerId, currentActedPlayerIds(room));
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
        evictOtherSocketsForPlayer(existingPlayer.id, socketId);
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
    stack: role === "spectator" ? 0 : room.startingStack,
    connected: true,
    joinedAt: Date.now(),
    inHand: false,
    commitment: 0,
    totalContribution: 0,
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

  evictOtherSocketsForPlayer(player.id, socketId);
  player.connected = true;
  socketToPlayerId.set(socketId, player.id);
  return { room, player };
}

// Validates and applies one betting action, advances the hand, and broadcasts. Used by
// real players (submit_action) and by practice bots.
function applyPlayerAction(
  room: RoomState,
  actorPlayerId: string,
  action: ActionEvent["action"],
  amount?: number
): { ok: boolean; message?: string } {
  const validation = validateAction(room, actorPlayerId, action, amount);
  if (!validation.ok) {
    return { ok: false, message: validation.message ?? "Invalid action." };
  }

  const currentPlayer = room.players.find((p) => p.id === actorPlayerId);
  if (!currentPlayer) {
    return { ok: false, message: "Player not found." };
  }

  appendAction(room, actorPlayerId, action, amount);
  markPlayerActedThisStreet(room, actorPlayerId);

  if (action === "fold") {
    currentPlayer.inHand = false;
  } else if (action === "call") {
    const callAmount = room.currentBet - currentPlayer.commitment;
    currentPlayer.stack -= callAmount;
    currentPlayer.commitment = room.currentBet;
    currentPlayer.totalContribution += callAmount;
  } else if (action === "raise" && typeof amount === "number") {
    const addAmount = amount - currentPlayer.commitment;
    currentPlayer.stack -= addAmount;
    currentPlayer.commitment = amount;
    currentPlayer.totalContribution += addAmount;
    room.currentBet = amount;
  } else if (action === "all_in") {
    const allInAmount = currentPlayer.stack;
    currentPlayer.commitment += allInAmount;
    currentPlayer.totalContribution += allInAmount;
    currentPlayer.stack = 0;
    room.currentBet = Math.max(room.currentBet, currentPlayer.commitment);
  }

  room.pots = calculatePots(room);

  const playersInHand = room.players.filter((p) => p.inHand && p.role !== "spectator").sort((a, b) => a.seat - b.seat);
  if (playersInHand.length === 1) {
    settleHand(room, [playersInHand[0].id]);
  } else if (shouldSettleHand(room, currentActedPlayerIds(room))) {
    advanceStreetOrShowdown(room);
  } else {
    room.actingPlayerId = findNextActingPlayer(room, actorPlayerId, currentActedPlayerIds(room));
  }

  emitRoomState(room.id);
  return { ok: true };
}

io.on("connection", (socket) => {
  socket.on("event", (event) => {
    // Every event that acts as a player must come from that player's own socket.
    // (Player ids are visible to everyone in the room, so without this check anyone
    // could send host-only events such as remove_player or declare_winners.)
    const claimedPlayerId =
      "actorPlayerId" in event ? event.actorPlayerId : "playerId" in event ? event.playerId : undefined;
    if (claimedPlayerId !== undefined && socketToPlayerId.get(socket.id) !== claimedPlayerId) {
      socket.emit("event", { type: "error", message: "You are not signed in as that player. Rejoin the room." });
      return;
    }

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

      if (!isDisplayNameAllowed(payload.displayName)) {
        socket.emit("event", { type: "error", message: "Please choose a different display name." });
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
      if (!event.payload.sessionId && !isDisplayNameAllowed(event.payload.displayName ?? "")) {
        socket.emit("event", { type: "error", message: "Please choose a different display name." });
        return;
      }

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
      room.awaitingDeal = false;
      room.pots = [];
      room.payouts = [];
      room.payoutState = "idle";
      room.payoutAnimationEndsAt = null;
      room.currentBet = 0;
      resetStreetActionState(room);

      const players = room.players
        .filter((p) => p.role !== "spectator" && p.stack > 0)
        .sort((a, b) => a.seat - b.seat);

      for (const player of room.players) {
        player.inHand = player.role !== "spectator" && player.stack > 0;
        player.commitment = 0;
        player.totalContribution = 0;
      }

      if (players.length >= 2) {
        // Rotate dealer button to next active player
        // First occupied seat clockwise of the old button. Using the seat number (not
        // the old dealer's index) keeps rotation correct when that player was removed.
        const firstSeatAfterDealer = players.findIndex((p) => p.seat > room.dealerSeat);
        const nextDealerIndex = firstSeatAfterDealer >= 0 ? firstSeatAfterDealer : 0;
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

        // A player who can't cover a blind posts what they have and is all-in for it.
        const sbAmount = Math.min(sb.stack, room.blinds.smallBlind);
        const bbAmount = Math.min(bb.stack, room.blinds.bigBlind);
        sb.commitment = sbAmount;
        sb.totalContribution = sbAmount;
        sb.stack -= sbAmount;
        bb.commitment = bbAmount;
        bb.totalContribution = bbAmount;
        bb.stack -= bbAmount;
        room.currentBet = room.blinds.bigBlind;
        room.pots.push({
          amount: sbAmount + bbAmount,
          contributors: [sb.id, bb.id],
        });

        // First to act: after big blind (heads-up: SB acts first preflop), skipping
        // anyone already all-in from posting a blind.
        const firstToActIndex = isHeadsUp ? sbIndex : (bbIndex + 1) % players.length;
        let actingIndex = -1;
        for (let offset = 0; offset < players.length; offset += 1) {
          const candidate = players[(firstToActIndex + offset) % players.length];
          if (candidate.stack > 0) {
            actingIndex = (firstToActIndex + offset) % players.length;
            break;
          }
        }

        if (actingIndex >= 0 && countActionCapablePlayers(room) > 1) {
          room.actingPlayerId = players[actingIndex].id;
        } else {
          // Nobody (or only one player) can bet: the blinds were everyone's whole stack.
          advanceStreetOrShowdown(room);
        }
      }

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

    if (event.type === "confirm_deal") {
      const room = roomById.get(event.roomId);
      if (!room) {
        socket.emit("event", { type: "error", message: "Room not found." });
        return;
      }

      if (room.hostPlayerId !== event.actorPlayerId) {
        socket.emit("event", { type: "error", message: "Only the host can confirm the cards are dealt." });
        return;
      }

      if (room.status !== "in_hand" || !room.awaitingDeal) {
        socket.emit("event", { type: "error", message: "There are no cards waiting to be dealt." });
        return;
      }

      room.awaitingDeal = false;
      if (countActionCapablePlayers(room) > 1) {
        room.actingPlayerId = findFirstPostflopActingPlayer(room);
      }
      if (room.actingPlayerId === null) {
        // Nobody can bet (everyone left is all-in): on to the next card, or the showdown.
        advanceStreetOrShowdown(room);
      }

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
      if (!newHost || newHost.pendingRemoval) {
        socket.emit("event", { type: "error", message: "Player not found." });
        return;
      }

      if (newHost.isBot) {
        socket.emit("event", { type: "error", message: "A practice player cannot be the host." });
        return;
      }

      room.hostPlayerId = event.newHostPlayerId;
      emitRoomState(room.id);
      return;
    }

    if (event.type === "remove_player") {
      const room = roomById.get(event.roomId);
      if (!room) {
        socket.emit("event", { type: "error", message: "Room not found." });
        return;
      }

      const permission = canRemovePlayer(room, event.actorPlayerId, event.targetPlayerId);
      if (!permission.ok) {
        socket.emit("event", { type: "error", message: permission.message ?? "Cannot remove player." });
        return;
      }

      const target = room.players.find((p) => p.id === event.targetPlayerId)!;
      const handInProgress = room.status === "in_hand" || room.status === "paused";

      // Chips the player already has in the pot stay there as dead money; only
      // their remaining stack leaves the table. Keep them in the roster, hidden,
      // until the hand settles so the pot math still sees their contribution.
      if (handInProgress && target.totalContribution > 0) {
        target.pendingRemoval = true;
        target.stack = 0;
      }

      if (handInProgress) {
        if (target.inHand) {
          appendAction(room, target.id, "fold");
        }
        target.inHand = false;

        if (room.status === "in_hand") {
          markPlayerActedThisStreet(room, target.id);
          // Their bet is no longer a live bet that others have to call.
          room.currentBet = room.players
            .filter((p) => p.inHand && p.role !== "spectator")
            .reduce((max, p) => Math.max(max, p.commitment), 0);
        }

        const playersInHand = room.players.filter((p) => p.inHand && p.role !== "spectator").sort((a, b) => a.seat - b.seat);
        if (playersInHand.length === 1) {
          settleHand(room, [playersInHand[0].id]);
        } else if (room.status === "in_hand" && !room.awaitingDeal) {
          if (shouldSettleHand(room, currentActedPlayerIds(room))) {
            advanceStreetOrShowdown(room);
          } else if (room.actingPlayerId === target.id) {
            room.actingPlayerId = findNextActingPlayer(room, target.id, currentActedPlayerIds(room));
          }
        }

        if (room.status === "in_hand" || room.status === "paused") {
          room.pots = calculatePots(room);
        }
      }

      if (!target.pendingRemoval) {
        room.players = room.players.filter((p) => p.id !== target.id);
      }
      playerIdToRoomId.delete(target.id);

      const targetSocketIds: string[] = [];
      socketToPlayerId.forEach((mappedPlayerId, socketId) => {
        if (mappedPlayerId === target.id) {
          targetSocketIds.push(socketId);
          socketToPlayerId.delete(socketId);
        }
      });
      sessionToPlayerId.forEach((mappedPlayerId, sessionId) => {
        if (mappedPlayerId === target.id) {
          sessionToPlayerId.delete(sessionId);
        }
      });

      for (const targetSocketId of targetSocketIds) {
        const targetSocket = io.sockets.sockets.get(targetSocketId);
        if (targetSocket) {
          targetSocket.emit("event", { type: "error", message: "You have been removed from the room by the host." });
          targetSocket.leave(room.id);
        }
      }

      emitRoomState(room.id);
      return;
    }

    if (event.type === "reorder_seats") {
      const room = roomById.get(event.roomId);
      if (!room) {
        socket.emit("event", { type: "error", message: "Room not found." });
        return;
      }

      const permission = canReorderSeats(room, event.actorPlayerId, event.orderedPlayerIds);
      if (!permission.ok) {
        socket.emit("event", { type: "error", message: permission.message ?? "Cannot reorder seats." });
        return;
      }

      // Preserve which *player* currently holds the dealer/small-blind button
      // across the reorder, since those fields are seat numbers, not player ids.
      const dealerPlayerId = room.players.find((p) => p.seat === room.dealerSeat)?.id;
      const smallBlindPlayerId = room.players.find((p) => p.seat === room.smallBlindSeat)?.id;

      event.orderedPlayerIds.forEach((playerId, index) => {
        const player = room.players.find((p) => p.id === playerId);
        if (player) {
          player.seat = index + 1;
        }
      });

      const newDealerSeat = room.players.find((p) => p.id === dealerPlayerId)?.seat;
      if (typeof newDealerSeat === "number") {
        room.dealerSeat = newDealerSeat;
      }
      const newSmallBlindSeat = room.players.find((p) => p.id === smallBlindPlayerId)?.seat;
      if (typeof newSmallBlindSeat === "number") {
        room.smallBlindSeat = newSmallBlindSeat;
      }

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

      if (room.mutedPlayerIds.includes(player.id)) {
        socket.emit("event", { type: "error", message: "The host has muted you in this room." });
        return;
      }

      const trimmed = event.text.trim().slice(0, 500); // Max 500 chars
      if (!trimmed) {
        return;
      }

      if (!chatLimiter.allow(player.id)) {
        socket.emit("event", { type: "error", message: "You're sending messages too fast. Slow down a little." });
        return;
      }

      const messageText = filterText(trimmed).text;

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

      const result = applyPlayerAction(room, event.actorPlayerId, event.action, event.amount);
      if (!result.ok) {
        socket.emit("event", { type: "error", message: result.message ?? "Invalid action." });
      }
      return;
    }

    if (event.type === "add_bots") {
      const room = roomById.get(event.roomId);
      if (!room) {
        socket.emit("event", { type: "error", message: "Room not found." });
        return;
      }

      if (room.hostPlayerId !== event.actorPlayerId) {
        socket.emit("event", { type: "error", message: "Only the host can add practice players." });
        return;
      }

      if (room.status !== "waiting") {
        socket.emit("event", { type: "error", message: "Add practice players between hands." });
        return;
      }

      const added = addBots(room, Number(event.count) || 0);
      if (added.length === 0) {
        socket.emit("event", { type: "error", message: `A room can have at most ${MAX_BOTS_PER_ROOM} practice players.` });
        return;
      }

      emitRoomState(room.id);
      return;
    }

    if (event.type === "report_message") {
      const room = roomById.get(event.roomId);
      if (!room) {
        socket.emit("event", { type: "error", message: "Room not found." });
        return;
      }

      const message = room.messages.find((m) => m.id === event.messageId);
      const reporter = room.players.find((p) => p.id === event.actorPlayerId);
      if (!message || !reporter) {
        socket.emit("event", { type: "error", message: "That message is no longer available." });
        return;
      }

      reportLog.add({
        at: Date.now(),
        roomCode: room.code,
        reporterId: reporter.id,
        reporterName: reporter.displayName,
        targetPlayerId: message.playerId,
        targetName: message.playerName,
        messageId: message.id,
        text: message.text,
        reason: (event.reason ?? "").slice(0, 200),
      });
      socket.emit("event", { type: "notice", message: "Thanks, your report was sent." });
      return;
    }

    if (event.type === "mute_player") {
      const room = roomById.get(event.roomId);
      if (!room) {
        socket.emit("event", { type: "error", message: "Room not found." });
        return;
      }

      if (room.hostPlayerId !== event.actorPlayerId) {
        socket.emit("event", { type: "error", message: "Only the host can mute players." });
        return;
      }

      const target = room.players.find((p) => p.id === event.targetPlayerId);
      if (!target || target.id === room.hostPlayerId) {
        socket.emit("event", { type: "error", message: "Player not found." });
        return;
      }

      const muted = new Set(room.mutedPlayerIds);
      if (event.muted) muted.add(target.id);
      else muted.delete(target.id);
      room.mutedPlayerIds = [...muted];
      emitRoomState(room.id);
      return;
    }

    if (event.type === "register_push_token") {
      const token = String(event.token ?? "").trim();
      if (!/^[0-9a-fA-F]{32,200}$/.test(token)) {
        socket.emit("event", { type: "error", message: "Invalid push token." });
        return;
      }
      if (roomById.get(event.roomId)?.players.some((p) => p.id === event.actorPlayerId)) {
        pushTokens.set(event.actorPlayerId, token);
        scheduleStatePersistence();
      }
      return;
    }

    if (event.type === "unregister_push_token") {
      pushTokens.delete(event.actorPlayerId);
      scheduleStatePersistence();
      return;
    }

    if (event.type === "app_state") {
      const room = roomById.get(event.roomId);
      if (!room || !room.players.some((p) => p.id === event.actorPlayerId)) {
        return;
      }
      playerAppActive.set(event.actorPlayerId, Boolean(event.active));
      // Backgrounded while it is their turn: nudge them now.
      notifyAwaitedPlayers(room);
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
      const roomPots = calculatePots(room);
      const requestedPotWinnerIds = Array.isArray(event.potWinnerIds) ? event.potWinnerIds : [];
      const fallbackWinnerIds = [...new Set(event.winnerIds)].filter((id) => eligibleWinnerIds.has(id));
      const normalizedPotWinnerIds = roomPots.map((pot, index) => {
        const eligibleContributors = pot.contributors.filter((id) => eligibleWinnerIds.has(id));
        if (eligibleContributors.length <= 1) {
          return eligibleContributors;
        }

        const selected = Array.isArray(requestedPotWinnerIds[index]) ? requestedPotWinnerIds[index] : [];
        const explicit = [...new Set(selected)].filter((id) => eligibleContributors.includes(id));
        if (explicit.length > 0) {
          return explicit;
        }

        // No explicit selection for this pot: fall back to the host's overall winner
        // pick, not the merged winnerIds list (which may include players auto-assigned
        // to other pots as the sole contributor there).
        return fallbackWinnerIds.filter((id) => eligibleContributors.includes(id));
      });

      const winnerIds = [...new Set([...fallbackWinnerIds, ...normalizedPotWinnerIds.flat()])];
      if (winnerIds.length === 0) {
        socket.emit("event", { type: "error", message: "Select at least one eligible winner." });
        return;
      }

      const winnerCoverage = validateWinnerCoverage(room, winnerIds, normalizedPotWinnerIds);
      if (!winnerCoverage.ok) {
        socket.emit("event", { type: "error", message: winnerCoverage.message ?? "Winner selection does not cover all pots." });
        return;
      }

      settleHand(room, winnerIds, normalizedPotWinnerIds);
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
setInterval(tickPayoutAnimations, 150);

async function startServer(): Promise<void> {
  await restoreStateFromDisk();
  httpServer.listen(port, () => {
    console.log(`No-Chip Poker server listening on port ${port}`);
  });
}

void startServer();

