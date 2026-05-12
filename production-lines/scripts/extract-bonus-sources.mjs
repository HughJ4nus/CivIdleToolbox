// Extracts the inputs we'll surface in the sidebar so the user can enter
// their own great-person + wonder levels. Output is structural metadata
// only (keys, display names, ages, what each one boosts) — no game logic
// is reproduced.
//
// Run: pnpm extract:bonus
// Reads:
//   ../CivIdle/shared/definitions/GreatPersonDefinitions.ts
//   ../CivIdle/shared/definitions/BuildingDefinitions.ts
//   ../CivIdle/shared/languages/en.ts
// Writes:
//   src/data/bonus-sources.json

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

const getBlockField = (body, fieldName) => {
   const re = new RegExp(`(?:^|[\\s,])${fieldName}\\s*:\\s*\\{`, "g");
   const m = re.exec(body);
   if (!m) return null;
   const open = body.indexOf("{", m.index);
   const end = matchBraces(body, open);
   if (end < 0) return null;
   return body.slice(open + 1, end - 1);
};

// ── i18n names ────────────────────────────────────────────────────────────
const enKeys = new Map();
{
   const src = readFileSync(resolve(CIVIDLE, "shared/languages/en.ts"), "utf8");
   for (const m of src.matchAll(/^\s+([A-Za-z0-9_]+):\s*"((?:\\.|[^"\\])*)",?\s*$/gm)) {
      enKeys.set(m[1], m[2]);
   }
}

// ── Building display names (so wonder entries show their localised name) ─
const buildingNames = new Map();
{
   const src = readFileSync(resolve(CIVIDLE, "shared/definitions/BuildingDefinitions.ts"), "utf8");
   const re = /^\s{3}([A-Za-z0-9_]+):\s*IBuildingDefinition\s*=\s*\{/gm;
   for (const m of src.matchAll(re)) {
      const key = m[1];
      const open = src.indexOf("{", m.index);
      const end = matchBraces(src, open);
      const body = src.slice(open + 1, end - 1);
      const nameMatch = body.match(/name:\s*\(\)\s*=>\s*\$t\(L\.([A-Za-z0-9_]+)\)/);
      if (nameMatch) buildingNames.set(key, enKeys.get(nameMatch[1]) ?? key);
   }
}

// ── Great People ─────────────────────────────────────────────────────────
const greatPeople = [];
{
   const src = readFileSync(
      resolve(CIVIDLE, "shared/definitions/GreatPersonDefinitions.ts"),
      "utf8",
   );
   // Top-level entries: `   Foo: IGreatPersonDefinition = { ... };`
   // OR  `   Foo: IGreatPersonDefinition = boostOf({ ... });`
   const re =
      /^\s{3}([A-Za-z0-9_]+):\s*IGreatPersonDefinition\s*=\s*(\{|boostOf\(\{)/gm;
   for (const m of src.matchAll(re)) {
      const key = m[1];
      const isBoost = m[2].startsWith("boostOf");
      const open = src.indexOf("{", m.index + m[0].length - 1);
      const end = matchBraces(src, open);
      const body = src.slice(open + 1, end - 1);

      const nameMatch = body.match(/name:\s*\(\)\s*=>\s*\$t\(L\.([A-Za-z0-9_]+)\)/);
      const name = nameMatch ? (enKeys.get(nameMatch[1]) ?? key) : key;
      const ageMatch = body.match(/age:\s*"([A-Za-z]+)"/);
      const age = ageMatch ? ageMatch[1] : "Unknown";

      if (isBoost) {
         const boostBlock = getBlockField(body, "boost");
         let multipliers = [];
         let buildings = [];
         if (boostBlock) {
            const mm = boostBlock.match(/multipliers:\s*\[([^\]]*)\]/);
            if (mm) multipliers = [...mm[1].matchAll(/"(\w+)"/g)].map((x) => x[1]);
            const bm = boostBlock.match(/buildings:\s*\[([^\]]*)\]/);
            if (bm) buildings = [...bm[1].matchAll(/"(\w+)"/g)].map((x) => x[1]);
         }
         greatPeople.push({
            key,
            name,
            age,
            kind: "boost",
            multipliers,
            buildings,
         });
         continue;
      }

      // Non-boost: keep the LevelBoost ones (they raise output indirectly
      // via the building's effective level). Skip wildcard/promotion/etc.
      const typeMatch = body.match(/type:\s*GreatPersonType\.([A-Za-z]+)/);
      const t = typeMatch ? typeMatch[1] : null;
      if (t === "LevelBoost") {
         greatPeople.push({ key, name, age, kind: "levelBoost" });
      }
   }
}

const AGE_ORDER = [
   "StoneAge",
   "BronzeAge",
   "IronAge",
   "ClassicalAge",
   "MiddleAge",
   "RenaissanceAge",
   "IndustrialAge",
   "WorldWarAge",
   "ColdWarAge",
   "InformationAge",
];
greatPeople.sort((a, b) => {
   const ai = AGE_ORDER.indexOf(a.age);
   const bi = AGE_ORDER.indexOf(b.age);
   if (ai !== bi) return ai - bi;
   return a.name.localeCompare(b.name);
});

// ── Wonders with global production bonuses ─────────────────────────────
// Sourced from a focused audit of OnProductionComplete.tsx. Only wonders
// whose effect applies WITHOUT depending on tile adjacency are listed —
// per-tile / neighbour-based wonders are intentionally excluded.
//
// Buckets:
//   • all-buildings global output multipliers
//   • per-building-type globals (specific building keys, no adjacency)
//   • filter-based globals (every building matching a predicate)
//   • level/state-conditional globals (every placed building meeting
//     a condition like level ≥ 10)
//   • festival-only or upgrade-only globals
const wonderEntries = [
   // — All-buildings global output —
   { key: "DysonSphere", effect: "Global +5 output, +1 per wonder level" },
   { key: "CentrePompidou", effect: "Global +1 output per unlocked city (×2 during festival)" },

   // — Per-building-type globals —
   { key: "CircusMaximus", effect: "+1 output to Musicians/Painters/Writers Guild" },
   { key: "Parthenon", effect: "+1 output to Musicians & Painters Guild" },
   { key: "Persepolis", effect: "+1 output to Stone Quarry, Logging Camp, Copper Mining Camp" },
   { key: "ForbiddenCity", effect: "+1 output to Paper Maker, Writers Guild, Printing House" },
   { key: "HimejiCastle", effect: "+1 output to Caravel/Galleon/Frigate Builder" },
   { key: "BrandenburgGate", effect: "+1 output to Oil Well & Coal Mine" },
   { key: "NileRiver", effect: "+1 output to Wheat Farm" },
   { key: "ManhattanProject", effect: "+2 output to Uranium Mine" },
   { key: "ApolloProgram", effect: "+2 output to Rocket Factory" },
   { key: "Sputnik1", effect: "+level output/storage to Cosmodrome AND +level effective level to every Cold War Age GP" },

   // — Filter-based globals —
   { key: "GrottaAzzurra", effect: "+1 output/worker/storage to all tier-1 buildings" },
   { key: "PyramidOfGiza", effect: "+1 output to every building producing Worker" },
   { key: "Stonehenge", effect: "+1 output to every building touching Stone" },
   { key: "Rijksmuseum", effect: "+1 output/worker/storage to every building touching Culture" },
   { key: "SummerPalace", effect: "+1 output/worker/storage to every building touching Gunpowder" },
   { key: "GoldenGateBridge", effect: "+1 output to every building producing Power" },
   { key: "UnitedNations", effect: "+1 output/worker/storage to every tier-4..6 building" },
   { key: "MountTai", effect: "+1 output to every Science-producing building" },
   { key: "YangtzeRiver", effect: "+1 output/worker to every building consuming Water" },
   { key: "Shenandoah", effect: "+2 output (unstable) to every building unlocked in current age" },
   { key: "CNTower", effect: "Output bonus to WW/Cold-War-age buildings, scales with tier distance" },
   { key: "ZigguratOfUr", effect: "Happiness-dependent output to non-Worker buildings of older ages (unstable)" },
   { key: "EuphratesRiver", effect: "Worker-utilisation-dependent output to non-Worker buildings of older ages (unstable)" },
   { key: "CologneCathedral", effect: "Output to every Science-producing building, scales with wonder level" },
   { key: "BlackForest", effect: "+5 output to every building consuming Wood or Lumber" },
   { key: "MatrioshkaBrain", effect: "Output to every Science-producing building, scales with wonder level" },
   { key: "SydneyHarbourBridge", effect: "Output to every Power-producing building, scales with wonder level" },

   // — Level / state-conditional globals (apply to every placed building
   //   meeting a state condition; not adjacency-based) —
   { key: "TempleOfHeaven", effect: "+1 worker to every placed building with level ≥ 10" },
   { key: "TajMahal", effect: "+5 worker to every under-construction building with level ≥ 20" },
   { key: "Neuschwanstein", effect: "+10 worker to every incomplete world wonder" },

   // — Wonders that boost GP effective levels (LHC-style) —
   { key: "LargeHadronCollider", effect: "+(level+1) effective level to every Information Age GP this run (excl. level-boost GPs)" },
   { key: "Aphrodite", effect: "+1 effective level to every Classical Age GP this run (also has under-construction worker bonus we don't model)" },

   // — Wonders that interact with trade tiles —
   { key: "WorldTradeOrganization", effect: "+wtoLevel output multiplier to every trade tile bonus's target building (stacks per tile)" },
   { key: "GreatOceanRoad", effect: "+wonderLevel level boost to every trade tile bonus's target building (Moomba festival adds +wonderLevel output too)" },
   { key: "LakeLouise", effect: "+2 level boost to every ally trade tile's target building (modelled here as +2 per trade tile since we don't track ally state)" },

   // — Wonders with a user-curated building list (manual approximation
   //   of an adjacency-based or in-game-target-picker effect) —
   { key: "CathedralOfBrasilia", effect: "Each listed building gets +N output multiplier where N = list length (manual stand-in for the in-game 2-tile production-chain effect)" },
   { key: "ChateauFrontenac", effect: "Each user-selected building gets +1 level boost (×2 during Winter Carnival festival, which we don't model)" },

   // — Wonders that target a specific building globally —
   { key: "Habitat67", effect: "+wonderLevel output/worker/storage to AI Lab; +InformationAge Wisdom adds +wisdom output/storage on top (happiness-based level boost not modelled)" },

   // — Festival-only output globals —
   { key: "Poseidon", effect: "Global +1 output during festival" },
   { key: "WallStreet", effect: "+5 output to ResearchFund during festival" },
];
// Wonders that are upgradeable in-game (in upstream's `UpgradableWorldWonders`
// set or have `max > 1`). Everything else is fixed at one "level" and the
// sidebar should render a checkbox rather than a number input.
const LEVELABLE_WONDERS = new Set([
   "CologneCathedral",
   "DysonSphere",
   "GreatOceanRoad",
   "LargeHadronCollider",
   "MatrioshkaBrain",
   "Sputnik1",
   "SydneyHarbourBridge",
   "UnitedNations",
   "WorldTradeOrganization",
   "ChateauFrontenac",
   "Habitat67",
]);

// Civilization-specific wonders. Sourced from each civ's `uniqueBuildings`
// and `naturalWonders` fields in upstream CityDefinitions.ts. The civ
// names below use the in-game DISPLAY name (`name: () => $t(L.X)`) — the
// internal city keys differ (e.g. internal `Athens` is shown as "Greek",
// internal `Rome` as "Roman", internal `Memphis` as "Egyptian").
//
// Wonders not listed below are universal — any civ can build them.
// Notable corrections vs an earlier draft: Persepolis and PyramidOfGiza
// are NOT in any civ's unique list — they are universal. There is no
// "Persian" civ in the game.
const WONDER_CIVILIZATION = {
   // Roman (internal key: Rome) — uniqueBuildings
   CircusMaximus: "Roman",
   // Roman (internal key: Rome) — naturalWonders
   GrottaAzzurra: "Roman",
   // Greek (internal key: Athens) — uniqueBuildings
   Parthenon: "Greek",
   // Greek (internal key: Athens) — naturalWonders
   Aphrodite: "Greek",
   Poseidon: "Greek",
   // Egyptian (internal key: Memphis) — naturalWonders
   NileRiver: "Egyptian",
   // Chinese (internal key: Beijing) — naturalWonders
   MountTai: "Chinese",
   YangtzeRiver: "Chinese",
   // American (internal key: NewYork) — uniqueBuildings + naturalWonders
   WallStreet: "American",
   Shenandoah: "American",
   // Babylonian (internal key: Babylon) — uniqueBuildings + naturalWonders
   ZigguratOfUr: "Babylonian",
   EuphratesRiver: "Babylonian",
   // German — uniqueBuildings + naturalWonders
   CologneCathedral: "German",
   BlackForest: "German",
   // French — uniqueBuildings
   CentrePompidou: "French",
   // Australian — uniqueBuildings
   SydneyHarbourBridge: "Australian",
   GreatOceanRoad: "Australian",
   // Canadian — naturalWonders + uniqueBuildings
   LakeLouise: "Canadian",
   ChateauFrontenac: "Canadian",
   Habitat67: "Canadian",
   // Russian — uniqueBuildings
   Sputnik1: "Russian",
   // Brazilian — uniqueBuildings
   CathedralOfBrasilia: "Brazilian",
};
const wonders = wonderEntries.map((w) => ({
   ...w,
   name: buildingNames.get(w.key) ?? w.key,
   levelable: LEVELABLE_WONDERS.has(w.key),
   civilization: WONDER_CIVILIZATION[w.key] ?? null,
}));

// ── Write ───────────────────────────────────────────────────────────────
const out = { greatPeople, wonders };
const dest = resolve(ROOT, "src/data/bonus-sources.json");
mkdirSync(dirname(dest), { recursive: true });
writeFileSync(dest, `${JSON.stringify(out, null, 2)}\n`);

const counts = {
   gpBoost: greatPeople.filter((g) => g.kind === "boost").length,
   gpLevelBoost: greatPeople.filter((g) => g.kind === "levelBoost").length,
   wonders: wonders.length,
};
console.log(`Wrote ${greatPeople.length} GPs + ${wonders.length} wonders to ${dest}`);
console.log("Breakdown:", counts);
