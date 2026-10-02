import type { ActionKind, Payout, Player, Pot, RoomState } from "../../shared-types/src/index.js";

function playerContribution(player: RoomState["players"][number]): number {
  if (Number.isFinite(player.totalContribution)) {
    return Math.max(0, player.totalContribution);
  }

  return Math.max(0, player.commitment);
}

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

  if (room.payoutState === "animating") {
    return { ok: false, message: "Payout animation is still in progress." };
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
  const contributors = room.players.filter((p) => p.role !== "spectator" && playerContribution(p) > 0);

  if (contributors.length === 0) {
    return pots;
  }

  // Side-pot boundaries only come from players still contesting the hand (they're
  // the only ones whose stack can actually cap the action). A folded player's
  // contribution is dead money that fills up existing tiers — it must never create
  // a tier of its own, or every fold produces a spurious "side pot" with the exact
  // same eligible players as the main pot.
  const liveContributors = contributors.filter((p) => p.inHand);
  const tierSource = liveContributors.length > 0 ? liveContributors : contributors;
  const tierLevels = [...new Set(tierSource.map((p) => playerContribution(p)))].sort((a, b) => a - b);

  let previousLevel = 0;
  for (const level of tierLevels) {
    const layerContributors = contributors.filter((p) => playerContribution(p) > previousLevel);
    const amount = layerContributors.reduce(
      (sum, p) => sum + (Math.min(playerContribution(p), level) - previousLevel),
      0
    );

    if (amount > 0) {
      pots.push({
        amount,
        contributors: contributors.filter((p) => p.inHand && playerContribution(p) >= level).map((p) => p.id),
      });
    }

    previousLevel = level;
  }

  // Normal folds never put in more than the largest live stake, but a player the
  // host removes mid-hand can (they may have out-bet everyone still in). That
  // excess is dead money: it goes into the top pot instead of vanishing.
  const excess = contributors.reduce((sum, p) => sum + Math.max(0, playerContribution(p) - previousLevel), 0);
  if (excess > 0 && pots.length > 0) {
    pots[pots.length - 1].amount += excess;
  }

  return pots;
}

export function determineWinners(room: RoomState): string[] {
  const playersInHand = room.players.filter((p) => p.inHand && p.role !== "spectator");
  return playersInHand.map((p) => p.id);
}

export function calculatePayouts(room: RoomState, winnerIds?: string[], potWinnerIds?: string[][]): Payout[] {
  const payouts: Payout[] = [];
  const winners = winnerIds && winnerIds.length > 0 ? winnerIds : determineWinners(room);

  if (winners.length === 0) {
    return payouts;
  }

  const pots = calculatePots(room);
  for (let i = 0; i < pots.length; i += 1) {
    const pot = pots[i];
    const explicitPotWinners = Array.isArray(potWinnerIds?.[i])
      ? [...new Set(potWinnerIds[i])].filter((winnerId) => pot.contributors.includes(winnerId))
      : [];
    const potWinners = explicitPotWinners.length > 0
      ? explicitPotWinners
      : winners.filter((w) => pot.contributors.includes(w));
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

export function validateWinnerCoverage(room: RoomState, winnerIds: string[], potWinnerIds?: string[][]): ValidationResult {
  const uniqueWinnerIds = [...new Set(winnerIds)];
  if (uniqueWinnerIds.length === 0) {
    return { ok: false, message: "Select at least one eligible winner." };
  }

  const pots = calculatePots(room);
  for (let i = 0; i < pots.length; i += 1) {
    const pot = pots[i];
    const explicitPotWinners = Array.isArray(potWinnerIds?.[i])
      ? [...new Set(potWinnerIds[i])].filter((winnerId) => pot.contributors.includes(winnerId))
      : [];
    const covered = explicitPotWinners.length > 0
      ? true
      : uniqueWinnerIds.some((winnerId) => pot.contributors.includes(winnerId));
    if (!covered) {
      const label =
        pots.length === 1 ? "pot" : i === 0 ? "main pot" : `side pot ${i}`;
      return {
        ok: false,
        message: `Selected winners do not cover ${label}. Include at least one eligible winner per pot.`,
      };
    }
  }

  return { ok: true };
}

export function countActionCapablePlayers(room: RoomState): number {
  return room.players.filter((p) => p.inHand && p.role !== "spectator" && p.stack > 0).length;
}

/**
 * Who acts next, given the set of player ids who have already acted on the
 * current street. Strictly seat-order based: always the next occupied seat
 * (wrapping around the table) among the players who still need to act, never
 * an arbitrary "lowest seat in the needing set" pick — that fallback is what
 * caused turns to visibly jump out of order / feel like they were skipped.
 *
 * A player still needs to act if their commitment hasn't caught up to the
 * table's highest commitment yet, OR — this is the big blind's preflop
 * option — if they simply haven't acted this street at all yet, even though
 * their posted blind already happens to match the highest commitment. Without
 * that second clause the big blind never gets a turn when everyone just
 * calls: their commitment matches the moment the last caller catches up, so
 * the street would end before the blind ever got to check or raise.
 */
export function findNextActingPlayer(
  room: RoomState,
  currentPlayerId: string,
  actedPlayerIds: ReadonlySet<string>
): string | null {
  const playersInHand = room.players
    .filter((p) => p.inHand && p.role !== "spectator")
    .sort((a, b) => a.seat - b.seat);

  if (playersInHand.length === 0) {
    return null;
  }

  const highestCommitment = playersInHand.reduce((max, p) => Math.max(max, p.commitment), 0);
  const candidates = playersInHand.filter(
    (p) => p.stack > 0 && (p.commitment < highestCommitment || !actedPlayerIds.has(p.id))
  );

  if (candidates.length === 0) {
    return null;
  }

  const currentSeat = room.players.find((p) => p.id === currentPlayerId)?.seat;
  if (typeof currentSeat !== "number") {
    return candidates[0].id;
  }

  const nextBySeat = candidates.find((p) => p.seat > currentSeat);
  return (nextBySeat ?? candidates[0]).id;
}

export function findFirstPostflopActingPlayer(room: RoomState): string | null {
  const playersInHand = room.players
    .filter((p) => p.inHand && p.role !== "spectator" && p.stack > 0)
    .sort((a, b) => a.seat - b.seat);

  if (playersInHand.length === 0) {
    return null;
  }

  const firstLeftOfDealer = playersInHand.find((p) => p.seat > room.dealerSeat) ?? playersInHand[0];
  return firstLeftOfDealer?.id ?? null;
}

/**
 * Mirrors findNextActingPlayer's notion of "still needs to act": a street is
 * only done once every player with chips has both matched the highest
 * commitment AND actually acted this street — the latter clause is what
 * gives the big blind their preflop option instead of the street ending the
 * instant the table's calls catch up to their posted blind.
 */
export function shouldSettleHand(room: RoomState, actedPlayerIds: ReadonlySet<string>): boolean {
  const playersInHand = room.players.filter((p) => p.inHand && p.role !== "spectator");
  if (playersInHand.length <= 1) {
    return true;
  }

  const playersWithChips = playersInHand.filter((p) => p.stack > 0);
  if (playersWithChips.length === 0) {
    return true;
  }

  const highestCommitment = playersInHand.reduce((max, p) => Math.max(max, p.commitment), 0);
  return playersWithChips.every((p) => p.commitment === highestCommitment && actedPlayerIds.has(p.id));
}

export function canRemovePlayer(room: RoomState, actorPlayerId: string, targetPlayerId: string): ValidationResult {
  if (room.hostPlayerId !== actorPlayerId) {
    return { ok: false, message: "Only the host can remove a player." };
  }

  if (targetPlayerId === actorPlayerId) {
    return { ok: false, message: "The host cannot remove themselves. Transfer host first." };
  }

  const target = room.players.find((p) => p.id === targetPlayerId);
  if (!target) {
    return { ok: false, message: "Player not found." };
  }

  if (target.id === room.hostPlayerId) {
    return { ok: false, message: "Cannot remove the host." };
  }

  return { ok: true };
}

export function canReorderSeats(room: RoomState, actorPlayerId: string, orderedPlayerIds: string[]): ValidationResult {
  if (room.hostPlayerId !== actorPlayerId) {
    return { ok: false, message: "Only the host can set table order." };
  }

  // "Between hands" means fully resolved: not while betting is under way, and not
  // while a showdown is still waiting for the host to pick winners.
  if (room.status !== "waiting") {
    return { ok: false, message: "Table order can only be changed between hands." };
  }

  const seatedPlayerIds = room.players.filter((p) => p.role !== "spectator").map((p) => p.id);
  const uniqueRequested = new Set(orderedPlayerIds);
  if (
    uniqueRequested.size !== orderedPlayerIds.length ||
    uniqueRequested.size !== seatedPlayerIds.length ||
    !seatedPlayerIds.every((id) => uniqueRequested.has(id))
  ) {
    return { ok: false, message: "New table order must include every seated player exactly once." };
  }

  return { ok: true };
}
