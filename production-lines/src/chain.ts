// Given a root building (amount, level) and a subgraph of upstream
// producers, compute the minimum integer count of every producer needed
// to feed the root without a deficit.
//
// Math (matches the production extractor's per-tick semantics):
//   per-tick demand for material M from a consumer C =
//     baseInput[C][M] × level(C) × amount(C)
//   per-tick supply from one producer P at level L =
//     baseOutput[P][M] × L
//   required count of P = ⌈demand / supply⌉
//
// When multiple producers in the subgraph output the same material,
// demand is split evenly across them.

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
   amount: number;
   level: number;
   /** Per-tick output of each output material at this amount × level. */
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
}

export const computeChainAmounts = ({
   rootKey,
   rootAmount,
   rootLevel,
   levelOverrides,
   amountOverrides,
   subgraph,
}: ChainOptions): Map<string, ChainResult> => {
   const levels = new Map<string, number>();
   for (const b of subgraph) {
      const override = levelOverrides[b.key];
      levels.set(b.key, Number.isFinite(override) && override > 0 ? override : rootLevel);
   }

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
   // amount is finalised before we visit the producers feeding it. (Edges
   // strictly cross tiers in this game's data so this ordering suffices.)
   const sorted = subgraph
      .slice()
      .sort((a, b) => (b.tier ?? 0) - (a.tier ?? 0));

   for (const consumer of sorted) {
      // Non-root override takes precedence over whatever was accumulated
      // from downstream demand. The root's amount is rootAmount and is
      // already in `amounts`; we don't apply override there.
      if (consumer.key !== rootKey) {
         const override = amountOverrides[consumer.key];
         if (Number.isFinite(override) && override >= 0) {
            amounts.set(consumer.key, Math.floor(override));
         }
      }
      const cAmount = amounts.get(consumer.key) ?? 0;
      if (cAmount === 0) continue;
      const cLevel = levels.get(consumer.key) ?? rootLevel;

      for (const [mat, baseIn] of Object.entries(consumer.input)) {
         if (NON_WALKABLE_INPUTS.has(mat)) continue;
         const totalDemand = baseIn * cLevel * cAmount;
         if (totalDemand <= 0) continue;
         const allProducers = producersOf.get(mat) ?? [];
         const producers = allProducers.filter((p) => p.key !== consumer.key);
         if (producers.length === 0) continue;
         const perProducerDemand = totalDemand / producers.length;

         for (const p of producers) {
            const pLevel = levels.get(p.key) ?? rootLevel;
            const perUnitSupply = (p.output[mat] ?? 0) * pLevel;
            if (perUnitSupply <= 0) continue;
            const required = Math.ceil(perProducerDemand / perUnitSupply);
            amounts.set(p.key, (amounts.get(p.key) ?? 0) + required);
         }
      }
   }

   const result = new Map<string, ChainResult>();
   for (const b of subgraph) {
      const amount = amounts.get(b.key) ?? 0;
      const level = levels.get(b.key) ?? rootLevel;
      const outputPerTick = new Map<string, number>();
      for (const [m, n] of Object.entries(b.output)) {
         outputPerTick.set(m, n * level * amount);
      }
      result.set(b.key, { amount, level, outputPerTick });
   }
   return result;
};
