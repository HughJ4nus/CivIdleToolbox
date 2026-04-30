// Builds a sample export SVG and asserts it's well-formed XML.
// Catches the kind of "invalid XML in attribute" bug that breaks <img> rasterization.
//
//   node scripts/test-export-svg.mjs
//
// Requires the project to be built first (uses dist/assets if needed) — but it
// imports source via tsx-friendly loader if available, otherwise compiles inline.

import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// Polyfill the bits the export code probes for ─ document, Image are not
// strictly needed for buildExportSvg (it falls back to a heuristic when no
// canvas is available), but let's avoid surprises.
globalThis.document = undefined;

// Use TypeScript via on-the-fly compilation.
let buildExportSvg;
try {
   const ts = require("typescript");
   const { readFileSync } = await import("node:fs");
   const sourcePath = new URL("../src/export.ts", import.meta.url);
   const typesPath = new URL("../src/types.ts", import.meta.url);
   const hexPath = new URL("../src/hex.ts", import.meta.url);

   const compile = (src) =>
      ts.transpileModule(src, {
         compilerOptions: {
            module: ts.ModuleKind.ESNext,
            target: ts.ScriptTarget.ES2022,
            moduleResolution: ts.ModuleResolutionKind.Bundler,
         },
      }).outputText;

   const wonderPath = new URL("../src/wonderRange.ts", import.meta.url);
   const buildingsPath = new URL("../src/data/buildings.json", import.meta.url);

   const tmp = mkdtempSync(join(tmpdir(), "hex-export-"));
   mkdirSync(join(tmp, "data"), { recursive: true });
   copyFileSync(buildingsPath, join(tmp, "data/buildings.json"));
   writeFileSync(join(tmp, "types.mjs"), compile(readFileSync(typesPath, "utf8")));
   writeFileSync(join(tmp, "hex.mjs"), compile(readFileSync(hexPath, "utf8")));
   const wonderSrc = readFileSync(wonderPath, "utf8").replace(
      /from ["']\.\/data\/buildings\.json["']/g,
      `from "./data/buildings.json" with { type: "json" }`,
   );
   writeFileSync(join(tmp, "wonderRange.mjs"), compile(wonderSrc));
   const exportSrc = readFileSync(sourcePath, "utf8")
      .replace(/from ["']\.\/types["']/g, `from "./types.mjs"`)
      .replace(/from ["']\.\/hex["']/g, `from "./hex.mjs"`)
      .replace(/from ["']\.\/wonderRange["']/g, `from "./wonderRange.mjs"`);
   writeFileSync(join(tmp, "export.mjs"), compile(exportSrc));
   ({ buildExportSvg } = await import(`file://${tmp}/export.mjs`));
} catch (err) {
   console.error("Could not load export module:", err);
   process.exit(2);
}

const sample = {
   version: 1,
   cols: 10,
   rows: 10,
   palette: [
      { id: "p1", color: "#e74c3c", label: "Wonder" },
      { id: "p2", color: "#f1c40f", label: "Resource" },
      // Hostile color string that bypasses sanitisation: SHOULD still produce
      // safe XML because export.ts also escapes attribute values.
      { id: "p3", color: '#aaa" onmouseover="alert(1)" foo="', label: "Hostile" },
   ],
   activeColorId: "p1",
   cells: {
      "5,5": { colorId: "p1", text: "Petra" },
      "4,5": { colorId: "p2", text: "Wheat <Farm>" },
      "6,5": { colorId: "p1", text: "Quote \"test\"" },
      "5,4": { colorId: null, text: "AT&T" },
      "3,3": { colorId: "p3", text: "Hostile color cell" },
      // Wonder with a known tile range — exercises the range-ring renderer.
      "8,8": { colorId: "p1", text: "Pantheon" },
   },
   title: 'My "Quoted" Map & Co.',
   notes: "Line 1\nLine 2 with <html-ish> & ampersands.",
   showRanges: true,
   activeFestivals: [],
   activeUpgrades: [],
   annotations: [
      { id: "a1", tier: "I", colorId: "p1", label: 'Build "Petra" first' },
      { id: "a2", tier: "II", colorId: "p2", label: "Then a wheat farm <if possible>" },
      { id: "a3", tier: "III", colorId: null, label: "Stuff & things" },
      { id: "a4", tier: "IV", colorId: "p3", label: "Row backed by hostile color" },
   ],
};

const svg = buildExportSvg(sample, { hexSize: 28 });

// 1) Quick string sanity checks.
const issues = [];
if (!svg.startsWith("<?xml") && !svg.startsWith("<svg")) issues.push("svg does not start with XML/SVG");
if (!svg.includes('xmlns="http://www.w3.org/2000/svg"')) issues.push("missing xmlns");

// 2) Look for the previous regression: an unescaped " inside an attribute that
//    isn't part of the attribute delimiter.
const badAttr = /font-family="[^"]*"[A-Za-z]/.exec(svg);
if (badAttr) issues.push(`malformed attribute: ${badAttr[0].slice(0, 80)}…`);

// 2b) The hostile-color string MUST NOT appear verbatim — export.ts has to
//     escape its attribute values. Sanitiser would normally clean this, but
//     buildExportSvg is invoked directly without sanitisation here.
if (svg.includes('onmouseover="alert(1)"')) {
   issues.push("hostile color string emitted unescaped into an SVG attribute");
}

// 3) Parse with a minimal XML parser to confirm well-formedness.
//    Use the built-in DOMParser via JSDOM if available, otherwise fall back to
//    Node's xmldom-style check via Sax.
let parseOk = false;
try {
   const { XMLParser } = require("fast-xml-parser");
   const parser = new XMLParser({ ignoreAttributes: false });
   parser.parse(svg);
   parseOk = true;
} catch {
   try {
      const sax = require("sax");
      await new Promise((resolve, reject) => {
         const stream = sax.parser(true);
         stream.onerror = reject;
         stream.onend = () => resolve();
         stream.write(svg).close();
      });
      parseOk = true;
   } catch (e) {
      issues.push(`parse failed: ${e.message}`);
   }
}
if (!parseOk && issues.length === 0) issues.push("no XML parser available to validate");

if (issues.length) {
   console.error("FAIL");
   issues.forEach((i) => console.error(" ·", i));
   const out = join(tmpdir(), "hex-export-bad.svg");
   writeFileSync(out, svg);
   console.error("Wrote SVG to", out, "for inspection");
   process.exit(1);
}

console.log(`OK · ${svg.length} bytes, parses cleanly.`);
