// Light-weight safety tools for user-generated content (chat and display names):
// a word filter, a per-player chat rate limit, and a report log. App Store review
// requires a way to filter, report and block objectionable content.

const LEET: Record<string, string> = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", $: "s", "!": "i" };

// Whole-word matches (after normalising look-alike characters)...
const BLOCKED_WORDS = new Set([
  "fuck", "fucker", "fucking", "fuk", "shit", "shitty", "bitch", "cunt", "asshole", "dickhead", "bastard",
  "slut", "whore", "twat", "wanker", "prick", "retard", "retarded", "kike", "spic", "chink", "gook", "tranny",
]);
// ...and stems that are never innocent, so extra letters can't dodge the filter.
const BLOCKED_STEMS = [/^nigg/, /^fagg?ot/, /^fuck/, /^cunt/, /^motherfuck/];

function normalizeWord(word: string): string {
  const mapped = [...word.toLowerCase()].map((ch) => LEET[ch] ?? ch).join("");
  return mapped.replace(/[^a-z]/g, "").replace(/(.)\1{2,}/g, "$1$1");
}

function isBlocked(word: string): boolean {
  const normalized = normalizeWord(word);
  if (!normalized) {
    return false;
  }
  const squashed = normalized.replace(/(.)\1+/g, "$1");
  return (
    BLOCKED_WORDS.has(normalized) ||
    BLOCKED_WORDS.has(squashed) ||
    BLOCKED_STEMS.some((stem) => stem.test(normalized) || stem.test(squashed))
  );
}

export function filterText(text: string): { text: string; flagged: boolean } {
  let flagged = false;
  const masked = text.replace(/[^\s]+/g, (token) => {
    if (isBlocked(token)) {
      flagged = true;
      return "*".repeat(Math.min(token.length, 8));
    }
    return token;
  });
  return { text: masked, flagged };
}

export function isDisplayNameAllowed(name: string): boolean {
  return !name.split(/[\s._-]+/).some((part) => isBlocked(part)) && !isBlocked(name.replace(/[\s._-]+/g, ""));
}

// At most `limit` chat messages per player in `windowMs`.
export class ChatRateLimiter {
  private readonly sent = new Map<string, number[]>();

  constructor(private readonly limit = 6, private readonly windowMs = 10_000) {}

  allow(playerId: string, now = Date.now()): boolean {
    const recent = (this.sent.get(playerId) ?? []).filter((at) => now - at < this.windowMs);
    if (recent.length >= this.limit) {
      this.sent.set(playerId, recent);
      return false;
    }
    recent.push(now);
    this.sent.set(playerId, recent);
    return true;
  }

  forget(playerId: string): void {
    this.sent.delete(playerId);
  }
}

export interface MessageReport {
  at: number;
  roomCode: string;
  reporterId: string;
  reporterName: string;
  targetPlayerId: string;
  targetName: string;
  messageId: string;
  text: string;
  reason: string;
}

// Reports are logged as one JSON line each (greppable in the host's log viewer) and
// the most recent ones are kept in memory.
export class ReportLog {
  private readonly reports: MessageReport[] = [];

  add(report: MessageReport): void {
    this.reports.push(report);
    if (this.reports.length > 500) {
      this.reports.shift();
    }
    console.log(`[REPORT] ${JSON.stringify(report)}`);
  }

  recent(limit = 50): MessageReport[] {
    return this.reports.slice(-limit);
  }
}
