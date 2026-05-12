// Translates the user's sidebar input (GP levels, wonder levels, Age of
// Wisdom) into per-building output / worker / storage multipliers and
// level boosts. Mirrors the upstream game's per-tick math:
//
//   effective_gp_level = base + ageWisdom[gp.age] + Σ wonder_gp_boost[gp.age]
//   effective_level    = building_level + Σ levelBoost
//   effective_output   = baseRecipe × effective_level × (1 + Σ output mults)
//
// Multipliers stack additively, not multiplicatively.

import type { Building } from "./buildingTypes";
import bonusData from "./data/bonus-sources.json";
import type { UserState } from "./userState";

interface GreatPersonEntry {
   key: string;
   name: string;
   age: string;
   kind: "boost" | "levelBoost";
   multipliers?: string[];
   buildings?: string[];
}
interface WonderEntry {
   key: string;
   name: string;
   effect: string;
}
const DATA = bonusData as unknown as {
   greatPeople: GreatPersonEntry[];
   wonders: WonderEntry[];
};

export interface BuildingBonus {
   outputMultiplier: number;
   workerMultiplier: number;
   storageMultiplier: number;
   levelBoost: number;
   /** Per-source breakdown — useful for tooltips / audit later. */
   contributors: Contributor[];
}
export interface Contributor {
   source: string;
   kind: "output" | "worker" | "storage" | "level";
   value: number;
}

const ensure = (
   map: Map<string, BuildingBonus>,
   key: string,
): BuildingBonus => {
   let entry = map.get(key);
   if (!entry) {
      entry = {
         outputMultiplier: 0,
         workerMultiplier: 0,
         storageMultiplier: 0,
         levelBoost: 0,
         contributors: [],
      };
      map.set(key, entry);
   }
   return entry;
};
const apply = (
   map: Map<string, BuildingBonus>,
   key: string,
   c: Contributor,
): void => {
   const b = ensure(map, key);
   if (c.kind === "output") b.outputMultiplier += c.value;
   else if (c.kind === "worker") b.workerMultiplier += c.value;
   else if (c.kind === "storage") b.storageMultiplier += c.value;
   else if (c.kind === "level") b.levelBoost += c.value;
   b.contributors.push(c);
};

// ── Wonder effects ──────────────────────────────────────────────────────
//
// Each entry computes the bonuses a wonder grants given its level and a
// list of all production buildings. Returns nothing if the level is 0
// (caller short-circuits before invoking). Only wonders with global,
// non-state-dependent effects are wired up — adjacency / festival /
// city-count / unstable wonders are intentionally skipped in this pass.

interface EffectCtx {
   prod: Building[]; // non-special buildings (the only ones with recipes)
}
type WonderEffect = (
   level: number,
   ctx: EffectCtx,
) => Array<{ building: string; kind: Contributor["kind"]; value: number }>;

const WONDER_EFFECTS: Record<string, WonderEffect> = {
   // ── All-buildings global output ─────────────────────────────────────
   DysonSphere: (level, ctx) => {
      // Source line: OnProductionComplete.tsx:1391 — base 5 + (level − 1)
      const value = 5 + (level - 1);
      return ctx.prod.map((b) => ({ building: b.key, kind: "output", value }));
   },

   // ── Per-building-type globals (fixed magnitude) ─────────────────────
   CircusMaximus: () => [
      { building: "MusiciansGuild", kind: "output", value: 1 },
      { building: "PaintersGuild", kind: "output", value: 1 },
      { building: "WritersGuild", kind: "output", value: 1 },
   ],
   Parthenon: () => [
      { building: "MusiciansGuild", kind: "output", value: 1 },
      { building: "PaintersGuild", kind: "output", value: 1 },
   ],
   Persepolis: () => [
      { building: "StoneQuarry", kind: "output", value: 1 },
      { building: "LoggingCamp", kind: "output", value: 1 },
      { building: "CopperMiningCamp", kind: "output", value: 1 },
   ],
   ForbiddenCity: () => [
      { building: "PaperMaker", kind: "output", value: 1 },
      { building: "WritersGuild", kind: "output", value: 1 },
      { building: "PrintingHouse", kind: "output", value: 1 },
   ],
   HimejiCastle: () => [
      { building: "CaravelBuilder", kind: "output", value: 1 },
      { building: "GalleonBuilder", kind: "output", value: 1 },
      { building: "FrigateBuilder", kind: "output", value: 1 },
   ],
   BrandenburgGate: () => [
      { building: "OilWell", kind: "output", value: 1 },
      { building: "CoalMine", kind: "output", value: 1 },
   ],
   NileRiver: () => [{ building: "WheatFarm", kind: "output", value: 1 }],
   ManhattanProject: () => [
      { building: "UraniumMine", kind: "output", value: 2 },
   ],
   ApolloProgram: () => [
      { building: "RocketFactory", kind: "output", value: 2 },
   ],

   // ── Per-building-type globals (level-scaled) ────────────────────────
   Sputnik1: (level) => [
      { building: "Cosmodrome", kind: "output", value: level },
   ],

   // ── Filter-based globals (fixed magnitude) ──────────────────────────
   GrottaAzzurra: (_, ctx) =>
      ctx.prod
         .filter((b) => b.tier === 1)
         .flatMap((b) => [
            { building: b.key, kind: "output" as const, value: 1 },
            { building: b.key, kind: "worker" as const, value: 1 },
            { building: b.key, kind: "storage" as const, value: 1 },
         ]),
   PyramidOfGiza: (_, ctx) =>
      ctx.prod
         .filter((b) => (b.output.Worker ?? 0) > 0)
         .map((b) => ({ building: b.key, kind: "output", value: 1 })),
   Stonehenge: (_, ctx) =>
      ctx.prod
         .filter((b) => (b.input.Stone ?? 0) > 0 || (b.output.Stone ?? 0) > 0)
         .map((b) => ({ building: b.key, kind: "output", value: 1 })),
   Rijksmuseum: (_, ctx) =>
      ctx.prod
         .filter((b) => (b.input.Culture ?? 0) > 0 || (b.output.Culture ?? 0) > 0)
         .flatMap((b) => [
            { building: b.key, kind: "output" as const, value: 1 },
            { building: b.key, kind: "worker" as const, value: 1 },
            { building: b.key, kind: "storage" as const, value: 1 },
         ]),
   SummerPalace: (_, ctx) =>
      ctx.prod
         .filter((b) => (b.input.Gunpowder ?? 0) > 0 || (b.output.Gunpowder ?? 0) > 0)
         .flatMap((b) => [
            { building: b.key, kind: "output" as const, value: 1 },
            { building: b.key, kind: "worker" as const, value: 1 },
            { building: b.key, kind: "storage" as const, value: 1 },
         ]),
   GoldenGateBridge: (_, ctx) =>
      ctx.prod
         .filter((b) => (b.output.Power ?? 0) > 0)
         .map((b) => ({ building: b.key, kind: "output", value: 1 })),
   UnitedNations: (_, ctx) =>
      ctx.prod
         .filter((b) => b.tier != null && b.tier >= 4 && b.tier <= 6)
         .flatMap((b) => [
            { building: b.key, kind: "output" as const, value: 1 },
            { building: b.key, kind: "worker" as const, value: 1 },
            { building: b.key, kind: "storage" as const, value: 1 },
         ]),
   MountTai: (_, ctx) =>
      ctx.prod
         .filter((b) => (b.output.Science ?? 0) > 0)
         .map((b) => ({ building: b.key, kind: "output", value: 1 })),
   BlackForest: (_, ctx) =>
      ctx.prod
         .filter((b) => (b.input.Wood ?? 0) > 0 || (b.input.Lumber ?? 0) > 0)
         .map((b) => ({ building: b.key, kind: "output", value: 5 })),

   // ── Filter-based globals (level-scaled) ─────────────────────────────
   MatrioshkaBrain: (level, ctx) =>
      ctx.prod
         .filter((b) => (b.output.Science ?? 0) > 0)
         .map((b) => ({ building: b.key, kind: "output", value: level })),
   CologneCathedral: (level, ctx) =>
      ctx.prod
         .filter((b) => (b.output.Science ?? 0) > 0)
         .map((b) => ({ building: b.key, kind: "output", value: level })),
   SydneyHarbourBridge: (level, ctx) =>
      ctx.prod
         .filter((b) => (b.output.Power ?? 0) > 0)
         .map((b) => ({ building: b.key, kind: "output", value: level })),

   // Intentionally unwired for first pass (need extra inputs / state):
   //   CentrePompidou      — needs city count
   //   Poseidon, WallStreet, GreatOceanRoad — festival only
   //   YangtzeRiver        — depends on a Wu-Zetian GP level
   //   Shenandoah, ZigguratOfUr, EuphratesRiver, CNTower — unstable / state-dependent
   //   TempleOfHeaven, TajMahal, Neuschwanstein — apply to placed buildings,
   //                                              not modelled here
};

// ── Wonders that boost GP effective levels (LHC-style) ─────────────────
//
// These don't directly multiply building output — they raise the
// effective level of the GPs of a given age, which then flows through to
// every GP's `output / worker / storage` multiplier on the buildings the
// GPs target. Modelled by a per-age "extra GP levels from wonders"
// table that gets added on top of base + Age of Wisdom in the GP loop
// below.
//
//   LargeHadronCollider — +2 + (level - 1) = level + 1 to InformationAge
//   Sputnik1            — +level to ColdWarAge (also has a separate
//                         per-building output bonus to Cosmodrome above)
//   Aphrodite           — fixed +1 to ClassicalAge (does not scale)
//
// Skipped: Kanagawa (boosts the player's *current* age, which we don't
// track), Lunar New Year festival modifier on Porcelain Tower (festival
// only).

type WonderGpLevelBoost = (
   level: number,
) => Array<{ age: string; value: number }>;

const WONDER_GP_LEVEL_BOOSTS: Record<string, WonderGpLevelBoost> = {
   LargeHadronCollider: (level) => [
      { age: "InformationAge", value: level + 1 },
   ],
   Sputnik1: (level) => [{ age: "ColdWarAge", value: level }],
   Aphrodite: () => [{ age: "ClassicalAge", value: 1 }],
};

// ── Trade tile bonuses ────────────────────────────────────────────────
//
// Per OnProductionComplete.tsx:159-213 in upstream:
//   • Each owned trade tile gives +5 output to its building
//     (`TRADE_TILE_BONUS = 5`)
//   • WorldTradeOrganization adds +wtoLevel output per tile
//   • GreatOceanRoad adds +wonderLevel LEVEL boost per tile
//   • LakeLouise adds +2 LEVEL boost per ALLY tile (we don't track ally
//     state, so we apply it to every trade tile as an over-approximation)
//
// All four are handled here because they share the per-tile loop.

const applyTradeTileBonuses = (
   out: Map<string, BuildingBonus>,
   userState: UserState,
): void => {
   const tiles = userState.tradeTiles ?? [];
   if (tiles.length === 0) return;
   const wtoLevel = userState.wonders.WorldTradeOrganization ?? 0;
   const gorLevel = userState.wonders.GreatOceanRoad ?? 0;
   const hasLakeLouise = (userState.wonders.LakeLouise ?? 0) > 0;
   for (const tile of tiles) {
      if (!tile.building) continue;
      apply(out, tile.building, {
         source: "Trade tile bonus",
         kind: "output",
         value: 5,
      });
      if (wtoLevel > 0) {
         apply(out, tile.building, {
            source: `World Trade Organization (lvl ${wtoLevel})`,
            kind: "output",
            value: wtoLevel,
         });
      }
      if (gorLevel > 0) {
         apply(out, tile.building, {
            source: `Great Ocean Road (lvl ${gorLevel})`,
            kind: "level",
            value: gorLevel,
         });
      }
      if (hasLakeLouise) {
         apply(out, tile.building, {
            source: "Lake Louise (assumed ally)",
            kind: "level",
            value: 2,
         });
      }
   }
};

// ── Top-level resolver ──────────────────────────────────────────────────

export const resolveBuildingBonuses = (
   userState: UserState,
   allBuildings: Building[],
): Map<string, BuildingBonus> => {
   const out = new Map<string, BuildingBonus>();
   const prod = allBuildings.filter((b) => !b.special);

   // Pre-pass: per-age extra GP effective levels from wonders the user has
   // (LHC, Sputnik 1, Aphrodite). Each entry tracks both the value and
   // the source wonder so the GP source string can show the breakdown.
   const wonderGpBoosts: Record<string, Array<{ name: string; value: number }>> = {};
   for (const wonder of DATA.wonders) {
      const lvl = userState.wonders[wonder.key] ?? 0;
      if (lvl <= 0) continue;
      const fn = WONDER_GP_LEVEL_BOOSTS[wonder.key];
      if (!fn) continue;
      for (const { age, value } of fn(lvl)) {
         if (value <= 0) continue;
         if (!wonderGpBoosts[age]) wonderGpBoosts[age] = [];
         wonderGpBoosts[age].push({ name: wonder.name, value });
      }
   }

   // Great People — boost-style only. Effective level = base + Age of
   // Wisdom for that age + Σ wonder GP-level boosts for that age. The
   // source string lays out the breakdown so the per-building tooltip
   // explains where every level point came from.
   for (const gp of DATA.greatPeople) {
      if (gp.kind !== "boost") continue;
      const baseLevel = userState.greatPeople[gp.key] ?? 0;
      if (baseLevel <= 0) continue;
      const wisdom = userState.ageWisdom[gp.age] ?? 0;
      const wonderBoosts = wonderGpBoosts[gp.age] ?? [];
      const wonderTotal = wonderBoosts.reduce((s, b) => s + b.value, 0);
      const effective = baseLevel + wisdom + wonderTotal;

      // Compose a "5 + 2 wisdom + 4 LHC" style breakdown when extras apply.
      const parts: string[] = [`${baseLevel}`];
      if (wisdom > 0) parts.push(`${wisdom} wisdom`);
      for (const wb of wonderBoosts) parts.push(`${wb.value} ${wb.name}`);
      const breakdown = parts.length > 1 ? ` = ${parts.join(" + ")}` : "";
      const source = `${gp.name} (lvl ${effective}${breakdown})`;

      const buildings = gp.buildings ?? [];
      const multipliers = (gp.multipliers ?? []) as Contributor["kind"][];
      for (const buildingKey of buildings) {
         for (const mult of multipliers) {
            apply(out, buildingKey, { source, kind: mult, value: effective });
         }
      }
   }

   // Wonders — only those with effect entries above.
   const ctx: EffectCtx = { prod };
   for (const wonder of DATA.wonders) {
      const level = userState.wonders[wonder.key] ?? 0;
      if (level <= 0) continue;
      const fn = WONDER_EFFECTS[wonder.key];
      if (!fn) continue;
      const source = `${wonder.name} (lvl ${level})`;
      for (const d of fn(level, ctx)) {
         apply(out, d.building, { source, kind: d.kind, value: d.value });
      }
   }

   // Trade tiles + their interaction with WorldTradeOrganization.
   applyTradeTileBonuses(out, userState);

   // Cathedral of Brasília — manual stand-in for the in-game adjacency
   // effect. When the wonder is owned and the user has added buildings
   // to the chain list, each listed building gets +N output multiplier
   // where N = list length. (In the game, N is the length of the
   // production chain formed by all buildings within 2 tiles of CoB —
   // we can't model adjacency here, so we let the user curate the list.)
   const hasCob = (userState.wonders.CathedralOfBrasilia ?? 0) > 0;
   const cobList = userState.cathedralOfBrasiliaBuildings ?? [];
   if (hasCob && cobList.length > 0) {
      const n = cobList.length;
      const source = `Cathedral of Brasília (${n} in chain)`;
      for (const buildingKey of cobList) {
         if (!buildingKey) continue;
         apply(out, buildingKey, { source, kind: "output", value: n });
      }
   }

   // Château Frontenac — same UX as CoB. Each user-selected target
   // building gets +1 effective level. (In-game it's ×2 during the
   // Winter Carnival festival; we don't model festivals.)
   const hasChateau = (userState.wonders.ChateauFrontenac ?? 0) > 0;
   const chateauList = userState.chateauFrontenacBuildings ?? [];
   if (hasChateau && chateauList.length > 0) {
      for (const buildingKey of chateauList) {
         if (!buildingKey) continue;
         apply(out, buildingKey, {
            source: "Château Frontenac",
            kind: "level",
            value: 1,
         });
      }
   }

   // Habitat 67 — targets AILab specifically. Wonder level grants
   // +wonderLevel output/worker/storage; an Information-Age-Wisdom
   // value adds another +wisdom output/storage on top; and a non-zero
   // happiness reading gives an additional +floor(happiness/5) level
   // boost (per OnProductionComplete.tsx:2204).
   const habitatLevel = userState.wonders.Habitat67 ?? 0;
   const happiness = Math.max(0, Math.floor(userState.finalHappiness ?? 0));
   if (habitatLevel > 0) {
      const baseSrc = `Habitat 67 (lvl ${habitatLevel})`;
      apply(out, "AILab", { source: baseSrc, kind: "output", value: habitatLevel });
      apply(out, "AILab", { source: baseSrc, kind: "worker", value: habitatLevel });
      apply(out, "AILab", { source: baseSrc, kind: "storage", value: habitatLevel });
      const infoWisdom = userState.ageWisdom.InformationAge ?? 0;
      if (infoWisdom > 0) {
         const wisdomSrc = `Habitat 67 + Information Age Wisdom (+${infoWisdom})`;
         apply(out, "AILab", { source: wisdomSrc, kind: "output", value: infoWisdom });
         apply(out, "AILab", { source: wisdomSrc, kind: "storage", value: infoWisdom });
      }
      if (happiness > 0) {
         const levelBoost = Math.round(happiness / 5);
         if (levelBoost > 0) {
            apply(out, "AILab", {
               source: `Habitat 67 + happiness (${happiness})`,
               kind: "level",
               value: levelBoost,
            });
         }
      }
   }

   // Ziggurat of Ur — when owned and happiness > 0, every non-Worker-
   // producing building gets +floor(happiness/10) output multiplier.
   // In-game this is also capped to floor((currentAgeIdx+1)/2) and
   // restricted to buildings unlocked before the current age. We don't
   // track current age, so we drop the cap and apply to all non-worker
   // production buildings — over-applies for late-game, mostly accurate
   // for mid-game.
   const ziggLevel = userState.wonders.ZigguratOfUr ?? 0;
   if (ziggLevel > 0 && happiness > 0) {
      const multiplier = Math.floor(happiness / 10);
      if (multiplier > 0) {
         const source = `Ziggurat of Ur (happiness ${happiness})`;
         for (const b of prod) {
            if ((b.output.Worker ?? 0) > 0) continue;
            apply(out, b.key, { source, kind: "output", value: multiplier });
         }
      }
   }

   return out;
};
