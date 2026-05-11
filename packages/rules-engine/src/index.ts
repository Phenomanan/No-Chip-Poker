import type { ActionKind, Payout, Pot, RoomState } from "../../shared-types/src/index.js";

export interface ValidationResult {
  ok: boolean;
  message?: string;
}

export function validateBlinds(smallBlind: number, bigBlind: number): ValidationResult {
  if (!Number.isFinite(smallBlind) || !Number.isFinite(bigBlind)) {
    return { ok: false, message: "Blinds must be finite numbers." };
  }

  if (smallBlind <= 0 || bigBlind <= 0) {
    return { ok: false, message: "Blinds must be positive." };
  }

  if (smallBlind >= bigBlind) {
    return { ok: false, message: "Small blind must be lower than big blind." };
  }

  return { ok: true };
}

export function canStartHand(room: RoomState, actorPlayerId: string): ValidationResult {
  if (room.hostPlayerId !== actorPlayerId) {
    return { ok: false, message: "Only the host can start a hand." };
  }

  const activePlayers = room.players.filter((p) => p.role !== "spectator" && p.stack > 0);
  if (activePlayers.length < 2) {
    return { ok: false, message: "At least two active players is required to start a hand." };
  }

  return { ok: true };
}

export function validateAction(room: RoomState, actorPlayerId: string, action: ActionKind, amount?: number): ValidationResult {
  if (room.status !== "in_hand") {
    return { ok: false, message: "No hand is currently in progress." };
  }

  if (room.actingPlayerId !== actorPlayerId) {
    return { ok: false, message: "It is not your turn." };
  }

  const actor = room.players.find((p) => p.id === actorPlayerId);
  if (!actor) {
    return { ok: false, message: "Player not found." };
  }

  if (!actor.inHand) {
    return { ok: false, message: "You have already folded." };
  }

  const playersInHand = room.players.filter((p) => p.inHand && p.role !== "spectator");
  if (playersInHand.length < 1) {
    return { ok: false, message: "No active players in hand." };
  }

  if (action === "fold") {
    return { ok: true };
  }

  if (action === "check") {
    if (actor.commitment < room.currentBet) {
      return { ok: false, message: "You must call, raise, or fold." };
    }
    return { ok: true };
  }

  if (action === "call") {
    const amountNeeded = room.currentBet - actor.commitment;
    if (amountNeeded <= 0) {
      return { ok: false, message: "No bet to call." };
    }
    if (actor.stack < amountNeeded) {
      return { ok: false, message: "Insufficient chips. Use all-in instead." };
    }
    return { ok: true };
  }

  if (action === "raise") {
    if (typeof amount !== "number" || amount < 0) {
      return { ok: false, message: "Invalid raise amount." };
    }
    const totalBet = amount;
    if (totalBet <= room.currentBet) {
      return { ok: false, message: "Raise must be greater than current bet." };
    }
    const chipsNeeded = totalBet - actor.commitment;
    if (chipsNeeded > actor.stack) {
      return { ok: false, message: "Raise exceeds your stack. Use all-in." };
    }
    return { ok: true };
  }

  if (action === "all_in") {
    if (actor.stack <= 0) {
      return { ok: false, message: "You have no chips." };
    }
    return { ok: true };
  }

  return { ok: false, message: "Invalid action." };
}

export function calculatePots(room: RoomState): Pot[] {
  const pots: Pot[] = [];
  const activePlayers = room.players.filter((p) => p.role !== "spectator" && (p.inHand || p.commitment > 0));

  if (activePlayers.length === 0) {
    return pots;
  }

  const sortedCommitments = [...new Set(activePlayers.map((p) => p.commitment))].sort((a, b) => a - b);

  let previousAmount = 0;
  for (const commitment of sortedCommitments) {
    const potAmount = (commitment - previousAmount) * activePlayers.filter((p) => p.commitment >= commitment).length;
    if (potAmount > 0) {
      pots.push({
        amount: potAmount,
        contributors: activePlayers.filter((p) => p.commitment >= commitment).map((p) => p.id),
      });
    }
    previousAmount = commitment;
  }

  return pots;
}

export function determineWinners(room: RoomState): string[] {
  const playersInHand = room.players.filter((p) => p.inHand && p.role !== "spectator");
  return playersInHand.map((p) => p.id);
}

export function calculatePayouts(room: RoomState, winnerIds?: string[]): Payout[] {
  const payouts: Payout[] = [];
  const winners = winnerIds && winnerIds.length > 0 ? winnerIds : determineWinners(room);

  if (winners.length === 0) {
    return payouts;
  }

  const pots = calculatePots(room);
  for (const pot of pots) {
    const potWinners = winners.filter((w) => pot.contributors.includes(w));
    if (potWinners.length > 0) {
      const chipsPerWinner = Math.floor(pot.amount / potWinners.length);
      const remainder = pot.amount % potWinners.length;

      for (let i = 0; i < potWinners.length; i++) {
        const winnerId = potWinners[i];
        const amount = chipsPerWinner + (i < remainder ? 1 : 0);
        const existing = payouts.find((p) => p.playerId === winnerId);
        if (existing) {
          existing.amount += amount;
        } else {
          payouts.push({ playerId: winnerId, amount });
        }
      }
    }
  }

  return payouts;
}
