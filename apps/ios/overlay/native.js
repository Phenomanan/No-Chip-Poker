// iOS-only behaviour that listens to the shared web app from the outside. It reads
// the live socket (exposed by the native bootstrap) and calls Capacitor plugins when
// they exist. Everything is guarded, so a missing plugin never breaks the game.
(function () {
  const cap = window.Capacitor;
  const plugins = cap?.Plugins ?? {};
  const haptics = plugins.Haptics;
  const keepAwake = plugins.KeepAwake;

  let playerId = null;
  let lastActing = null;
  let lastAwaitingDeal = false;
  let awake = false;

  const buzz = (style) => {
    try {
      haptics?.impact?.({ style });
    } catch (error) {
      // haptics are a nicety
    }
  };

  function setAwake(on) {
    if (on === awake) return;
    awake = on;
    try {
      if (on) keepAwake?.keepAwake?.();
      else keepAwake?.allowSleep?.();
    } catch (error) {
      // optional
    }
  }

  function onEvent(evt) {
    if (!evt) return;
    if (evt.type === "room_created" || evt.type === "joined_room") playerId = evt.playerId;
    if (evt.type !== "room_state") return;
    const room = evt.room;
    setAwake(room.status === "in_hand" || room.status === "paused");

    if (room.actingPlayerId && room.actingPlayerId !== lastActing && room.actingPlayerId === playerId) {
      buzz("HEAVY"); // it's your turn
    }
    if (room.awaitingDeal && !lastAwaitingDeal && room.hostPlayerId === playerId) {
      buzz("MEDIUM"); // host: cards are due
    }
    lastActing = room.actingPlayerId;
    lastAwaitingDeal = Boolean(room.awaitingDeal);
  }

  function attach() {
    const socket = window.__chiplessSocket;
    if (!socket) {
      setTimeout(attach, 200);
      return;
    }
    socket.on("event", onEvent);
  }
  attach();

  // Coming back from the background: make sure the connection is alive.
  document.addEventListener("visibilitychange", () => {
    const socket = window.__chiplessSocket;
    if (document.visibilityState === "visible" && socket && !socket.connected) socket.connect();
  });
})();
