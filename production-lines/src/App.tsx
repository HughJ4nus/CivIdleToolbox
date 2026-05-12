import { useEffect, useMemo, useRef, useState } from "react";
import buildingsData from "./data/buildings.json";
import { countAdjacentCrossings, reorderByBarycenter, type Edge } from "./layout";

interface Building {
   key: string;
   name: string;
   special: "WorldWonder" | "NaturalWonder" | "HQ" | null;
   tier: number | null;
   input: Record<string, number>;
   output: Record<string, number>;
}

const ALL_BUILDINGS = buildingsData as unknown as Building[];

// Inputs that don't represent a tangible upstream building (workers come
// from population, power from the grid, etc.). Drawing lines for these
// would clutter the chart without explaining a production chain.
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

const subtitleFor = (b: Building): string => {
   const outs = Object.keys(b.output);
   if (outs.length === 0) return "—";
   return outs.join(", ");
};

// Layout constants — must match the CSS variables in styles.css.
const CARD_W = 220;
const CARD_H = 80;
const GAP_X = 110;
const GAP_Y = 40;
const HEADING_H = 30;
const TOP_PAD = GAP_Y;

const ZOOM_MIN = 0.25;
const ZOOM_MAX = 3;

interface CardPos {
   x: number;
   y: number;
   building: Building;
}

export const App = (): JSX.Element => {
   // Bucket non-wonder buildings by tier, alphabetised within each tier as
   // the seed ordering. Crossing-min reorders this in a moment.
   const initialColumns = useMemo(() => {
      const byTier = new Map<number, Building[]>();
      for (const b of ALL_BUILDINGS) {
         if (b.special) continue;
         if (b.tier == null) continue;
         if (!byTier.has(b.tier)) byTier.set(b.tier, []);
         byTier.get(b.tier)!.push(b);
      }
      return [...byTier.entries()]
         .sort(([a], [b]) => a - b)
         .map(([tier, buildings]) => ({
            tier,
            buildings: buildings.slice().sort((a, b) => a.name.localeCompare(b.name)),
         }));
   }, []);

   // Edges are derived from the data, not positions, so reorderByBarycenter
   // can reshuffle columns without us re-deriving the graph.
   const edges = useMemo<Edge[]>(() => {
      const skip = NON_WALKABLE_INPUTS;
      const producersFor = new Map<string, string[]>();
      for (const col of initialColumns) {
         for (const b of col.buildings) {
            for (const m of Object.keys(b.output)) {
               if (skip.has(m)) continue;
               if (!producersFor.has(m)) producersFor.set(m, []);
               producersFor.get(m)!.push(b.key);
            }
         }
      }
      const out: Edge[] = [];
      for (const col of initialColumns) {
         for (const b of col.buildings) {
            for (const m of Object.keys(b.input)) {
               if (skip.has(m)) continue;
               const ps = producersFor.get(m);
               if (!ps) continue;
               for (const p of ps) {
                  if (p !== b.key) out.push({ producer: p, consumer: b.key });
               }
            }
         }
      }
      return out;
   }, [initialColumns]);

   // Apply Sugiyama-style barycenter sweeps to minimise edge crossings.
   const columns = useMemo(() => {
      const reordered = reorderByBarycenter(
         initialColumns.map((c) => ({ buildings: c.buildings })),
         edges,
         { keyOf: (b) => b.key },
      );
      return initialColumns.map((c, i) => ({ tier: c.tier, buildings: reordered[i] }));
   }, [initialColumns, edges]);

   // Diagnostics — exposed in the topbar so we can see the heuristic working.
   const crossingsBefore = useMemo(
      () =>
         countAdjacentCrossings(
            initialColumns.map((c) => c.buildings),
            edges,
            (b) => b.key,
         ),
      [initialColumns, edges],
   );
   const crossingsAfter = useMemo(
      () =>
         countAdjacentCrossings(
            columns.map((c) => c.buildings),
            edges,
            (b) => b.key,
         ),
      [columns, edges],
   );

   const totalCount = useMemo(
      () => columns.reduce((acc, c) => acc + c.buildings.length, 0),
      [columns],
   );

   // Card positions: laid out by hand so we can compute connection paths.
   // Each column starts at x = colIdx * (CARD_W + GAP_X). The first card in
   // a column sits below the heading at y = HEADING_H + TOP_PAD.
   const layout = useMemo(() => {
      const map = new Map<string, CardPos>();
      columns.forEach((col, colIdx) => {
         const x = colIdx * (CARD_W + GAP_X);
         col.buildings.forEach((b, rowIdx) => {
            const y = HEADING_H + TOP_PAD + rowIdx * (CARD_H + GAP_Y);
            map.set(b.key, { x, y, building: b });
         });
      });
      return map;
   }, [columns]);

   const worldDims = useMemo(() => {
      const colCount = columns.length;
      const maxRows = columns.reduce((m, c) => Math.max(m, c.buildings.length), 0);
      return {
         width: colCount * CARD_W + (colCount - 1) * GAP_X,
         height: HEADING_H + TOP_PAD + maxRows * CARD_H + (maxRows - 1) * GAP_Y,
      };
   }, [columns]);

   // Map each edge to a cubic bezier between producer's right edge and
   // consumer's left edge. Control points are pulled horizontally by half
   // the gap, yielding the smooth "S" that leaves/arrives horizontally.
   const connections = useMemo(() => {
      const lines: Array<{ d: string; key: string }> = [];
      for (let i = 0; i < edges.length; i++) {
         const e = edges[i];
         const producer = layout.get(e.producer);
         const consumer = layout.get(e.consumer);
         if (!producer || !consumer) continue;
         const px = producer.x + CARD_W;
         const py = producer.y + CARD_H / 2;
         const cx = consumer.x;
         const cy = consumer.y + CARD_H / 2;
         const dx = (cx - px) * 0.5;
         const d = `M ${px},${py} C ${px + dx},${py} ${cx - dx},${cy} ${cx},${cy}`;
         lines.push({ d, key: `${e.producer}->${e.consumer}-${i}` });
      }
      return lines;
   }, [edges, layout]);

   // ── Pan + zoom ────────────────────────────────────────────────────────
   const viewportRef = useRef<HTMLDivElement | null>(null);
   const [zoom, setZoom] = useState(0.7);
   const [pan, setPan] = useState({ x: 80, y: 40 });
   const dragRef = useRef<{ active: boolean; lastX: number; lastY: number }>({
      active: false,
      lastX: 0,
      lastY: 0,
   });

   const onMouseDown = (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      dragRef.current = { active: true, lastX: e.clientX, lastY: e.clientY };
   };

   useEffect(() => {
      const onMove = (e: MouseEvent) => {
         if (!dragRef.current.active) return;
         const dx = e.clientX - dragRef.current.lastX;
         const dy = e.clientY - dragRef.current.lastY;
         dragRef.current.lastX = e.clientX;
         dragRef.current.lastY = e.clientY;
         setPan((p) => ({ x: p.x + dx, y: p.y + dy }));
      };
      const onUp = () => {
         dragRef.current.active = false;
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
      return () => {
         window.removeEventListener("mousemove", onMove);
         window.removeEventListener("mouseup", onUp);
      };
   }, []);

   useEffect(() => {
      const el = viewportRef.current;
      if (!el) return;
      const onWheel = (e: WheelEvent) => {
         e.preventDefault();
         const rect = el.getBoundingClientRect();
         const screenX = e.clientX - rect.left;
         const screenY = e.clientY - rect.top;
         // 1.025 per notch — gentle zoom step.
         const factor = e.deltaY < 0 ? 1.025 : 1 / 1.025;
         setZoom((prev) => {
            const next = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, prev * factor));
            const ratio = next / prev;
            setPan((p) => ({
               x: screenX - (screenX - p.x) * ratio,
               y: screenY - (screenY - p.y) * ratio,
            }));
            return next;
         });
      };
      el.addEventListener("wheel", onWheel, { passive: false });
      return () => el.removeEventListener("wheel", onWheel);
   }, []);

   const resetView = () => {
      setZoom(0.7);
      setPan({ x: 80, y: 40 });
   };

   return (
      <div className="app">
         <header className="topbar">
            <div className="brand">
               <h1>CivIdle production buildings</h1>
               <span className="tagline">
                  {totalCount} buildings · {connections.length} input lines ·{" "}
                  {crossingsAfter} crossings ({crossingsBefore} before reorder) ·
                  scroll to zoom · drag to pan
               </span>
            </div>
            <div className="zoom-readout">
               <span>{Math.round(zoom * 100)}%</span>
               <button type="button" onClick={resetView}>
                  Reset
               </button>
            </div>
         </header>
         <div
            className="viewport"
            ref={viewportRef}
            onMouseDown={onMouseDown}
            style={{ cursor: dragRef.current.active ? "grabbing" : "grab" }}
         >
            <div
               className="world"
               style={{
                  width: worldDims.width,
                  height: worldDims.height,
                  transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                  transformOrigin: "0 0",
               }}
            >
               {/* Connection layer sits behind the cards. */}
               <svg
                  className="connection-layer"
                  width={worldDims.width}
                  height={worldDims.height}
                  viewBox={`0 0 ${worldDims.width} ${worldDims.height}`}
                  pointerEvents="none"
               >
                  {connections.map((c) => (
                     <path key={c.key} d={c.d} />
                  ))}
               </svg>

               {/* Column headings (text only, positioned over the world). */}
               {columns.map(({ tier, buildings }, colIdx) => (
                  <div
                     key={`hdr-${tier}`}
                     className="tier-heading"
                     style={{
                        left: colIdx * (CARD_W + GAP_X),
                        width: CARD_W,
                     }}
                  >
                     Tier {tier}
                     <span className="count">{buildings.length}</span>
                  </div>
               ))}

               {/* Cards. */}
               {[...layout.values()].map((c) => (
                  <div
                     key={c.building.key}
                     className="card"
                     style={{ left: c.x, top: c.y }}
                  >
                     <div className="card-title">{c.building.name}</div>
                     <div className="card-subtitle">{subtitleFor(c.building)}</div>
                  </div>
               ))}
            </div>
         </div>
      </div>
   );
};
