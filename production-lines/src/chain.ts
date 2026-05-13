// Given a root building (amount, level) and a subgraph of upstream
// producers, compute the minimum integer count of every producer needed
// to feed the root without a deficit.
//
// Math (matches IntraTickCache.ts in upstream):
//   effective_level(P)        = level(P) + Σ levelBoost(P)
//   per-tick supply from P    = baseOutput[P][M] × effective_level(P)
//                                                × (1 + Σ output mults(P))
//   per-tick demand from C    = baseInput[C][M] × effective_level(C)
//                                                × amount(C)
//                               (inputs are NOT scaled by output mults)
//   required count of P       = ⌈demand / supply⌉
//
// When multiple producers in the subgraph output the same material,
// demand is split evenly across them.

import type { BuildingBonus } from "./bonusResolver";
import type { Building } from "./buildingTypes";

const NON_WALKABLE_INPUTS = new Set([
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

export interface ChainResult {
   /** User-set or computed building count. */
   amount: number;
   /** Base level *as displayed in the level input* (without bonus boosts). */
   level: number;
   /** Effective level used by the math: `level + bonus.levelBoost`. */
   effectiveLevel: number;
   /** Effective per-unit per-tick output multiplier: 1 + Σ output mults.
    *  1.0 means no bonuses, 1.5 means a +50% effective bonus. */
   outputMultiplier: number;
   /** Per-tick output of each output material at this amount × effective
    *  level × output multiplier. */
   outputPerTick: Map<string, number>;
}

export interface ChainOptions {
   rootKey: string;
   rootAmount: number;
   rootLevel: number;
   /** Per-building level overrides; missing entries fall back to rootLevel. */
   levelOverrides: Record<string, number>;
   /** Per-building amount overrides. When set on a non-root building the
    *  override REPLACES the computed-from-demand amount, and upstream
    *  producers are sized for the override (not the original demand). */
   amountOverrides: Record<string, number>;
   subgraph: Building[];
   /** Per-building bonus contributions from GPs / wonders / Age of Wisdom.
    *  Empty Map disables bonuses entirely (the math then matches the
    *  un-modified per-tick formula). */
   bonuses: Map<string, BuildingBonus>;
}

export const computeChainAmounts = ({
   rootKey,
   rootAmount,
   rootLevel,
   levelOverrides,
   amountOverrides,
   subgraph,
   bonuses,
}: ChainOptions): Map<string, ChainResult> => {
   const levels = new Map<string, number>();
   for (const b of subgraph) {
      const override = levelOverrides[b.key];
      levels.set(b.key, Number.isFinite(override) && override > 0 ? override : rootLevel);
   }
   // Effective level = base level + any levelBoost from bonuses.
   const effectiveLevelOf = (key: string): number =>
      (levels.get(key) ?? rootLevel) + (bonuses.get(key)?.levelBoost ?? 0);
   const outputFactorOf = (key: string): number =>
      1 + (bonuses.get(key)?.outputMultiplier ?? 0);

   const amounts = new Map<string, number>();
   amounts.set(rootKey, Math.max(0, Math.floor(rootAmount)));

   // Index producers within the subgraph by output material.
   const producersOf = new Map<string, Building[]>();
   for (const b of subgraph) {
      for (const m of Object.keys(b.output)) {
         if (NON_WALKABLE_INPUTS.has(m)) continue;
         if (!producersOf.has(m)) producersOf.set(m, []);
         producersOf.get(m)!.push(b);
      }
   }

   // Walk consumers → producers. Sort by descending tier so any consumer's
   // amount is usually finalised before we visit the producers feeding it.
   // BUT: a few same-tier producer/consumer pairs exist (e.g. tier-4
   // University ← Pagoda for Faith), where the per-tier order is otherwise
   // unstable. To handle those without giving up the tier-sorted shortcut,
   // re-run the sweep until amounts stop changing — typically settles in
   // 2-3 passes; capped at 16 to fail loud on a real cycle.
   const sorted = subgraph
      .slice()
      .sort((a, b) => (b.tier ?? 0) - (a.tier ?? 0));

   // Snapshot of last pass's amounts — what we feed into THIS pass as
   // the "consumer side" of the sweep. New per-pass demand accumulates
   // into a fresh map. When the post-pass map equals the snapshot, we've
   // hit a fixed point.
   let prevAmounts = new Map(amounts);
   for (let pass = 0; pass < 16; pass++) {
      const next = new Map<string, number>();
      next.set(rootKey, prevAmounts.get(rootKey) ?? 0);
      // Honour amount overrides for non-root consumers: they replace
      // whatever demand we'd otherwise have accumulated into them.
      for (const [key, override] of Object.entries(amountOverrides)) {
         if (key === rootKey) continue;
         if (Number.isFinite(override) && override >= 0) {
            next.set(key, Math.floor(override));
         }
      }
      for (const consumer of sorted) {
         const cAmount = next.get(consumer.key) ?? prevAmounts.get(consumer.key) ?? 0;
         if (cAmount === 0) continue;
         const cEff = effectiveLevelOf(consumer.key);
         for (const [mat, baseIn] of Object.entries(consumer.input)) {
            if (NON_WALKABLE_INPUTS.has(mat)) continue;
            const totalDemand = baseIn * cEff * cAmount;
            if (totalDemand <= 0) continue;
            const allProducers = producersOf.get(mat) ?? [];
            const producers = allProducers.filter((p) => p.key !== consumer.key);
            if (producers.length === 0) continue;
            const perProducerDemand = totalDemand / producers.length;
            for (const p of producers) {
               const pEff = effectiveLevelOf(p.key);
               const perUnitSupply = (p.output[mat] ?? 0) * pEff * outputFactorOf(p.key);
               if (perUnitSupply <= 0) continue;
               // Don't push demand into a manually-overridden producer:
               // its amount is set by the user, full stop.
               if (
                  p.key !== rootKey &&
                  Number.isFinite(amountOverrides[p.key]) &&
                  amountOverrides[p.key] >= 0
               ) {
                  continue;
               }
               const required = Math.ceil(perProducerDemand / perUnitSupply);
               next.set(p.key, (next.get(p.key) ?? 0) + required);
            }
         }
      }
      // Stable when keys + values match between passes.
      let stable = next.size === prevAmounts.size;
      if (stable) {
         for (const [k, v] of next) {
            if (prevAmounts.get(k) !== v) { stable = false; break; }
         }
      }
      prevAmounts = next;
      if (stable) break;
   }
   amounts.clear();
   for (const [k, v] of prevAmounts) amounts.set(k, v);

   const result = new Map<string, ChainResult>();
   for (const b of subgraph) {
      const amount = amounts.get(b.key) ?? 0;
      const level = levels.get(b.key) ?? rootLevel;
      const effectiveLevel = effectiveLevelOf(b.key);
      const outputMultiplier = outputFactorOf(b.key);
      const outputPerTick = new Map<string, number>();
      for (const [m, n] of Object.entries(b.output)) {
         outputPerTick.set(m, n * effectiveLevel * outputMultiplier * amount);
      }
      result.set(b.key, {
         amount,
         level,
         effectiveLevel,
         outputMultiplier,
         outputPerTick,
      });
   }
   return result;
};
