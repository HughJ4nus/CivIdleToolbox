// Layered DAG crossing minimisation via the barycenter heuristic.
// Sugiyama-style: each column is a layer, every edge goes between layers,
// no intra-layer edges. We sweep left→right then right→left, reordering
// each layer so each card sits at the average vertical position of its
// neighbours in the adjacent layer. Repeat until ordering stops changing.
//
// Worst case is O(passes × layers × cards × edges); for our scale (8 ×
// 136 × 274) it runs in single-digit ms once at startup.

export interface Edge<TKey extends string = string> {
   producer: TKey;
   consumer: TKey;
}

export interface ColumnInput<T> {
   buildings: T[];
}

const arraysEqualByKey = <T>(a: T[], b: T[], keyOf: (x: T) => string): boolean => {
   if (a.length !== b.length) return false;
   for (let i = 0; i < a.length; i++) if (keyOf(a[i]) !== keyOf(b[i])) return false;
   return true;
};

export interface ReorderOptions<T, K extends string> {
   keyOf: (x: T) => K;
   maxPasses?: number;
}

export const reorderByBarycenter = <T, K extends string>(
   initial: ColumnInput<T>[],
   edges: Edge<K>[],
   { keyOf, maxPasses = 12 }: ReorderOptions<T, K>,
): T[][] => {
   const cols = initial.map((c) => c.buildings.slice());

   const sweep = (
      sourceIdx: number,
      targetIdx: number,
      pickAdjKey: (e: Edge<K>) => K,
      pickMyKey: (e: Edge<K>) => K,
   ): boolean => {
      const sourcePos = new Map<string, number>();
      cols[sourceIdx].forEach((b, idx) => sourcePos.set(keyOf(b), idx));

      const ranked = cols[targetIdx].map((b, originalIdx) => {
         const myKey = keyOf(b);
         let sum = 0;
         let count = 0;
         for (const e of edges) {
            if (pickMyKey(e) !== myKey) continue;
            const pos = sourcePos.get(pickAdjKey(e));
            if (pos !== undefined) {
               sum += pos;
               count++;
            }
         }
         // Cards with no edges to the adjacent column keep their current
         // index as their score — they don't get bumped around for no
         // reason.
         const score = count > 0 ? sum / count : originalIdx;
         return { b, score, originalIdx };
      });
      ranked.sort((a, b) => a.score - b.score || a.originalIdx - b.originalIdx);
      const newOrder = ranked.map((r) => r.b);
      if (arraysEqualByKey(newOrder, cols[targetIdx], keyOf)) return false;
      cols[targetIdx] = newOrder;
      return true;
   };

   for (let pass = 0; pass < maxPasses; pass++) {
      let changed = false;
      // Left→right: reorder column i looking at column i-1 (incoming edges).
      for (let i = 1; i < cols.length; i++) {
         if (sweep(i - 1, i, (e) => e.producer, (e) => e.consumer)) changed = true;
      }
      // Right→left: reorder column i looking at column i+1 (outgoing edges).
      for (let i = cols.length - 2; i >= 0; i--) {
         if (sweep(i + 1, i, (e) => e.consumer, (e) => e.producer)) changed = true;
      }
      if (!changed) break;
   }
   return cols;
};

// Counts how many edge crossings occur between every pair of adjacent
// columns, given an ordering. O(layers × E²) — for our scale, sub-ms.
// Only counts crossings between *adjacent* columns; long edges that skip
// columns aren't double-counted across the layers they pass through.
export const countAdjacentCrossings = <T, K extends string>(
   columns: T[][],
   edges: Edge<K>[],
   keyOf: (x: T) => K,
): number => {
   // Position of each card key in its column.
   const colPos: Map<string, number>[] = columns.map((col) => {
      const m = new Map<string, number>();
      col.forEach((b, i) => m.set(keyOf(b), i));
      return m;
   });
   // Column index of each card key.
   const colOf = new Map<string, number>();
   columns.forEach((col, ci) =>
      col.forEach((b) => colOf.set(keyOf(b), ci)),
   );

   let total = 0;
   for (let li = 0; li + 1 < columns.length; li++) {
      // Edges that go strictly from li to li+1.
      const layerEdges: Array<{ pIdx: number; cIdx: number }> = [];
      for (const e of edges) {
         if (colOf.get(e.producer) !== li || colOf.get(e.consumer) !== li + 1) continue;
         const pIdx = colPos[li].get(e.producer);
         const cIdx = colPos[li + 1].get(e.consumer);
         if (pIdx === undefined || cIdx === undefined) continue;
         layerEdges.push({ pIdx, cIdx });
      }
      // Crossing test: edges (a→b) and (c→d) cross iff (a<c && b>d) || (a>c && b<d).
      for (let i = 0; i < layerEdges.length; i++) {
         for (let j = i + 1; j < layerEdges.length; j++) {
            const e1 = layerEdges[i];
            const e2 = layerEdges[j];
            if (
               (e1.pIdx < e2.pIdx && e1.cIdx > e2.cIdx) ||
               (e1.pIdx > e2.pIdx && e1.cIdx < e2.cIdx)
            ) {
               total++;
            }
         }
      }
   }
   return total;
};
