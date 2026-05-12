const isLocalhost = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";

function loadSocketClient(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Failed to load Socket.IO client from ${src}`));
    document.head.appendChild(script);
  });
}

async function start() {
  const primarySrc = isLocalhost ? "/socket.io/socket.io.js" : "https://cdn.socket.io/4.8.1/socket.io.min.js";
  const fallbackSrc = isLocalhost ? null : "/socket.io/socket.io.js";

  try {
    await loadSocketClient(primarySrc);
  } catch (error) {
    if (!fallbackSrc) {
      throw error;
    }

    await loadSocketClient(fallbackSrc);
  }

  await import("./app.js");
}

void start();