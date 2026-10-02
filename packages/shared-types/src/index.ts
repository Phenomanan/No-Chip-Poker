export type Role = "host" | "player" | "spectator";

export type Street = "preflop" | "flop" | "turn" | "river" | "showdown" | "resolved";

export type RoomStatus = "waiting" | "in_hand" | "paused" | "ended";

export interface Player {
  id: string;
  displayName: string;
  role: Role;
  seat: number;
  stack: number;
  connected: boolean;
  joinedAt: number;
  inHand: boolean;
  commitment: number;
  totalContribution: number;
  // Set when the host removes a player mid-hand: their chips stay in the pot as
  // dead money until the hand settles, then the player is dropped. Clients should
  // not show these players.
  pendingRemoval?: boolean;
}

export interface Pot {
  amount: number;
  contributors: string[];
}

export interface Payout {
  playerId: string;
  amount: number;
}

export interface BlindSettings {
  smallBlind: number;
  bigBlind: number;
}

export interface BlindVoteState {
  proposedByPlayerId: string;
  multiplier: number;
  createdAt: number;
  resolvedAt?: number;
  status: "open" | "passed" | "failed";
  eligiblePlayerIds: string[];
  yesVotes: string[];
  noVotes: string[];
}

export interface BlindScheduleState {
  enabled: boolean;
  levelDurationSeconds: number;
  levelNumber: number;
  nextLevelAt: number | null;
}

export interface RoomState {
  id: string;
  code: string;
  name: string;
  status: RoomStatus;
  street: Street;
  hostPlayerId: string;
  dealerSeat: number;
  smallBlindSeat: number;
  actingPlayerId: string | null;
  // True right after the street advances: the host deals the new community cards and
  // confirms before anyone is asked to act.
  awaitingDeal: boolean;
  pots: Pot[];
  currentBet: number;
  blinds: BlindSettings;
  startingStack: number;
  players: Player[];
  actionLog: ActionEvent[];
  payouts: Payout[];
  payoutState: "idle" | "animating";
  payoutAnimationEndsAt: number | null;
  messages: ChatMessage[];
  blindVote: BlindVoteState | null;
  blindSchedule: BlindScheduleState;
  updatedAt: number;
}

export interface ChatMessage {
  id: string;
  playerId: string;
  playerName: string;
  text: string;
  at: number;
  clientMessageId?: string;
}

export type ActionKind = "fold" | "check" | "call" | "raise" | "all_in";

export interface ActionEvent {
  id: string;
  roomId: string;
  playerId: string;
  action: ActionKind;
  amount?: number;
  at: number;
}

export interface JoinRoomInput {
  roomCode: string;
  displayName: string;
  role?: Role;
  sessionId?: string;
}

export interface CreateRoomInput {
  name: string;
  displayName: string;
  smallBlind: number;
  bigBlind: number;
  startingStack: number;
}

export interface RejoinInput {
  roomCode: string;
  sessionId: string;
}

export type ServerEvent =
  | { type: "room_state"; room: RoomState }
  | { type: "room_created"; room: RoomState; sessionId: string; playerId: string }
  | { type: "joined_room"; room: RoomState; sessionId: string; playerId: string }
  | { type: "rejoined_room"; room: RoomState; playerId: string }
  | { type: "error"; message: string };

export type ClientEvent =
  | { type: "create_room"; payload: CreateRoomInput }
  | { type: "join_room"; payload: JoinRoomInput }
  | { type: "rejoin_room"; payload: RejoinInput }
  | { type: "start_hand"; roomId: string; actorPlayerId: string }
  | { type: "update_blinds"; roomId: string; actorPlayerId: string; blinds: BlindSettings }
  | { type: "request_double_blinds_vote"; roomId: string; actorPlayerId: string }
  | { type: "cast_double_blinds_vote"; roomId: string; actorPlayerId: string; approve: boolean }
  | { type: "configure_blind_schedule"; roomId: string; actorPlayerId: string; levelDurationSeconds: number }
  | { type: "toggle_blind_schedule"; roomId: string; actorPlayerId: string; enabled: boolean }
  | { type: "reset_blind_schedule"; roomId: string; actorPlayerId: string }
  | { type: "submit_action"; roomId: string; actorPlayerId: string; action: ActionKind; amount?: number }
  | { type: "confirm_deal"; roomId: string; actorPlayerId: string }
  | { type: "transfer_host"; roomId: string; actorPlayerId: string; newHostPlayerId: string }
  | { type: "remove_player"; roomId: string; actorPlayerId: string; targetPlayerId: string }
  | { type: "reorder_seats"; roomId: string; actorPlayerId: string; orderedPlayerIds: string[] }
  | { type: "send_message"; roomId: string; playerId: string; text: string; clientMessageId?: string }
  | {
      type: "declare_winners";
      roomId: string;
      actorPlayerId: string;
      winnerIds: string[];
      potWinnerIds?: string[][];
    };

export interface ClientToServerEvents {
  event: (event: ClientEvent) => void;
}

export interface ServerToClientEvents {
  event: (event: ServerEvent) => void;
}
