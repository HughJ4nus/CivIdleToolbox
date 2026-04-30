// Extracts the list of buildings (with display name + special tag + tile range)
// from the cloned CivIdle source so we can offer them as quick labels and draw
// range overlays around wonders.
//
// Run from the hex-map directory:   npm run extract:buildings
// Reads:
//   ../CivIdle/shared/definitions/BuildingDefinitions.ts
//   ../CivIdle/shared/languages/en.ts
//   ../CivIdle/shared/logic/BuildingLogic.ts
// Writes:
//   src/data/buildings.json   — [{ key, name, special, range? }]

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const CIVIDLE = resolve(ROOT, "..", "CivIdle");

// Buildings whose range is a function of festival/upgrade/adjacency. The map
// records the base value (no boosts active). Keep this in sync with the
// `getBuildingRange` switch — if a new dynamic wonder is added, the extractor
// will silently drop it until added here.
const DYNAMIC_BASES = {
   YellowCraneTower: 1,
   GreatWall: 1,
   Capybara: 2,
   GiantOtter: 2,
   Hoatzin: 2,
   RoyalFlycatcher: 2,
   RedFort: 3,
   SanchiStupa: 2,
   GangesRiver: 1,
   Uluru: 2,
   KizhiPogost: 3,
   LakeBaikal: 2,
   AuroraBorealis: 2,
   AtlasMountains: 2,
   SagradaFamilia: 2,
   CristoRedentor: 2,
   Atomium: 2,
};

// `getBuildingRange(xy, building, gs)` in BuildingLogic.ts is a giant switch.
// We parse its body to map building keys to their baseline range. Cases that
// chain multiple labels (`case "A": case "B": { return N; }`) are flattened.
// Cases whose body is a function call or conditional (festival / upgrade /
// neighbour boost) are matched against `DYNAMIC_BASES` above.
function extractRanges(src) {
   const fnStart = src.indexOf("export function getBuildingRange");
   if (fnStart < 0) return new Map();
   const bodyStart = src.indexOf("{", fnStart);
   if (bodyStart < 0) return new Map();
   let depth = 0;
   let end = bodyStart;
   for (let i = bodyStart; i < src.length; i++) {
      const ch = src[i];
      if (ch === "{") depth++;
      else if (ch === "}") {
         depth--;
         if (depth === 0) {
            end = i + 1;
            break;
         }
      }
   }
   const body = src.slice(bodyStart, end);
   const out = new Map();
   const caseRe = /case\s+"([A-Za-z0-9_]+)"\s*:/g;
   const blockRe = /((?:\s*case\s+"[A-Za-z0-9_]+"\s*:\s*)+)\{([\s\S]*?)\n\s*\}/g;
   for (const m of body.matchAll(blockRe)) {
      const labels = [];
      for (const cm of m[1].matchAll(caseRe)) labels.push(cm[1]);
      const range = parseRangeFromBlock(m[2], labels);
      if (range == null) continue;
      for (const k of labels) out.set(k, range);
   }
   return out;
}

function parseRangeFromBlock(block, labels) {
   const literal = block.match(/return\s+(\d+)\s*;/);
   if (literal) return Number(literal[1]);
   for (const k of labels) {
      if (k in DYNAMIC_BASES) return DYNAMIC_BASES[k];
   }
   // Non-wonder buildings (Caravansary, Warehouse) default to 0 — skip so we
   // don't flood entries with range:0.
   return null;
}

const buildingsSrc = readFileSync(
   resolve(CIVIDLE, "shared/definitions/BuildingDefinitions.ts"),
   "utf8",
);
const enSrc = readFileSync(resolve(CIVIDLE, "shared/languages/en.ts"), "utf8");
const buildingLogicSrc = readFileSync(
   resolve(CIVIDLE, "shared/logic/BuildingLogic.ts"),
   "utf8",
);

// 1) Build a map of i18n keys -> display strings from en.ts.
//    Lines look like:    Foo: "Bar",
const enKeys = new Map();
for (const m of enSrc.matchAll(/^\s+([A-Za-z0-9_]+):\s*"((?:\\.|[^"\\])*)",?\s*$/gm)) {
   enKeys.set(m[1], m[2]);
}

// 2) Pull baseline range per building from BuildingLogic.ts.
const ranges = extractRanges(buildingLogicSrc);

// 3) Walk every "FooName: IBuildingDefinition = { ... };" block and pull
//    the i18n key referenced by `name: () => $t(L.X)` plus the optional
//    `special: BuildingSpecial.Y`.
const blockRe = /^\s{3}([A-Za-z0-9_]+):\s*IBuildingDefinition\s*=\s*\{([\s\S]*?)^\s{3}\};/gm;
const out = [];
for (const m of buildingsSrc.matchAll(blockRe)) {
   const key = m[1];
   const body = m[2];
   const nameMatch = body.match(/name:\s*\(\)\s*=>\s*\$t\(L\.([A-Za-z0-9_]+)\)/);
   const specialMatch = body.match(/special:\s*BuildingSpecial\.([A-Za-z]+)/);
   const nameKey = nameMatch ? nameMatch[1] : key;
   const display = enKeys.get(nameKey) ?? key;
   const entry = {
      key,
      name: display,
      special: specialMatch ? specialMatch[1] : null, // "WorldWonder" | "NaturalWonder" | "HQ" | null
   };
   // Only annotate wonders. Buildings like Warehouse / Caravansary also have
   // a range under specific options — but the user-facing feature is "wonder
   // range circles", so don't draw rings around regular buildings.
   const isWonder = entry.special === "WorldWonder" || entry.special === "NaturalWonder";
   if (isWonder && ranges.has(key)) entry.range = ranges.get(key);
   out.push(entry);
}

out.sort((a, b) => a.name.localeCompare(b.name));

const dest = resolve(ROOT, "src/data/buildings.json");
mkdirSync(dirname(dest), { recursive: true });
writeFileSync(dest, JSON.stringify(out, null, 2) + "\n");

const counts = out.reduce(
   (acc, b) => {
      acc[b.special ?? "Normal"] = (acc[b.special ?? "Normal"] ?? 0) + 1;
      return acc;
   },
   {},
);
const withRange = out.filter((b) => typeof b.range === "number").length;
console.log(`Wrote ${out.length} buildings to ${dest}`);
console.log("By category:", counts);
console.log(`Range-bearing entries: ${withRange}`);
