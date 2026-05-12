import {
   useCallback,
   useEffect,
   useMemo,
   useRef,
   useState,
   type CSSProperties,
} from "react";
import type { Building } from "./buildingTypes";
import { computeChainAmounts, type ChainResult } from "./chain";
import buildingsData from "./data/buildings.json";
import { countAdjacentCrossings, reorderByBarycenter, type Edge } from "./layout";

interface Column {
   tier: number;
   buildings: Building[];
}

const ALL_BUILDINGS = buildingsData as unknown as Building[];

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

// Base production per tick at building level 1, no modifiers — exactly
// the output map in BuildingDefinitions.ts (e.g. House → "6× Worker",
// WheatFarm → "1× Wheat"). Effective output in-game is then
// baseOutput × level × (1 + Σ output multipliers).
const subtitleFor = (b: Building): string => {
   const entries = Object.entries(b.output);
   if (entries.length === 0) return "—";
   return entries.map(([m, n]) => `${n}× ${m}`).join(", ");
};

// Layout constants — must match the CSS variables.
const CARD_W = 220;
const CARD_H = 110;
const GAP_X = 110;
const GAP_Y = 55; // half of CARD_H
const HEADING_H = 30;
const TOP_PAD = GAP_Y;

const ZOOM_MIN = 0.25;
const ZOOM_MAX = 3;

interface CardPos {
   x: number;
   y: number;
   building: Building;
}

// ────────────────────────────────────────────────────────────────────────
// Pure helpers
// ────────────────────────────────────────────────────────────────────────

const computeColumnsFor = (buildings: Building[]): Column[] => {
   const byTier = new Map<number, Building[]>();
   for (const b of buildings) {
      if (b.special) continue;
      if (b.tier == null) continue;
      if (!byTier.has(b.tier)) byTier.set(b.tier, []);
      byTier.get(b.tier)!.push(b);
   }
   return [...byTier.entries()]
      .sort(([a], [b]) => a - b)
      .map(([tier, bs]) => ({
         tier,
         buildings: bs.slice().sort((a, b) => a.name.localeCompare(b.name)),
      }));
};

const computeEdgesFor = (buildings: Building[]): Edge[] => {
   const skip = NON_WALKABLE_INPUTS;
   const allow = new Set(buildings.map((b) => b.key));
   const producersFor = new Map<string, string[]>();
   for (const b of buildings) {
      for (const m of Object.keys(b.output)) {
         if (skip.has(m)) continue;
         if (!producersFor.has(m)) producersFor.set(m, []);
         producersFor.get(m)!.push(b.key);
      }
   }
   const out: Edge[] = [];
   for (const b of buildings) {
      for (const m of Object.keys(b.input)) {
         if (skip.has(m)) continue;
         const ps = producersFor.get(m);
         if (!ps) continue;
         for (const p of ps) {
            if (p !== b.key && allow.has(p)) out.push({ producer: p, consumer: b.key });
         }
      }
   }
   return out;
};

const reorderCols = (cols: Column[], edges: Edge[]): Column[] => {
   const reordered = reorderByBarycenter(
      cols.map((c) => ({ buildings: c.buildings })),
      edges,
      { keyOf: (b: Building) => b.key },
   );
   return cols.map((c, i) => ({ tier: c.tier, buildings: reordered[i] }));
};

// BFS upstream + downstream from `root` along edges, returning the set
// of building keys that participate in the production line through it.
const computeProductionLine = (root: string, edges: Edge[]): Set<string> => {
   const out = new Set<string>([root]);
   // Index edges for O(1) neighbour lookups.
   const upFromConsumer = new Map<string, string[]>();
   const downFromProducer = new Map<string, string[]>();
   for (const e of edges) {
      if (!upFromConsumer.has(e.consumer)) upFromConsumer.set(e.consumer, []);
      upFromConsumer.get(e.consumer)!.push(e.producer);
      if (!downFromProducer.has(e.producer)) downFromProducer.set(e.producer, []);
      downFromProducer.get(e.producer)!.push(e.consumer);
   }
   const walk = (start: string, neighbours: Map<string, string[]>) => {
      const queue = [start];
      while (queue.length) {
         const k = queue.shift()!;
         for (const n of neighbours.get(k) ?? []) {
            if (out.has(n)) continue;
            out.add(n);
            queue.push(n);
         }
      }
   };
   walk(root, upFromConsumer);
   walk(root, downFromProducer);
   return out;
};

// ────────────────────────────────────────────────────────────────────────
// usePanZoom — drag-to-pan + scroll-to-zoom for any viewport element.
// ────────────────────────────────────────────────────────────────────────

interface PanZoomState {
   /** Callback ref — assign to the viewport element. Re-binds wheel
    *  listener when the element mounts/unmounts (matters for the modal). */
   viewportRef: (el: HTMLDivElement | null) => void;
   zoom: number;
   pan: { x: number; y: number };
   onMouseDown: (e: React.MouseEvent) => void;
   reset: () => void;
   /** True if the most recent mousedown was followed by any movement. Used
    *  to suppress card-clicks at the end of a drag. */
   movedThisDrag: () => boolean;
}

const usePanZoom = (
   initialZoom: number,
   initialPan: { x: number; y: number },
): PanZoomState => {
   // Track the viewport element via state so effects can react to it
   // mounting (a regular useRef doesn't trigger re-renders, which means
   // the wheel-listener effect runs once with `null` and never re-binds
   // when a lazily-mounted viewport — like the modal — appears).
   const [viewport, setViewport] = useState<HTMLDivElement | null>(null);
   const viewportRef = useCallback((el: HTMLDivElement | null) => setViewport(el), []);

   const [zoom, setZoom] = useState(initialZoom);
   const [pan, setPan] = useState(initialPan);
   const dragRef = useRef({ active: false, lastX: 0, lastY: 0, moved: false });

   const onMouseDown = useCallback((e: React.MouseEvent) => {
      if (e.button !== 0) return;
      dragRef.current = { active: true, lastX: e.clientX, lastY: e.clientY, moved: false };
   }, []);

   useEffect(() => {
      const onMove = (e: MouseEvent) => {
         if (!dragRef.current.active) return;
         const dx = e.clientX - dragRef.current.lastX;
         const dy = e.clientY - dragRef.current.lastY;
         if (Math.abs(dx) + Math.abs(dy) > 0) dragRef.current.moved = true;
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
      if (!viewport) return;
      const onWheel = (e: WheelEvent) => {
         e.preventDefault();
         const rect = viewport.getBoundingClientRect();
         const screenX = e.clientX - rect.left;
         const screenY = e.clientY - rect.top;
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
      viewport.addEventListener("wheel", onWheel, { passive: false });
      return () => viewport.removeEventListener("wheel", onWheel);
   }, [viewport]);

   const reset = useCallback(() => {
      setZoom(initialZoom);
      setPan(initialPan);
   }, [initialZoom, initialPan.x, initialPan.y]);

   const movedThisDrag = useCallback(() => dragRef.current.moved, []);

   return { viewportRef, zoom, pan, onMouseDown, reset, movedThisDrag };
};

// ────────────────────────────────────────────────────────────────────────
// TierWorld — renders cards + bezier lines for a given column set.
// Used both inside the pan/zoom main viewport AND inside the modal body.
// ────────────────────────────────────────────────────────────────────────

interface TierWorldProps {
   columns: Column[];
   edges: Edge[];
   onCardClick?: (key: string) => void;
   highlightKey?: string;
   /** When provided, each card shows its calculated amount + an editable level. */
   chainResults?: Map<string, ChainResult>;
   onLevelChange?: (key: string, level: number) => void;
   /** Pass `null` as amount to clear an override; otherwise an integer. */
   onAmountChange?: (key: string, amount: number | null) => void;
   /** Set of building keys that have a user-set amount override (so the
    *  card UI can show the input as "overridden" rather than computed). */
   amountOverrideKeys?: Set<string>;
}

const TierWorld = ({
   columns,
   edges,
   onCardClick,
   highlightKey,
   chainResults,
   onLevelChange,
   onAmountChange,
   amountOverrideKeys,
}: TierWorldProps): JSX.Element => {
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
         width: Math.max(1, colCount * CARD_W + Math.max(0, colCount - 1) * GAP_X),
         height: Math.max(1, HEADING_H + TOP_PAD + maxRows * CARD_H + Math.max(0, maxRows - 1) * GAP_Y),
      };
   }, [columns]);

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

   return (
      <div
         className="tier-world"
         style={{ width: worldDims.width, height: worldDims.height }}
      >
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

         {columns.map(({ tier, buildings }, colIdx) => (
            <div
               key={`hdr-${tier}`}
               className="tier-heading"
               style={{ left: colIdx * (CARD_W + GAP_X), width: CARD_W }}
            >
               Tier {tier}
               <span className="count">{buildings.length}</span>
            </div>
         ))}

         {[...layout.values()].map((c) => {
            const isHighlight = highlightKey === c.building.key;
            const result = chainResults?.get(c.building.key);
            const className = `card${isHighlight ? " card-highlight" : ""}${onCardClick ? " card-clickable" : ""}${result ? " card-with-chain" : ""}`;
            return (
               <div
                  key={c.building.key}
                  className={className}
                  style={{ left: c.x, top: c.y } as CSSProperties}
                  onClick={onCardClick ? () => onCardClick(c.building.key) : undefined}
               >
                  <div className="card-title">{c.building.name}</div>
                  <div className="card-subtitle">{subtitleFor(c.building)}</div>
                  {result && (
                     <div className="card-chain-row">
                        {/* Amount is editable on every card. The root's
                            amount syncs with the modal header's Amount
                            field — both edit the same state. Overridden
                            (or root) cards render the input in cyan so
                            user-set amounts are obvious at a glance. */}
                        <label
                           className={`card-amount-edit${
                              c.building.key === highlightKey ||
                              amountOverrideKeys?.has(c.building.key)
                                 ? " overridden"
                                 : ""
                           }`}
                           title={
                              c.building.key === highlightKey
                                 ? "Anchor of this production line — also editable from the modal header"
                                 : amountOverrideKeys?.has(c.building.key)
                                   ? "Manual override (clear the field to revert to computed)"
                                   : "Computed from downstream demand — type to override"
                           }
                        >
                           ×
                           <input
                              type="number"
                              min={0}
                              max={99999}
                              value={result.amount}
                              onClick={(e) => e.stopPropagation()}
                              onMouseDown={(e) => e.stopPropagation()}
                              onChange={(e) => {
                                 const raw = e.target.value;
                                 if (raw === "") {
                                    onAmountChange?.(c.building.key, null);
                                    return;
                                 }
                                 const v = Math.max(0, Math.floor(Number(raw) || 0));
                                 onAmountChange?.(c.building.key, v);
                              }}
                           />
                        </label>
                        <label className="card-level">
                           Lvl
                           <input
                              type="number"
                              min={1}
                              max={99}
                              value={result.level}
                              onClick={(e) => e.stopPropagation()}
                              onMouseDown={(e) => e.stopPropagation()}
                              onChange={(e) => {
                                 const v = Math.max(1, Math.floor(Number(e.target.value) || 1));
                                 onLevelChange?.(c.building.key, v);
                              }}
                           />
                        </label>
                     </div>
                  )}
               </div>
            );
         })}
      </div>
   );
};

// ────────────────────────────────────────────────────────────────────────
// App
// ────────────────────────────────────────────────────────────────────────

export const App = (): JSX.Element => {
   const allBuildings = useMemo(
      () => ALL_BUILDINGS.filter((b) => !b.special && b.tier != null),
      [],
   );
   const initialColumns = useMemo(() => computeColumnsFor(allBuildings), [allBuildings]);
   const edges = useMemo(() => computeEdgesFor(allBuildings), [allBuildings]);
   const columns = useMemo(() => reorderCols(initialColumns, edges), [initialColumns, edges]);

   const crossingsBefore = useMemo(
      () => countAdjacentCrossings(initialColumns.map((c) => c.buildings), edges, (b) => b.key),
      [initialColumns, edges],
   );
   const crossingsAfter = useMemo(
      () => countAdjacentCrossings(columns.map((c) => c.buildings), edges, (b) => b.key),
      [columns, edges],
   );

   const totalCount = useMemo(
      () => columns.reduce((acc, c) => acc + c.buildings.length, 0),
      [columns],
   );

   // ── Modal: clicking a card opens a filtered view of just that line ──
   const [selectedKey, setSelectedKey] = useState<string | null>(null);
   const [rootAmount, setRootAmount] = useState(1);
   const [rootLevel, setRootLevel] = useState(10);
   const [perBuildingLevels, setPerBuildingLevels] = useState<Record<string, number>>({});
   const [perBuildingAmounts, setPerBuildingAmounts] = useState<Record<string, number>>({});

   const subgraph = useMemo(() => {
      if (!selectedKey) return null;
      const lineKeys = computeProductionLine(selectedKey, edges);
      const subBuildings = allBuildings.filter((b) => lineKeys.has(b.key));
      const subCols = computeColumnsFor(subBuildings);
      const subEdges = computeEdgesFor(subBuildings);
      const ordered = reorderCols(subCols, subEdges);
      const root = allBuildings.find((b) => b.key === selectedKey);
      return {
         columns: ordered,
         edges: subEdges,
         root,
         count: subBuildings.length,
         buildings: subBuildings,
      };
   }, [selectedKey, edges, allBuildings]);

   // Run the chain math whenever the inputs change. Display only — no
   // mutation of the columns themselves.
   const chainResults = useMemo(() => {
      if (!subgraph || !selectedKey) return undefined;
      return computeChainAmounts({
         rootKey: selectedKey,
         rootAmount,
         rootLevel,
         levelOverrides: perBuildingLevels,
         amountOverrides: perBuildingAmounts,
         subgraph: subgraph.buildings,
      });
   }, [subgraph, selectedKey, rootAmount, rootLevel, perBuildingLevels, perBuildingAmounts]);

   useEffect(() => {
      if (!selectedKey) return;
      const onKey = (e: KeyboardEvent) => {
         if (e.key === "Escape") setSelectedKey(null);
      };
      window.addEventListener("keydown", onKey);
      return () => window.removeEventListener("keydown", onKey);
   }, [selectedKey]);

   // Reset chain inputs whenever a new production line opens.
   useEffect(() => {
      if (!selectedKey) return;
      setRootAmount(1);
      setRootLevel(10);
      setPerBuildingLevels({});
      setPerBuildingAmounts({});
   }, [selectedKey]);

   const onLevelChange = useCallback((key: string, level: number) => {
      setPerBuildingLevels((prev) => ({ ...prev, [key]: level }));
   }, []);

   // The root's amount lives in `rootAmount` so the modal header can edit
   // it; non-root amounts go into `perBuildingAmounts`. Both paths funnel
   // through this one callback so the card UI can stay uniform.
   const onAmountChange = useCallback(
      (key: string, amount: number | null) => {
         if (key === selectedKey) {
            // Root: empty input falls back to 0 (no production line).
            setRootAmount(amount ?? 0);
            return;
         }
         setPerBuildingAmounts((prev) => {
            if (amount == null) {
               const { [key]: _drop, ...rest } = prev;
               return rest;
            }
            return { ...prev, [key]: amount };
         });
      },
      [selectedKey],
   );

   const amountOverrideKeysSet = useMemo(
      () => new Set(Object.keys(perBuildingAmounts)),
      [perBuildingAmounts],
   );

   // ── Pan + zoom: one independent state for the main view, one for the
   //    modal. The modal viewport is mounted/unmounted with selectedKey,
   //    so its hook restarts each time you open a different production line.
   const main = usePanZoom(0.7, { x: 80, y: 40 });
   const modal = usePanZoom(1, { x: 40, y: 40 });

   // Reset the modal view each time you open a new production line, so a
   // small chain doesn't inherit a heavily-zoomed/panned state from the
   // previous one.
   useEffect(() => {
      if (selectedKey) modal.reset();
      // intentionally only on selectedKey change — modal.reset is stable
      // enough that chasing it as a dep would just churn.
      // eslint-disable-next-line react-hooks/exhaustive-deps
   }, [selectedKey]);

   // Suppress card click if the user actually dragged on the main viewport.
   const handleCardClick = (key: string) => {
      if (main.movedThisDrag()) return;
      setSelectedKey(key);
   };

   return (
      <div className="app">
         <header className="topbar">
            <div className="brand">
               <h1>CivIdle production buildings</h1>
               <span className="tagline">
                  {totalCount} buildings · {edges.length} input lines · {crossingsAfter}{" "}
                  crossings ({crossingsBefore} before reorder) · click a card · scroll to
                  zoom · drag to pan
               </span>
            </div>
            <div className="zoom-readout">
               <span>{Math.round(main.zoom * 100)}%</span>
               <button type="button" onClick={main.reset}>
                  Reset
               </button>
            </div>
         </header>
         <div
            className="viewport"
            ref={main.viewportRef}
            onMouseDown={main.onMouseDown}
            style={{ cursor: "grab" }}
         >
            <div
               className="world-transform"
               style={{
                  transform: `translate(${main.pan.x}px, ${main.pan.y}px) scale(${main.zoom})`,
                  transformOrigin: "0 0",
               }}
            >
               <TierWorld columns={columns} edges={edges} onCardClick={handleCardClick} />
            </div>
         </div>

         {subgraph && (
            <div className="modal-backdrop" onClick={() => setSelectedKey(null)}>
               <div className="modal-content" onClick={(e) => e.stopPropagation()}>
                  <header className="modal-header">
                     <h3>
                        Production line for{" "}
                        <span className="modal-root-name">{subgraph.root?.name}</span>
                        <span className="modal-count">{subgraph.count} buildings</span>
                     </h3>
                     <div className="modal-header-actions">
                        <label className="modal-input">
                           Amount
                           <input
                              type="number"
                              min={0}
                              max={9999}
                              value={rootAmount}
                              onChange={(e) =>
                                 setRootAmount(
                                    Math.max(0, Math.floor(Number(e.target.value) || 0)),
                                 )
                              }
                           />
                        </label>
                        <label className="modal-input">
                           Level
                           <input
                              type="number"
                              min={1}
                              max={99}
                              value={rootLevel}
                              onChange={(e) =>
                                 setRootLevel(
                                    Math.max(1, Math.floor(Number(e.target.value) || 1)),
                                 )
                              }
                           />
                        </label>
                        <div className="zoom-readout">
                           <span>{Math.round(modal.zoom * 100)}%</span>
                           <button type="button" onClick={modal.reset}>
                              Reset
                           </button>
                        </div>
                        <button
                           type="button"
                           className="modal-close"
                           aria-label="Close"
                           onClick={() => setSelectedKey(null)}
                        >
                           ×
                        </button>
                     </div>
                  </header>
                  <div
                     className="modal-body modal-viewport"
                     ref={modal.viewportRef}
                     onMouseDown={modal.onMouseDown}
                     style={{ cursor: "grab" }}
                  >
                     <div
                        className="world-transform"
                        style={{
                           transform: `translate(${modal.pan.x}px, ${modal.pan.y}px) scale(${modal.zoom})`,
                           transformOrigin: "0 0",
                        }}
                     >
                        <TierWorld
                           columns={subgraph.columns}
                           edges={subgraph.edges}
                           highlightKey={selectedKey ?? undefined}
                           chainResults={chainResults}
                           onLevelChange={onLevelChange}
                           onAmountChange={onAmountChange}
                           amountOverrideKeys={amountOverrideKeysSet}
                        />
                     </div>
                  </div>
               </div>
            </div>
         )}
      </div>
   );
};
