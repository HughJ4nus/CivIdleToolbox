// Resolves a hex's text label to the *effective* tile range of the wonder
// named on it, taking active festivals, unlocked upgrades, and adjacency into
// account. Mirrors `getBuildingRange` in CivIdle's BuildingLogic.ts — keep
// this file in sync when the game adds or changes range modifiers.

import buildings from "./data/buildings.json";

interface BuildingEntry {
   key: string;
   name: string;
   special: "WorldWonder" | "NaturalWonder" | "HQ" | null;
   range?: number;
}

const ALL: BuildingEntry[] = buildings as BuildingEntry[];

// Lookup tables built lazily from buildings.json. Both display name and game
// key are accepted, case-insensitive and trim-tolerant.
const ENTRY_BY_LABEL: ReadonlyMap<string, BuildingEntry> = (() => {
   const m = new Map<string, BuildingEntry>();
   for (const b of ALL) {
      m.set(b.name.trim().toLowerCase(), b);
      m.set(b.key.trim().toLowerCase(), b);
   }
   return m;
})();

export const lookupBuilding = (text: string | undefined): BuildingEntry | null => {
   if (!text) return null;
   return ENTRY_BY_LABEL.get(text.trim().toLowerCase()) ?? null;
};

// ── Modifier metadata ──────────────────────────────────────────────────────

interface FestivalEffect {
   /** "override" replaces the base; "delta" adds to the running total. */
   mode: "override" | "delta";
   value: number;
}

// Wonders whose festival changes their tile range. Pulled from the
// `getBuildingRange` switch — most use `isFestival ? X : base` (override),
// while AtlasMountains adds +2 on top of any upgrade boost.
const FESTIVAL_RANGE: Record<string, FestivalEffect> = {
   Capybara: { mode: "override", value: 3 },
   GiantOtter: { mode: "override", value: 3 },
   Hoatzin: { mode: "override", value: 3 },
   RoyalFlycatcher: { mode: "override", value: 3 },
   RedFort: { mode: "override", value: 5 },
   SanchiStupa: { mode: "override", value: 3 },
   GangesRiver: { mode: "override", value: 2 },
   Uluru: { mode: "override", value: 3 },
   KizhiPogost: { mode: "override", value: 6 },
   LakeBaikal: { mode: "override", value: 4 },
   AuroraBorealis: { mode: "override", value: 4 },
   AtlasMountains: { mode: "delta", value: 2 },
};

interface UpgradeBoost {
   upgrade: string;
   delta: number;
}

const UPGRADE_BOOSTS: Record<string, UpgradeBoost[]> = {
   AtlasMountains: [{ upgrade: "SuffeteAdministration", delta: 2 }],
   SagradaFamilia: [{ upgrade: "CothonDockyards", delta: 2 }],
   CristoRedentor: [{ upgrade: "CothonDockyards", delta: 2 }],
   Atomium: [{ upgrade: "CothonDockyards", delta: 2 }],
};

interface AdjacencyOverride {
   neighborKey: string;
   neighborName: string;
   rangeWhenAdjacent: number;
}

// Wonders whose range is fixed by what sits next to them. Detected from cell
// labels — no toggle needed: if you put YangtzeRiver next to YellowCraneTower
// on the map, the boost activates.
const ADJACENCY_OVERRIDES: Record<string, AdjacencyOverride> = {
   YellowCraneTower: {
      neighborKey: "YangtzeRiver",
      neighborName: "Yangtze River",
      rangeWhenAdjacent: 2,
   },
   GreatWall: {
      neighborKey: "ForbiddenCity",
      neighborName: "Forbidden City",
      rangeWhenAdjacent: 2,
   },
};

// ── UI catalogues ──────────────────────────────────────────────────────────

export interface FestivalToggleInfo {
   key: string;
   name: string;
   baseRange: number;
   festivalRange: number;
}

export interface UpgradeInfo {
   id: string;
   name: string;
   /** Wonder keys this upgrade boosts, with their boosted ranges. */
   affects: Array<{ key: string; name: string; baseRange: number; boostedRange: number }>;
}

const UPGRADE_NAMES: Record<string, string> = {
   SuffeteAdministration: "Suffete Administration",
   CothonDockyards: "Cothon Dockyards",
};

/** All wonders whose range changes when their festival is active. */
export const FESTIVAL_TOGGLES: ReadonlyArray<FestivalToggleInfo> = (() => {
   const out: FestivalToggleInfo[] = [];
   for (const key of Object.keys(FESTIVAL_RANGE)) {
      const entry = ALL.find((b) => b.key === key);
      if (!entry || entry.range == null) continue;
      const eff = FESTIVAL_RANGE[key];
      const festivalRange = eff.mode === "override" ? eff.value : entry.range + eff.value;
      out.push({
         key,
         name: entry.name,
         baseRange: entry.range,
         festivalRange,
      });
   }
   out.sort((a, b) => a.name.localeCompare(b.name));
   return out;
})();

/** Upgrades that affect any wonder's range. */
export const UPGRADE_TOGGLES: ReadonlyArray<UpgradeInfo> = (() => {
   const grouped = new Map<string, UpgradeInfo>();
   for (const [wonderKey, boosts] of Object.entries(UPGRADE_BOOSTS)) {
      const wonder = ALL.find((b) => b.key === wonderKey);
      if (!wonder || wonder.range == null) continue;
      for (const boost of boosts) {
         const id = boost.upgrade;
         if (!grouped.has(id)) {
            grouped.set(id, { id, name: UPGRADE_NAMES[id] ?? id, affects: [] });
         }
         grouped.get(id)!.affects.push({
            key: wonder.key,
            name: wonder.name,
            baseRange: wonder.range,
            boostedRange: wonder.range + boost.delta,
         });
      }
   }
   for (const info of grouped.values()) {
      info.affects.sort((a, b) => a.name.localeCompare(b.name));
   }
   return [...grouped.values()].sort((a, b) => a.name.localeCompare(b.name));
})();

// ── Effective-range computation ────────────────────────────────────────────

export interface RangeContext {
   festivals: ReadonlySet<string>;
   upgrades: ReadonlySet<string>;
}

export const buildRangeContext = (
   activeFestivals: readonly string[],
   activeUpgrades: readonly string[],
): RangeContext => ({
   festivals: new Set(activeFestivals),
   upgrades: new Set(activeUpgrades),
});

const matchesNeighbor = (text: string, expectedKey: string, expectedName: string): boolean => {
   const e = lookupBuilding(text);
   if (e) return e.key === expectedKey;
   return text.trim().toLowerCase() === expectedName.toLowerCase();
};

/**
 * Effective range for a wonder named in `text`. Returns null if the label
 * doesn't match a known ranged wonder, or if the wonder's effective range is
 * 0 (no ring to draw). `neighborTexts` is consulted only for adjacency-
 * conditioned wonders (YellowCraneTower / GreatWall).
 */
export const getEffectiveRange = (
   text: string | undefined,
   ctx: RangeContext,
   neighborTexts: readonly string[],
): number | null => {
   const entry = lookupBuilding(text);
   if (!entry || entry.range == null) return null;

   // Adjacency-conditioned wonders ignore festivals/upgrades — they take the
   // full override or the static base.
   const adj = ADJACENCY_OVERRIDES[entry.key];
   if (adj) {
      const boosted = neighborTexts.some((t) => matchesNeighbor(t, adj.neighborKey, adj.neighborName));
      const r = boosted ? adj.rangeWhenAdjacent : entry.range;
      return r >= 1 ? r : null;
   }

   let range = entry.range;
   const fest = FESTIVAL_RANGE[entry.key];
   if (fest && ctx.festivals.has(entry.key)) {
      range = fest.mode === "override" ? fest.value : range + fest.value;
   }
   for (const u of UPGRADE_BOOSTS[entry.key] ?? []) {
      if (ctx.upgrades.has(u.upgrade)) range += u.delta;
   }
   return range >= 1 ? range : null;
};

/** Back-compat: baseline range with no modifiers, for tests / simple lookups. */
export const lookupWonderRange = (text: string | undefined): number | null => {
   const e = lookupBuilding(text);
   return e?.range ?? null;
};
