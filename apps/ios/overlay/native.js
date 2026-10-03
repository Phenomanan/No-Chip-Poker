// iOS-only behaviour layered on the unmodified web app (apps/web). It works from the
// outside: it reads the live Socket.IO connection (exposed by the native bootstrap),
// adds a few pieces of UI to the page, and calls Capacitor plugins when they exist.
// Everything is guarded, so a missing plugin or changed markup never breaks the game.
(function () {
  "use strict";

  const LEGAL_BASE = "https://phenomanan.github.io/No-Chip-Poker/legal";
  const cap = window.Capacitor;
  const plugins = cap?.Plugins ?? {};
  const { Haptics, KeepAwake, PushNotifications, App: AppPlugin } = plugins;

  const plugin = (p) => (p && typeof p === "object" ? "yes" : "no");
  console.log(`[native] overlay ready: haptics=${plugin(Haptics)} keepAwake=${plugin(KeepAwake)} push=${plugin(PushNotifications)} app=${plugin(AppPlugin)} splash=${plugin(plugins.SplashScreen)}`);

  const state = { playerId: null, room: null, awake: false, lastActing: null, lastAwaitingDeal: false, pushAsked: false };
  const BLOCK_KEY = "native-blocked-names";

  const safely = (fn) => {
    try {
      return fn();
    } catch (error) {
      return undefined;
    }
  };
  const socketRef = () => window.__chiplessSocket;
  const send = (event) => socketRef()?.emit("event", event);
  const esc = (value) => String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  // ------------------------------------------------------------------ blocked players (this device)
  const readBlocked = () => safely(() => JSON.parse(localStorage.getItem(BLOCK_KEY) || "[]")) || [];
  const writeBlocked = (names) => safely(() => localStorage.setItem(BLOCK_KEY, JSON.stringify(names)));
  const isBlocked = (name) => readBlocked().includes(String(name).toLowerCase());
  function setBlocked(name, blocked) {
    const names = new Set(readBlocked());
    if (blocked) names.add(String(name).toLowerCase());
    else names.delete(String(name).toLowerCase());
    writeBlocked([...names]);
    decorateChat();
    refreshBlockedLink();
  }

  // ------------------------------------------------------------------ small UI kit (sheet + toast)
  function ensureStyles() {
    if (document.getElementById("native-ui-style")) return;
    const style = document.createElement("style");
    style.id = "native-ui-style";
    style.textContent = `
      .native-sheet-backdrop{position:fixed;inset:0;z-index:300;background:rgba(0,0,0,.55);display:flex;align-items:flex-end;justify-content:center}
      .native-sheet{width:min(520px,100%);background:var(--bg-elev,#18231d);color:var(--ink,#f3ecd8);border:1px solid var(--stroke,#3b4a3f);border-radius:18px 18px 0 0;padding:1rem 1rem calc(1rem + env(safe-area-inset-bottom,0px));display:grid;gap:.5rem}
      .native-sheet h4{margin:0 0 .25rem;font-family:var(--font-display,serif)}
      .native-sheet button{width:100%;margin:0}
      .native-sheet .danger{background:var(--danger,#c0394e);color:#fff}
      .native-sheet .quiet{background:transparent;color:var(--ink,#f3ecd8);border:1px solid var(--stroke,#3b4a3f)}
      .native-toast{position:fixed;left:50%;bottom:calc(5.5rem + env(safe-area-inset-bottom,0px));transform:translateX(-50%);z-index:400;background:rgba(0,0,0,.85);color:#fff;border-radius:999px;padding:.55rem 1rem;font-size:.9rem;max-width:90vw;text-align:center}
      .native-msg-action{all:unset;cursor:pointer;margin-left:.4rem;padding:0 .35rem;color:var(--muted,#9fb0a5);font-size:1.05rem;line-height:1;border-radius:6px}
      .native-link-row{display:flex;gap:1rem;justify-content:center;flex-wrap:wrap;margin:1.2rem 0 .5rem;font-size:.85rem}
      .native-link-row a,.native-link-row button{all:unset;cursor:pointer;color:var(--muted,#9fb0a5);text-decoration:underline}
      .native-practice small{display:block;color:var(--muted,#9fb0a5);margin:.2rem 0 .6rem}
    `;
    document.head.appendChild(style);
  }

  function toast(message) {
    ensureStyles();
    const el = document.createElement("div");
    el.className = "native-toast";
    el.textContent = message;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2600);
  }

  function openSheet(title, buttons) {
    ensureStyles();
    const backdrop = document.createElement("div");
    backdrop.className = "native-sheet-backdrop";
    const sheet = document.createElement("div");
    sheet.className = "native-sheet";
    sheet.setAttribute("role", "dialog");
    sheet.innerHTML = `<h4>${esc(title)}</h4>`;
    const close = () => backdrop.remove();
    for (const spec of buttons) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = spec.label;
      if (spec.className) b.className = spec.className;
      b.addEventListener("click", () => {
        close();
        spec.onClick?.();
      });
      sheet.appendChild(b);
    }
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "quiet";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", close);
    sheet.appendChild(cancel);
    backdrop.addEventListener("click", (e) => e.target === backdrop && close());
    backdrop.appendChild(sheet);
    document.body.appendChild(backdrop);
    return close;
  }

  // ------------------------------------------------------------------ chat: report / block / mute
  function visibleMessages() {
    return (state.room?.messages || []).slice(-20);
  }

  function decorateChat() {
    const box = document.getElementById("chat-messages");
    if (!box || !state.room) return;
    const messages = visibleMessages();
    const rows = [...box.children];
    messages.forEach((msg, i) => {
      const row = rows[i];
      if (!row || row.dataset.msgId === msg.id) {
        if (row) row.style.display = isBlocked(msg.playerName) && msg.playerId !== state.playerId ? "none" : "";
        return;
      }
      row.dataset.msgId = msg.id;
      row.style.display = isBlocked(msg.playerName) && msg.playerId !== state.playerId ? "none" : "";
      if (msg.playerId === state.playerId) return;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "native-msg-action";
      button.setAttribute("aria-label", `Options for ${msg.playerName}'s message`);
      button.textContent = "⋯";
      button.addEventListener("click", () => openMessageSheet(msg));
      row.appendChild(button);
    });
  }

  function openMessageSheet(msg) {
    const isHost = state.room?.hostPlayerId === state.playerId;
    const muted = (state.room?.mutedPlayerIds || []).includes(msg.playerId);
    const buttons = [
      {
        label: "Report this message",
        className: "danger",
        onClick: () => send({ type: "report_message", roomId: state.room.id, actorPlayerId: state.playerId, messageId: msg.id, reason: "reported from the app" }),
      },
      { label: `Block ${msg.playerName}`, onClick: () => { setBlocked(msg.playerName, true); toast(`${msg.playerName} is blocked on this device.`); } },
    ];
    if (isHost) {
      buttons.push({
        label: muted ? `Unmute ${msg.playerName}` : `Mute ${msg.playerName} in this room`,
        onClick: () => send({ type: "mute_player", roomId: state.room.id, actorPlayerId: state.playerId, targetPlayerId: msg.playerId, muted: !muted }),
      });
    }
    openSheet(`${msg.playerName}: "${msg.text.slice(0, 60)}"`, buttons);
  }

  function refreshBlockedLink() {
    const link = document.getElementById("native-blocked-link");
    if (!link) return;
    const count = readBlocked().length;
    link.hidden = count === 0;
    link.textContent = `Blocked players (${count})`;
  }

  function openBlockedSheet() {
    const names = readBlocked();
    if (names.length === 0) return;
    openSheet("Blocked players", names.map((name) => ({ label: `Unblock ${name}`, onClick: () => { setBlocked(name, false); toast(`${name} unblocked.`); } })));
  }

  // ------------------------------------------------------------------ extra UI injected into the page
  function injectPracticeCard() {
    const form = document.querySelector("#auth-panel .form-grid");
    if (!form || document.getElementById("native-practice-card")) return;
    ensureStyles();
    const card = document.createElement("div");
    card.className = "card native-practice";
    card.id = "native-practice-card";
    card.innerHTML = `
      <h3>Practice Table</h3>
      <small>Play a full hand on your own with practice players. No friends needed.</small>
      <label>Display Name <input id="native-practice-name" placeholder="Alex" /></label>
      <button id="native-practice-start" type="button">Start Practice Table</button>`;
    form.insertBefore(card, form.firstChild);
    const nameInput = card.querySelector("#native-practice-name");
    nameInput.value = safely(() => localStorage.getItem("native-practice-name")) || "";
    card.querySelector("#native-practice-start").addEventListener("click", () => {
      const displayName = nameInput.value.trim() || "You";
      safely(() => localStorage.setItem("native-practice-name", displayName));
      state.practiceRequested = true;
      send({ type: "create_room", payload: { name: "Practice Table", displayName, smallBlind: 25, bigBlind: 50, startingStack: 1000 } });
    });
  }

  function injectFooterLinks() {
    const shell = document.querySelector("main.shell");
    if (!shell || document.getElementById("native-links")) return;
    ensureStyles();
    const row = document.createElement("div");
    row.className = "native-link-row";
    row.id = "native-links";
    row.innerHTML = `
      <a href="${LEGAL_BASE}/privacy.html" target="_blank" rel="noopener">Privacy</a>
      <a href="${LEGAL_BASE}/terms.html" target="_blank" rel="noopener">Terms</a>
      <a href="${LEGAL_BASE}/support.html" target="_blank" rel="noopener">Support</a>
      <button id="native-blocked-link" type="button" hidden></button>`;
    shell.appendChild(row);
    row.querySelector("#native-blocked-link").addEventListener("click", openBlockedSheet);
    refreshBlockedLink();
  }

  function setupDom() {
    injectPracticeCard();
    injectFooterLinks();
    const chat = document.getElementById("chat-messages");
    if (chat && !chat.dataset.nativeObserved) {
      chat.dataset.nativeObserved = "1";
      new MutationObserver(decorateChat).observe(chat, { childList: true });
    }
  }

  // ------------------------------------------------------------------ haptics, keep-awake
  const buzz = (style) => safely(() => Haptics?.impact?.({ style }));
  function setAwake(on) {
    if (on === state.awake) return;
    state.awake = on;
    safely(() => (on ? KeepAwake?.keepAwake?.() : KeepAwake?.allowSleep?.()));
  }

  // ------------------------------------------------------------------ push notifications
  function registerPushToken(token) {
    if (!state.room || !state.playerId || !token) return;
    send({ type: "register_push_token", roomId: state.room.id, actorPlayerId: state.playerId, token, platform: "ios" });
  }

  function setupPush() {
    if (!PushNotifications || state.pushAsked) return;
    state.pushAsked = true;
    safely(() => {
      PushNotifications.addListener("registration", (result) => {
        state.pushToken = result?.value;
        registerPushToken(state.pushToken);
      });
      PushNotifications.addListener("registrationError", () => {});
      // Ask once, when the player first enters a room, so the prompt has context.
      Promise.resolve(PushNotifications.requestPermissions()).then((perm) => {
        if (perm?.receive === "granted") PushNotifications.register();
      });
    });
  }

  function reportAppState(active) {
    if (state.room && state.playerId) send({ type: "app_state", roomId: state.room.id, actorPlayerId: state.playerId, active });
  }

  // ------------------------------------------------------------------ socket events
  function onEvent(evt) {
    if (!evt) return;
    if (evt.type === "room_created" || evt.type === "joined_room" || evt.type === "rejoined_room") {
      state.playerId = evt.playerId;
      state.room = evt.room;
      setupPush();
      registerPushToken(state.pushToken);
      if (evt.type === "room_created" && state.practiceRequested) {
        state.practiceRequested = false;
        send({ type: "add_bots", roomId: evt.room.id, actorPlayerId: evt.playerId, count: 3 });
      }
    }
    if (evt.type === "notice") toast(evt.message);
    if (evt.type !== "room_state") return;

    const room = evt.room;
    state.room = room;
    setAwake(room.status === "in_hand" || room.status === "paused");
    if (room.actingPlayerId && room.actingPlayerId !== state.lastActing && room.actingPlayerId === state.playerId) buzz("HEAVY");
    if (room.awaitingDeal && !state.lastAwaitingDeal && room.hostPlayerId === state.playerId) buzz("MEDIUM");
    state.lastActing = room.actingPlayerId;
    state.lastAwaitingDeal = Boolean(room.awaitingDeal);
    decorateChat();
  }

  function attach() {
    const socket = socketRef();
    if (!socket) {
      setTimeout(attach, 150);
      return;
    }
    socket.on("event", onEvent);
    // After a reconnect the server forgets which sockets belong to whom until we rejoin;
    // tell it our state again once the app's own rejoin has gone through.
    socket.on("connect", () => setTimeout(() => reportAppState(document.visibilityState !== "hidden"), 800));
  }

  // ------------------------------------------------------------------ app lifecycle
  document.addEventListener("visibilitychange", () => {
    const active = document.visibilityState !== "hidden";
    reportAppState(active);
    const socket = socketRef();
    if (active && socket && !socket.connected) socket.connect();
  });
  safely(() => AppPlugin?.addListener?.("appStateChange", (s) => {
    reportAppState(Boolean(s?.isActive));
    const socket = socketRef();
    if (s?.isActive && socket && !socket.connected) socket.connect();
  }));

  attach();
  const domTimer = setInterval(setupDom, 400);
  setupDom();
  setTimeout(() => clearInterval(domTimer), 60000);
  window.__nativeOverlay = { state, openMessageSheet, setBlocked, isBlocked };
})();
