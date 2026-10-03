// The Pages site must serve the web app exactly as it is in apps/web, plus the legal pages.
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildPages } from "./build-pages.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failed = 0;
const check = (name, ok, detail) => {
  if (ok) console.log(`PASS ${name}`);
  else {
    failed += 1;
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
};
const walk = async (dir) => (await readdir(dir, { withFileTypes: true, recursive: true })).filter((e) => e.isFile()).map((e) => path.join(e.parentPath, e.name));
const hash = async (f) => createHash("sha256").update(await readFile(f)).digest("hex");

const site = await buildPages();
const webFiles = await walk(path.join(root, "apps/web"));
let same = true;
for (const file of webFiles) {
  const rel = path.relative(path.join(root, "apps/web"), file);
  try {
    if ((await hash(file)) !== (await hash(path.join(site, rel)))) same = false;
  } catch {
    same = false;
  }
}
check("every apps/web file is published unchanged", same && webFiles.length > 0);
for (const page of ["index.html", "privacy.html", "terms.html", "support.html", "legal.css"]) {
  check(`legal/${page} is published`, (await readFile(path.join(site, "legal", page), "utf8")).length > 100);
}
const privacy = await readFile(path.join(site, "legal/privacy.html"), "utf8");
check("the privacy policy covers chat, push tokens and the 24-hour deletion", /chat/i.test(privacy) && /push/i.test(privacy) && /24 hours/.test(privacy));
check("the web app's index.html is the site root", (await readFile(path.join(site, "index.html"), "utf8")).includes("No-Chip Poker"));
console.log(failed ? `\npages build: ${failed} failed` : "\npages build: all passed");
if (failed) process.exitCode = 1;
