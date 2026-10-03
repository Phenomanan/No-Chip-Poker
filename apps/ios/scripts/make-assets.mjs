// Renders assets/icon.svg and assets/splash.svg into the Xcode asset catalog.
// Needs Playwright + Chrome. The App Store icon must be a flat 1024px square (no alpha).
import { chromium } from "playwright";
import { readFile, copyFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const assets = path.resolve(here, "../assets");
const catalog = path.resolve(here, "../ios/App/App/Assets.xcassets");

const browser = await chromium.launch({ channel: "chrome", headless: true });
async function render(svgFile, size, outFile) {
  const svg = await readFile(path.join(assets, svgFile), "utf8");
  const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  await page.setContent(`<html><body style="margin:0;background:#08201a">${svg}</body></html>`);
  await page.screenshot({ path: outFile, omitBackground: false });
  await page.close();
}
const icon = path.join(catalog, "AppIcon.appiconset/AppIcon-512@2x.png");
await render("icon.svg", 1024, icon);
const splash = path.join(catalog, "Splash.imageset/splash-2732x2732.png");
await render("splash.svg", 2732, splash);
await copyFile(splash, path.join(catalog, "Splash.imageset/splash-2732x2732-1.png"));
await copyFile(splash, path.join(catalog, "Splash.imageset/splash-2732x2732-2.png"));
await copyFile(icon, path.join(assets, "icon-1024.png"));
await browser.close();
console.log("icon and splash written");
