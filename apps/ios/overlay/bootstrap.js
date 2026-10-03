// iOS replacement for apps/web/src/bootstrap.js. The web version loads the
// Socket.IO client from a CDN (or the dev server); the app must be self-contained,
// so this loads the copy bundled in ./vendor and then the shared app.js.
const nativeReady = Boolean(window.Capacitor?.isNativePlatform?.());
document.documentElement.classList.add("native-app");
if (nativeReady) document.documentElement.classList.add("native-ios");

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(script);
  });
}

// The splash screen stays up until the page has painted (launchAutoHide is off), so
// there is no blank WebView flash; a timeout makes sure it can never get stuck.
function hideSplash() {
  try {
    window.Capacitor?.Plugins?.SplashScreen?.hide?.();
  } catch (error) {
    // optional
  }
}
setTimeout(hideSplash, 8000);

async function start() {
  await loadScript("./vendor/socket.io.min.js");

  // Hand the live socket to native.js (haptics, keep-awake, push) without touching app.js.
  const realIo = window.io;
  window.io = (...args) => {
    const socket = realIo(...args);
    window.__chiplessSocket = socket;
    return socket;
  };

  await loadScript("./src/native.js").catch(() => {});
  await import("./app.js");
  requestAnimationFrame(() => requestAnimationFrame(hideSplash));
}

start().catch((error) => {
  console.error(error);
  hideSplash();
});
