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
  pots: Pot[];
  currentBet: number;
  blinds: BlindSettings;
  players: Player[];
  actionLog: ActionEvent[];
  payouts: Payout[];
  messages: ChatMessage[];
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
  | { type: "submit_action"; roomId: string; actorPlayerId: string; action: ActionKind; amount?: number }
  | { type: "transfer_host"; roomId: string; actorPlayerId: string; newHostPlayerId: string }
  | { type: "send_message"; roomId: string; playerId: string; text: string; clientMessageId?: string }
  | { type: "declare_winners"; roomId: string; actorPlayerId: string; winnerIds: string[] };

export interface ClientToServerEvents {
  event: (event: ClientEvent) => void;
}

export interface ServerToClientEvents {
  event: (event: ServerEvent) => void;
}
