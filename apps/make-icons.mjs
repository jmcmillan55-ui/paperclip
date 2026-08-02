#!/usr/bin/env node
/**
 * Render the app icons.
 *
 * Build-time only: it drives the Chromium that Playwright already provides, so
 * the apps themselves stay dependency-free. Output is committed, so this only
 * needs re-running when a mark or a colour changes.
 *
 *   node apps/make-icons.mjs
 *
 * Marks are drawn inside the middle 60% of the canvas so they survive Android's
 * maskable crop, which can take a circle out of the middle 80%.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));

const GROUND = "#16301F";   // hunter deep
const BRONZE = "#C89A6B";   // bronze lift
const SIZES = [180, 192, 512, 1024];

/* A carpenter's square: the tool you check a corner with. */
const ESTIMATOR_MARK = `
  <path d="M22 22 L22 74 L78 74" fill="none" stroke="${BRONZE}"
        stroke-width="11" stroke-linecap="square" stroke-linejoin="miter"/>
  <path d="M34 74 L34 63 M46 74 L46 66 M58 74 L58 63 M70 74 L70 66"
        fill="none" stroke="${GROUND}" stroke-width="4" stroke-linecap="butt"/>`;

/* A clipboard: what the day gets written on. */
const FIELDLOG_MARK = `
  <rect x="26" y="24" width="48" height="56" rx="6" fill="none"
        stroke="${BRONZE}" stroke-width="8"/>
  <rect x="40" y="16" width="20" height="14" rx="4" fill="${BRONZE}"/>
  <path d="M38 48 H62 M38 60 H62 M38 70 H53" fill="none"
        stroke="${BRONZE}" stroke-width="6" stroke-linecap="round"/>`;

const APPS = [
  { dir: "contractor-estimator", mark: ESTIMATOR_MARK },
  { dir: "field-log", mark: FIELDLOG_MARK },
];

const page$ = async (browser, mark, size) => {
  const page = await browser.newPage({
    viewport: { width: size, height: size },
    deviceScaleFactor: 1,
  });
  await page.setContent(`<!doctype html><meta charset="utf-8">
    <style>html,body{margin:0;padding:0;background:${GROUND}}</style>
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"
         width="${size}" height="${size}" style="display:block">
      <rect width="100" height="100" fill="${GROUND}"/>
      ${mark}
    </svg>`);
  return page;
};

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium",
});

for (const app of APPS) {
  const out = resolve(here, app.dir, "icons");
  mkdirSync(out, { recursive: true });
  for (const size of SIZES) {
    const page = await page$(browser, app.mark, size);
    const buf = await page.screenshot({ omitBackground: false });
    const name = size === 180 ? "apple-touch-icon.png" : `icon-${size}.png`;
    writeFileSync(resolve(out, name), buf);
    await page.close();
    console.log(`${app.dir}/icons/${name}  ${size}x${size}  ${(buf.length / 1024).toFixed(1)} KB`);
  }
}

await browser.close();
