// Validates src/sanitize.ts. Catches regressions where a malformed or hostile
// import could leak into the renderer / SVG export.
//   node scripts/test-sanitize.mjs

import { createRequire } from "node:module";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const compile = (src) =>
   ts.transpileModule(src, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
   }).outputText;

const tmp = mkdtempSync(join(tmpdir(), "hex-sanitize-"));
const writeMod = (name, srcPath) => {
   const src = readFileSync(srcPath, "utf8")
      .replace(/from ["']\.\/types["']/g, `from "./types.mjs"`)
      .replace(/from ["']\.\/utilities\/i18n["']/g, "");
   writeFileSync(join(tmp, name), compile(src));
};
writeMod("types.mjs", new URL("../src/types.ts", import.meta.url));
writeMod("sanitize.mjs", new URL("../src/sanitize.ts", import.meta.url));
const { sanitizeMapState, sanitizeColor } = await import(`file://${tmp}/sanitize.mjs`);

let failed = 0;
const eq = (label, actual, expected) => {
   const ok = JSON.stringify(actual) === JSON.stringify(expected);
   console.log(`${ok ? "✓" : "✗"} ${label}${ok ? "" : `\n   actual:   ${JSON.stringify(actual)}\n   expected: ${JSON.stringify(expected)}`}`);
   if (!ok) failed++;
};
const ok = (label, cond) => {
   console.log(`${cond ? "✓" : "✗"} ${label}`);
   if (!cond) failed++;
};

// ── Color sanitiser ─────────────────────────────────────────────────────────
eq("color: #abc", sanitizeColor("#abc"), "#abc");
eq("color: #aabbcc", sanitizeColor("#aabbcc"), "#aabbcc");
eq("color: #aabbccdd (with alpha)", sanitizeColor("#aabbccdd"), "#aabbccdd");
eq("color: hsl(123 70% 55%)", sanitizeColor("hsl(123 70% 55%)"), "hsl(123 70% 55%)");
eq("color: rgb(255, 0, 0)", sanitizeColor("rgb(255, 0, 0)"), "rgb(255, 0, 0)");

// Hostile / malformed → fallback
eq("color: hostile attribute injection", sanitizeColor('#aaa" onclick="x"'), "#888888");
eq("color: hostile <script>", sanitizeColor("<script>"), "#888888");
eq("color: amp injection", sanitizeColor("#aaa&b=c"), "#888888");
eq("color: javascript:url", sanitizeColor("javascript:alert(1)"), "#888888");
eq("color: empty string", sanitizeColor(""), "#888888");
eq("color: undefined", sanitizeColor(undefined), "#888888");
eq("color: number", sanitizeColor(123), "#888888");
eq("color: named css color (rejected by design)", sanitizeColor("red"), "#888888");

// ── Full state sanitiser ───────────────────────────────────────────────────
eq("non-object → fallback to initial", sanitizeMapState(null).version, 1);
eq("wrong version → fallback", sanitizeMapState({ version: 2 }).version, 1);

const hostile = {
   version: 1,
   cols: 9999, // clamp
   rows: -5, // clamp
   title: "T".repeat(10000), // truncate to 200
   notes: "N".repeat(50000), // truncate to 10000
   palette: [
      { id: "p1", color: '#aaa" onclick="x"', label: "<script>" }, // bad color → fallback, label preserved
      { id: "p2", color: "#abc", label: "Wonder" },
      { id: "p2", color: "#def", label: "duplicate id" }, // id collision → de-duped
      "not an object",
      null,
      { id: "p3" }, // missing color/label → fallback
   ],
   activeColorId: "doesnt-exist", // → null because not in palette
   annotations: [
      { id: "a1", tier: "I", colorId: "p1", label: "ok" },
      { id: "a2", tier: "T".repeat(50), label: "x" }, // tier truncated
      "junk",
      { id: 999 }, // bad id → autogen
   ],
   cells: {
      "0,0": { colorId: "p1", text: "Petra" },
      "10,10": { text: "Quote \"test\" & <html>" },
      "../../etc/passwd": { text: "evil" }, // bad key → dropped
      "1,1": "not an object", // bad value → dropped
      "2,2": { colorId: "X".repeat(100), text: "T".repeat(2000) }, // both truncated
   },
};

const result = sanitizeMapState(hostile);

ok("cols clamped to 80", result.cols === 80);
ok("rows clamped to 1", result.rows === 1);
ok("title truncated to 200", result.title.length === 200);
ok("notes truncated to 10000", result.notes.length === 10000);
ok("hostile color falls back", result.palette.find((p) => p.id === "p1")?.color === "#888888");
ok("hostile label preserved as text (no XML interpretation)", result.palette.find((p) => p.id === "p1")?.label === "<script>");
ok("duplicate id is preserved with suffix", result.palette.some((p) => p.id === "p2_"));
ok("non-object palette entries dropped", result.palette.every((p) => p && typeof p === "object"));
ok("activeColorId nulled when not in palette", result.activeColorId === null);
ok("annotation tier truncated", result.annotations.find((a) => a.id === "a2")?.tier?.length === 8);
ok("non-object annotation dropped", result.annotations.every((a) => a && typeof a === "object"));
ok("bad cell key dropped", !("../../etc/passwd" in result.cells));
ok("non-object cell value dropped", !("1,1" in result.cells));
ok("colorId truncated", result.cells["2,2"]?.colorId?.length === 32);
ok("cell text truncated", result.cells["2,2"]?.text?.length === 500);
ok("good cell preserved", result.cells["0,0"]?.text === "Petra");
ok("html in cell text preserved as text (no XML interpretation)", result.cells["10,10"]?.text === "Quote \"test\" & <html>");

if (failed) {
   console.error(`\n${failed} failure(s)`);
   process.exit(1);
}
console.log("\nall sanitiser cases pass");
