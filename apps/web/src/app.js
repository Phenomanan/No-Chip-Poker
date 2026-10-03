const urlParams = new URLSearchParams(window.location.search);
const runtimeServerUrl = urlParams.get("server") || localStorage.getItem("chipless-server-url");
const PRODUCTION_SERVER_URL =
  runtimeServerUrl || window.CHIPLESS_CONFIG?.SERVER_URL || "https://your-backend.onrender.com";
if (urlParams.get("server")) {
  localStorage.setItem("chipless-server-url", urlParams.get("server"));
}
const isLocalhost = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";
const socket = isLocalhost ? io() : io(PRODUCTION_SERVER_URL);
const activeServerLabel = isLocalhost ? window.location.origin : PRODUCTION_SERVER_URL;

let currentRoom = null;
let currentPlayerId = "";
let currentSessionId = "";
let raiseMode = false;
let isSocketConnected = false;
const pendingChatById = new Map();
const pendingChatOrder = [];
const SESSION_STORAGE_KEY = "chipless-sessions";
const LAST_SESSION_ROOM_CODE_KEY = "chipless-last-room-code";

const feedback = document.querySelector("#feedback");
const authPanel = document.querySelector("#auth-panel");
const roomPanel = document.querySelector("#room-panel");
const connectionStatusEl = document.querySelector("#connection-status");

const roomCodeEl = document.querySelector("#room-code");
const roomNameEl = document.querySelector("#room-name");
const roomStatusEl = document.querySelector("#room-status");
const roomStreetEl = document.querySelector("#room-street");
const dealerInstructionBannerEl = document.querySelector("#dealer-instruction-banner");
const hostPlayerListEl = document.querySelector("#host-player-list");
const hostPlayerListHintEl = document.querySelector("#host-player-list-hint");
const potEl = document.querySelector("#pot");
const potTitleLabelEl = document.querySelector("#pot-title-label");
const potVisualButton = document.querySelector("#pot-visual-button");
const potVisualStacksEl = document.querySelector("#pot-visual-stacks");
const turnOrderTrackEl = document.querySelector("#turn-order-track");
const turnStateLegendEl = document.querySelector("#turn-state-legend");
const payoutBannerEl = document.querySelector("#payout-banner");
const currentBetEl = document.querySelector("#current-bet");
const blindsEl = document.querySelector("#blinds");
const blindTimerEl = document.querySelector("#blind-timer");
const nextBlindCardEl = document.querySelector("#next-blind-card");
const actingPlayerEl = document.querySelector("#acting-player");
const yourStackEl = document.querySelector("#your-stack");
const yourCommitmentEl = document.querySelector("#your-commitment");
const playersEl = document.querySelector("#players");
const logEl = document.querySelector("#log");
const actionsContainer = document.querySelector("#actions-container");
const blindVotePanelEl = document.querySelector("#blind-vote-panel");

const createDisplayName = document.querySelector("#create-display-name");
const createRoomName = document.querySelector("#create-room-name");
const createSb = document.querySelector("#create-sb");
const createBb = document.querySelector("#create-bb");
const createStack = document.querySelector("#create-stack");

const joinRoomCode = document.querySelector("#join-room-code");
const joinDisplayName = document.querySelector("#join-display-name");
const joinRole = document.querySelector("#join-role");

const updateSb = document.querySelector("#update-sb");
const updateBb = document.querySelector("#update-bb");
const scheduleMinutesInput = document.querySelector("#schedule-minutes");
const raiseAmountInput = document.querySelector("#raise-amount-input");

const createRoomButton = document.querySelector("#create-room-button");
const joinRoomButton = document.querySelector("#join-room-button");
const rejoinRoomButton = document.querySelector("#rejoin-room-button");
const leaveRoomButton = document.querySelector("#leave-room-button");
const startHandButton = document.querySelector("#start-hand-button");
const updateBlindsButton = document.querySelector("#update-blinds-button");
const saveScheduleButton = document.querySelector("#save-schedule-button");
const toggleScheduleButton = document.querySelector("#toggle-schedule-button");
const resetScheduleButton = document.querySelector("#reset-schedule-button");
const tableSettingsToggleButton = document.querySelector("#table-settings-toggle");
const tableSettingsCloseButton = document.querySelector("#table-settings-close");
const tableSettingsPanel = document.querySelector("#table-settings-panel");
const hostControlsCard = document.querySelector("#host-controls-card");
const transferHostSelect = document.querySelector("#transfer-host-select");
const transferHostButton = document.querySelector("#transfer-host-button");
const showdownMainCard = document.querySelector("#showdown-main-card");
const showdownMainStatus = document.querySelector("#showdown-main-status");
const showdownWinnersListMain = document.querySelector("#showdown-winners-list-main");
const showdownActionsMain = document.querySelector("#showdown-actions-main");
const declareWinnersButtonMain = document.querySelector("#declare-winners-button-main");
const selectAllWinnersButtonMain = document.querySelector("#select-all-winners-button-main");
const clearAllWinnersButtonMain = document.querySelector("#clear-all-winners-button-main");
const handRankingsButton = document.querySelector("#hand-rankings-button");
const handRankingsModal = document.querySelector("#hand-rankings-modal");
const closeRankingsButton = document.querySelector("#close-rankings-button");
const handRankingsList = document.querySelector("#hand-rankings-list");
const chipDetailModal = document.querySelector("#chip-detail-modal");
const chipDetailTitle = document.querySelector("#chip-detail-title");
const chipDetailBody = document.querySelector("#chip-detail-body");
const closeChipDetailButton = document.querySelector("#close-chip-detail-button");
const chatMessagesEl = document.querySelector("#chat-messages");
const chatInput = document.querySelector("#chat-input");
const chatSendButton = document.querySelector("#chat-send-button");

const HAND_RANKINGS = [
  { rank: "Royal Flush", description: "A-high straight flush", cards: ["A♠", "K♠", "Q♠", "J♠", "10♠"] },
  { rank: "Straight Flush", description: "Five consecutive cards, same suit", cards: ["9♥", "8♥", "7♥", "6♥", "5♥"] },
  { rank: "Four of a Kind", description: "Four cards with the same value", cards: ["Q♠", "Q♥", "Q♦", "Q♣", "2♠"] },
  { rank: "Full House", description: "Three of a kind plus a pair", cards: ["K♠", "K♥", "K♦", "9♣", "9♠"] },
  { rank: "Flush", description: "Five cards of the same suit", cards: ["A♦", "J♦", "8♦", "5♦", "2♦"] },
  { rank: "Straight", description: "Five consecutive cards", cards: ["10♣", "9♦", "8♠", "7♥", "6♣"] },
  { rank: "Three of a Kind", description: "Three cards with the same value", cards: ["7♠", "7♥", "7♦", "K♣", "2♥"] },
  { rank: "Two Pair", description: "Two different pairs", cards: ["J♠", "J♦", "4♥", "4♣", "9♠"] },
  { rank: "Pair", description: "Two cards with the same value", cards: ["A♠", "A♦", "10♣", "6♥", "3♣"] },
  { rank: "High Card", description: "No combination; highest card plays", cards: ["A♣", "J♠", "8♥", "5♦", "2♣"] },
];

// In-app replacement for window.confirm(): resolves true on Confirm, false on
// Cancel, Escape, or a tap on the backdrop.
function confirmDialog({ title = "Are you sure?", message = "", confirmLabel = "Confirm", danger = false } = {}) {
  const modal = document.querySelector("#confirm-modal");
  const okButton = document.querySelector("#confirm-ok");
  const cancelButton = document.querySelector("#confirm-cancel");
  if (!modal || !okButton || !cancelButton) {
    return Promise.resolve(window.confirm(message || title));
  }

  document.querySelector("#confirm-title").textContent = title;
  document.querySelector("#confirm-message").textContent = message;
  okButton.textContent = confirmLabel;
  okButton.classList.toggle("danger", danger);
  modal.classList.remove("hidden");
  cancelButton.focus();

  return new Promise((resolve) => {
    const finish = (result) => {
      modal.classList.add("hidden");
      okButton.removeEventListener("click", onOk);
      cancelButton.removeEventListener("click", onCancel);
      modal.removeEventListener("click", onBackdrop);
      document.removeEventListener("keydown", onKey);
      resolve(result);
    };
    const onOk = () => finish(true);
    const onCancel = () => finish(false);
    const onBackdrop = (event) => {
      if (event.target === modal) finish(false);
    };
    const onKey = (event) => {
      if (event.key === "Escape") finish(false);
    };
    okButton.addEventListener("click", onOk);
    cancelButton.addEventListener("click", onCancel);
    modal.addEventListener("click", onBackdrop);
    document.addEventListener("keydown", onKey);
  });
}

function setFeedback(message, isError) {
  feedback.style.color = isError ? "var(--danger)" : "var(--safe-ink)";
  feedback.textContent = message;
}

function toNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function formatStreet(street) {
  const labels = {
    preflop: "Preflop",
    flop: "Flop",
    turn: "Turn",
    river: "River",
    showdown: "Showdown",
    resolved: "Resolved",
  };
  return labels[street] ?? street;
}

// Explicit, always-visible dealer instructions per street — testers found the
// old bare street label ("Current stage: Flop") too easy to miss/misread, so
// this spells out exactly what the physical dealer should do right now.
function formatDealerInstruction(room) {
  if (room.status === "in_hand" && room.awaitingDeal) {
    const dealt = { flop: "3 community cards (the flop)", turn: "1 more community card (the turn)", river: "the final community card (the river)" }[room.street] || "the next cards";
    return {
      title: `Deal ${dealt}`,
      detail: currentPlayerId === room.hostPlayerId
        ? "Burn one card, deal face-up, then tap the button below. Betting starts after you do."
        : "Betting starts as soon as the host confirms the cards are dealt.",
    };
  }

  if (room.status === "in_hand") {
    switch (room.street) {
      case "preflop":
        return {
          title: "Preflop — deal 2 hole cards to each player",
          detail: "Action starts to the left of the big blind.",
        };
      case "flop":
        return {
          title: "Flop — deal 3 community cards face-up",
          detail: "Burn one card first, then place three face-up in the middle.",
        };
      case "turn":
        return {
          title: "Turn — deal 1 more community card",
          detail: "Burn one card first, then place the 4th card face-up.",
        };
      case "river":
        return {
          title: "River — deal the final community card",
          detail: "Burn one card first, then place the 5th and last card face-up.",
        };
      default:
        return null;
    }
  }

  if (room.status === "paused" && room.street === "showdown") {
    return {
      title: "Showdown — reveal hands",
      detail: "Players show their cards; the host selects the winner(s) below.",
    };
  }

  return null;
}

function renderDealerInstructionBanner(room) {
  if (!dealerInstructionBannerEl) {
    return;
  }

  const instruction = formatDealerInstruction(room);
  if (!instruction) {
    dealerInstructionBannerEl.classList.add("hidden");
    dealerInstructionBannerEl.innerHTML = "";
    return;
  }

  dealerInstructionBannerEl.classList.remove("hidden");
  dealerInstructionBannerEl.classList.toggle("awaiting-deal", Boolean(room.awaitingDeal));
  dealerInstructionBannerEl.innerHTML = `
    <p class="dealer-instruction-title">${escapeHtml(instruction.title)}</p>
    <p class="dealer-instruction-detail">${escapeHtml(instruction.detail)}</p>
  `;
}

function formatHandStatus(room, playerId) {
  const player = room.players.find((p) => p.id === playerId);
  if (!player) {
    return room.status === "in_hand" ? "Observing" : "Waiting";
  }

  if (player.role === "spectator") {
    return "Spectating";
  }

  if (room.status !== "in_hand") {
    return room.status === "paused" ? "Waiting for showdown" : "Waiting";
  }

  return player.inHand ? "Playing" : "Out";
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatTimestamp(timestamp) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return "now";
  }
  const now = new Date();
  const diffMs = now - date;
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);

  if (diffSecs < 60) {
    return "now";
  } else if (diffMins < 60) {
    return `${diffMins}m ago`;
  } else if (diffHours < 24) {
    return `${diffHours}h ago`;
  } else {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
}

function createClientMessageId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function updateConnectionStatus(state) {
  if (!connectionStatusEl) {
    return;
  }

  if (state === "online") {
    connectionStatusEl.textContent = "● Connected";
    connectionStatusEl.className = "connection-status online";
    return;
  }

  if (state === "reconnecting") {
    connectionStatusEl.textContent = "● Reconnecting...";
    connectionStatusEl.className = "connection-status reconnecting";
    return;
  }

  connectionStatusEl.textContent = "● Disconnected";
  connectionStatusEl.className = "connection-status offline";
}

function addPendingChatMessage(message) {
  pendingChatById.set(message.clientMessageId, message);
  pendingChatOrder.push(message.clientMessageId);
}

function markPendingChatMessage(clientMessageId, status) {
  const existing = pendingChatById.get(clientMessageId);
  if (!existing) {
    return;
  }

  pendingChatById.set(clientMessageId, {
    ...existing,
    status,
  });
}

function removePendingChatMessage(clientMessageId) {
  pendingChatById.delete(clientMessageId);
  const index = pendingChatOrder.indexOf(clientMessageId);
  if (index >= 0) {
    pendingChatOrder.splice(index, 1);
  }
}

function pendingMessagesList() {
  return pendingChatOrder
    .map((id) => pendingChatById.get(id))
    .filter(Boolean);
}

function flushPendingChatMessages() {
  if (!currentRoom || !currentPlayerId || !isSocketConnected) {
    return;
  }

  pendingMessagesList().forEach((pending) => {
    if (pending.status === "sending") {
      return;
    }

    emit({
      type: "send_message",
      roomId: currentRoom.id,
      playerId: currentPlayerId,
      text: pending.text,
      clientMessageId: pending.clientMessageId,
    });
    markPendingChatMessage(pending.clientMessageId, "sending");
  });
}

function reconcileDeliveredChatMessages(room) {
  (room.messages || []).forEach((msg) => {
    if (msg.playerId !== currentPlayerId || !msg.clientMessageId) {
      return;
    }

    removePendingChatMessage(msg.clientMessageId);
  });
}

function renderChatMessages(room) {
  const serverMessages = (room.messages || []).slice(-20).map((msg) => {
    return `<div style="font-size: 0.9rem; margin-bottom: 0.4rem;"><strong>${escapeHtml(msg.playerName)}</strong> <span style="color: var(--muted); font-size: 0.85rem;">${formatTimestamp(msg.at)}</span>: ${escapeHtml(msg.text)}</div>`;
  });

  const pendingMessages = pendingMessagesList().map((pending) => {
    const statusLabel = pending.status === "queued" ? "queued" : "sending";
    return `<div style="font-size: 0.9rem; margin-bottom: 0.4rem; opacity: 0.78;"><strong>You</strong> <span style="color: var(--muted); font-size: 0.85rem;">${formatTimestamp(pending.at)} • ${statusLabel}</span>: ${escapeHtml(pending.text)}</div>`;
  });

  const allMessages = [...serverMessages, ...pendingMessages];
  chatMessagesEl.innerHTML = allMessages.join("") || "<div style='color: var(--muted); font-size: 0.9rem;'>No messages yet.</div>";
  chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
}

function readSessionStore() {
  const raw = localStorage.getItem(SESSION_STORAGE_KEY);
  if (!raw) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    return {};
  }
}

function writeSessionStore(store) {
  localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(store));
}

function saveSession(cache) {
  const roomCode = String(cache.roomCode || "").trim().toUpperCase();
  if (!roomCode) {
    return;
  }

  const store = readSessionStore();
  store[roomCode] = {
    roomCode,
    sessionId: cache.sessionId,
    playerId: cache.playerId,
    updatedAt: Date.now(),
  };
  writeSessionStore(store);
  localStorage.setItem(LAST_SESSION_ROOM_CODE_KEY, roomCode);
}

function readSession(preferredRoomCode) {
  const store = readSessionStore();
  const requestedRoomCode = String(preferredRoomCode || "").trim().toUpperCase();
  if (requestedRoomCode && store[requestedRoomCode]) {
    return store[requestedRoomCode];
  }

  const lastRoomCode = localStorage.getItem(LAST_SESSION_ROOM_CODE_KEY);
  if (lastRoomCode && store[lastRoomCode]) {
    return store[lastRoomCode];
  }

  const allSessions = Object.values(store).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  if (allSessions.length > 0) {
    return allSessions[0];
  }

  return null;
}

function clearSession(roomCode) {
  const normalized = String(roomCode || "").trim().toUpperCase();
  if (!normalized) {
    return;
  }

  const store = readSessionStore();
  delete store[normalized];
  writeSessionStore(store);
}

function markRoomAsMostRecent(roomCode) {
  const normalized = String(roomCode || "").trim().toUpperCase();
  if (!normalized) {
    return;
  }

  localStorage.setItem(LAST_SESSION_ROOM_CODE_KEY, normalized);
}

function showRoomPanel(room) {
  document.body.classList.add("in-room");
  authPanel.classList.add("hidden");
  roomPanel.classList.remove("hidden");
  renderRoom(room);
}

// Tries to silently resume the last saved session on this socket connection —
// used both right after a full page load/refresh and after the socket.io
// client auto-reconnects from a network blip, so players don't have to
// manually hit "Rejoin Last Session" in either case. Prefers the currently
// open room's session (mid-session reconnect) over "whatever was last used"
// (fresh page load).
function attemptAutoRejoin() {
  const cached = readSession(currentRoom?.code);
  if (!cached) {
    return false;
  }

  emit({
    type: "rejoin_room",
    payload: {
      roomCode: cached.roomCode,
      sessionId: cached.sessionId,
    },
  });
  return true;
}

function showAuthPanel() {
  currentRoom = null;
  currentPlayerId = "";
  currentSessionId = "";
  raiseMode = false;
  document.body.classList.remove("in-room");
  authPanel.classList.remove("hidden");
  roomPanel.classList.add("hidden");
}

function calculateLegalActions(room, playerId) {
  if (room.actingPlayerId !== playerId || room.status !== "in_hand") {
    return [];
  }

  const player = room.players.find((p) => p.id === playerId);
  if (!player || !player.connected) {
    return [];
  }

  if (!player.inHand || player.stack <= 0) {
    return [];
  }

  const actions = [];
  const amountToCall = Math.max(0, room.currentBet - player.commitment);

  // Everyone can fold or go all-in
  if (amountToCall > 0) {
    actions.push("fold");
  }

  // Check if no bet is outstanding for this player
  if (amountToCall === 0) {
    actions.push("check");
  } else if (player.stack >= amountToCall) {
    actions.push("call");
  }

  // Can raise if they can add more chips than needed to call
  if (player.stack > amountToCall) {
    actions.push("raise");
  }

  // Can go all-in if they have chips
  if (player.stack > 0) {
    actions.push("all_in");
  }

  return actions;
}

function calculateMinRaise(room) {
  return room.currentBet + room.blinds.bigBlind;
}

function calculatePotAmount(room) {
  return Array.isArray(room.pots) ? room.pots.reduce((sum, pot) => sum + pot.amount, 0) : 0;
}

function formatCountdown(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return "00:00";
  }

  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function renderBlindScheduleSummary(room) {
  if (!blindTimerEl || !nextBlindCardEl) {
    return;
  }

  const schedule = room.blindSchedule;
  if (!schedule?.enabled || !schedule?.nextLevelAt) {
    blindTimerEl.textContent = "--:--";
    nextBlindCardEl.classList.add("hidden");
    return;
  }

  nextBlindCardEl.classList.remove("hidden");

  const secondsRemaining = Math.max(0, Math.ceil((schedule.nextLevelAt - Date.now()) / 1000));
  blindTimerEl.textContent = formatCountdown(secondsRemaining);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

// Classic casino colors (white / red / green / black / purple), tuned to sit on
// the felt-and-gold table: slightly muted bodies, ivory edge spots, brass inlay.
const CHIP_STYLES = {
  500: { bg: '#6a4a9e', rim: '#2f1c55', stripe: '#eadfff', text: '#f3ecff', center: 'rgba(20,8,48,0.45)' },
  100: { bg: '#2a2d33', rim: '#0c0e11', stripe: '#d9b95c', text: '#f1dd9a', center: 'rgba(0,0,0,0.45)' },
  25:  { bg: '#1f8260', rim: '#0b3f2d', stripe: '#e9f7ef', text: '#e9f7ef', center: 'rgba(0,30,18,0.4)' },
  5:   { bg: '#b8344a', rim: '#5a1220', stripe: '#fde6e8', text: '#fde6e8', center: 'rgba(50,0,10,0.38)' },
  1:   { bg: '#efe8d4', rim: '#9b8f72', stripe: '#8c6c2c', text: '#4a3a16', center: 'rgba(120,96,40,0.18)' },
};
const CHIP_GOLD = '#d8b45a';

function chipFaceSvg(denom) {
  const s = CHIP_STYLES[denom] || CHIP_STYLES[1];
  const label = String(denom);
  const fs = label.length >= 3 ? '5.8' : '7';
  return `<svg class="chip-face-svg" width="28" height="28" viewBox="0 0 28 28" aria-hidden="true"><circle cx="14" cy="14" r="13.5" fill="${s.rim}"/><circle cx="14" cy="14" r="12.5" fill="${s.bg}"/><circle cx="14" cy="14" r="12.5" fill="none" stroke="${s.stripe}" stroke-width="4.5" stroke-dasharray="3.1 6.74" stroke-dashoffset="1.55"/><circle cx="14" cy="14" r="8.4" fill="none" stroke="${CHIP_GOLD}" stroke-width="0.8"/><circle cx="14" cy="14" r="6.2" fill="${s.center}"/><ellipse cx="14" cy="9.5" rx="6" ry="2.4" fill="rgba(255,255,255,0.14)"/><text x="14" y="17.2" text-anchor="middle" fill="${s.text}" font-size="${fs}" font-weight="800" font-family="IBM Plex Mono,ui-monospace,monospace">${label}</text></svg>`;
}

// A short stack of casino chips seen from slightly above: every chip has a
// visible rim with edge spots, the top chip shows its face with a brass inlay.
function chipTowerSvg(denom, count) {
  const s = CHIP_STYLES[denom] || CHIP_STYLES[1];
  const visible = Math.max(1, Math.min(count, 6));
  const w = 28;
  const cx = w / 2;
  const rx = 12.5;
  const ry = 4.8;
  const thick = 3.4;
  const pitch = thick + 0.5;
  const overflow = count > 6 ? count - 6 : 0;
  const bodyH = ry * 2 + thick + (visible - 1) * pitch + 3;
  const svgH = bodyH + (overflow > 0 ? 10 : 0);
  const baseCy = bodyH - ry - thick - 1.5;

  let g = `<ellipse cx="${cx}" cy="${(baseCy + thick + 1).toFixed(1)}" rx="${rx + 1}" ry="${ry}" fill="rgba(0,0,0,0.35)"/>`;
  for (let i = 0; i < visible; i += 1) {
    const cy = baseCy - i * pitch;
    const bottom = cy + thick;
    const sideY = cy + thick / 2;
    g += `<path d="M${cx - rx} ${cy.toFixed(2)}V${bottom.toFixed(2)}A${rx} ${ry} 0 0 0 ${cx + rx} ${bottom.toFixed(2)}V${cy.toFixed(2)}Z" fill="${s.rim}"/>`;
    g += `<path d="M${cx - rx} ${sideY.toFixed(2)}A${rx} ${ry} 0 0 0 ${cx + rx} ${sideY.toFixed(2)}" fill="none" stroke="${s.stripe}" stroke-width="${(thick * 0.85).toFixed(2)}" stroke-dasharray="2.6 3.4"/>`;
    g += `<ellipse cx="${cx}" cy="${cy.toFixed(2)}" rx="${rx}" ry="${ry}" fill="${s.bg}" stroke="${s.rim}" stroke-width="0.7"/>`;
  }
  const topCy = baseCy - (visible - 1) * pitch;
  g += `<ellipse cx="${cx}" cy="${topCy.toFixed(2)}" rx="${rx - 0.9}" ry="${ry - 0.4}" fill="none" stroke="${s.stripe}" stroke-width="1.8" stroke-dasharray="3 3.6" opacity="0.9"/>`;
  g += `<ellipse cx="${cx}" cy="${topCy.toFixed(2)}" rx="${(rx * 0.64).toFixed(1)}" ry="${(ry * 0.64).toFixed(1)}" fill="${s.center}" stroke="${CHIP_GOLD}" stroke-width="0.8"/>`;
  g += `<ellipse cx="${(cx - rx * 0.3).toFixed(1)}" cy="${(topCy - ry * 0.35).toFixed(1)}" rx="${(rx * 0.32).toFixed(1)}" ry="${(ry * 0.22).toFixed(1)}" fill="rgba(255,255,255,0.28)"/>`;

  const overflowText = overflow > 0
    ? `<text x="${cx}" y="${(bodyH + 8).toFixed(1)}" text-anchor="middle" fill="${CHIP_GOLD}" font-size="7.5" font-weight="700" font-family="IBM Plex Mono,ui-monospace,monospace">+${overflow}</text>`
    : '';

  return `<svg class="chip-tower-svg" width="${w}" height="${svgH.toFixed(1)}" viewBox="0 0 ${w} ${svgH.toFixed(1)}" aria-hidden="true">${g}${overflowText}</svg>`;
}

function getChipBreakdown(amount) {
  const denoms = [500, 100, 25, 5, 1];
  const rows = [];
  let remaining = Math.max(0, Math.floor(amount));

  denoms.forEach((denom) => {
    if (remaining < denom) {
      return;
    }
    const count = Math.floor(remaining / denom);
    remaining -= count * denom;
    if (count > 0) {
      rows.push({ denom, count });
    }
  });

  return rows;
}

function renderBreakdownRows(amount) {
  const rows = getChipBreakdown(amount);
  if (rows.length === 0) {
    return "<p class=\"chip-breakdown-empty\">No chips in this stack.</p>";
  }

  return rows
    .map(({ denom, count }) => `
      <div class="chip-breakdown-row">
        <div class="chip-breakdown-left">
          ${chipFaceSvg(denom)}
          <span>$${denom}</span>
        </div>
        <div class="chip-breakdown-right">
          <span>${chipTowerSvg(denom, Math.min(6, count))}</span>
          <strong>${count}</strong>
        </div>
      </div>
    `)
    .join("");
}

function openChipDetailModal(title, sections, extraHtml = "") {
  if (!chipDetailModal || !chipDetailTitle || !chipDetailBody) {
    return;
  }

  chipDetailTitle.textContent = title;
  chipDetailBody.innerHTML = sections
    .map((section) => `
      <section class="chip-breakdown-section">
        <h4>${section.title}</h4>
        <p class="chip-breakdown-total">Total ${section.amount}</p>
        ${renderBreakdownRows(section.amount)}
      </section>
    `)
    .join("") + extraHtml;

  chipDetailModal.classList.remove("hidden");
}

// A compact pile of chip towers for any amount. Fixed height so whatever the
// amount, the thing it sits in never changes size or shifts.
function renderChipPile(amount, maxTowers = 3) {
  if (amount <= 0) {
    return '<span class="chip-pile-empty"></span>';
  }
  return getChipBreakdown(amount)
    .slice(0, maxTowers)
    .map(({ denom, count }) => `<span class="chip-pile-tower">${chipTowerSvg(denom, Math.min(count, 5))}</span>`)
    .join("");
}

function renderPotStackPreview(room) {
  if (!potVisualStacksEl) {
    return;
  }
  potVisualStacksEl.innerHTML = renderChipPile(calculatePotAmount(room));
}

function getVisualPots(room) {
  const pots = Array.isArray(room.pots) ? room.pots.filter((pot) => Number.isFinite(pot.amount) && pot.amount > 0) : [];
  const total = calculatePotAmount(room);

  if (pots.length === 0) {
    return [{ label: "Main", amount: total }];
  }

  // Keep a single pooled visual while betting for this street is still unresolved.
  if (room.status === "in_hand" && room.currentBet > 0) {
    return [{ label: "In Play", amount: total }];
  }

  return pots.map((pot, index) => ({
    label: index === 0 ? "Main" : `Side ${index}`,
    amount: pot.amount,
  }));
}

// Seats are placed around the oval by angle, starting at the top (12
// o'clock) and going clockwise — generalizes to however many players are
// actually seated, matching a real table instead of a fixed 4-corner layout.
function seatSlotPosition(index, total) {
  const angle = (-90 + index * (360 / total)) * (Math.PI / 180);
  return {
    left: 50 + 40 * Math.cos(angle),
    top: 50 + 45 * Math.sin(angle),
  };
}

// Where a seat's chip stack sits: on the felt in front of the seat, toward the
// pot. It follows the slot (the seat position in the order), never the pointer.
function chipSlotPosition(index, total) {
  // A ring between the pot medallion (center) and the seat ring, so a stack never
  // sits under the pot or under its player's icon/name.
  const angle = (-90 + index * (360 / total)) * (Math.PI / 180);
  return {
    left: 50 + 28.5 * Math.cos(angle),
    top: 50 + 29.5 * Math.sin(angle),
  };
}

// Tapping a chip stack pops up its number for a moment; tapping it again while
// the number is showing opens the full chip breakdown.
let stackPeekId = null;
let stackPeekTimer = null;

function setStackPeek(id) {
  stackPeekId = id;
  clearTimeout(stackPeekTimer);
  if (id) {
    stackPeekTimer = setTimeout(() => setStackPeek(null), 2800);
  }
  document.querySelectorAll(".seat-chips").forEach((el) => {
    el.classList.toggle("show-amount", el.getAttribute("data-chips-for") === id);
  });
}

function placeAt(el, pos) {
  el.style.left = `${pos.left.toFixed(2)}%`;
  el.style.top = `${pos.top.toFixed(2)}%`;
}

// Seat and chip elements persist between renders (keyed by player id) so they
// animate from slot to slot when the order changes instead of being rebuilt.
function reconcileById(container, selector, attr, ids, create) {
  const existing = new Map();
  container.querySelectorAll(selector).forEach((el) => existing.set(el.getAttribute(attr), el));
  existing.forEach((el, id) => {
    if (!ids.includes(id)) {
      el.remove();
      existing.delete(id);
    }
  });
  return (id) => {
    let el = existing.get(id);
    if (!el) {
      el = create(id);
      container.appendChild(el);
      existing.set(id, el);
    }
    return el;
  };
}

function renderTableTurnVisual(room) {
  if (!turnOrderTrackEl || !turnStateLegendEl) {
    return;
  }

  const players = room.players
    .filter((player) => player.role !== "spectator")
    .sort((a, b) => a.seat - b.seat);

  if (players.length === 0) {
    turnOrderTrackEl.innerHTML = "<p class=\"turn-empty\">No active players</p>";
    turnStateLegendEl.innerHTML = "";
    return;
  }
  turnOrderTrackEl.querySelector(".turn-empty")?.remove();

  const ids = players.map((p) => p.id);
  const isHost = currentPlayerId === room.hostPlayerId;
  const canDragReorder = isHost && room.status === "waiting" && players.length > 1;

  const seatFor = reconcileById(turnOrderTrackEl, ".turn-seat", "data-player-id", ids, (id) => {
    const el = document.createElement("article");
    el.setAttribute("data-player-id", id);
    el.addEventListener("pointerdown", (event) => {
      if (el.classList.contains("draggable")) {
        startTableSeatDrag(event, el);
      }
    });
    return el;
  });
  const chipsFor = reconcileById(turnOrderTrackEl, ".seat-chips", "data-chips-for", ids, (id) => {
    const el = document.createElement("div");
    el.setAttribute("data-chips-for", id);
    el.setAttribute("role", "button");
    el.setAttribute("tabindex", "0");
    el.addEventListener("click", () => {
      if (stackPeekId !== id) {
        setStackPeek(id);
        return;
      }
      setStackPeek(null);
      const player = currentRoom?.players.find((p) => p.id === id);
      if (player) {
        openChipDetailModal(`${player.displayName}'s Stack`, [{ title: "Player Stack", amount: player.stack }]);
      }
    });
    el.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        el.click();
      }
    });
    return el;
  });

  players.forEach((player, index) => {
    const isActing = room.status === "in_hand" && player.id === room.actingPlayerId;
    const isFolded = room.status === "in_hand" && !player.inHand;
    const isCalled = room.status === "in_hand" && room.currentBet > 0 && player.inHand && player.commitment === room.currentBet;
    const isToCall = room.status === "in_hand" && room.currentBet > 0 && player.inHand && player.commitment < room.currentBet;
    const wonThisHand = room.status === "waiting" && Array.isArray(room.payouts) && room.payouts.some((payout) => payout.playerId === player.id);

    let stateClass = "waiting";
    if (isFolded) {
      stateClass = "folded";
    } else if (isActing) {
      stateClass = "acting";
    } else if (isCalled) {
      stateClass = "called";
    } else if (isToCall) {
      stateClass = "betting";
    } else if (wonThisHand) {
      stateClass = "winner";
    }

    const dealerBadge = player.seat === room.dealerSeat ? "D" : player.seat === room.smallBlindSeat ? "SB" : "";
    const bet = room.status === "in_hand" && player.inHand && player.commitment > 0 ? player.commitment : 0;
    const initial = player.displayName.trim().slice(0, 1).toUpperCase() || "?";

    const seatEl = seatFor(player.id);
    seatEl.className = `turn-seat ${stateClass}${canDragReorder ? " draggable" : ""}${seatEl.classList.contains("dragging") ? " dragging" : ""}`;
    seatEl.innerHTML = `
      <div class="turn-seat-avatar">
        ${escapeHtml(initial)}
        <span class="turn-seat-order">${index + 1}</span>
        ${dealerBadge ? `<span class="turn-seat-badge">${dealerBadge}</span>` : ""}
      </div>
      <span class="turn-seat-name">${escapeHtml(player.displayName)}</span>
      <span class="turn-seat-meta${bet ? " has-bet" : ""}">${bet ? `bet ${bet}` : "&nbsp;"}</span>
    `;
    if (!seatEl.classList.contains("dragging")) {
      placeAt(seatEl, seatSlotPosition(index, players.length));
    }

    const chipsEl = chipsFor(player.id);
    chipsEl.className = `seat-chips${isFolded ? " folded" : ""}${player.stack <= 0 ? " empty" : ""}${player.id === stackPeekId ? " show-amount" : ""}`;
    chipsEl.setAttribute("aria-label", `${player.displayName}'s chip stack: ${player.stack}. Tap to show the amount.`);
    chipsEl.innerHTML = `
      <span class="seat-chips-pile">${renderChipPile(player.stack, 2)}</span>
      <span class="seat-chips-amount">${player.stack}</span>
    `;
    placeAt(chipsEl, chipSlotPosition(index, players.length));
  });

  turnStateLegendEl.innerHTML = `
    <span class="legend-pill acting">Acting</span>
    <span class="legend-pill called">Called/Checked</span>
    <span class="legend-pill betting">To Call</span>
    <span class="legend-pill folded">Folded</span>
    ${canDragReorder ? '<span class="seat-drag-hint">Drag a player to change the table order</span>' : ""}
  `;
}

// Lets the host set table order directly on the table (dragging a player to
// where they should sit) instead of only through the list in Host Controls —
// both call the same reorder_seats event. Only the player's icon and name
// follow the pointer; the chip stacks stay in their slots and slide to the new
// ones once the server confirms the new order.
function startTableSeatDrag(event, seatEl) {
  if (!turnOrderTrackEl || !currentRoom || !currentPlayerId) {
    return;
  }

  event.preventDefault();
  seatEl.classList.add("dragging");
  try {
    seatEl.setPointerCapture(event.pointerId);
  } catch (error) {
    // Capture is only a nicety; the window-level listeners below carry the drag.
  }

  const draggedId = seatEl.getAttribute("data-player-id");
  const order = currentRoom.players
    .filter((player) => player.role !== "spectator")
    .sort((a, b) => a.seat - b.seat)
    .map((player) => player.id);

  const pointFromEvent = (e) => {
    const rect = turnOrderTrackEl.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * 100,
      y: ((e.clientY - rect.top) / rect.height) * 100,
    };
  };

  const onMove = (moveEvent) => {
    const p = pointFromEvent(moveEvent);
    placeAt(seatEl, { left: p.x, top: p.y });
  };

  const onUp = (upEvent) => {
    seatEl.classList.remove("dragging");
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onUp);

    const p = pointFromEvent(upEvent);
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < order.length; i += 1) {
      const slot = seatSlotPosition(i, order.length);
      const d = Math.hypot(slot.left - p.x, slot.top - p.y);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    }

    const from = order.indexOf(draggedId);
    // Settle the dragged seat into its drop slot; the next room_state re-renders
    // everything (including the chip stacks) into the confirmed order. If nothing
    // changed or the server refuses, re-render so nothing is left stranded.
    placeAt(seatEl, seatSlotPosition(best, order.length));
    setTimeout(() => {
      if (currentRoom) {
        renderTableTurnVisual(currentRoom);
      }
    }, 1200);
    if (from < 0 || from === best) {
      if (currentRoom) {
        renderTableTurnVisual(currentRoom);
      }
      return;
    }
    order.splice(from, 1);
    order.splice(best, 0, draggedId);

    emit({
      type: "reorder_seats",
      roomId: currentRoom.id,
      actorPlayerId: currentPlayerId,
      orderedPlayerIds: order,
    });
  };

  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onUp);
}

function bindStackAndPotBreakdownHandlers(room) {
  document.querySelectorAll("[data-player-stack-id]").forEach((button) => {
    button.onclick = () => {
      const playerId = button.getAttribute("data-player-stack-id");
      const player = room.players.find((p) => p.id === playerId);
      if (!player) {
        return;
      }
      openChipDetailModal(`${player.displayName}'s Stack`, [{ title: "Player Stack", amount: player.stack }]);
    };
  });

  if (potVisualButton) {
    potVisualButton.onclick = () => {
      const total = calculatePotAmount(room);
      const visualPots = getVisualPots(room);
      const sections = visualPots.map((pot, index) => ({
        title: visualPots.length > 1 ? `${pot.label || `Side ${index}`} Pot` : "Main Pot",
        amount: pot.amount,
      }));
      if (sections.length === 0) {
        sections.push({ title: "Main Pot", amount: total });
      }

      // Who put in what this hand (includes anyone removed mid-hand, since their
      // chips stay in the pot).
      const contributions = (currentRoom?.players || [])
        .filter((p) => p.totalContribution > 0)
        .sort((a, b) => b.totalContribution - a.totalContribution)
        .map((p) => `<div class="pot-contrib-row"><span>${escapeHtml(p.displayName)}</span><strong>${p.totalContribution}</strong></div>`)
        .join("");

      openChipDetailModal("Pot Breakdown", sections, contributions
        ? `<section class="chip-breakdown-section"><h4>Put in this hand</h4>${contributions}</section>`
        : "");
    };
  }
}

function renderStackPreview(stack, densityFactor = 1, emptyLabel = "busted", emptyClass = "stack-empty") {
  if (stack <= 0) {
    return `<span class="${emptyClass}">${emptyLabel}</span>`;
  }

  const breakdown = getChipBreakdown(stack).slice(0, 4);
  if (breakdown.length === 0) {
    return `<span class="${emptyClass}">${emptyLabel}</span>`;
  }

  return breakdown
    .map(({ denom, count }) => {
      const visualCount = Math.max(1, Math.min(7, Math.round(count * densityFactor)));
      return `
        <span class="stack-preview-chip" title="$${denom}">
          ${chipTowerSvg(denom, visualCount)}
        </span>
      `;
    })
    .join("");
}

// Seat numbers can have gaps after players are removed; people see (and the table
// shows) their position in the seating order instead.
function seatPosition(room, player) {
  if (player.role === "spectator") {
    return null;
  }
  const seated = room.players.filter((p) => p.role !== "spectator").sort((a, b) => a.seat - b.seat);
  return seated.findIndex((p) => p.id === player.id) + 1;
}

function formatPlayerRow(room, player, topStack) {
  const isActive = player.id === room.actingPlayerId ? "active" : "";
  const isMe = player.id === currentPlayerId;
  const isMyTurn = isMe && player.id === room.actingPlayerId;
  const meLabel = isMe ? " (you)" : "";
  const meClass = [isMe ? "me" : "", isMyTurn ? "my-turn" : ""].filter(Boolean).join(" ");
  const connected = player.connected ? "online" : "offline";
  const payout = room.payouts?.find((payoutRow) => payoutRow.playerId === player.id);
  const payoutIndex = room.payouts?.findIndex((payoutRow) => payoutRow.playerId === player.id) ?? -1;
  const payoutInfo = payout ? `<span class="player-badge payout">Won ${payout.amount}</span>` : "";
  const dealerBadge = player.seat === room.dealerSeat ? `<span class="player-badge dealer">D</span>` : "";
  const sbBadge = player.seat === room.smallBlindSeat ? `<span class="player-badge sb">SB</span>` : "";
  const yourTurnBadge = isMyTurn ? `<span class="player-badge your-turn">▶ Your turn</span>` : "";
  const commitmentText = player.inHand ? `<span class="player-meta-chip">bet ${player.commitment}</span>` : "";
  const heightPercent = topStack > 0 ? clamp((player.stack / topStack) * 100, 0, 100) : 0;
  const receivesPayout = room.payoutState === "animating" && (room.payouts || []).some((payout) => payout.playerId === player.id);
  const payoutClass = receivesPayout ? "payout-recipient" : "";
  const payoutGrowClass = receivesPayout ? "payout-grow" : "";
  const payoutDelay = payoutIndex >= 0 ? payoutIndex * 220 : 0;
  const payoutStyle = receivesPayout ? `style="--payout-delay:${payoutDelay}ms;"` : "";
  const payoutFloat = receivesPayout && payout
    ? `<span class="payout-float" style="--payout-delay:${payoutDelay}ms;">+${payout.amount}</span>`
    : "";

  return `
    <li class="${isActive} ${meClass} ${payoutClass} player-row" ${payoutStyle}>
      <div class="player-row-top">
        <div>
          <strong>${player.displayName}${meLabel}</strong>
          <div class="player-meta-line">
            <span>${player.role}</span>
            ${seatPosition(room, player) ? `<span>seat ${seatPosition(room, player)}</span>` : ""}
            <span class="${connected === "online" ? "status-online" : "status-offline"}">${connected}</span>
          </div>
        </div>
        <div class="player-badges">${yourTurnBadge}${dealerBadge}${sbBadge}${payoutInfo}</div>
      </div>
      <div class="stack-visual-wrap">
        <div class="stack-meter-track"><div class="stack-meter-fill ${payoutGrowClass}" style="width: ${heightPercent}%;"></div></div>
        ${payoutFloat}
        <button class="stack-chip-preview" data-player-stack-id="${player.id}" aria-label="Show ${player.displayName} chip breakdown">
          <span class="stack-chip-breakdown">${renderStackPreview(player.stack)}</span>
        </button>
      </div>
      <div class="player-meta-line">
        <span class="player-meta-chip">stack ${player.stack}</span>
        ${commitmentText}
      </div>
    </li>
  `;
}

function renderBlindVotePanel(room, playerId) {
  if (!blindVotePanelEl) {
    return;
  }

  const me = room.players.find((p) => p.id === playerId);
  if (!me || me.role === "spectator") {
    blindVotePanelEl.innerHTML = "";
    blindVotePanelEl.classList.add("hidden");
    return;
  }

  blindVotePanelEl.classList.remove("hidden");
  const vote = room.blindVote;

  if (!vote || vote.status !== "open") {
    const canStartVote = room.status === "waiting";
    const proposerName = vote ? room.players.find((p) => p.id === vote.proposedByPlayerId)?.displayName || "A player" : "";
    let statusText = "No active vote";
    if (vote?.status === "passed") {
      statusText = `${proposerName}'s vote passed. Blinds doubled.`;
    } else if (vote?.status === "failed") {
      statusText = `${proposerName}'s vote failed.`;
    }
    blindVotePanelEl.innerHTML = `
      <div class="blind-vote-head">
        <h4>Blind Vote</h4>
        <span class="vote-pill">${statusText}</span>
      </div>
      <p class="blind-vote-copy">Start a table vote to double blinds for the next hand. Requires strict majority.</p>
      <button id="start-double-blinds-vote-button" class="ghost" ${canStartVote ? "" : "disabled"}>Start Vote: Double Blinds</button>
    `;

    const startButton = document.querySelector("#start-double-blinds-vote-button");
    if (startButton) {
      startButton.addEventListener("click", () => {
        if (!currentRoom || !currentPlayerId) {
          return;
        }
        emit({
          type: "request_double_blinds_vote",
          roomId: currentRoom.id,
          actorPlayerId: currentPlayerId,
        });
      });
    }

    return;
  }

  const proposer = room.players.find((p) => p.id === vote.proposedByPlayerId)?.displayName || "A player";
  const yesCount = vote.yesVotes.length;
  const noCount = vote.noVotes.length;
  const total = vote.eligiblePlayerIds.length;
  const needed = Math.floor(total / 2) + 1;
  const votedAlready = vote.yesVotes.includes(playerId) || vote.noVotes.includes(playerId);

  blindVotePanelEl.innerHTML = `
    <div class="blind-vote-head">
      <h4>Blind Vote</h4>
      <span class="vote-pill open">Live</span>
    </div>
    <p class="blind-vote-copy">${proposer} proposed doubling blinds. Majority needed: ${needed}/${total} yes votes.</p>
    <div class="vote-tally-row">
      <span class="vote-yes">Yes ${yesCount}</span>
      <span class="vote-no">No ${noCount}</span>
      <span class="vote-needed">Need ${needed}</span>
    </div>
    <div class="vote-actions-row">
      <button id="double-blinds-vote-yes-button" class="ghost" ${votedAlready ? "disabled" : ""}>Vote Yes</button>
      <button id="double-blinds-vote-no-button" class="action" ${votedAlready ? "disabled" : ""}>Vote No</button>
    </div>
  `;

  const yesButton = document.querySelector("#double-blinds-vote-yes-button");
  if (yesButton) {
    yesButton.addEventListener("click", () => {
      if (!currentRoom || !currentPlayerId) {
        return;
      }

      emit({
        type: "cast_double_blinds_vote",
        roomId: currentRoom.id,
        actorPlayerId: currentPlayerId,
        approve: true,
      });
    });
  }

  const noButton = document.querySelector("#double-blinds-vote-no-button");
  if (noButton) {
    noButton.addEventListener("click", () => {
      if (!currentRoom || !currentPlayerId) {
        return;
      }

      emit({
        type: "cast_double_blinds_vote",
        roomId: currentRoom.id,
        actorPlayerId: currentPlayerId,
        approve: false,
      });
    });
  }
}

function renderActions(room, playerId) {
  const me = room.players.find((p) => p.id === playerId);
  const isHost = room.hostPlayerId === playerId;

  if (room.status !== "in_hand") {
    if (isHost) {
      actionsContainer.innerHTML = "<p style=\"color: var(--muted); font-size: 0.9rem; margin: 0;\">Press Start Hand to begin the next hand.</p>";
    } else {
      actionsContainer.innerHTML = "<p style=\"color: var(--muted); font-size: 0.9rem; margin: 0;\">Waiting for host to start the hand...</p>";
    }
    raiseMode = false;
    return;
  }

  if (room.awaitingDeal) {
    raiseMode = false;
    const what = { flop: "Flop", turn: "Turn", river: "River" }[room.street] || "Cards";
    const count = { flop: "3 cards", turn: "1 card", river: "1 card" }[room.street] || "cards";
    if (isHost) {
      actionsContainer.innerHTML = `<button id="confirm-deal-button" class="action deal-confirm">${what} dealt (${count}) — start betting</button>`;
      document.querySelector("#confirm-deal-button").addEventListener("click", () => {
        if (!currentRoom || !currentPlayerId) {
          return;
        }
        emit({ type: "confirm_deal", roomId: currentRoom.id, actorPlayerId: currentPlayerId });
      });
    } else {
      actionsContainer.innerHTML = `<p class="deal-wait">Waiting for the host to deal the ${what.toLowerCase()}…</p>`;
    }
    return;
  }

  if (me && !me.inHand) {
    actionsContainer.innerHTML = "<p style=\"color: var(--muted); font-size: 0.9rem; margin: 0;\">You are out of this hand.</p>";
    raiseMode = false;
    return;
  }

  if (room.street === "showdown" && room.status === "paused") {
    actionsContainer.innerHTML = `<p style="color: var(--muted); font-size: 0.9rem; margin: 0;">${
      isHost ? "Declare winner(s) in Host Controls." : "Waiting for host to declare winner(s)."
    }</p>`;
    raiseMode = false;
    return;
  }

  const actions = calculateLegalActions(room, playerId);
  const player = room.players.find((p) => p.id === playerId);

  if (actions.length === 0) {
    actionsContainer.innerHTML = "<p style=\"color: var(--muted); font-size: 0.9rem; margin: 0;\">Waiting for your turn...</p>";
    raiseMode = false;
    return;
  }

  let html = '<div class="actions-row">';

  actions.forEach((action) => {
    if (action === "raise") {
      html += `<button id="raise-button-trigger" class="action raise">Raise</button>`;
    } else if (action === "fold") {
      html += `<button data-action="fold" class="action fold">Fold</button>`;
    } else if (action === "check") {
      html += `<button data-action="check" class="action call">Check</button>`;
    } else if (action === "call") {
      const amountToCall = Math.max(0, room.currentBet - player.commitment);
      html += `<button data-action="call" class="action call">Call (${amountToCall})</button>`;
    } else if (action === "all_in") {
      html += `<button data-action="all_in" class="action danger">All In</button>`;
    }
  });

  html += "</div>";

  if (raiseMode && actions.includes("raise") && player) {
    const minRaise = calculateMinRaise(room);
    const pot = calculatePotAmount(room);
    const allIn = player.stack;

    html += `
      <div style="margin-top: 0.6rem; display: flex; gap: 0.5rem; flex-wrap: wrap;">
        <input id="raise-amount-input" type="number" min="${minRaise}" placeholder="Raise to..." style="flex: 1; min-width: 120px;" />
        <button id="min-raise-button" class="action ghost" style="font-size: 0.85rem; padding: 0.5rem 0.6rem;">Min (${minRaise})</button>
        <button id="pot-button" class="action ghost" style="font-size: 0.85rem; padding: 0.5rem 0.6rem;">Pot (${pot})</button>
        <button id="all-in-button" class="action ghost" style="font-size: 0.85rem; padding: 0.5rem 0.6rem;">All In (${allIn})</button>
        <button id="raise-submit-button" class="action" style="padding: 0.5rem 0.85rem;">Submit</button>
      </div>
    `;
  }

  actionsContainer.innerHTML = html;

  // Attach event listeners
  document.querySelectorAll("button[data-action]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (!currentRoom || !currentPlayerId) {
        return;
      }

      emit({
        type: "submit_action",
        roomId: currentRoom.id,
        actorPlayerId: currentPlayerId,
        action: btn.dataset.action,
      });
    });
  });

  const raiseButton = document.querySelector("#raise-button-trigger");
  if (raiseButton) {
    raiseButton.addEventListener("click", () => {
      raiseMode = true;
      renderActions(room, playerId);
      setTimeout(() => {
        const input = document.querySelector("#raise-amount-input");
        if (input) input.focus();
      }, 0);
    });
  }

  const minButton = document.querySelector("#min-raise-button");
  if (minButton) {
    minButton.addEventListener("click", () => {
      const amount = calculateMinRaise(room);
      const input = document.querySelector("#raise-amount-input");
      if (input) input.value = String(amount);
    });
  }

  const potButton = document.querySelector("#pot-button");
  if (potButton) {
    potButton.addEventListener("click", () => {
      const amount = calculatePotAmount(room);
      const input = document.querySelector("#raise-amount-input");
      if (input) input.value = String(amount);
    });
  }

  const allInQuickButton = document.querySelector("#all-in-button");
  if (allInQuickButton) {
    allInQuickButton.addEventListener("click", () => {
      const amount = player.stack;
      const input = document.querySelector("#raise-amount-input");
      if (input) input.value = String(amount);
    });
  }

  const raiseSubmitButton = document.querySelector("#raise-submit-button");
  if (raiseSubmitButton) {
    raiseSubmitButton.addEventListener("click", () => {
      if (!currentRoom || !currentPlayerId) {
        return;
      }

      const input = document.querySelector("#raise-amount-input");
      const amount = toNumber(input?.value, NaN);
      if (!Number.isFinite(amount)) {
        setFeedback("Enter a valid raise amount.", true);
        return;
      }

      emit({
        type: "submit_action",
        roomId: currentRoom.id,
        actorPlayerId: currentPlayerId,
        action: "raise",
        amount,
      });

      raiseMode = false;
    });
  }
}

const DEFAULT_TAB_TITLE = "No-Chip Poker";

function updateTabTitle(room, me) {
  const isMyTurn = Boolean(
    me && me.inHand && room.status === "in_hand" && room.actingPlayerId === me.id
  );
  document.title = isMyTurn ? `● Your turn — ${DEFAULT_TAB_TITLE}` : DEFAULT_TAB_TITLE;
}

function renderRoom(incomingRoom) {
  // Players removed mid-hand stay in the server's roster only so their chips remain in
  // the pot; they should not appear anywhere in the UI.
  const room = { ...incomingRoom, players: incomingRoom.players.filter((p) => !p.pendingRemoval) };
  currentRoom = room;
  roomCodeEl.textContent = room.code;
  roomNameEl.textContent = room.name;
  roomStatusEl.textContent = `Hand Status: ${formatHandStatus(room, currentPlayerId)}`;
  roomStreetEl.textContent = `Current stage: ${formatStreet(room.street)}`;
  renderDealerInstructionBanner(room);

  const totalPot = Array.isArray(room.pots) ? room.pots.reduce((sum, p) => sum + p.amount, 0) : 0;
  potEl.textContent = String(totalPot);
  renderPotTitleLabel(room);
  renderPotStackPreview(room);
  renderTableTurnVisual(room);
  currentBetEl.textContent = String(room.currentBet);
  blindsEl.textContent = `${room.blinds.smallBlind} / ${room.blinds.bigBlind}`;
  renderBlindScheduleSummary(room);

  const acting = room.players.find((p) => p.id === room.actingPlayerId);
  actingPlayerEl.textContent = acting ? acting.displayName : room.status === "in_hand" && room.awaitingDeal ? "Dealing…" : "-";

  const me = room.players.find((p) => p.id === currentPlayerId);
  yourStackEl.textContent = me ? String(me.stack) : "-";
  yourCommitmentEl.textContent = me ? String(me.commitment) : "-";
  updateTabTitle(room, me);

  const topStack = room.players.reduce((max, p) => Math.max(max, p.stack), 0);
  playersEl.innerHTML = room.players.map((p) => formatPlayerRow(room, p, topStack)).join("");
  bindStackAndPotBreakdownHandlers(room);

  renderPayoutBanner(room);

  logEl.innerHTML =
    room.actionLog
      .slice()
      .reverse()
      .map((entry) => {
        const actor = room.players.find((p) => p.id === entry.playerId)?.displayName ?? "unknown";
        const amount = typeof entry.amount === "number" ? ` ${entry.amount}` : "";
        return `<li>${new Date(entry.at).toLocaleTimeString()} - ${actor}: ${entry.action}${amount}</li>`;
      })
      .join("") || "<li>No actions yet.</li>";

  reconcileDeliveredChatMessages(room);
  renderChatMessages(room);

  renderActions(room, currentPlayerId);
  renderBlindVotePanel(room, currentPlayerId);

  // Show/hide host controls based on whether current player is host
  const isHost = currentPlayerId === room.hostPlayerId;
  const canDeclareShowdown = room.status === "paused" && room.street === "showdown";
  hostControlsCard.style.display = isHost ? 'block' : 'none';
  renderHostPlayerList(room, isHost);
  if (startHandButton) {
    const payoutReady = room.payoutState === "idle";
    const showStartHand = isHost && room.status === "waiting" && payoutReady;
    startHandButton.style.display = showStartHand ? "inline-flex" : "none";
  }
  
  // Populate transfer host dropdown
  if (isHost) {
    const otherPlayers = room.players.filter(p => p.id !== currentPlayerId && p.role === 'player');
    transferHostSelect.innerHTML = '<option value="">Select player...</option>';
    otherPlayers.forEach(p => {
      const option = document.createElement('option');
      option.value = p.id;
      option.textContent = p.displayName;
      transferHostSelect.appendChild(option);
    });
    transferHostButton.disabled = otherPlayers.length === 0;

    if (scheduleMinutesInput && room.blindSchedule) {
      scheduleMinutesInput.value = String(Math.max(1, Math.round(room.blindSchedule.levelDurationSeconds / 60)));
    }
    if (toggleScheduleButton && room.blindSchedule) {
      toggleScheduleButton.textContent = room.blindSchedule.enabled ? "Pause Schedule" : "Start Schedule";
    }
  }

  const showdownPots = Array.isArray(room.pots) ? room.pots : [];
  const isMultiPotShowdown = canDeclareShowdown && showdownPots.length > 1;

  if (canDeclareShowdown) {
    const candidates = room.players.filter((p) => p.inHand && p.role !== "spectator");
    showdownWinnersListMain.innerHTML = isMultiPotShowdown
      ? renderShowdownPotGroups(room, showdownPots, candidates)
      : candidates
          .map(
            (p) => `
              <label class="showdown-winner-option">
                <input type="checkbox" data-pot-index="0" value="${p.id}" />
                <span>${p.displayName}</span>
              </label>
            `
          )
          .join("");
  } else {
    showdownWinnersListMain.innerHTML = "";
  }

  if (showdownMainCard) {
    showdownMainCard.classList.toggle("hidden", !canDeclareShowdown);
  }
  // Everyone can see who is contesting the pot, but only the host's picks count.
  showdownWinnersListMain.querySelectorAll("input[type='checkbox']").forEach((input) => {
    if (!isHost) input.disabled = true;
  });

  if (showdownMainStatus) {
    showdownMainStatus.textContent = canDeclareShowdown
      ? (isHost
          ? (isMultiPotShowdown
              ? "This hand has side pots. Select the winner(s) for each pot below, then confirm."
              : "Select winner(s) and confirm to resolve the hand.")
          : "Waiting for host to declare winner(s).")
      : "Showdown controls appear here when a hand reaches showdown.";
  }

  const showMainHostActions = isHost && canDeclareShowdown;
  if (showdownActionsMain) {
    showdownActionsMain.classList.toggle("hidden", !showMainHostActions);
  }
  if (declareWinnersButtonMain) {
    declareWinnersButtonMain.classList.toggle("hidden", !showMainHostActions);
  }
}

function potGroupLabel(index) {
  return index === 0 ? "the main pot" : `side pot ${index}`;
}

// When a hand has side pots, the flat "pick the winner(s)" checklist can't express
// that the main pot and a side pot may go to different players (e.g. a short stack
// wins the main pot outright while a side pot is contested between two other
// players who covered it). This renders one checkbox group per pot instead, each
// scoped to only the players who actually contributed to (and are still in the
// hand for) that pot.
function renderShowdownPotGroups(room, pots, candidates) {
  const eligiblePlayerIds = new Set(candidates.map((p) => p.id));

  return pots
    .map((pot, index) => {
      const eligibleContributors = pot.contributors.filter((id) => eligiblePlayerIds.has(id));
      const label = index === 0 ? "Main Pot" : `Side Pot ${index}`;
      const uncontested = eligibleContributors.length <= 1;

      const optionsHtml = eligibleContributors.length > 0
        ? eligibleContributors
            .map((id) => {
              const player = room.players.find((p) => p.id === id);
              const name = player ? player.displayName : "Unknown";
              const checkedAttr = uncontested ? "checked" : "";
              const disabledAttr = uncontested ? "disabled" : "";
              return `
                <label class="showdown-winner-option ${uncontested ? "uncontested" : ""}">
                  <input type="checkbox" data-pot-index="${index}" value="${id}" ${checkedAttr} ${disabledAttr} />
                  <span>${name}</span>
                </label>
              `;
            })
            .join("")
        : `<p class="showdown-hint">No eligible player remains for this pot.</p>`;

      return `
        <div class="showdown-pot-group">
          <p class="showdown-pot-group-label">${label} — ${pot.amount} chips${uncontested && eligibleContributors.length === 1 ? " (uncontested)" : ""}</p>
          <div class="showdown-pot-group-options">${optionsHtml}</div>
        </div>
      `;
    })
    .join("");
}

function getSelectedWinnerIds(listElement) {
  return [...new Set([...listElement.querySelectorAll("input[type='checkbox']:checked")].map((el) => el.value))];
}

function getSelectedPotWinnerIds(listElement, potCount) {
  const groups = Array.from({ length: potCount }, () => []);
  listElement.querySelectorAll("input[type='checkbox']:checked").forEach((el) => {
    const potIndex = Number(el.dataset.potIndex);
    if (Number.isInteger(potIndex) && groups[potIndex]) {
      groups[potIndex].push(el.value);
    }
  });
  return groups;
}

function setAllWinnerCheckboxes(listElement, checked) {
  listElement.querySelectorAll("input[type='checkbox']:not(:disabled)").forEach((cb) => {
    cb.checked = checked;
  });
}

async function submitDeclaredWinnersFrom(listElement) {
  if (!currentRoom || !currentPlayerId) {
    return;
  }

  if (currentRoom.hostPlayerId !== currentPlayerId) {
    setFeedback("Only the host can declare winner(s).", true);
    return;
  }

  const selectedWinnerIds = getSelectedWinnerIds(listElement);
  if (selectedWinnerIds.length === 0) {
    setFeedback("Select at least one winner.", true);
    return;
  }

  const pots = Array.isArray(currentRoom.pots) ? currentRoom.pots : [];
  const isMultiPot = pots.length > 1;
  let potWinnerIds;

  if (isMultiPot) {
    potWinnerIds = getSelectedPotWinnerIds(listElement, pots.length);
    for (let i = 0; i < potWinnerIds.length; i += 1) {
      const groupHasContestedInputs = listElement.querySelectorAll(
        `input[type='checkbox'][data-pot-index="${i}"]:not(:disabled)`
      ).length > 0;
      if (groupHasContestedInputs && potWinnerIds[i].length === 0) {
        setFeedback(`Select at least one winner for ${potGroupLabel(i)}.`, true);
        return;
      }
    }
  }

  const winnerNames = selectedWinnerIds.map((id) => {
    const winner = currentRoom.players.find((p) => p.id === id);
    return winner ? winner.displayName : "Unknown";
  }).join(", ");

  const confirmed = await confirmDialog({
    title: "Pay out the pot?",
    message: `Award the pot to ${winnerNames}. This cannot be undone.`,
    confirmLabel: "Pay out",
  });
  if (!confirmed || !currentRoom) {
    return;
  }

  emit({
    type: "declare_winners",
    roomId: currentRoom.id,
    actorPlayerId: currentPlayerId,
    winnerIds: selectedWinnerIds,
    ...(isMultiPot ? { potWinnerIds } : {}),
  });
}

function renderPotTitleLabel(room) {
  if (!potTitleLabelEl) {
    return;
  }
  // Fixed short label: the medallion is a static, fixed-size chip. Winners are
  // announced in the payout banner instead of squeezing a sentence in here.
  const paidOut = room.status === "waiting" && Array.isArray(room.payouts) && room.payouts.length > 0;
  potTitleLabelEl.textContent = paidOut ? "Paid" : "Pot";
}

function renderPayoutBanner(room) {
  if (!payoutBannerEl) {
    return;
  }

  if (!Array.isArray(room.payouts) || room.payouts.length === 0 || room.status !== "waiting") {
    payoutBannerEl.classList.add("hidden");
    payoutBannerEl.innerHTML = "";
    if (potVisualButton) {
      potVisualButton.classList.remove("payout-distributing");
    }
    return;
  }

  const payoutSummary = room.payouts
    .map((payout) => {
      const name = room.players.find((player) => player.id === payout.playerId)?.displayName || "Player";
      return `${name} wins ${payout.amount}`;
    })
    .join(" • ");

  if (room.payoutState === "animating") {
    if (potVisualButton) {
      potVisualButton.classList.add("payout-distributing");
    }
    payoutBannerEl.classList.remove("hidden");
    payoutBannerEl.innerHTML = `
      <div>
        <p class="payout-banner-text">${payoutSummary}!</p>
        <p class="payout-banner-sub">Chips are being pushed now...</p>
      </div>
    `;
    return;
  }

  if (potVisualButton) {
    potVisualButton.classList.remove("payout-distributing");
  }
  payoutBannerEl.classList.remove("hidden");
  payoutBannerEl.innerHTML = `
    <div>
      <p class="payout-banner-text">${payoutSummary}!</p>
      <p class="payout-banner-sub">Payout complete. Ready for next hand.</p>
    </div>
  `;
}

function renderHostPlayerList(room, isHost) {
  if (!hostPlayerListEl) {
    return;
  }

  if (!isHost) {
    hostPlayerListEl.innerHTML = "";
    return;
  }

  const reorderLocked = room.status !== "waiting";
  if (hostPlayerListHintEl) {
    hostPlayerListHintEl.textContent = reorderLocked
      ? "Table order is locked until this hand is paid out."
      : "Drag a row by its handle to set seat order. Removing a player takes effect immediately.";
  }

  const seatedPlayers = room.players.filter((p) => p.role !== "spectator").sort((a, b) => a.seat - b.seat);
  const spectators = room.players.filter((p) => p.role === "spectator");

  const rowHtml = (p, seatLabel) => {
    const isSelf = p.id === currentPlayerId;
    const isHostRow = p.id === room.hostPlayerId;
    const tag = isHostRow
      ? ' <span class="spectator-tag">(host)</span>'
      : isSelf
        ? ' <span class="spectator-tag">(you)</span>'
        : "";
    const canDrag = p.role !== "spectator" && !reorderLocked;
    return `
      <li class="host-player-row${reorderLocked ? " reorder-disabled" : ""}" data-player-id="${p.id}" data-spectator="${p.role === "spectator"}">
        <span class="drag-handle" ${canDrag ? "" : 'style="visibility:hidden"'} title="Drag to reorder">⠿</span>
        <span class="host-player-seat">${seatLabel}</span>
        <span class="host-player-name">${escapeHtml(p.displayName)}${tag}</span>
        ${isHostRow ? "" : `<button type="button" class="host-player-remove-button" data-remove-player-id="${p.id}">Remove</button>`}
      </li>
    `;
  };

  hostPlayerListEl.innerHTML =
    seatedPlayers.map((p, index) => rowHtml(p, `#${index + 1}`)).join("") + spectators.map((p) => rowHtml(p, "spec")).join("");

  hostPlayerListEl.querySelectorAll("[data-remove-player-id]").forEach((button) => {
    button.addEventListener("click", async () => {
      const targetId = button.getAttribute("data-remove-player-id");
      const target = room.players.find((p) => p.id === targetId);
      if (!currentRoom || !currentPlayerId || !target) {
        return;
      }

      const handNote = room.status === "waiting" ? "" : " Their chips already in the pot stay in the pot.";
      const confirmed = await confirmDialog({
        title: `Remove ${target.displayName}?`,
        message: `They'll be taken off the table and can't rejoin with their old seat.${handNote}`,
        confirmLabel: "Remove",
        danger: true,
      });
      if (!confirmed) {
        return;
      }

      emit({
        type: "remove_player",
        roomId: currentRoom.id,
        actorPlayerId: currentPlayerId,
        targetPlayerId: targetId,
      });
    });
  });

  if (!reorderLocked) {
    hostPlayerListEl.querySelectorAll(".host-player-row[data-spectator='false'] .drag-handle").forEach((handle) => {
      handle.addEventListener("pointerdown", startHostPlayerDrag);
    });
  }
}

// Pointer Events (not the HTML5 drag-and-drop API) so the same code drives
// both mouse drag and touch drag — this is a poker companion app, most
// players are reordering seats from a phone at the table.
function startHostPlayerDrag(event) {
  const row = event.target.closest(".host-player-row");
  if (!row || !hostPlayerListEl) {
    return;
  }

  event.preventDefault();
  row.classList.add("dragging");

  const seatedRowSelector = ".host-player-row[data-spectator='false']";

  const onMove = (moveEvent) => {
    const siblings = [...hostPlayerListEl.querySelectorAll(seatedRowSelector)].filter((el) => el !== row);
    const afterElement = siblings.find((sibling) => moveEvent.clientY < sibling.getBoundingClientRect().top + sibling.getBoundingClientRect().height / 2);

    if (afterElement) {
      hostPlayerListEl.insertBefore(row, afterElement);
    } else if (siblings.length > 0) {
      hostPlayerListEl.insertBefore(row, siblings[siblings.length - 1].nextSibling);
    }
  };

  const onUp = () => {
    row.classList.remove("dragging");
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);

    if (!currentRoom || !currentPlayerId) {
      return;
    }

    const newOrder = [...hostPlayerListEl.querySelectorAll(seatedRowSelector)].map((el) => el.getAttribute("data-player-id"));

    emit({
      type: "reorder_seats",
      roomId: currentRoom.id,
      actorPlayerId: currentPlayerId,
      orderedPlayerIds: newOrder,
    });
  };

  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp, { once: true });
}

function emit(event) {
  socket.emit("event", event);
}

function ensureRealtimeConnected(actionLabel) {
  if (isSocketConnected) {
    return true;
  }

  const localHint =
    isLocalhost
      ? "Start the backend server locally (npm run dev:server) and refresh."
      : "If you are running locally, open with ?server=http://localhost:3001 (or your backend URL).";
  setFeedback(`Cannot ${actionLabel} while disconnected from ${activeServerLabel}. ${localHint}`, true);
  return false;
}

if (tableSettingsToggleButton && tableSettingsPanel) {
  tableSettingsToggleButton.addEventListener("click", () => {
    tableSettingsPanel.classList.toggle("hidden");
  });
}

if (tableSettingsCloseButton && tableSettingsPanel) {
  tableSettingsCloseButton.addEventListener("click", () => {
    tableSettingsPanel.classList.add("hidden");
  });
}

if (closeChipDetailButton && chipDetailModal) {
  closeChipDetailButton.addEventListener("click", () => {
    chipDetailModal.classList.add("hidden");
  });
}

if (chipDetailModal) {
  chipDetailModal.addEventListener("click", (event) => {
    if (event.target === chipDetailModal) {
      chipDetailModal.classList.add("hidden");
    }
  });
}

createRoomButton.addEventListener("click", () => {
  if (!ensureRealtimeConnected("create a room")) {
    return;
  }

  const displayName = createDisplayName.value.trim();
  if (!displayName) {
    setFeedback("Enter a display name before creating a room.", true);
    return;
  }

  emit({
    type: "create_room",
    payload: {
      displayName,
      name: createRoomName.value.trim(),
      smallBlind: toNumber(createSb.value, 25),
      bigBlind: toNumber(createBb.value, 50),
      startingStack: toNumber(createStack.value, 1000),
    },
  });
});

joinRoomButton.addEventListener("click", () => {
  if (!ensureRealtimeConnected("join a room")) {
    return;
  }

  const displayName = joinDisplayName.value.trim();
  const roomCode = joinRoomCode.value.trim().toUpperCase();
  if (!roomCode || !displayName) {
    setFeedback("Enter both room code and display name to join.", true);
    return;
  }

  const payload = {
    roomCode,
    displayName,
    role: joinRole.value,
  };

  emit({ type: "join_room", payload });
});

rejoinRoomButton.addEventListener("click", () => {
  if (!ensureRealtimeConnected("rejoin")) {
    return;
  }

  if (!attemptAutoRejoin()) {
    showAuthPanel();
    setFeedback("No previous session found in this browser.", true);
  }
});

if (leaveRoomButton) {
  leaveRoomButton.addEventListener("click", async () => {
    if (!currentRoom) {
      return;
    }

    const confirmed = await confirmDialog({
      title: "Leave this room?",
      message: "You'll need the room code to rejoin.",
      confirmLabel: "Leave",
      danger: true,
    });
    if (!confirmed || !currentRoom) {
      return;
    }

    clearSession(currentRoom.code);
    showAuthPanel();
    setFeedback("Left the room.");

    // A plain UI reset isn't enough: the old socket is still joined to the
    // room's channel server-side and would keep receiving room_state
    // broadcasts. Forcing a fresh connection (client-initiated disconnects
    // don't auto-reconnect, so this needs an explicit connect()) makes the
    // server mark this player disconnected, same as closing the tab would.
    socket.disconnect();
    socket.connect();
  });
}

startHandButton.addEventListener("click", () => {
  if (!currentRoom || !currentPlayerId) {
    return;
  }

  emit({ type: "start_hand", roomId: currentRoom.id, actorPlayerId: currentPlayerId });
});

updateBlindsButton.addEventListener("click", () => {
  if (!currentRoom || !currentPlayerId) {
    return;
  }

  emit({
    type: "update_blinds",
    roomId: currentRoom.id,
    actorPlayerId: currentPlayerId,
    blinds: {
      smallBlind: toNumber(updateSb.value || String(currentRoom.blinds.smallBlind), currentRoom.blinds.smallBlind),
      bigBlind: toNumber(updateBb.value || String(currentRoom.blinds.bigBlind), currentRoom.blinds.bigBlind),
    },
  });
});

saveScheduleButton.addEventListener("click", () => {
  if (!currentRoom || !currentPlayerId) {
    return;
  }

  const minutes = toNumber(scheduleMinutesInput.value, NaN);
  if (!Number.isFinite(minutes) || minutes < 1) {
    setFeedback("Enter a valid blind level duration in minutes.", true);
    return;
  }

  emit({
    type: "configure_blind_schedule",
    roomId: currentRoom.id,
    actorPlayerId: currentPlayerId,
    levelDurationSeconds: Math.floor(minutes * 60),
  });
});

toggleScheduleButton.addEventListener("click", () => {
  if (!currentRoom || !currentPlayerId) {
    return;
  }

  const enabled = !(currentRoom.blindSchedule && currentRoom.blindSchedule.enabled);
  emit({
    type: "toggle_blind_schedule",
    roomId: currentRoom.id,
    actorPlayerId: currentPlayerId,
    enabled,
  });
});

resetScheduleButton.addEventListener("click", () => {
  if (!currentRoom || !currentPlayerId) {
    return;
  }

  emit({
    type: "reset_blind_schedule",
    roomId: currentRoom.id,
    actorPlayerId: currentPlayerId,
  });
});

transferHostButton.addEventListener("click", () => {
  if (!currentRoom || !currentPlayerId || !transferHostSelect.value) {
    setFeedback("Please select a player to transfer host to.", true);
    return;
  }

  emit({
    type: "transfer_host",
    roomId: currentRoom.id,
    actorPlayerId: currentPlayerId,
    newHostPlayerId: transferHostSelect.value,
  });
  transferHostSelect.value = "";
  setFeedback("Host transferred successfully.");
});

if (selectAllWinnersButtonMain) {
  selectAllWinnersButtonMain.addEventListener("click", () => {
    setAllWinnerCheckboxes(showdownWinnersListMain, true);
  });
}

if (clearAllWinnersButtonMain) {
  clearAllWinnersButtonMain.addEventListener("click", () => {
    setAllWinnerCheckboxes(showdownWinnersListMain, false);
  });
}

if (declareWinnersButtonMain) {
  declareWinnersButtonMain.addEventListener("click", () => {
    submitDeclaredWinnersFrom(showdownWinnersListMain);
  });
}

handRankingsButton.addEventListener("click", () => {
  handRankingsList.innerHTML = HAND_RANKINGS.map(
    (ranking, index) =>
      `<div class="hand-ranking-item">
        <div>
          <div class="hand-rank-name">${index + 1}. ${ranking.rank}</div>
          <div class="hand-rank-desc">${ranking.description}</div>
          <div class="hand-rank-cards">${ranking.cards.map((card) => {
            const isRed = card.includes("♥") || card.includes("♦");
            return `<span class="card-chip ${isRed ? "red" : "black"}">${card}</span>`;
          }).join("")}</div>
        </div>
      </div>`
  ).join("");
  handRankingsModal.classList.remove("hidden");
});

closeRankingsButton.addEventListener("click", () => {
  handRankingsModal.classList.add("hidden");
});

handRankingsModal.addEventListener("click", (e) => {
  if (e.target === handRankingsModal) {
    handRankingsModal.classList.add("hidden");
  }
});

function sendChatMessage() {
  if (!currentRoom || !currentPlayerId) return;
  const text = chatInput.value.trim();
  if (!text) return;

  const clientMessageId = createClientMessageId();
  addPendingChatMessage({
    clientMessageId,
    text,
    at: Date.now(),
    status: isSocketConnected ? "sending" : "queued",
  });

  if (isSocketConnected) {
    emit({
      type: "send_message",
      roomId: currentRoom.id,
      playerId: currentPlayerId,
      text,
      clientMessageId,
    });
  } else {
    setFeedback("Offline: message queued and will send on reconnect.", true);
  }

  chatInput.value = "";
  renderChatMessages(currentRoom);
}

chatSendButton.addEventListener("click", sendChatMessage);
chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    sendChatMessage();
  }
});

socket.on("connect", () => {
  isSocketConnected = true;
  updateConnectionStatus("online");
  flushPendingChatMessages();

  // Covers both a fresh page load/refresh (currentRoom is still null, so this
  // resumes whatever session was last saved) and the socket.io client's own
  // automatic reconnection after a network blip (currentRoom is already set,
  // so this re-attaches the same room/session over the new socket) — neither
  // case should require the player to notice anything or click a button.
  if (attemptAutoRejoin()) {
    setFeedback("Reconnected. Restoring your session...");
  } else {
    setFeedback(`Connected to realtime server: ${activeServerLabel}`);
  }
});

socket.on("disconnect", (reason) => {
  isSocketConnected = false;
  pendingMessagesList().forEach((pending) => {
    if (pending.status === "sending") {
      markPendingChatMessage(pending.clientMessageId, "queued");
    }
  });
  updateConnectionStatus("offline");
  if (currentRoom) {
    renderChatMessages(currentRoom);
  }

  // "io server disconnect" means the SERVER closed this socket on purpose —
  // in this app that only happens when the same session was opened on
  // another connection (another tab/device) and this one got evicted so
  // only one socket is ever authoritative for a player. socket.io
  // deliberately does NOT auto-reconnect after a server-initiated
  // disconnect, so claiming "reconnecting automatically" here would be a
  // lie — send the player back to the auth screen with an accurate reason
  // instead of leaving a permanently-stuck "reconnecting" message up.
  if (reason === "io server disconnect") {
    clearSession(currentRoom?.code);
    showAuthPanel();
    setFeedback("This session was opened in another tab or window. Rejoin here if you need to.", true);
    return;
  }

  setFeedback(`Disconnected from ${activeServerLabel}. Reconnecting automatically...`, true);
});

socket.io.on("reconnect_attempt", () => {
  updateConnectionStatus("reconnecting");
});

socket.io.on("reconnect_error", () => {
  updateConnectionStatus("reconnecting");
});

socket.on("connect_error", () => {
  updateConnectionStatus("offline");
  ensureRealtimeConnected("perform this action");
});

socket.on("event", (serverEvent) => {
  if (serverEvent.type === "error") {
    if (
      serverEvent.message === "Session expired. Join again with display name." ||
      serverEvent.message === "You have been removed from the room by the host."
    ) {
      clearSession(currentRoom?.code);
      showAuthPanel();
    }
    setFeedback(serverEvent.message, true);
    return;
  }

  if (serverEvent.type === "room_created") {
    currentPlayerId = serverEvent.playerId;
    currentSessionId = serverEvent.sessionId;
    saveSession({
      roomCode: serverEvent.room.code,
      sessionId: serverEvent.sessionId,
      playerId: serverEvent.playerId,
    });
    markRoomAsMostRecent(serverEvent.room.code);
    showRoomPanel(serverEvent.room);
    setFeedback("Room created. Share the room code with friends.");
    return;
  }

  if (serverEvent.type === "joined_room") {
    currentPlayerId = serverEvent.playerId;
    currentSessionId = serverEvent.sessionId;
    saveSession({
      roomCode: serverEvent.room.code,
      sessionId: serverEvent.sessionId,
      playerId: serverEvent.playerId,
    });
    markRoomAsMostRecent(serverEvent.room.code);
    showRoomPanel(serverEvent.room);
    setFeedback("Joined room successfully.");
    return;
  }

  if (serverEvent.type === "rejoined_room") {
    currentPlayerId = serverEvent.playerId;
    const cached = readSession(serverEvent.room.code);
    if (cached) {
      currentSessionId = cached.sessionId;
    }
    markRoomAsMostRecent(serverEvent.room.code);
    showRoomPanel(serverEvent.room);
    setFeedback("Rejoined room and restored state.");
    return;
  }

  if (serverEvent.type === "room_state") {
    renderRoom(serverEvent.room);
  }
});


setInterval(() => {
  if (currentRoom) {
    renderBlindScheduleSummary(currentRoom);
  }
}, 1000);

void currentSessionId;





