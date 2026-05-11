const PRODUCTION_SERVER_URL =
  window.CHIPLESS_CONFIG?.SERVER_URL || "https://your-backend.onrender.com";
const isLocalhost = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";
const socket = isLocalhost ? io() : io(PRODUCTION_SERVER_URL);

let currentRoom = null;
let currentPlayerId = "";
let currentSessionId = "";
let raiseMode = false;

const feedback = document.querySelector("#feedback");
const authPanel = document.querySelector("#auth-panel");
const roomPanel = document.querySelector("#room-panel");

const roomCodeEl = document.querySelector("#room-code");
const roomNameEl = document.querySelector("#room-name");
const roomStatusEl = document.querySelector("#room-status");
const roomStreetEl = document.querySelector("#room-street");
const potEl = document.querySelector("#pot");
const currentBetEl = document.querySelector("#current-bet");
const blindsEl = document.querySelector("#blinds");
const actingPlayerEl = document.querySelector("#acting-player");
const playersEl = document.querySelector("#players");
const logEl = document.querySelector("#log");
const actionsContainer = document.querySelector("#actions-container");

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
const raiseAmountInput = document.querySelector("#raise-amount-input");

const createRoomButton = document.querySelector("#create-room-button");
const joinRoomButton = document.querySelector("#join-room-button");
const rejoinRoomButton = document.querySelector("#rejoin-room-button");
const startHandButton = document.querySelector("#start-hand-button");
const updateBlindsButton = document.querySelector("#update-blinds-button");
const hostControlsCard = document.querySelector("#host-controls-card");
const transferHostSelect = document.querySelector("#transfer-host-select");
const transferHostButton = document.querySelector("#transfer-host-button");
const showdownControls = document.querySelector("#showdown-controls");
const showdownWinnersList = document.querySelector("#showdown-winners-list");
const declareWinnersButton = document.querySelector("#declare-winners-button");
const selectAllWinnersButton = document.querySelector("#select-all-winners-button");
const clearAllWinnersButton = document.querySelector("#clear-all-winners-button");
const handRankingsButton = document.querySelector("#hand-rankings-button");
const handRankingsModal = document.querySelector("#hand-rankings-modal");
const closeRankingsButton = document.querySelector("#close-rankings-button");
const handRankingsList = document.querySelector("#hand-rankings-list");
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

function setFeedback(message, isError) {
  feedback.style.color = isError ? "#7f1d1d" : "#14532d";
  feedback.textContent = message;
}

function toNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function saveSession(cache) {
  localStorage.setItem("chipless-session", JSON.stringify(cache));
}

function readSession() {
  const raw = localStorage.getItem("chipless-session");
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    return null;
  }
}

function showRoomPanel(room) {
  authPanel.classList.add("hidden");
  roomPanel.classList.remove("hidden");
  renderRoom(room);
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
  } else {
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

function renderActions(room, playerId) {
  if (room.street === "showdown" && room.status === "paused") {
    const isHost = room.hostPlayerId === playerId;
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
      html += `<button id="raise-button-trigger" class="action">Raise</button>`;
    } else if (action === "fold") {
      html += `<button data-action="fold" class="action">Fold</button>`;
    } else if (action === "check") {
      html += `<button data-action="check" class="action">Check</button>`;
    } else if (action === "call") {
      html += `<button data-action="call" class="action">Call</button>`;
    } else if (action === "all_in") {
      html += `<button data-action="all_in" class="action danger">All In</button>`;
    }
  });

  html += "</div>";

  if (raiseMode && actions.includes("raise") && player) {
    const minRaise = calculateMinRaise(room);
    const pot = calculatePotAmount(room);
    const halfPot = Math.floor(pot / 2);
    const allIn = player.stack;

    html += `
      <div style="margin-top: 0.6rem; display: flex; gap: 0.5rem; flex-wrap: wrap;">
        <input id="raise-amount-input" type="number" min="${minRaise}" placeholder="Raise to..." style="flex: 1; min-width: 120px;" />
        <button id="min-raise-button" class="action ghost" style="font-size: 0.85rem; padding: 0.5rem 0.6rem;">Min (${minRaise})</button>
        <button id="half-pot-button" class="action ghost" style="font-size: 0.85rem; padding: 0.5rem 0.6rem;">½ Pot (${halfPot})</button>
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

  const halfPotButton = document.querySelector("#half-pot-button");
  if (halfPotButton) {
    halfPotButton.addEventListener("click", () => {
      const amount = Math.floor(calculatePotAmount(room) / 2);
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

function renderRoom(room) {
  currentRoom = room;
  roomCodeEl.textContent = room.code;
  roomNameEl.textContent = room.name;
  roomStatusEl.textContent = room.status;
  roomStreetEl.textContent = room.street;
  
  const totalPot = Array.isArray(room.pots) ? room.pots.reduce((sum, p) => sum + p.amount, 0) : 0;
  potEl.textContent = String(totalPot);
  currentBetEl.textContent = String(room.currentBet);
  blindsEl.textContent = `${room.blinds.smallBlind} / ${room.blinds.bigBlind}`;

  const acting = room.players.find((p) => p.id === room.actingPlayerId);
  actingPlayerEl.textContent = acting ? acting.displayName : "-";

  playersEl.innerHTML = room.players
    .map((p) => {
      const isActive = p.id === room.actingPlayerId ? "active" : "";
      const me = p.id === currentPlayerId ? " (you)" : "";
      const connected = p.connected ? "online" : "offline";
      const payoutInfo = room.payouts?.find((payout) => payout.playerId === p.id)
        ? ` [Won ${room.payouts.find((payout) => payout.playerId === p.id).amount}]`
        : "";
      const dealerBadge = p.seat === room.dealerSeat ? " 🎰" : "";
      const sbBadge = p.seat === room.smallBlindSeat ? " 🔸" : "";
      return `<li class="${isActive}">${p.displayName}${me} - ${p.role} - seat ${p.seat}${dealerBadge}${sbBadge} - stack ${p.stack} - ${connected}${payoutInfo}</li>`;
    })
    .join("");

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

  chatMessagesEl.innerHTML =
    (room.messages || [])
      .slice(-20)
      .map((msg) => `<div style="font-size: 0.9rem; margin-bottom: 0.4rem;"><strong>${msg.playerName}:</strong> ${msg.text}</div>`)
      .join("") || "<div style='color: var(--muted); font-size: 0.9rem;'>No messages yet.</div>";
  chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;

  renderActions(room, currentPlayerId);

  // Show/hide host controls based on whether current player is host
  const isHost = currentPlayerId === room.hostPlayerId;
  hostControlsCard.style.display = isHost ? 'block' : 'none';
  
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

    const canDeclareShowdown = room.status === "paused" && room.street === "showdown";
    showdownControls.classList.toggle("hidden", !canDeclareShowdown);

    if (canDeclareShowdown) {
      const candidates = room.players.filter((p) => p.inHand && p.role !== "spectator");
      showdownWinnersList.innerHTML = candidates
        .map(
          (p) => `
            <label class="showdown-winner-option">
              <input type="checkbox" value="${p.id}" />
              <span>${p.displayName}</span>
            </label>
          `
        )
        .join("");
    } else {
      showdownWinnersList.innerHTML = "";
    }
  } else {
    showdownControls.classList.add("hidden");
  }
}

function emit(event) {
  socket.emit("event", event);
}

createRoomButton.addEventListener("click", () => {
  emit({
    type: "create_room",
    payload: {
      displayName: createDisplayName.value.trim(),
      name: createRoomName.value.trim(),
      smallBlind: toNumber(createSb.value, 25),
      bigBlind: toNumber(createBb.value, 50),
      startingStack: toNumber(createStack.value, 1000),
    },
  });
});

joinRoomButton.addEventListener("click", () => {
  const payload = {
    roomCode: joinRoomCode.value.trim().toUpperCase(),
    displayName: joinDisplayName.value.trim(),
    role: joinRole.value,
  };

  emit({ type: "join_room", payload });
});

rejoinRoomButton.addEventListener("click", () => {
  const cached = readSession();
  if (!cached) {
    setFeedback("No previous session found in this browser.", true);
    return;
  }

  emit({
    type: "rejoin_room",
    payload: {
      roomCode: cached.roomCode,
      sessionId: cached.sessionId,
    },
  });
});

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

selectAllWinnersButton.addEventListener("click", () => {
  showdownWinnersList.querySelectorAll("input[type='checkbox']").forEach((cb) => {
    cb.checked = true;
  });
});

clearAllWinnersButton.addEventListener("click", () => {
  showdownWinnersList.querySelectorAll("input[type='checkbox']").forEach((cb) => {
    cb.checked = false;
  });
});

declareWinnersButton.addEventListener("click", () => {
  if (!currentRoom || !currentPlayerId) {
    return;
  }

  const selectedWinnerIds = [...showdownWinnersList.querySelectorAll("input[type='checkbox']:checked")].map((el) => el.value);
  if (selectedWinnerIds.length === 0) {
    setFeedback("Select at least one winner.", true);
    return;
  }

  const winnerNames = selectedWinnerIds.map((id) => {
    const winner = currentRoom.players.find((p) => p.id === id);
    return winner ? winner.displayName : "Unknown";
  }).join(", ");

  if (!confirm(`Award pot to ${winnerNames}? This cannot be undone.`)) {
    return;
  }

  emit({
    type: "declare_winners",
    roomId: currentRoom.id,
    actorPlayerId: currentPlayerId,
    winnerIds: selectedWinnerIds,
  });
});

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

  emit({
    type: "send_message",
    roomId: currentRoom.id,
    playerId: currentPlayerId,
    text,
  });
  chatInput.value = "";
}

chatSendButton.addEventListener("click", sendChatMessage);
chatInput.addEventListener("keypress", (e) => {
  if (e.key === "Enter") {
    sendChatMessage();
  }
});

socket.on("connect", () => {
  setFeedback("Connected to realtime server.");
});

socket.on("disconnect", () => {
  setFeedback("Disconnected. You can rejoin your room when connection returns.", true);
});

socket.on("event", (serverEvent) => {
  if (serverEvent.type === "error") {
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
    showRoomPanel(serverEvent.room);
    setFeedback("Joined room successfully.");
    return;
  }

  if (serverEvent.type === "rejoined_room") {
    currentPlayerId = serverEvent.playerId;
    const cached = readSession();
    if (cached) {
      currentSessionId = cached.sessionId;
    }
    showRoomPanel(serverEvent.room);
    setFeedback("Rejoined room and restored state.");
    return;
  }

  if (serverEvent.type === "room_state") {
    renderRoom(serverEvent.room);
  }
});

const cached = readSession();
if (cached) {
  joinRoomCode.value = cached.roomCode;
  setFeedback("Previous session found. Click Rejoin Last Session.");
}

void currentSessionId;





