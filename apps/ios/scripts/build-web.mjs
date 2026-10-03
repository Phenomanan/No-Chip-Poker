// Assembles the web bundle for the iOS app in apps/ios/www.
//
// The iOS app does NOT fork the web app. It copies apps/web (read-only) and layers
// apps/ios/overlay on top: a self-contained bootstrap (no CDN), bundled fonts,
// safe-area/native styles and native.js. apps/web is never written to.
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const iosDir = path.resolve(here, "..");
const webDir = path.resolve(iosDir, "../web");
const outDir = path.join(iosDir, "www");
const overlayDir = path.join(iosDir, "overlay");

function mustReplace(source, pattern, replacement, what) {
  if (!pattern.test(source)) {
    throw new Error(`apps/web/index.html changed shape: could not find ${what}. Update apps/ios/scripts/build-web.mjs.`);
  }
  return source.replace(pattern, replacement);
}

export async function buildIosWeb() {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  // Copy the web app's real files only (not stray shims such as apps/web/npm*).
  await cp(path.join(webDir, "src"), path.join(outDir, "src"), { recursive: true });
  let html = await readFile(path.join(webDir, "index.html"), "utf8");

  // Overlay: replacements and additions.
  await cp(path.join(overlayDir, "bootstrap.js"), path.join(outDir, "src/bootstrap.js"));
  await cp(path.join(overlayDir, "native.js"), path.join(outDir, "src/native.js"));
  await cp(path.join(overlayDir, "native.css"), path.join(outDir, "src/native.css"));
  await cp(path.join(overlayDir, "fonts"), path.join(outDir, "fonts"), { recursive: true });
  await cp(path.join(overlayDir, "vendor"), path.join(outDir, "vendor"), { recursive: true });

  // index.html: drop Google Fonts, cover the whole screen (notch), add native.css.
  html = mustReplace(html, /\s*<link[^>]*fonts\.googleapis\.com[^>]*\/?>/g, "", "Google Fonts links");
  html = mustReplace(html, /\s*<link[^>]*fonts\.gstatic\.com[^>]*\/?>/g, "", "gstatic preconnect");
  html = mustReplace(
    html,
    /<meta name="viewport"[^>]*\/?>/,
    '<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />',
    "viewport meta"
  );
  html = mustReplace(
    html,
    /(<link rel="stylesheet" href="\.\/src\/styles\.css"\s*\/>)/,
    '$1\n    <link rel="stylesheet" href="./src/native.css" />',
    "styles.css link"
  );
  await writeFile(path.join(outDir, "index.html"), html);

  return outDir;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = await buildIosWeb();
  const files = await readdir(out);
  console.log(`iOS web bundle built in ${out} (${files.join(", ")})`);
}
