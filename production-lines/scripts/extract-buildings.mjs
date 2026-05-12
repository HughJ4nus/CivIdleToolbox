// Pulls building keys + display names + computed tiers from the cloned
// CivIdle source. Mirrors the tier algorithm in CivIdle/shared/logic/
// Constants.ts: resource producers (no input) get tier 1; everything
// else is max(input material tier) + 1, iterated to fixed point;
// special buildings (HQ/WorldWonder/NaturalWonder) get tier 0; plus
// the manual CloneFactory/CloneLab = 8 overrides at Constants.ts:320.
//
// Run from the production-lines directory:   pnpm extract
// Reads:
//   ../CivIdle/shared/definitions/BuildingDefinitions.ts
//   ../CivIdle/shared/languages/en.ts
// Writes:
//   src/data/buildings.json   — [{ key, name, special, tier }]

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const CIVIDLE = resolve(ROOT, "..", "CivIdle");

const matchBraces = (src, start) => {
   if (src[start] !== "{") return -1;
   let depth = 0;
   for (let i = start; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") {
         depth--;
         if (depth === 0) return i + 1;
      }
   }
   return -1;
};

const parseFlatTab = (text) => {
   const out = {};
   for (const m of text.matchAll(/(\w+)\s*:\s*([\d.]+)/g)) out[m[1]] = Number(m[2]);
   return out;
};

const getBlockField = (body, fieldName) => {
   const re = new RegExp(`(?:^|[\\s,])${fieldName}\\s*:\\s*\\{`, "g");
   const m = re.exec(body);
   if (!m) return null;
   const open = body.indexOf("{", m.index);
   const end = matchBraces(body, open);
   if (end < 0) return null;
   return body.slice(open + 1, end - 1);
};

// ── i18n names from en.ts ────────────────────────────────────────────────
const enKeys = new Map();
{
   const enSrc = readFileSync(resolve(CIVIDLE, "shared/languages/en.ts"), "utf8");
   for (const m of enSrc.matchAll(/^\s+([A-Za-z0-9_]+):\s*"((?:\\.|[^"\\])*)",?\s*$/gm)) {
      enKeys.set(m[1], m[2]);
   }
}

// ── Walk every IBuildingDefinition entry ────────────────────────────────
const src = readFileSync(resolve(CIVIDLE, "shared/definitions/BuildingDefinitions.ts"), "utf8");
const out = [];
const re = /^\s{3}([A-Za-z0-9_]+):\s*IBuildingDefinition\s*=\s*\{/gm;
for (const m of src.matchAll(re)) {
   const key = m[1];
   const open = src.indexOf("{", m.index);
   const end = matchBraces(src, open);
   const body = src.slice(open + 1, end - 1);

   const inputBlock = getBlockField(body, "input");
   const outputBlock = getBlockField(body, "output");
   const specialMatch = body.match(/special:\s*BuildingSpecial\.([A-Za-z]+)/);
   const nameMatch = body.match(/name:\s*\(\)\s*=>\s*\$t\(L\.([A-Za-z0-9_]+)\)/);

   out.push({
      key,
      name: nameMatch ? (enKeys.get(nameMatch[1]) ?? key) : key,
      input: inputBlock ? parseFlatTab(inputBlock) : {},
      output: outputBlock ? parseFlatTab(outputBlock) : {},
      special: specialMatch ? specialMatch[1] : null,
      tier: null,
   });
}

// ── Tier algorithm (mirrors Constants.ts) ───────────────────────────────
const matTier = new Map();
// Seed: every building with no input but some output is a tier-1 producer.
for (const b of out) {
   if (Object.keys(b.input).length === 0 && Object.keys(b.output).length > 0) {
      b.tier = 1;
      for (const res of Object.keys(b.output)) {
         if (!matTier.has(res) || matTier.get(res) > 1) matTier.set(res, 1);
      }
   }
}
for (let pass = 0; pass < 30; pass++) {
   let changed = false;
   for (const b of out) {
      if (b.tier !== null) continue;
      const inputs = Object.keys(b.input);
      if (inputs.length === 0) continue;
      if (!inputs.every((r) => matTier.has(r))) continue;
      const t = Math.max(...inputs.map((r) => matTier.get(r))) + 1;
      b.tier = t;
      for (const res of Object.keys(b.output)) {
         if (!matTier.has(res) || matTier.get(res) > t) matTier.set(res, t);
      }
      changed = true;
   }
   if (!changed) break;
}
// Special buildings get tier 0 (Constants.ts:316).
for (const b of out) if (b.special) b.tier = 0;
// Manual overrides at Constants.ts:320-321.
for (const b of out) {
   if (b.key === "CloneFactory" || b.key === "CloneLab") b.tier = 8;
}

// Keep input + output so the UI can render a subtitle (what the building
// produces / consumes).
const slim = out.map(({ key, name, special, tier, input, output }) => ({
   key,
   name,
   special,
   tier,
   input,
   output,
}));
slim.sort((a, b) => a.name.localeCompare(b.name));

const dest = resolve(ROOT, "src/data/buildings.json");
mkdirSync(dirname(dest), { recursive: true });
writeFileSync(dest, `${JSON.stringify(slim, null, 2)}\n`);

const counts = slim.reduce((acc, b) => {
   const k = b.special ?? `tier ${b.tier}`;
   acc[k] = (acc[k] ?? 0) + 1;
   return acc;
}, {});
console.log(`Wrote ${slim.length} buildings to ${dest}`);
console.log("By bucket:", counts);
