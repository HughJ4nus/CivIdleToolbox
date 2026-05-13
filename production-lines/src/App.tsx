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
import { reorderByBarycenter, type Edge } from "./layout";
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
const CARD_W = 240;
const CARD_H = 140;
const GAP_X = 110;
const GAP_Y = 70; // half of CARD_H
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
   /** Per-card electrification level. Optional — when undefined the
    *  Elec input doesn't render. */
   onElectrificationChange?: (key: string, value: number) => void;
   /** Clone-factory cloning target + dropdown options. Render a
    *  dropdown on CloneFactory / CloneLab cards. */
   cloneFactoryTarget?: string;
   cloneFactoryOptions?: string[];
   onCloneFactoryTargetChange?: (material: string) => void;
   /** Pass `null` as amount to clear an override; otherwise an integer. */
   onAmountChange?: (key: string, amount: number | null) => void;
   /** Set of building keys that have a user-set amount override (so the
    *  card UI can show the input as "overridden" rather than computed). */
   amountOverrideKeys?: Set<string>;
   /** Per-building bonus contributions from GPs / wonders / Age of Wisdom.
    *  Used purely for display — the bonuses are baked into chainResults. */
   bonuses?: Map<string, BuildingBonus>;
   /** Per-instance card height override. The dropdown rendered on
    *  CloneFactory cards needs an extra row of vertical space; the
    *  modal bumps this so EVERY card in that line stays uniform. */
   cardHeight?: number;
}

const TierWorld = ({
   columns,
   edges,
   onCardClick,
   highlightKey,
   chainResults,
   onLevelChange,
   onElectrificationChange,
   onAmountChange,
   amountOverrideKeys,
   bonuses,
   cloneFactoryTarget,
   cloneFactoryOptions,
   onCloneFactoryTargetChange,
   cardHeight,
}: TierWorldProps): JSX.Element => {
   // Local card-height override: cloned-factory mode bumps it so the
   // extra dropdown row fits without overflowing the card. GAP_Y is
   // kept proportional (half card height — same invariant the CSS
   // variables hold).
   const cardH = cardHeight ?? CARD_H;
   const gapY = Math.round(cardH / 2);
   const layout = useMemo(() => {
      const map = new Map<string, CardPos>();
      columns.forEach((col, colIdx) => {
         const x = colIdx * (CARD_W + GAP_X);
         col.buildings.forEach((b, rowIdx) => {
            const y = HEADING_H + TOP_PAD + rowIdx * (cardH + gapY);
            map.set(b.key, { x, y, building: b });
         });
      });
      return map;
   }, [columns, cardH, gapY]);

   const worldDims = useMemo(() => {
      const colCount = columns.length;
      const maxRows = columns.reduce((m, c) => Math.max(m, c.buildings.length), 0);
      return {
         width: Math.max(1, colCount * CARD_W + Math.max(0, colCount - 1) * GAP_X),
         height: Math.max(1, HEADING_H + TOP_PAD + maxRows * cardH + Math.max(0, maxRows - 1) * gapY),
      };
   }, [columns, cardH, gapY]);

   const connections = useMemo(() => {
      const lines: Array<{ d: string; key: string; consumer: string }> = [];
      for (let i = 0; i < edges.length; i++) {
         const e = edges[i];
         const producer = layout.get(e.producer);
         const consumer = layout.get(e.consumer);
         if (!producer || !consumer) continue;
         const px = producer.x + CARD_W;
         const py = producer.y + cardH / 2;
         const cx = consumer.x;
         const cy = consumer.y + cardH / 2;
         const dx = (cx - px) * 0.5;
         const d = `M ${px},${py} C ${px + dx},${py} ${cx - dx},${cy} ${cx},${cy}`;
         lines.push({ d, key: `${e.producer}->${e.consumer}-${i}`, consumer: e.consumer });
      }
      return lines;
   }, [edges, layout, cardH]);

   // Track hovered card so we can highlight its incoming edges (edges
   // strictly cross tiers in this graph, so "incoming" == "from lower
   // tiers" — exactly what the user asked for).
   const [hoverKey, setHoverKey] = useState<string | null>(null);

   return (
      <div
         className="tier-world"
         style={{
            width: worldDims.width,
            height: worldDims.height,
            ...(cardHeight ? ({ "--card-h": `${cardHeight}px` } as CSSProperties) : {}),
         }}
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
                  {(c.building.key === "CloneFactory" ||
                     c.building.key === "CloneLab") &&
                     onCloneFactoryTargetChange &&
                     cloneFactoryOptions && (
                        <select
                           className="card-clone-target"
                           value={cloneFactoryTarget ?? ""}
                           onClick={(e) => e.stopPropagation()}
                           onMouseDown={(e) => e.stopPropagation()}
                           onChange={(e) =>
                              onCloneFactoryTargetChange(e.target.value)
                           }
                        >
                           <option value="">— clone what? —</option>
                           {cloneFactoryOptions.map((m) => (
                              <option key={m} value={m}>
                                 {m}
                              </option>
                           ))}
                        </select>
                     )}
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
                           {(() => {
                              const boost = bonus?.levelBoost ?? 0;
                              const elec = result.electrification;
                              const total = boost + elec;
                              if (total <= 0) return null;
                              const parts: string[] = [];
                              if (boost > 0) parts.push(`+${boost} from bonuses`);
                              if (elec > 0) parts.push(`+${elec} from electrification`);
                              return (
                                 <span
                                    className="card-level-boost"
                                    title={`${parts.join(" · ")} (effective ${result.effectiveLevel})`}
                                 >
                                    +{total}
                                 </span>
                              );
                           })()}
                        </label>
                     </div>
                  )}
                  {result && onElectrificationChange && (
                     <div className="card-elec-row">
                        <label
                           className="card-level card-elec"
                           title={
                              result.electrification > 0
                                 ? `+${result.electrification} effective level · ${result.powerDemand.toLocaleString()} Power demand`
                                 : "Electrification level (each tier-up costs round(4^level) Power per tile)"
                           }
                        >
                           Elec
                           <input
                              type="number"
                              min={0}
                              max={result.level}
                              value={result.electrification}
                              onClick={(e) => e.stopPropagation()}
                              onMouseDown={(e) => e.stopPropagation()}
                              onChange={(e) => {
                                 const v = Math.max(0, Math.floor(Number(e.target.value) || 0));
                                 onElectrificationChange(c.building.key, v);
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

   // First-visit welcome modal. localStorage flag flips on dismiss so it
   // only shows once per browser; guard reads against SSR-style absence.
   const WELCOME_KEY = "production-lines:welcome-seen:v1";
   const [showWelcome, setShowWelcome] = useState(() => {
      if (typeof localStorage === "undefined") return false;
      return localStorage.getItem(WELCOME_KEY) !== "true";
   });
   const dismissWelcome = useCallback(() => {
      try {
         localStorage.setItem(WELCOME_KEY, "true");
      } catch {
         /* private mode / quota — flag won't stick but the modal closes */
      }
      setShowWelcome(false);
   }, []);
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

   // Adaptive GP target assignment. Empty string clears the assignment.
   const onAdaptiveGpChange = useCallback(
      (gpKey: string, buildingKey: string) => {
         setUserState((prev) => {
            const next = { ...(prev.adaptiveGreatPeople ?? {}) };
            if (buildingKey) next[gpKey] = buildingKey;
            else delete next[gpKey];
            return { ...prev, adaptiveGreatPeople: next };
         });
      },
      [],
   );

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
         // Adaptive GP assignments come from gs.adaptiveGreatPeople Map.
         adaptiveGreatPeople: parsed.adaptiveGreatPeople,
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
      // CloneFactory / CloneLab roots only matter if the user has picked
      // a material to clone. We inject {[target]:1} / {[target]:1} into
      // its recipe so the chain math treats it as a real consumer +
      // producer of that material.
      //
      // Upstream's intrinsic recipe is 1 input / 2 output per level
      // (IntraTickCache.ts:142), but the output formula collapses to
      // half-base + half-boosted (IntraTickCache.ts:181):
      //   final = (2 × level) × 0.5 × (1 + bonuses) = level × (1 + bonuses)
      // i.e. effectively 1 output per level with the full multiplier
      // applied. Modelling the recipe as 1:1 mirrors that net behaviour
      // — chain math then treats the building like a normal 1:1 producer
      // and gets the right per-tile demand vs supply.
      const target = userState.cloneFactoryTarget;
      const isCloneRoot =
         (selectedKey === "CloneFactory" || selectedKey === "CloneLab") &&
         !!target;
      const buildingsForChain = isCloneRoot
         ? allBuildings.map((b) =>
              b.key === selectedKey
                 ? { ...b, input: { [target!]: 1 }, output: { [target!]: 1 } }
                 : b,
           )
         : allBuildings;
      const edgesForChain = isCloneRoot
         ? computeEdgesFor(buildingsForChain)
         : edges;
      const lineKeys = new Set(
         computeProductionLine(selectedKey, edgesForChain),
      );
      // Pull the powerplant + its fuel chain into the subgraph as soon
      // as the user has any electrification configured. Sums RAW
      // electrification across every electrifiable building in the line;
      // chain math caps at each building's level later.
      const NON_WALK = new Set([
         "Worker","Power","Science","Festival","Warp",
         "Explorer","Teleport","Cycle","TradeValue",
      ]);
      const ELEC_EXTRAS = new Set(["SwissBank", "CloneFactory"]);
      const isElectrifiable = (b: Building): boolean => {
         if (ELEC_EXTRAS.has(b.key)) return true;
         if (b.special) return false;
         const outs = Object.keys(b.output);
         if (outs.length === 0) return false;
         return outs.every((o) => !NON_WALK.has(o));
      };
      const defaultElec = userState.defaultElectrification ?? 0;
      const elecOverrides = userState.electrificationOverrides ?? {};
      let totalElec = 0;
      for (const k of lineKeys) {
         const b = buildingsForChain.find((x) => x.key === k);
         if (!b || !isElectrifiable(b)) continue;
         const raw = elecOverrides[k] ?? defaultElec;
         if (raw > 0) totalElec += raw;
      }
      const plantKey = userState.useFusionPower
         ? "FusionPowerPlant"
         : "NuclearPowerPlant";
      const includePlant =
         totalElec > 0 &&
         buildingsForChain.some((b) => b.key === plantKey);
      if (includePlant) {
         const plantLine = computeProductionLine(plantKey, edgesForChain);
         for (const k of plantLine) lineKeys.add(k);
      }
      const subBuildings = buildingsForChain.filter((b) => lineKeys.has(b.key));
      // Re-tier CloneFactory / CloneLab to max(others) + 1 inside this
      // subgraph so the layout puts it rightmost regardless of its
      // canonical tier-8 placement in the main view.
      if (selectedKey === "CloneFactory" || selectedKey === "CloneLab") {
         const cloneIdx = subBuildings.findIndex((b) => b.key === selectedKey);
         if (cloneIdx >= 0) {
            const others = subBuildings.filter((b) => b.key !== selectedKey);
            const maxOther = others.reduce(
               (m, b) => Math.max(m, b.tier ?? 0),
               0,
            );
            subBuildings[cloneIdx] = {
               ...subBuildings[cloneIdx],
               tier: maxOther + 1,
            };
         }
      }
      // Re-tier the powerplant to the root's tier so it stacks "below"
      // (in the same column as) the final product instead of landing in
      // its canonical tier-3/4 column far to the left.
      if (includePlant) {
         const rootTier =
            subBuildings.find((b) => b.key === selectedKey)?.tier ?? 0;
         const plantIdx = subBuildings.findIndex((b) => b.key === plantKey);
         if (plantIdx >= 0) {
            subBuildings[plantIdx] = {
               ...subBuildings[plantIdx],
               tier: rootTier,
            };
         }
      }
      const subCols = computeColumnsFor(subBuildings);
      const subEdges = computeEdgesFor(subBuildings);
      const ordered = reorderCols(subCols, subEdges);
      const root = subBuildings.find((b) => b.key === selectedKey);
      return {
         columns: ordered,
         edges: subEdges,
         root,
         count: subBuildings.length,
         buildings: subBuildings,
         plantKey: includePlant ? plantKey : null,
      };
   }, [
      selectedKey,
      edges,
      allBuildings,
      userState.cloneFactoryTarget,
      userState.electrificationOverrides,
      userState.defaultElectrification,
      userState.useFusionPower,
   ]);

   // Translate sidebar inputs into per-building bonus contributions.
   // Computed once (not just for the modal) so the main view can also
   // surface a bonus pill on each card.
   const bonuses = useMemo(
      () => resolveBuildingBonuses(userState, allBuildings),
      [userState, allBuildings],
   );

   // Faith producer eligibility: Shrine is always available; only one of
   // Church/Mosque/Pagoda is unlocked per run, gated by Luxor Temple's
   // Religion direction. User can prefer either via the sidebar; default
   // is "the unlocked one if Luxor is built, otherwise Shrine".
   const RELIGION_TO_FAITH_BUILDING: Record<string, string> = {
      Christianity: "Church",
      Islam: "Mosque",
      Buddhism: "Pagoda",
   };
   const luxorBuilt = (userState.wonders.LuxorTemple ?? 0) > 0;
   const luxorReligion = userState.wonderDirections?.LuxorTemple;
   const unlockedFaithBuilding =
      luxorBuilt && luxorReligion
         ? RELIGION_TO_FAITH_BUILDING[luxorReligion]
         : undefined;
   const eligibleFaithBuildings = useMemo(() => {
      const set = new Set<string>(["Shrine"]);
      if (unlockedFaithBuilding) set.add(unlockedFaithBuilding);
      return set;
   }, [unlockedFaithBuilding]);
   const chosenFaithBuilding =
      userState.preferredFaithBuilding &&
      eligibleFaithBuildings.has(userState.preferredFaithBuilding)
         ? userState.preferredFaithBuilding
         : unlockedFaithBuilding ?? "Shrine";
   const onFaithBuildingChange = useCallback((building: string) => {
      setUserState((prev) => ({
         ...prev,
         preferredFaithBuilding: building || undefined,
      }));
   }, []);
   const allowedProducers = useCallback(
      (material: string): Set<string> | undefined => {
         if (material === "Faith") return new Set([chosenFaithBuilding]);
         return undefined;
      },
      [chosenFaithBuilding],
   );

   // Run the chain math whenever the inputs change. Display only — no
   // mutation of the columns themselves.
   //
   // Two-pass when the powerplant is in the subgraph: pass 1 computes
   // every other building's amount (and their power demand); pass 2
   // pins the plant's amount to ⌈total Power demand / per-plant supply⌉
   // and re-runs so the fuel chain (NuclearFuelRod / FusionFuel + their
   // upstream) sizes correctly.
   const chainResults = useMemo(() => {
      if (!subgraph || !selectedKey) return undefined;
      const baseOpts = {
         rootKey: selectedKey,
         rootAmount,
         rootLevel,
         levelOverrides: perBuildingLevels,
         amountOverrides: perBuildingAmounts,
         subgraph: subgraph.buildings,
         bonuses,
         allowedProducers,
         electrificationOverrides: userState.electrificationOverrides,
         defaultElectrification: userState.defaultElectrification,
      };
      let results = computeChainAmounts(baseOpts);
      const plantKey = subgraph.plantKey;
      if (!plantKey) return results;
      const plantDef = subgraph.buildings.find((b) => b.key === plantKey);
      const plantBaseOutput = plantDef?.output.Power ?? 0;
      const plantBonus = bonuses.get(plantKey);
      const plantLevelBase = perBuildingLevels[plantKey] ?? rootLevel;
      const plantEffectiveLevel =
         plantLevelBase + (plantBonus?.levelBoost ?? 0);
      const plantSupply =
         plantBaseOutput *
         plantEffectiveLevel *
         (1 + (plantBonus?.outputMultiplier ?? 0));
      if (plantSupply <= 0) return results;
      // Loop until plants-needed stabilises: the fuel chain itself may
      // be electrified, in which case the first pass under-counts power
      // demand. Capped at 4 iterations — converges in 1-2 in practice
      // since each pass adds at most a thin slice of fuel-chain demand.
      let prevPlants = -1;
      for (let pass = 0; pass < 4; pass++) {
         let powerDemand = 0;
         for (const [k, r] of results) {
            if (k === plantKey) continue;
            powerDemand += r.powerDemand;
         }
         if (powerDemand <= 0) break;
         const plantsNeeded = Math.ceil(powerDemand / plantSupply);
         if (plantsNeeded === prevPlants) break;
         prevPlants = plantsNeeded;
         results = computeChainAmounts({
            ...baseOpts,
            amountOverrides: {
               ...perBuildingAmounts,
               [plantKey]: plantsNeeded,
            },
         });
      }
      return results;
   }, [subgraph, selectedKey, rootAmount, rootLevel, perBuildingLevels, perBuildingAmounts, bonuses, allowedProducers, userState.electrificationOverrides, userState.defaultElectrification]);

   // Hide upstream buildings the chain math doesn't actually need
   // (amount = 0). Examples: when the root has multiple producers and
   // the user picks a path that bypasses some of them, those bypassed
   // producers — and any unique ancestors only they reach — would
   // otherwise sit in the modal at amount 0. The root is always kept.
   const visibleSubgraph = useMemo(() => {
      if (!subgraph || !chainResults || !selectedKey) return subgraph;
      const visible = subgraph.buildings.filter(
         (b) => b.key === selectedKey || (chainResults.get(b.key)?.amount ?? 0) > 0,
      );
      if (visible.length === subgraph.buildings.length) return subgraph;
      const cols = computeColumnsFor(visible);
      const subEdges = computeEdgesFor(visible);
      const ordered = reorderCols(cols, subEdges);
      return {
         columns: ordered,
         edges: subEdges,
         root: subgraph.root,
         count: visible.length,
         buildings: visible,
      };
   }, [subgraph, chainResults, selectedKey]);

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

   // Per-card electrification override. Writing 0 = "leave at default";
   // the chain math falls back to userState.defaultElectrification.
   const onElectrificationChange = useCallback(
      (key: string, value: number) => {
         const clamped = Math.max(0, Math.floor(value));
         setUserState((prev) => {
            const next = { ...(prev.electrificationOverrides ?? {}) };
            if (clamped === 0) delete next[key];
            else next[key] = clamped;
            return { ...prev, electrificationOverrides: next };
         });
      },
      [],
   );
   // Bulk-set default electrification + clear per-card overrides so every
   // electrifiable card uniformly uses N. Mirrors onSetAllChainLevels.
   const onSetAllElectrification = useCallback((value: number) => {
      const clamped = Math.max(0, Math.floor(value));
      setUserState((prev) => ({
         ...prev,
         defaultElectrification: clamped,
         electrificationOverrides: {},
      }));
   }, []);
   const [bulkElectrification, setBulkElectrification] = useState(0);
   const onFusionPowerToggle = useCallback((checked: boolean) => {
      setUserState((prev) => ({ ...prev, useFusionPower: checked }));
   }, []);
   const onCloneFactoryTargetChange = useCallback((material: string) => {
      setUserState((prev) => ({
         ...prev,
         cloneFactoryTarget: material || undefined,
      }));
   }, []);
   // Every material some production building actually produces — used
   // as the dropdown options on CloneFactory / CloneLab cards. Sorted
   // alphabetically for stable order. Filters out non-storable materials
   // since CloneFactory can't produce things like Worker / Power /
   // Science (NoStorage in upstream).
   const cloneFactoryOptions = useMemo(() => {
      const NON_STORABLE = new Set([
         "Worker","Power","Science","Festival","Warp",
         "Explorer","Teleport","Cycle","TradeValue",
      ]);
      const materials = new Set<string>();
      for (const b of allBuildings) {
         for (const m of Object.keys(b.output)) {
            if (!NON_STORABLE.has(m)) materials.add(m);
         }
      }
      return [...materials].sort((a, b) => a.localeCompare(b));
   }, [allBuildings]);

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
      // Total Power demand from all electrified buildings, plus how many
      // selected-type power plants we'd need to supply it. Same effective-
      // level + bonus math as any other producer.
      const powerDemand = entries.reduce(
         (s, e) => s + e.result.powerDemand,
         0,
      );
      const plantKey = userState.useFusionPower
         ? "FusionPowerPlant"
         : "NuclearPowerPlant";
      const plantDef = allBuildings.find((b) => b.key === plantKey);
      const plantBaseOutput = plantDef?.output.Power ?? 0;
      const plantBonus = bonuses.get(plantKey);
      const plantLevel = rootLevel + (plantBonus?.levelBoost ?? 0);
      const plantSupply =
         plantBaseOutput *
         plantLevel *
         (1 + (plantBonus?.outputMultiplier ?? 0));
      const powerPlantsNeeded =
         powerDemand > 0 && plantSupply > 0
            ? Math.ceil(powerDemand / plantSupply)
            : 0;
      return {
         entries,
         totalBuildings,
         distinctTypes,
         happiness,
         finalOutput,
         powerDemand,
         powerPlantsNeeded,
         plantKey,
         plantSupply,
      };
   }, [subgraph, chainResults, selectedKey, allBuildings, bonuses, rootLevel, userState.useFusionPower]);

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
               <h1>CivIdle production line calculator</h1>
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
               thisRunGreatPeople={userState.thisRunGreatPeople ?? {}}
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
               faithBuilding={chosenFaithBuilding}
               eligibleFaithBuildings={eligibleFaithBuildings}
               onFaithBuildingChange={onFaithBuildingChange}
               unlockedTechs={userState.unlockedTechs ?? {}}
               onTechChange={onTechChange}
               adaptiveGreatPeople={userState.adaptiveGreatPeople ?? {}}
               onAdaptiveGpChange={onAdaptiveGpChange}
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

         {visibleSubgraph && (
            <div className="modal-backdrop" onClick={() => setSelectedKey(null)}>
               <div className="modal-content" onClick={(e) => e.stopPropagation()}>
                  <header className="modal-header">
                     <h3>
                        Production line for{" "}
                        <span className="modal-root-name">{visibleSubgraph.root?.name}</span>
                        <span className="modal-count">{visibleSubgraph.count} buildings</span>
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
                        <label
                           className="modal-bulk-level"
                           title="Apply this electrification level to every electrifiable building (clears per-card overrides)"
                        >
                           Set all elec
                           <input
                              type="number"
                              min={0}
                              max={99}
                              value={bulkElectrification}
                              onChange={(e) =>
                                 setBulkElectrification(
                                    Math.max(0, Math.floor(Number(e.target.value) || 0)),
                                 )
                              }
                           />
                           <button
                              type="button"
                              onClick={() => onSetAllElectrification(bulkElectrification)}
                           >
                              Apply
                           </button>
                        </label>
                        <label
                           className="modal-fusion-toggle"
                           title="Use Fusion Power Plants instead of Nuclear in the Power rundown"
                        >
                           <input
                              type="checkbox"
                              checked={!!userState.useFusionPower}
                              onChange={(e) =>
                                 onFusionPowerToggle(e.target.checked)
                              }
                           />
                           Fusion Power
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
                              columns={visibleSubgraph.columns}
                              edges={visibleSubgraph.edges}
                              highlightKey={selectedKey ?? undefined}
                              chainResults={chainResults}
                              onLevelChange={onLevelChange}
                              onElectrificationChange={onElectrificationChange}
                              onAmountChange={onAmountChange}
                              amountOverrideKeys={amountOverrideKeysSet}
                              bonuses={bonuses}
                              cloneFactoryTarget={userState.cloneFactoryTarget}
                              cloneFactoryOptions={cloneFactoryOptions}
                              onCloneFactoryTargetChange={onCloneFactoryTargetChange}
                              cardHeight={
                                 selectedKey === "CloneFactory" ||
                                 selectedKey === "CloneLab"
                                    ? 175
                                    : undefined
                              }
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
                              <h4>Power</h4>
                              {rundown.powerDemand > 0 ? (
                                 <div className="rundown-happiness">
                                    <span className="rundown-happiness-num">
                                       ×{rundown.powerPlantsNeeded}
                                    </span>
                                    <span className="rundown-happiness-detail">
                                       {rundown.plantKey === "FusionPowerPlant"
                                          ? "Fusion Power Plants"
                                          : "Nuclear Power Plants"}
                                       <br />
                                       {rundown.powerDemand.toLocaleString()} Power
                                       demand · {Math.round(rundown.plantSupply).toLocaleString()}/plant
                                    </span>
                                 </div>
                              ) : (
                                 <div className="rundown-empty">— no electrification —</div>
                              )}
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

         {showWelcome && (
            <div className="modal-backdrop" onClick={dismissWelcome}>
               <div
                  className="modal-content welcome-modal"
                  onClick={(e) => e.stopPropagation()}
               >
                  <header className="modal-header">
                     <h3>Welcome</h3>
                     <button
                        type="button"
                        className="modal-close"
                        aria-label="Close"
                        onClick={dismissWelcome}
                     >
                        ×
                     </button>
                  </header>
                  <div className="modal-body welcome-body">
                     <p>
                        Load your save file, or manually input your values. Click
                        the end product you want to produce, and input your
                        desired levels and amounts.
                     </p>
                     <p>
                        UN General Assemblies and trade tile bonusses must be
                        added manually, as these values do not live in your save
                        file.
                     </p>
                     <button
                        type="button"
                        className="welcome-dismiss"
                        onClick={dismissWelcome}
                     >
                        Got it
                     </button>
                  </div>
               </div>
            </div>
         )}
      </div>
   );
};
