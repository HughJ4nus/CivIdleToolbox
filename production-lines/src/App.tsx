import {
   useCallback,
   useEffect,
   useMemo,
   useRef,
   useState,
   type CSSProperties,
} from "react";
import { resolveBuildingBonuses, type BuildingBonus } from "./bonusResolver";
import type { Building } from "./buildingTypes";
import { computeChainAmounts, type ChainResult } from "./chain";
import bonusSourcesData from "./data/bonus-sources.json";
import buildingsData from "./data/buildings.json";
import { countAdjacentCrossings, reorderByBarycenter, type Edge } from "./layout";
import type { ParsedSave } from "./saveImport";
import { Sidebar } from "./Sidebar";
import { loadUserState, saveUserState } from "./userState";

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

// BFS upstream from `root` along edges. The clicked card is treated as
// the end of the production line, so we only collect the buildings that
// directly or transitively *produce* what root needs — not any downstream
// consumers of root's output.
const computeProductionLine = (root: string, edges: Edge[]): Set<string> => {
   const out = new Set<string>([root]);
   const upFromConsumer = new Map<string, string[]>();
   for (const e of edges) {
      if (!upFromConsumer.has(e.consumer)) upFromConsumer.set(e.consumer, []);
      upFromConsumer.get(e.consumer)!.push(e.producer);
   }
   const queue = [root];
   while (queue.length) {
      const k = queue.shift()!;
      for (const p of upFromConsumer.get(k) ?? []) {
         if (out.has(p)) continue;
         out.add(p);
         queue.push(p);
      }
   }
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
   /** Imperatively centre the viewport on a world-space point. Used by
    *  the search bar to jump to a building. Optionally clamps zoom. */
   panTo: (worldX: number, worldY: number, opts?: { zoom?: number }) => void;
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

   const panTo = useCallback(
      (worldX: number, worldY: number, opts?: { zoom?: number }) => {
         if (!viewport) return;
         const rect = viewport.getBoundingClientRect();
         const targetZoom = Math.max(
            ZOOM_MIN,
            Math.min(ZOOM_MAX, opts?.zoom ?? zoom),
         );
         setZoom(targetZoom);
         setPan({
            x: rect.width / 2 - worldX * targetZoom,
            y: rect.height / 2 - worldY * targetZoom,
         });
      },
      [viewport, zoom],
   );

   return { viewportRef, zoom, pan, onMouseDown, reset, movedThisDrag, panTo };
};

// ────────────────────────────────────────────────────────────────────────
// SearchBar — substring-matches building names, jumps the main viewport
// to the picked result. Lives in the top bar.
// ────────────────────────────────────────────────────────────────────────

interface SearchBarProps {
   buildings: Building[];
   onPick: (b: Building) => void;
}

const SearchBar = ({ buildings, onPick }: SearchBarProps): JSX.Element => {
   const [query, setQuery] = useState("");
   const [open, setOpen] = useState(false);
   // Substring match (case-insensitive); cap at 12 results so the dropdown
   // stays usable. Shown in the order the columns walk the buildings.
   const matches = useMemo(() => {
      const q = query.trim().toLowerCase();
      if (!q) return [];
      const out: Building[] = [];
      for (const b of buildings) {
         if (b.name.toLowerCase().includes(q)) {
            out.push(b);
            if (out.length >= 12) break;
         }
      }
      return out;
   }, [query, buildings]);

   const pick = (b: Building): void => {
      onPick(b);
      setQuery(b.name);
      setOpen(false);
   };

   return (
      <div className="search-bar">
         <input
            type="search"
            value={query}
            placeholder="Search buildings…"
            onChange={(e) => {
               setQuery(e.target.value);
               setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            // Delay close so a click inside the dropdown still fires.
            onBlur={() => window.setTimeout(() => setOpen(false), 120)}
            onKeyDown={(e) => {
               if (e.key === "Enter" && matches.length > 0) {
                  e.preventDefault();
                  pick(matches[0]);
               } else if (e.key === "Escape") {
                  setOpen(false);
               }
            }}
         />
         {open && matches.length > 0 && (
            <ul className="search-results">
               {matches.map((b) => (
                  <li key={b.key}>
                     <button
                        type="button"
                        // onMouseDown so it fires before the input's blur.
                        onMouseDown={(e) => {
                           e.preventDefault();
                           pick(b);
                        }}
                     >
                        <span className="search-name">{b.name}</span>
                        <span className="search-tier">T{b.tier}</span>
                     </button>
                  </li>
               ))}
            </ul>
         )}
      </div>
   );
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
   /** Per-building bonus contributions from GPs / wonders / Age of Wisdom.
    *  Used purely for display — the bonuses are baked into chainResults. */
   bonuses?: Map<string, BuildingBonus>;
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
   bonuses,
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
      const lines: Array<{ d: string; key: string; consumer: string }> = [];
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
         lines.push({ d, key: `${e.producer}->${e.consumer}-${i}`, consumer: e.consumer });
      }
      return lines;
   }, [edges, layout]);

   // Track hovered card so we can highlight its incoming edges (edges
   // strictly cross tiers in this graph, so "incoming" == "from lower
   // tiers" — exactly what the user asked for).
   const [hoverKey, setHoverKey] = useState<string | null>(null);

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
               <path
                  key={c.key}
                  d={c.d}
                  className={hoverKey === c.consumer ? "edge-hover-incoming" : undefined}
               />
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
            const bonus = bonuses?.get(c.building.key);
            const hasBonus =
               bonus != null &&
               (bonus.outputMultiplier > 0 || bonus.levelBoost > 0);
            const className = `card${isHighlight ? " card-highlight" : ""}${onCardClick ? " card-clickable" : ""}${result ? " card-with-chain" : ""}${hasBonus ? " card-bonused" : ""}`;
            // Build a tooltip that lists every contributor to this building.
            const bonusTooltip = hasBonus
               ? bonus!.contributors
                    .map(
                       (s) =>
                          `${s.source} → ${s.kind === "level" ? `+${s.value} level` : `+${s.value} ${s.kind}`}`,
                    )
                    .join("\n")
               : undefined;
            return (
               <div
                  key={c.building.key}
                  className={className}
                  style={{ left: c.x, top: c.y } as CSSProperties}
                  onClick={onCardClick ? () => onCardClick(c.building.key) : undefined}
                  onMouseEnter={() => setHoverKey(c.building.key)}
                  onMouseLeave={() =>
                     setHoverKey((k) => (k === c.building.key ? null : k))
                  }
               >
                  <div className="card-title">{c.building.name}</div>
                  <div className="card-subtitle">{subtitleFor(c.building)}</div>
                  {hasBonus && (
                     <div className="card-bonus-row" title={bonusTooltip}>
                        {bonus!.outputMultiplier > 0 && (
                           <span className="card-bonus-pill">
                              +{Math.round(bonus!.outputMultiplier * 100)}% out
                           </span>
                        )}
                        {bonus!.levelBoost > 0 && !result && (
                           <span className="card-bonus-pill">
                              +{bonus!.levelBoost} lvl
                           </span>
                        )}
                     </div>
                  )}
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
                           {bonus && bonus.levelBoost > 0 && (
                              <span
                                 className="card-level-boost"
                                 title={`+${bonus.levelBoost} from bonuses (effective ${result.effectiveLevel})`}
                              >
                                 +{bonus.levelBoost}
                              </span>
                           )}
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

   // Mirror of the layout calculation TierWorld does internally, kept up
   // here so the topbar search can pan/zoom directly to a specific card.
   // Must stay in lockstep with TierWorld's layout — same constants, same
   // ordering rules.
   const mainLayout = useMemo(() => {
      const map = new Map<string, { x: number; y: number; building: Building }>();
      columns.forEach((col, colIdx) => {
         const x = colIdx * (CARD_W + GAP_X);
         col.buildings.forEach((b, rowIdx) => {
            const y = HEADING_H + TOP_PAD + rowIdx * (CARD_H + GAP_Y);
            map.set(b.key, { x, y, building: b });
         });
      });
      return map;
   }, [columns]);

   // ── Sidebar: user-set GP + wonder levels, persisted to localStorage.
   // Resolves into per-building output / level bonuses below; the chain
   // math then applies those bonuses to the modal's amount calculations.
   const [userState, setUserState] = useState(() => loadUserState());
   useEffect(() => {
      saveUserState(userState);
   }, [userState]);
   const onGpChange = useCallback((key: string, level: number) => {
      setUserState((prev) => ({
         ...prev,
         greatPeople: { ...prev.greatPeople, [key]: level },
      }));
   }, []);
   const onWonderChange = useCallback((key: string, level: number) => {
      setUserState((prev) => ({
         ...prev,
         wonders: { ...prev.wonders, [key]: level },
      }));
   }, []);
   const onAgeWisdomChange = useCallback((age: string, level: number) => {
      setUserState((prev) => ({
         ...prev,
         ageWisdom: { ...prev.ageWisdom, [age]: level },
      }));
   }, []);
   // Trade tiles — list of { id, building }. Each tile contributes +5
   // output to the chosen building (and WorldTradeOrganization adds
   // +wtoLevel per tile on top, handled in the bonus resolver).
   const onAddTradeTile = useCallback(() => {
      setUserState((prev) => ({
         ...prev,
         tradeTiles: [
            ...(prev.tradeTiles ?? []),
            // crypto.randomUUID exists in all evergreen browsers; falls
            // back to Math.random for the rare case it isn't present.
            {
               id:
                  typeof crypto !== "undefined" && crypto.randomUUID
                     ? crypto.randomUUID()
                     : `tt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
               building: "",
            },
         ],
      }));
   }, []);
   const onRemoveTradeTile = useCallback((id: string) => {
      setUserState((prev) => ({
         ...prev,
         tradeTiles: (prev.tradeTiles ?? []).filter((t) => t.id !== id),
      }));
   }, []);
   const onTradeTileBuildingChange = useCallback(
      (id: string, building: string) => {
         setUserState((prev) => ({
            ...prev,
            tradeTiles: (prev.tradeTiles ?? []).map((t) =>
               t.id === id ? { ...t, building } : t,
            ),
         }));
      },
      [],
   );

   // Cathedral of Brasília — manual building list. The user adds the
   // buildings they have within 2 tiles of CoB; each gets +N output
   // multiplier where N = list length (the in-game effect is
   // adjacency-based and we don't model adjacency).
   const onCobAddBuilding = useCallback(() => {
      setUserState((prev) => ({
         ...prev,
         cathedralOfBrasiliaBuildings: [
            ...(prev.cathedralOfBrasiliaBuildings ?? []),
            "",
         ],
      }));
   }, []);
   const onCobRemoveBuilding = useCallback((index: number) => {
      setUserState((prev) => ({
         ...prev,
         cathedralOfBrasiliaBuildings: (
            prev.cathedralOfBrasiliaBuildings ?? []
         ).filter((_, i) => i !== index),
      }));
   }, []);
   const onCobBuildingChange = useCallback(
      (index: number, building: string) => {
         setUserState((prev) => ({
            ...prev,
            cathedralOfBrasiliaBuildings: (
               prev.cathedralOfBrasiliaBuildings ?? []
            ).map((b, i) => (i === index ? building : b)),
         }));
      },
      [],
   );

   // Château Frontenac — same UX as Cathedral of Brasília but a different
   // effect (each user-selected target gets +1 level boost).
   const onChateauAddBuilding = useCallback(() => {
      setUserState((prev) => ({
         ...prev,
         chateauFrontenacBuildings: [
            ...(prev.chateauFrontenacBuildings ?? []),
            "",
         ],
      }));
   }, []);
   const onChateauRemoveBuilding = useCallback((index: number) => {
      setUserState((prev) => ({
         ...prev,
         chateauFrontenacBuildings: (
            prev.chateauFrontenacBuildings ?? []
         ).filter((_, i) => i !== index),
      }));
   }, []);
   const onChateauBuildingChange = useCallback(
      (index: number, building: string) => {
         setUserState((prev) => ({
            ...prev,
            chateauFrontenacBuildings: (
               prev.chateauFrontenacBuildings ?? []
            ).map((b, i) => (i === index ? building : b)),
         }));
      },
      [],
   );

   // United Nations General Assembly voted-boost targets — same UX as
   // Château Frontenac and Cathedral of Brasília. Each picked building
   // gets +(UN level + 4) output multiplier.
   const onUnAddBuilding = useCallback(() => {
      setUserState((prev) => ({
         ...prev,
         unitedNationsBuildings: [...(prev.unitedNationsBuildings ?? []), ""],
      }));
   }, []);
   const onUnRemoveBuilding = useCallback((index: number) => {
      setUserState((prev) => ({
         ...prev,
         unitedNationsBuildings: (prev.unitedNationsBuildings ?? []).filter(
            (_, i) => i !== index,
         ),
      }));
   }, []);
   const onUnBuildingChange = useCallback(
      (index: number, building: string) => {
         setUserState((prev) => ({
            ...prev,
            unitedNationsBuildings: (prev.unitedNationsBuildings ?? []).map(
               (b, i) => (i === index ? building : b),
            ),
         }));
      },
      [],
   );

   // Direction pick for the directional wonders (ChoghaZanbil/LuxorTemple/
   // BigBen). Empty string clears the pick.
   const onWonderDirectionChange = useCallback(
      (key: string, direction: string) => {
         setUserState((prev) => ({
            ...prev,
            wonderDirections: { ...(prev.wonderDirections ?? {}), [key]: direction },
         }));
      },
      [],
   );

   // Toggle a research tech on/off. Save importer fills the same map
   // from gs.unlockedTech; either source is the same shape.
   const onTechChange = useCallback((key: string, checked: boolean) => {
      setUserState((prev) => {
         const next = { ...(prev.unlockedTechs ?? {}) };
         if (checked) next[key] = true;
         else delete next[key];
         return { ...prev, unlockedTechs: next };
      });
   }, []);

   // Save import: replace GPs / wonders / Age of Wisdom with values from
   // a parsed save file, but keep trade tiles + CoB list intact (they're
   // either multiplayer state or a manual user-curated approximation
   // that isn't reconstructable from the save).
   const onImportSave = useCallback((parsed: ParsedSave) => {
      setUserState((prev) => ({
         greatPeople: parsed.greatPeople,
         thisRunGreatPeople: parsed.thisRunGreatPeople,
         wonders: parsed.wonders,
         ageWisdom: parsed.ageWisdom,
         tradeTiles: prev.tradeTiles ?? [],
         cathedralOfBrasiliaBuildings: prev.cathedralOfBrasiliaBuildings ?? [],
         chateauFrontenacBuildings: prev.chateauFrontenacBuildings ?? [],
         unitedNationsBuildings: prev.unitedNationsBuildings ?? [],
         finalHappiness: prev.finalHappiness ?? 0,
         // Merge: keep manually-picked directions, overlay with anything
         // the save importer pulled out of the wonder building data.
         wonderDirections: {
            ...(prev.wonderDirections ?? {}),
            ...parsed.wonderDirections,
         },
         // Tech list comes straight from the save's unlockedTech Set.
         unlockedTechs: parsed.unlockedTechs,
      }));
   }, []);

   // Testing helper: set every known great-person key to the given level.
   const onSetAllGpLevels = useCallback((level: number) => {
      setUserState((prev) => {
         const greatPeople: Record<string, number> = {};
         // Pull keys from the bonus-sources data so this covers exactly
         // the GPs the sidebar lists.
         for (const gp of (
            (bonusSourcesData as { greatPeople: { key: string }[] }).greatPeople
         )) {
            greatPeople[gp.key] = level;
         }
         return { ...prev, greatPeople };
      });
   }, []);

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

   // Translate sidebar inputs into per-building bonus contributions.
   // Computed once (not just for the modal) so the main view can also
   // surface a bonus pill on each card.
   const bonuses = useMemo(
      () => resolveBuildingBonuses(userState, allBuildings),
      [userState, allBuildings],
   );

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
         bonuses,
      });
   }, [subgraph, selectedKey, rootAmount, rootLevel, perBuildingLevels, perBuildingAmounts, bonuses]);

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

   // Bulk-set every building's level in the open production line. Pushes
   // the value to rootLevel AND clears per-card overrides so the chain
   // math uniformly uses N for every card.
   const onSetAllChainLevels = useCallback((level: number) => {
      const clamped = Math.max(1, Math.floor(level || 1));
      setRootLevel(clamped);
      setPerBuildingLevels({});
   }, []);
   const [bulkChainLevel, setBulkChainLevel] = useState(10);

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

   // Derived data for the modal's right-hand rundown panel.
   //   • Final output = root building's outputPerTick (already includes
   //     bonuses + level + amount).
   //   • Per-building list sorted by tier descending (top of chain at
   //     the top), then alphabetical for stable order within a tier.
   //   • Happiness cost = total building count − distinct types
   //     (each building costs 1 happiness, but ONE per type is free).
   const rundown = useMemo(() => {
      if (!subgraph || !chainResults || !selectedKey) return null;
      const entries = subgraph.buildings
         .map((b) => {
            const r = chainResults.get(b.key);
            return r ? { building: b, result: r } : null;
         })
         .filter((e): e is { building: Building; result: ChainResult } => e != null)
         .filter((e) => e.result.amount > 0);
      entries.sort((a, b) => {
         const ta = a.building.tier ?? 0;
         const tb = b.building.tier ?? 0;
         if (tb !== ta) return tb - ta;
         return a.building.name.localeCompare(b.building.name);
      });
      const totalBuildings = entries.reduce((s, e) => s + e.result.amount, 0);
      const distinctTypes = entries.length;
      const happiness = Math.max(0, totalBuildings - distinctTypes);
      const rootResult = chainResults.get(selectedKey);
      const finalOutput = rootResult
         ? [...rootResult.outputPerTick.entries()].filter(([, n]) => n > 0)
         : [];
      return {
         entries,
         totalBuildings,
         distinctTypes,
         happiness,
         finalOutput,
      };
   }, [subgraph, chainResults, selectedKey]);

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

   // Search-bar handler: centre the picked card in the main viewport.
   // Bumps zoom up to at least 0.9 if the user is zoomed out so the
   // landing card is actually readable.
   const handleSearchPick = useCallback(
      (b: Building) => {
         const pos = mainLayout.get(b.key);
         if (!pos) return;
         const cx = pos.x + CARD_W / 2;
         const cy = pos.y + CARD_H / 2;
         main.panTo(cx, cy, { zoom: Math.max(main.zoom, 0.9) });
      },
      [mainLayout, main],
   );

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
            <SearchBar buildings={allBuildings} onPick={handleSearchPick} />
            <div className="zoom-readout">
               <span>{Math.round(main.zoom * 100)}%</span>
               <button type="button" onClick={main.reset}>
                  Reset
               </button>
            </div>
         </header>
         <div className="main">
            <Sidebar
               gpLevels={userState.greatPeople}
               wonderLevels={userState.wonders}
               ageWisdom={userState.ageWisdom}
               tradeTiles={userState.tradeTiles ?? []}
               cobBuildings={userState.cathedralOfBrasiliaBuildings ?? []}
               chateauBuildings={userState.chateauFrontenacBuildings ?? []}
               unBuildings={userState.unitedNationsBuildings ?? []}
               allBuildings={allBuildings}
               onGpChange={onGpChange}
               onWonderChange={onWonderChange}
               onAgeWisdomChange={onAgeWisdomChange}
               onAddTradeTile={onAddTradeTile}
               onRemoveTradeTile={onRemoveTradeTile}
               onTradeTileBuildingChange={onTradeTileBuildingChange}
               onCobAddBuilding={onCobAddBuilding}
               onCobRemoveBuilding={onCobRemoveBuilding}
               onCobBuildingChange={onCobBuildingChange}
               onChateauAddBuilding={onChateauAddBuilding}
               onChateauRemoveBuilding={onChateauRemoveBuilding}
               onChateauBuildingChange={onChateauBuildingChange}
               onUnAddBuilding={onUnAddBuilding}
               onUnRemoveBuilding={onUnRemoveBuilding}
               onUnBuildingChange={onUnBuildingChange}
               wonderDirections={userState.wonderDirections ?? {}}
               onWonderDirectionChange={onWonderDirectionChange}
               unlockedTechs={userState.unlockedTechs ?? {}}
               onTechChange={onTechChange}
               onSetAllGpLevels={onSetAllGpLevels}
               onImportSave={onImportSave}
            />
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
                  <TierWorld
                     columns={columns}
                     edges={edges}
                     onCardClick={handleCardClick}
                     bonuses={bonuses}
                  />
               </div>
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
                        <label
                           className="modal-bulk-level"
                           title="Final happiness reading. Drives Habitat 67's level boost to AI Lab and Ziggurat of Ur's output multiplier."
                        >
                           Final happiness
                           <input
                              type="number"
                              min={0}
                              max={9999}
                              value={userState.finalHappiness ?? 0}
                              onChange={(e) =>
                                 setUserState((prev) => ({
                                    ...prev,
                                    finalHappiness: Math.max(
                                       0,
                                       Math.floor(Number(e.target.value) || 0),
                                    ),
                                 }))
                              }
                           />
                        </label>
                        <label
                           className="modal-bulk-level"
                           title="Apply this level to every building in the chain (clears per-card overrides)"
                        >
                           Set all levels
                           <input
                              type="number"
                              min={1}
                              max={99}
                              value={bulkChainLevel}
                              onChange={(e) =>
                                 setBulkChainLevel(
                                    Math.max(1, Math.floor(Number(e.target.value) || 1)),
                                 )
                              }
                           />
                           <button
                              type="button"
                              onClick={() => onSetAllChainLevels(bulkChainLevel)}
                           >
                              Apply
                           </button>
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
                  <div className="modal-main">
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
                              bonuses={bonuses}
                           />
                        </div>
                     </div>
                     {rundown && (
                        <aside className="modal-rundown">
                           <section className="rundown-section">
                              <h4>Final output</h4>
                              {rundown.finalOutput.length === 0 ? (
                                 <div className="rundown-empty">— set an amount —</div>
                              ) : (
                                 <ul className="rundown-output-list">
                                    {rundown.finalOutput.map(([mat, n]) => (
                                       <li key={mat}>
                                          <span className="rundown-num">
                                             {n.toLocaleString(undefined, {
                                                maximumFractionDigits: 1,
                                             })}
                                          </span>
                                          <span className="rundown-mat">{mat}</span>
                                          <span className="rundown-per">/tick</span>
                                       </li>
                                    ))}
                                 </ul>
                              )}
                           </section>
                           <section className="rundown-section">
                              <h4>Happiness cost</h4>
                              <div className="rundown-happiness">
                                 <span className="rundown-happiness-num">
                                    {rundown.happiness}
                                 </span>
                                 <span className="rundown-happiness-detail">
                                    {rundown.totalBuildings} buildings ·{" "}
                                    {rundown.distinctTypes} types
                                    <br />
                                    <em>(1 of each type is free)</em>
                                 </span>
                              </div>
                           </section>
                           <section className="rundown-section">
                              <h4>Buildings ({rundown.totalBuildings})</h4>
                              <ul className="rundown-buildings">
                                 {rundown.entries.map(({ building, result }) => (
                                    <li key={building.key}>
                                       <span className="rundown-amount">
                                          ×{result.amount}
                                       </span>
                                       <span className="rundown-name">
                                          {building.name}
                                       </span>
                                       <span className="rundown-meta">
                                          T{building.tier} · lvl {result.level}
                                       </span>
                                    </li>
                                 ))}
                              </ul>
                           </section>
                        </aside>
                     )}
                  </div>
               </div>
            </div>
         )}
      </div>
   );
};
