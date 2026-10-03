// Practice-table players. They do not play poker (there are no cards in this app);
// they exist so one person can walk through a whole hand — betting, the host's
// deal button, showdown, payouts — on their own, and so App Review can try the app.
import { validateAction } from "../../../packages/rules-engine/src/index.js";
import type { ActionKind, RoomState } from "../../../packages/shared-types/src/index.js";

export interface BotMove {
  action: ActionKind;
  amount?: number;
}

export const BOT_NAMES = ["Ace", "Bluff", "Chip", "Dealer Dan", "Ember", "Flush", "Gus", "Hawk"];
export const MAX_BOTS_PER_ROOM = 5;

export function chooseBotMove(room: RoomState, botId: string, rand: () => number = Math.random): BotMove {
  const bot = room.players.find((p) => p.id === botId);
  if (!bot) {
    return { action: "fold" };
  }

  const need = Math.max(0, room.currentBet - bot.commitment);
  const bigBlind = room.blinds.bigBlind;
  const roll = rand();
  const wantsRaise = roll < (need > 0 ? 0.1 : 0.15);
  const raiseTo = Math.max(room.currentBet, 0) + bigBlind * (1 + Math.floor(rand() * 3));
  const canAffordRaise = bot.commitment + bot.stack > raiseTo;

  const candidates: BotMove[] = [];
  if (need > 0) {
    if (bot.stack <= need) {
      candidates.push(roll < 0.6 ? { action: "all_in" } : { action: "fold" });
    } else if (roll > 0.88 && need > bot.stack * 0.3) {
      candidates.push({ action: "fold" });
    } else if (wantsRaise && canAffordRaise) {
      candidates.push({ action: "raise", amount: raiseTo });
    }
    candidates.push({ action: "call" });
  } else {
    if (wantsRaise && canAffordRaise) {
      candidates.push({ action: "raise", amount: raiseTo });
    }
    candidates.push({ action: "check" });
  }
  candidates.push({ action: "check" }, { action: "call" }, { action: "all_in" }, { action: "fold" });

  for (const move of candidates) {
    if (validateAction(room, botId, move.action, move.amount).ok) {
      return move;
    }
  }
  return { action: "fold" };
}
