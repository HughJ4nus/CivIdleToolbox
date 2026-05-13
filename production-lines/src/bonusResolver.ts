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

interface UpgradeEffect {
   [buildingKey: string]: { output?: number; worker?: number; storage?: number };
}
interface DirectionalWonderDef {
   kindLabel: string;
   paths: Record<string, string[]>;
}
interface TechEntry {
   key: string;
   name: string;
   age: string | null;
   column: number | null;
   buildingMultiplier: UpgradeEffect;
}
const EXT = bonusData as unknown as {
   directionalWonders?: Record<string, DirectionalWonderDef>;
   upgrades?: Record<string, UpgradeEffect>;
   techs?: TechEntry[];
};
const DIRECTIONAL = EXT.directionalWonders ?? {};
const UPGRADES = EXT.upgrades ?? {};
const TECHS = EXT.techs ?? [];

interface GreatPersonEntry {
   key: string;
   name: string;
   age: string;
   kind: "boost" | "levelBoost" | "adaptive";
   multipliers?: string[];
   buildings?: string[];
   /** value(level) = level × valueMultiplier. Most GPs have 1; some
    *  (Aristotle, Julius Caesar etc.) have 2. */
   valueMultiplier?: number;
   /** Civ restriction. GPs with a `city` are NOT eligible for Age of
    *  Wisdom (per upstream's isEligibleForWisdom). */
   city?: string | null;
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

// Materials that can't be stored in inventory — Worker, Power, Science
// etc. Mirrors upstream's NoStorage set. Used by canBeElectrified below.
const NON_STORABLE = new Set([
   "Worker",
   "Power",
   "Science",
   "Festival",
   "Warp",
   "Explorer",
   "Teleport",
   "Cycle",
   "TradeValue",
]);

// Mirror of upstream's BuildingLogic.canBeElectrified(): non-special
// production building whose every output is a storable resource.
// SwissBank is a documented exception; CloneFactory too. CloneLab is
// gated by OsakaCastle in upstream which we don't track — including it
// unconditionally over-applies in the rare CloneLab-without-Osaka case.
const ELECTRIFIABLE_EXTRAS = new Set(["SwissBank", "CloneFactory"]);
const isElectrifiable = (b: Building): boolean => {
   if (ELECTRIFIABLE_EXTRAS.has(b.key)) return true;
   if (b.special) return false;
   const outs = Object.keys(b.output);
   if (outs.length === 0) return false;
   return outs.every((o) => !NON_STORABLE.has(o));
};

// Wonders that have a dedicated LevelBoost-type great-person which
// raises the wonder's effective level by getGreatPersonTotalLevel
// (permanent + harmonic-of-this-run, no wisdom). Mirrors upstream's
// WonderToGreatPerson map in BuildingLogic.ts:1387.
const WONDER_TO_GP: Record<string, string> = {
   InternationalSpaceStation: "WilliamShepherd",
   MarinaBaySands: "LeeKuanYew",
   PalmJumeirah: "EmmanuelleCharpentier",
   AldersonDisk: "DanAlderson",
   DysonSphere: "FreemanDyson",
   MatrioshkaBrain: "VeraRubin",
   RedFort: "AkbarTheGreat",
   Petra: "Zenobia",
   ItaipuDam: "Pele",
   CologneCathedral: "Beethoven",
   SydneyHarbourBridge: "JohnBradfield",
   Hermitage: "Tchaikovsky",
   Habitat67: "GeoffreyHinton",
};

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
   // Per OnProductionComplete.tsx:1720 — Centre Pompidou pushes a
   // global `+level` output multiplier and `+2×level` storage multiplier,
   // where the in-game level is `cities.size + 1`. We treat that count
   // as the wonder's "level" in the sidebar (set manually or filled in
   // by the save importer), then apply the formula below.
   CentrePompidou: (level, ctx) =>
      ctx.prod.flatMap((b) => [
         { building: b.key, kind: "output" as const, value: level },
         { building: b.key, kind: "storage" as const, value: 2 * level },
      ]),

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
   // Temple of Artemis: +1 output/worker/storage to SwordForge + Armory.
   // Per OnProductionComplete.tsx:591.
   TempleOfArtemis: () => [
      { building: "SwordForge", kind: "output", value: 1 },
      { building: "SwordForge", kind: "worker", value: 1 },
      { building: "SwordForge", kind: "storage", value: 1 },
      { building: "Armory", kind: "output", value: 1 },
      { building: "Armory", kind: "worker", value: 1 },
      { building: "Armory", kind: "storage", value: 1 },
   ],
   // Terracotta Army: +1 output/worker/storage to IronMiningCamp.
   // Per OnProductionComplete.tsx:437.
   TerracottaArmy: () => [
      { building: "IronMiningCamp", kind: "output", value: 1 },
      { building: "IronMiningCamp", kind: "worker", value: 1 },
      { building: "IronMiningCamp", kind: "storage", value: 1 },
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
   // CN Tower: every WorldWar/Cold-War age building with tier > 0 gets
   // +m output/worker/storage where m = |ageIdx + 1 − tier|. Per
   // OnProductionComplete.tsx:1012. WorldWarAge.idx = 7, ColdWarAge.idx = 8.
   CNTower: (_, ctx) => {
      const ageIdx: Record<string, number> = { WorldWarAge: 7, ColdWarAge: 8 };
      const out: Array<{ building: string; kind: Contributor["kind"]; value: number }> = [];
      for (const b of ctx.prod) {
         const idx = b.unlockAge ? ageIdx[b.unlockAge] : undefined;
         if (idx === undefined) continue;
         if ((b.tier ?? 0) <= 0) continue;
         const m = Math.abs(idx + 1 - (b.tier ?? 0));
         if (m === 0) continue;
         out.push({ building: b.key, kind: "output", value: m });
         out.push({ building: b.key, kind: "worker", value: m });
         out.push({ building: b.key, kind: "storage", value: m });
      }
      return out;
   },
   // Yangtze River: every Water-CONSUMING building gets +1 output and
   // +1 worker. Storage piece adds +(1 + WuZetian permanent) per
   // building — Wu-Zetian-level dependency handled inline below.
   // Plus triggers ZhengHe.tick(getTotalLevel) — also handled inline.
   // Per OnProductionComplete.tsx:960.
   YangtzeRiver: (_, ctx) =>
      ctx.prod
         .filter((b) => (b.input.Water ?? 0) > 0)
         .flatMap((b) => [
            { building: b.key, kind: "output" as const, value: 1 },
            { building: b.key, kind: "worker" as const, value: 1 },
         ]),
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
//     (`TRADE_TILE_BONUS = 5`) — PER TILE
//   • WorldTradeOrganization adds +wtoLevel output PER TILE
//   • GreatOceanRoad adds +wonderLevel LEVEL boost ONCE per distinct
//     building type across all owned tiles (deduplicated via Set in
//     OnProductionComplete.tsx's `case "GreatOceanRoad"`)
//   • LakeLouise adds +2 LEVEL boost per ALLY tile (we don't track ally
//     state, so we apply it to every trade tile as an over-approximation)

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
      if (hasLakeLouise) {
         apply(out, tile.building, {
            source: "Lake Louise (assumed ally)",
            kind: "level",
            value: 2,
         });
      }
   }
   if (gorLevel > 0) {
      // Dedupe by building type — upstream uses a Set, so a player with
      // the same building on two trade tiles still only gets +GOR once
      // for that type.
      const distinctTypes = new Set<string>();
      for (const tile of tiles) {
         if (tile.building) distinctTypes.add(tile.building);
      }
      for (const buildingKey of distinctTypes) {
         apply(out, buildingKey, {
            source: `Great Ocean Road (lvl ${gorLevel})`,
            kind: "level",
            value: gorLevel,
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

   // Harmonic series for this-run GP picks: amount → 1 + 1/2 + … + 1/amount.
   // Mirrors RebirthLogic.getGreatPersonThisRunLevel in upstream.
   const harmonic = (n: number): number => {
      if (!Number.isFinite(n) || n <= 0) return 0;
      let s = 0;
      for (let i = 1; i <= n; i++) s += 1 / i;
      return s;
   };

   // Effective wonder level = base build level + getWonderExtraLevel
   // (the LevelBoost-type GP for that wonder, total = perm + harmonic
   // this-run, NO wisdom). Mirrors BuildingLogic.getWonderExtraLevel.
   const wonderExtraLevel = (wonderKey: string): number => {
      const gp = WONDER_TO_GP[wonderKey];
      if (!gp) return 0;
      const perm = userState.greatPeople[gp] ?? 0;
      const tr = harmonic(userState.thisRunGreatPeople?.[gp] ?? 0);
      return Math.floor(perm + tr);
   };
   const effectiveWonderLevel = (wonderKey: string): number =>
      (userState.wonders[wonderKey] ?? 0) + wonderExtraLevel(wonderKey);

   // Pre-pass: per-age extra GP effective levels from wonders the user has
   // (LHC, Sputnik 1, Aphrodite). Each entry tracks both the value and
   // the source wonder so the GP source string can show the breakdown.
   const wonderGpBoosts: Record<string, Array<{ name: string; value: number }>> = {};
   for (const wonder of DATA.wonders) {
      const lvl = effectiveWonderLevel(wonder.key);
      if (lvl <= 0) continue;
      const fn = WONDER_GP_LEVEL_BOOSTS[wonder.key];
      if (!fn) continue;
      for (const { age, value } of fn(lvl)) {
         if (value <= 0) continue;
         if (!wonderGpBoosts[age]) wonderGpBoosts[age] = [];
         wonderGpBoosts[age].push({ name: wonder.name, value });
      }
   }

   // Great People — boost-style only. Effective level = permanent base
   // + harmonic(thisRunPicks) + Age of Wisdom for that age + Σ wonder
   // GP-level boosts. The source string lays out the breakdown so the
   // per-building tooltip explains where every level point came from.
   //
   // We iterate every GP that has either a permanent level OR this-run
   // picks — a fresh-start GP picked this rebirth still buffs buildings
   // even with permanent=0.
   for (const gp of DATA.greatPeople) {
      if (gp.kind !== "boost") continue;
      const baseLevel = userState.greatPeople[gp.key] ?? 0;
      const thisRunPicks = userState.thisRunGreatPeople?.[gp.key] ?? 0;
      if (baseLevel <= 0 && thisRunPicks <= 0) continue;
      const thisRunLevel = harmonic(thisRunPicks);
      // Wisdom only applies to GPs without a city restriction
      // (isEligibleForWisdom in upstream).
      const wisdomEligible = !gp.city;
      const wisdom = wisdomEligible ? (userState.ageWisdom[gp.age] ?? 0) : 0;
      const wonderBoosts = wonderGpBoosts[gp.age] ?? [];
      const wonderTotal = wonderBoosts.reduce((s, b) => s + b.value, 0);
      const effectiveLevel = baseLevel + thisRunLevel + wisdom + wonderTotal;
      // Per-tick contribution = value(level) = level × valueMultiplier.
      // Game makes separate tick() calls per source (perm/this-run/
      // wisdom/wonder-boost), each calling value() — but value() is
      // linear so summing first is mathematically equivalent.
      const valueMult = gp.valueMultiplier ?? 1;
      const contribution = effectiveLevel * valueMult;

      // Compose a "5 + 1.83 this run + 2 wisdom + 4 LHC, ×2 value" breakdown.
      const parts: string[] = [`${baseLevel}`];
      if (thisRunLevel > 0) {
         parts.push(`${thisRunLevel.toFixed(2)} this run (×${thisRunPicks})`);
      }
      if (wisdom > 0) parts.push(`${wisdom} wisdom`);
      for (const wb of wonderBoosts) parts.push(`${wb.value} ${wb.name}`);
      const breakdown = parts.length > 1 ? ` = ${parts.join(" + ")}` : "";
      const valNote = valueMult !== 1 ? `, ×${valueMult} value` : "";
      const source = `${gp.name} (lvl ${effectiveLevel.toFixed(2)}${breakdown}${valNote})`;

      const buildings = gp.buildings ?? [];
      const multipliers = (gp.multipliers ?? []) as Contributor["kind"][];
      for (const buildingKey of buildings) {
         for (const mult of multipliers) {
            apply(out, buildingKey, { source, kind: mult, value: contribution });
         }
      }
   }

   // Adaptive Great People — player picks ONE building per Adaptive GP
   // (Narmer, KingDavid, Laozi, GenghisKhan, ChristopherColumbus,
   // MichaelFaraday, OskarSchindler, NeilArmstrong, SidMeier). The
   // chosen building gets value(level) output + storage. Skipped by
   // the game when the chosen building produces Worker (per
   // tickAdaptiveGreatPerson).
   for (const gp of DATA.greatPeople) {
      if (gp.kind !== "adaptive") continue;
      const target = userState.adaptiveGreatPeople?.[gp.key];
      if (!target) continue;
      const targetDef = allBuildings.find((b) => b.key === target);
      if (targetDef && (targetDef.output.Worker ?? 0) > 0) continue;
      const baseLevel = userState.greatPeople[gp.key] ?? 0;
      const thisRunPicks = userState.thisRunGreatPeople?.[gp.key] ?? 0;
      const wonderBoosts = wonderGpBoosts[gp.age] ?? [];
      // Per-tick GP loop in upstream calls tick() for perm AND this-run
      // (no eligibility check); wonder cases (LHC, Sputnik1, Aphrodite)
      // also call tick() on every GP of their age — Adaptive included.
      // Each tick adds value(level) = level × valueMult to the assigned
      // building's output + storage multipliers. value() is linear so we
      // sum all sources into one effective level.
      // Adaptive GPs are NOT eligible for Age of Wisdom (upstream's
      // isEligibleForWisdom requires Normal && !city) — that source
      // alone is excluded.
      if (baseLevel <= 0 && thisRunPicks <= 0 && wonderBoosts.length === 0) {
         continue;
      }
      const thisRunLevel = harmonic(thisRunPicks);
      const wonderTotal = wonderBoosts.reduce((s, b) => s + b.value, 0);
      const effectiveLevel = baseLevel + thisRunLevel + wonderTotal;
      const valueMult = gp.valueMultiplier ?? 1;
      const contribution = effectiveLevel * valueMult;

      const parts: string[] = [`${baseLevel}`];
      if (thisRunLevel > 0) {
         parts.push(`${thisRunLevel.toFixed(2)} this run (×${thisRunPicks})`);
      }
      for (const wb of wonderBoosts) parts.push(`${wb.value} ${wb.name}`);
      const breakdown = parts.length > 1 ? ` = ${parts.join(" + ")}` : "";
      const valNote = valueMult !== 1 ? `, ×${valueMult} value` : "";
      const source = `${gp.name} → ${target} (lvl ${effectiveLevel.toFixed(2)}${breakdown}${valNote})`;

      apply(out, target, { source, kind: "output", value: contribution });
      apply(out, target, { source, kind: "storage", value: contribution });
   }

   // Wonders — only those with effect entries above.
   const ctx: EffectCtx = { prod };
   for (const wonder of DATA.wonders) {
      const base = userState.wonders[wonder.key] ?? 0;
      // The wonder must actually be built — getWonderExtraLevel boost
      // only applies to a built wonder (its case-statement runs only
      // for placed buildings).
      if (base <= 0) continue;
      const fn = WONDER_EFFECTS[wonder.key];
      if (!fn) continue;
      const level = effectiveWonderLevel(wonder.key);
      const extra = level - base;
      const source = extra > 0
         ? `${wonder.name} (lvl ${level} = ${base} + ${extra} ${WONDER_TO_GP[wonder.key]})`
         : `${wonder.name} (lvl ${level})`;
      for (const d of fn(level, ctx)) {
         apply(out, d.building, { source, kind: d.kind, value: d.value });
      }
   }

   // PoweredBuilding boost — Update.ts:702 in upstream. Every electrifiable
   // building with `power: true` gets +5 effective level once the
   // Electricity feature is unlocked (which is true for any player
   // late enough to be tweaking bonuses in this tool). We apply it
   // unconditionally; a pre-Electricity user would see a small over-
   // prediction here.
   for (const b of prod) {
      if (!b.requiresPower) continue;
      if (!isElectrifiable(b)) continue;
      apply(out, b.key, {
         source: "Powered building",
         kind: "level",
         value: 5,
      });
   }

   // Researched techs — each unlocked tech with a buildingMultiplier
   // contributes its multipliers to the listed buildings (output / worker
   // / storage). Mirrors how Upgrades work; tech defs use the same shape.
   for (const tech of TECHS) {
      if (!userState.unlockedTechs?.[tech.key]) continue;
      const source = `Tech: ${tech.name}`;
      for (const [buildingKey, kinds] of Object.entries(tech.buildingMultiplier)) {
         if (typeof kinds.output === "number" && kinds.output !== 0) {
            apply(out, buildingKey, { source, kind: "output", value: kinds.output });
         }
         if (typeof kinds.worker === "number" && kinds.worker !== 0) {
            apply(out, buildingKey, { source, kind: "worker", value: kinds.worker });
         }
         if (typeof kinds.storage === "number" && kinds.storage !== 0) {
            apply(out, buildingKey, { source, kind: "storage", value: kinds.storage });
         }
      }
   }

   // Yangtze River — Wu-Zetian-dependent storage + ZhengHe-trigger
   // pieces. The base +1 output / +1 worker to Water consumers is
   // already in WONDER_EFFECTS above. Per OnProductionComplete.tsx:960.
   const yangtzeLevel = userState.wonders.YangtzeRiver ?? 0;
   if (yangtzeLevel > 0) {
      const wuZetian = userState.greatPeople.WuZetian ?? 0;
      // Storage: +1 + wuZetian to Water-consumers, +wuZetian to others.
      for (const b of prod) {
         const consumesWater = (b.input.Water ?? 0) > 0;
         if (consumesWater) {
            apply(out, b.key, {
               source: `Yangtze River (Wu Zetian +${wuZetian})`,
               kind: "storage",
               value: 1 + wuZetian,
            });
         } else if (wuZetian > 0) {
            apply(out, b.key, {
               source: `Yangtze River (Wu Zetian +${wuZetian})`,
               kind: "storage",
               value: wuZetian,
            });
         }
      }
      // ZhengHe.tick(getGreatPersonTotalLevel("ZhengHe")) — total =
      // permanent + harmonic(thisRunPicks). NB: wisdom is NOT included
      // (per RebirthLogic.getGreatPersonTotalLevel).
      const zhengPerm = userState.greatPeople.ZhengHe ?? 0;
      const zhengThisRun = harmonic(userState.thisRunGreatPeople?.ZhengHe ?? 0);
      const zhengTotal = zhengPerm + zhengThisRun;
      if (zhengTotal > 0) {
         // ZhengHe value(level) = level (multiplier 1). Boosts
         // CaravelBuilder + GalleonBuilder, output + storage.
         const zhengContribution = zhengTotal; // valueMultiplier = 1
         const src = `Yangtze River → Zheng He (lvl ${zhengTotal.toFixed(2)})`;
         for (const buildingKey of ["CaravelBuilder", "GalleonBuilder"]) {
            apply(out, buildingKey, { source: src, kind: "output", value: zhengContribution });
            apply(out, buildingKey, { source: src, kind: "storage", value: zhengContribution });
         }
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

   // United Nations — General Assembly weekly voted boost: each picked
   // building gets +5 + (UN level − 1) = +(UN level + 4) output. The
   // universal +1 to all tier-4..6 buildings is handled by UN's entry
   // in WONDER_EFFECTS; this is the additional voted-boost layer.
   const unLevel = userState.wonders.UnitedNations ?? 0;
   const unList = userState.unitedNationsBuildings ?? [];
   if (unLevel > 0 && unList.length > 0) {
      const value = unLevel + 4;
      const source = `United Nations General Assembly (lvl ${unLevel})`;
      for (const buildingKey of unList) {
         if (!buildingKey) continue;
         apply(out, buildingKey, { source, kind: "output", value });
      }
   }

   // Habitat 67 — targets AILab specifically. Wonder level grants
   // +wonderLevel output/worker/storage; an Information-Age-Wisdom
   // value adds another +wisdom output/storage on top; and a non-zero
   // happiness reading gives an additional +floor(happiness/5) level
   // boost (per OnProductionComplete.tsx:2204).
   const habitatBase = userState.wonders.Habitat67 ?? 0;
   const habitatLevel = effectiveWonderLevel("Habitat67");
   const happiness = Math.max(0, Math.floor(userState.finalHappiness ?? 0));
   if (habitatBase > 0) {
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

   // ChoghaZanbil / LuxorTemple / BigBen — directional wonders. Each
   // picks one of several "paths" (Tradition / Religion / Ideology);
   // every level reached unlocks the path's upgrade at index level-1.
   // We look up each unlocked upgrade's buildingMultiplier and stack
   // them additively. Source: OnProductionComplete.tsx:1061..1113 +
   // UpgradeDefinitions.ts.
   for (const [wonderKey, def] of Object.entries(DIRECTIONAL)) {
      const wonderLevel = userState.wonders[wonderKey] ?? 0;
      if (wonderLevel <= 0) continue;
      const direction = userState.wonderDirections?.[wonderKey];
      if (!direction) continue;
      const path = def.paths[direction];
      if (!path) continue;
      const wonderName =
         DATA.wonders.find((w) => w.key === wonderKey)?.name ?? wonderKey;
      // Walk every unlocked upgrade (indices 0..wonderLevel-1, capped at
      // path length so an over-typed level doesn't crash).
      const reached = Math.min(wonderLevel, path.length);
      for (let i = 0; i < reached; i++) {
         const upgradeKey = path[i];
         const source = `${wonderName} · ${direction} ${["I", "II", "III", "IV", "V"][i] ?? i + 1}`;
         const effects = UPGRADES[upgradeKey];
         if (effects) {
            for (const [buildingKey, kinds] of Object.entries(effects)) {
               if (typeof kinds.output === "number" && kinds.output !== 0) {
                  apply(out, buildingKey, {
                     source,
                     kind: "output",
                     value: kinds.output,
                  });
               }
               if (typeof kinds.worker === "number" && kinds.worker !== 0) {
                  apply(out, buildingKey, {
                     source,
                     kind: "worker",
                     value: kinds.worker,
                  });
               }
               if (typeof kinds.storage === "number" && kinds.storage !== 0) {
                  apply(out, buildingKey, {
                     source,
                     kind: "storage",
                     value: kinds.storage,
                  });
               }
            }
         }
         // Special-case upgrades whose effect isn't expressible as a
         // static buildingMultiplier map — these need bespoke handling
         // matched against upstream's per-tick code.
         if (upgradeKey === "Liberalism5") {
            // "All buildings that can be electrified get +5 Building
            // Level Boost for free." — Update.ts:704.
            for (const b of prod) {
               if (!isElectrifiable(b)) continue;
               apply(out, b.key, { source, kind: "level", value: 5 });
            }
         }
         if (upgradeKey === "Liberalism4") {
            // "All power plants get +1 Production Multiplier." —
            // Liberalism4.tick in UpgradeDefinitions.ts.
            for (const b of prod) {
               if ((b.output.Power ?? 0) > 0) {
                  apply(out, b.key, { source, kind: "output", value: 1 });
               }
            }
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
