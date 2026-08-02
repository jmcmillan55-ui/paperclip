#!/usr/bin/env node
/**
 * Derive the hosted-artifact build from index.html.
 *
 * index.html is the source of truth and is a complete standalone document, so
 * it opens by double-clicking it from disk. The Artifact host supplies its own
 * <!doctype>/<head>/<body> skeleton and renders the file contents inside the
 * body, so publishing the full document verbatim would nest a second document.
 *
 * This strips the wrapper and keeps <title>, the <style> block, and the body
 * contents — one source, two outputs, no drift.
 *
 *   node apps/field-log/build-artifact.mjs [outfile]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const srcPath = resolve(here, "index.html");
const outPath = process.argv[2] ? resolve(process.argv[2]) : resolve(here, "dist-artifact.html");

const src = readFileSync(srcPath, "utf8");

const pick = (re, what) => {
  const m = src.match(re);
  if (!m) throw new Error(`Could not find ${what} in ${srcPath}`);
  return m[1];
};

const title = pick(/<title>([\s\S]*?)<\/title>/i, "<title>").trim();
const style = pick(/<style>([\s\S]*?)<\/style>/i, "<style> block");
const body = pick(/<body[^>]*>([\s\S]*?)<\/body>/i, "<body> contents").trim();

const out = `<title>${title}</title>\n<style>${style}</style>\n${body}\n`;
writeFileSync(outPath, out);

const kb = (n) => (n / 1024).toFixed(1) + " KB";
console.log(`built ${outPath} (${kb(out.length)}) from ${kb(src.length)} source`);

// The page must stay self-contained: a strict CSP blocks every external host.
const offenders = [
  [/<script[^>]+\bsrc=/i, "external <script src>"],
  [/<link[^>]+rel=["']?stylesheet/i, "external stylesheet <link>"],
  [/@import\s+url\(/i, "CSS @import url()"],
  [/https?:\/\/(?!www\.w3\.org)/i, "absolute http(s) URL"]
];
// XML namespace URIs are identifiers, not fetches — no parser dereferences them,
// and CSP never sees them. Strip xmlns="..." before the absolute-URL test so a
// generated KML document does not trip a guard meant for scripts and stylesheets.
const scanned = out.replace(/\sxmlns(:[A-Za-z0-9_-]+)?=(["'])[^"']*\2/g, "");
const found = offenders.filter(([re]) => re.test(scanned)).map(([, label]) => label);
if (found.length) {
  console.error("External references found — the artifact CSP will block these:\n  " + found.join("\n  "));
  process.exit(1);
}
console.log("self-contained: no external references");
