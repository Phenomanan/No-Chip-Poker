// Assembles the GitHub Pages site in ./_site:
//   - everything in apps/web, copied unchanged to the site root (the live web app)
//   - apps/ios/legal under /legal/ (privacy policy, terms, support for the App Store listing)
// The web app's files are never modified; the legal pages only add new URLs.
import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const siteDir = path.join(root, "_site");

export async function buildPages() {
  await rm(siteDir, { recursive: true, force: true });
  await mkdir(siteDir, { recursive: true });
  await cp(path.join(root, "apps/web"), siteDir, { recursive: true });
  await mkdir(path.join(siteDir, "legal"), { recursive: true });
  await cp(path.join(root, "apps/ios/legal"), path.join(siteDir, "legal"), { recursive: true });
  return siteDir;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(`Pages site built in ${await buildPages()}`);
}
