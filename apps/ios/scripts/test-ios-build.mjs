// Guards for the iOS bundle build. Fast, no browser:
//  - building the iOS bundle never modifies apps/web (the web app stays as-is)
//  - the shared web code is copied verbatim (app.js, styles.css, theme.js)
//  - the bundle has no third-party hosts (fonts, CDN scripts) so it works offline
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildIosWeb } from "./build-web.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "../../web");
let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    passed += 1;
    console.log(`PASS ${name}`);
  } else {
    failed += 1;
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else out.push(full);
  }
  return out;
}

async function snapshot(dir) {
  const map = new Map();
  for (const file of await walk(dir)) {
    map.set(path.relative(dir, file), createHash("sha256").update(await readFile(file)).digest("hex"));
  }
  return map;
}

const before = await snapshot(webDir);
const out = await buildIosWeb();
const after = await snapshot(webDir);

check("building the iOS bundle leaves apps/web untouched", before.size === after.size && [...before].every(([f, h]) => after.get(f) === h));

const bundle = await snapshot(out);
for (const shared of ["src/app.js", "src/styles.css", "src/theme.js", "src/config.js"]) {
  check(`${shared} is the web app's file, unmodified`, bundle.get(shared) === before.get(shared));
}
check("bootstrap is replaced by the self-contained native one", bundle.get("src/bootstrap.js") !== before.get("src/bootstrap.js"));
check("bundle ships its own fonts and Socket.IO client", [...bundle.keys()].some((f) => f.endsWith(".woff2")) && bundle.has("vendor/socket.io.min.js"));
check("stray web files (npm/npx shims) are not copied", ![...bundle.keys()].some((f) => /^(npm|npx)/.test(f)));

// Third-party hosts: only the game server URL in config.js may appear.
const bad = [];
for (const file of ["index.html", "src/bootstrap.js", "src/native.js", "src/native.css", "src/theme.js", "src/styles.css"]) {
  const text = await readFile(path.join(out, file), "utf8");
  for (const m of text.matchAll(/https?:\/\/[^\s"')`]+/g)) {
    // Links to the privacy/terms/support pages are navigations, not downloaded resources.
    if (/^https:\/\/phenomanan\.github\.io\/No-Chip-Poker\/legal/.test(m[0])) continue;
    bad.push(`${file}: ${m[0]}`);
  }
}
check("no external URLs in the shell, styles or scripts", bad.length === 0, bad.slice(0, 5).join(" | "));
const appUrls = [...(await readFile(path.join(out, "src/app.js"), "utf8")).matchAll(/https?:\/\/[^\s"'`)]+/g)].map((m) => m[0]);
check("app.js only references the game server", appUrls.every((u) => /onrender\.com|your-backend|localhost/.test(u)), appUrls.join(" | "));

const size = (await Promise.all((await walk(out)).map(async (f) => (await stat(f)).size))).reduce((a, b) => a + b, 0);
check("bundle is small (under 1 MB)", size < 1_000_000, `${size} bytes`);

console.log(`\nios build: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
