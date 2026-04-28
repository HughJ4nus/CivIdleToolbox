// Extracts the list of buildings (with display name + special tag) from the
// cloned CivIdle source so we can offer them as quick labels.
//
// Run from the hex-map directory:   npm run extract:buildings
// Reads:
//   ../CivIdle/shared/definitions/BuildingDefinitions.ts
//   ../CivIdle/shared/languages/en.ts
// Writes:
//   src/data/buildings.json   — [{ key, name, special }]

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const CIVIDLE = resolve(ROOT, "..", "CivIdle");

const buildingsSrc = readFileSync(
   resolve(CIVIDLE, "shared/definitions/BuildingDefinitions.ts"),
   "utf8",
);
const enSrc = readFileSync(resolve(CIVIDLE, "shared/languages/en.ts"), "utf8");

// 1) Build a map of i18n keys -> display strings from en.ts.
//    Lines look like:    Foo: "Bar",
const enKeys = new Map();
for (const m of enSrc.matchAll(/^\s+([A-Za-z0-9_]+):\s*"((?:\\.|[^"\\])*)",?\s*$/gm)) {
   enKeys.set(m[1], m[2]);
}

// 2) Walk every "FooName: IBuildingDefinition = { ... };" block and pull
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
   out.push({
      key,
      name: display,
      special: specialMatch ? specialMatch[1] : null, // "WorldWonder" | "NaturalWonder" | "HQ" | null
   });
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
console.log(`Wrote ${out.length} buildings to ${dest}`);
console.log("By category:", counts);
