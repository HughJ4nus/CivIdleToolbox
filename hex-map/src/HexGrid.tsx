import {
   memo,
   useCallback,
   useEffect,
   useLayoutEffect,
   useMemo,
   useRef,
   useState,
   type CSSProperties,
} from "react";
import {
   SQRT3,
   allCoords,
   center,
   cornerPoints,
   gridDimensions,
   hexPolygonPoints,
   neighborOffsets,
   tileKey,
   tilesInRange,
} from "./hex";
import type { HexCell, MapState, PaletteEntry } from "./types";
import { buildRangeContext, getEffectiveRange } from "./wonderRange";

// ────────────────────────────────────────────────────────────────────────────
// Text fitting
// ────────────────────────────────────────────────────────────────────────────

const FONT_FAMILY = `system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
const FONT_WEIGHT = 600;
const LINE_RATIO = 1.1;
const MAX_LINES = 3;
const MIN_FONT_SIZE = 6;

let measurementCanvas: HTMLCanvasElement | null = null;
const getMeasureCtx = (): CanvasRenderingContext2D | null => {
   if (typeof document === "undefined") return null;
   if (!measurementCanvas) measurementCanvas = document.createElement("canvas");
   return measurementCanvas.getContext("2d");
};

const measureText = (text: string, fontSize: number): number => {
   const ctx = getMeasureCtx();
   if (!ctx) return text.length * fontSize * 0.55; // SSR fallback
   ctx.font = `${FONT_WEIGHT} ${fontSize}px ${FONT_FAMILY}`;
   return ctx.measureText(text).width;
};

const greedyWrap = (text: string, maxWidth: number, fontSize: number): string[] => {
   const words = text.trim().split(/\s+/).filter(Boolean);
   if (words.length === 0) return [];
   const lines: string[] = [];
   let cur = words[0];
   for (let i = 1; i < words.length; i++) {
      const w = words[i];
      const candidate = `${cur} ${w}`;
      if (measureText(candidate, fontSize) <= maxWidth) {
         cur = candidate;
      } else {
         lines.push(cur);
         cur = w;
      }
   }
   lines.push(cur);
   return lines;
};

interface FittedLabel {
   lines: string[];
   fontSize: number;
   lineHeight: number;
   maxWidth: number;
}

/**
 * Fit `text` inside the inscribed rectangle of a pointy-top hex of `size`.
 * Returns the wrapped lines, the font size to use, and the per-line max width
 * (used by the renderer to apply SVG `textLength` only on lines that overflow).
 */
const fitLabel = (text: string, size: number): FittedLabel => {
   const trimmed = text.trim();
   // Inscribed rectangle for a pointy-top hex: width = √3·size (the flat
   // left/right edges), height = size (the y-range of those flat edges).
   // A small padding keeps the text away from the border.
   const maxWidth = SQRT3 * size * 0.86;
   const maxHeight = size * 0.9;
   if (!trimmed) {
      return { lines: [], fontSize: 0, lineHeight: 0, maxWidth };
   }

   // Start from the same scale we used before, but allow growth up to a cap.
   const baseFontSize = Math.min(size * 0.42, Math.max(8, size * 0.32));
   let fontSize = baseFontSize;

   // Iteratively shrink until the wrapped text fits in MAX_LINES at
   // maxHeight, or we hit the minimum font size.
   for (let attempt = 0; attempt < 8; attempt++) {
      const lines = greedyWrap(trimmed, maxWidth, fontSize);
      const usedLines = Math.min(lines.length, MAX_LINES);
      const totalHeight = (usedLines - 1) * fontSize * LINE_RATIO + fontSize;
      const fits = lines.length <= MAX_LINES && totalHeight <= maxHeight;
      if (fits) {
         return {
            lines,
            fontSize,
            lineHeight: fontSize * LINE_RATIO,
            maxWidth,
         };
      }
      // Shrink. Pick a factor based on how badly we're overflowing in either
      // dimension so we converge in a couple of iterations.
      const overflowH = (lines.length * fontSize * LINE_RATIO) / maxHeight;
      const overflowW = lines.length === 1 ? measureText(trimmed, fontSize) / maxWidth : 1;
      const shrink = Math.max(1.12, Math.max(overflowH, overflowW));
      fontSize = Math.max(MIN_FONT_SIZE, fontSize / shrink);
      if (fontSize <= MIN_FONT_SIZE) break;
   }

   // Last resort: keep MIN_FONT_SIZE and let the renderer apply textLength on
   // any overflowing line so the text still fits horizontally.
   const lines = greedyWrap(trimmed, maxWidth, fontSize).slice(0, MAX_LINES);
   return {
      lines,
      fontSize,
      lineHeight: fontSize * LINE_RATIO,
      maxWidth,
   };
};

export type Tool = "pan" | "paint";

interface Props {
   state: MapState;
   hexSize: number;
   selected: string | null;
   tool: Tool;
   onToolChange: (t: Tool) => void;
   onHexClick: (key: string) => void;
   onHexContextMenu: (key: string, ev: React.MouseEvent) => void;
}

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 8;
const DRAG_THRESHOLD_PX = 4;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

const paletteLookup = (palette: PaletteEntry[]): Map<string, PaletteEntry> =>
   new Map(palette.map((p) => [p.id, p]));

interface RangeRing {
   key: string;
   color: string;
   edges: ReadonlyArray<readonly [number, number, number, number]>;
}

/**
 * For every cell whose label names a wonder with a tile range, build the
 * outline of the area within that range. The outline is the set of hex edges
 * that face *outside* the in-range set (or the grid boundary).
 */
const computeRangeRings = (
   state: MapState,
   palette: Map<string, PaletteEntry>,
   hexSize: number,
): RangeRing[] => {
   if (!state.showRanges) return [];
   const rings: RangeRing[] = [];
   const ctx = buildRangeContext(state.activeFestivals, state.activeUpgrades);
   for (const [key, cell] of Object.entries(state.cells)) {
      if (!cell.text || !cell.colorId) continue;
      const [col, row] = key.split(",").map(Number);
      const neighborTexts = neighborOffsets(row).map(([dc, dr]) => {
         const nk = `${col + dc},${row + dr}`;
         return state.cells[nk]?.text ?? "";
      });
      const range = getEffectiveRange(cell.text, ctx, neighborTexts);
      if (range == null || range < 1) continue;
      const color = palette.get(cell.colorId)?.color;
      if (!color) continue;
      const tiles = tilesInRange(col, row, range, state.cols, state.rows);
      const inRange = new Set(tiles.map((t) => `${t.col},${t.row}`));
      const edges: Array<readonly [number, number, number, number]> = [];
      for (const t of tiles) {
         const offsets = neighborOffsets(t.row);
         const c = center(t.col, t.row, hexSize);
         const corners = cornerPoints(c.x, c.y, hexSize);
         for (let i = 0; i < 6; i++) {
            const [dc, dr] = offsets[i];
            const nKey = `${t.col + dc},${t.row + dr}`;
            if (inRange.has(nKey)) continue;
            const a = corners[i];
            const b = corners[(i + 1) % 6];
            edges.push([a.x, a.y, b.x, b.y]);
         }
      }
      rings.push({ key, color, edges });
   }
   return rings;
};

const HexCellNode = memo(function HexCellNode({
   col,
   row,
   size,
   cell,
   palette,
   selected,
   onClick,
   onContextMenu,
}: {
   col: number;
   row: number;
   size: number;
   cell: HexCell | undefined;
   palette: Map<string, PaletteEntry>;
   selected: boolean;
   onClick: (ev: React.MouseEvent) => void;
   onContextMenu: (ev: React.MouseEvent) => void;
}) {
   const points = hexPolygonPoints(col, row, size);
   const c = center(col, row, size);
   const fill = cell?.colorId ? palette.get(cell.colorId)?.color ?? "#1a1a1a" : "#1a1a1a";
   const stroke = selected ? "#ffffff" : "#0a0a0a";
   const strokeW = selected ? 2.5 : 1;
   const fitted = cell?.text ? fitLabel(cell.text, size) : null;
   const dataKey = `${col},${row}`;

   return (
      <g className="hex" data-key={dataKey} onClick={onClick} onContextMenu={onContextMenu}>
         <polygon
            points={points}
            fill={fill}
            stroke={stroke}
            strokeWidth={strokeW}
            strokeLinejoin="round"
         />
         {fitted && fitted.lines.length > 0 && (
            <text
               x={c.x}
               y={c.y - ((fitted.lines.length - 1) * fitted.lineHeight) / 2}
               textAnchor="middle"
               dominantBaseline="middle"
               fontSize={fitted.fontSize}
               fontFamily={FONT_FAMILY}
               fontWeight={FONT_WEIGHT}
               fill="#ffffff"
               stroke="#000000"
               strokeWidth={Math.max(0.4, fitted.fontSize / 12)}
               paintOrder="stroke"
               style={{ pointerEvents: "none", userSelect: "none" }}
            >
               {fitted.lines.map((line, i) => {
                  const naturalW = measureText(line, fitted.fontSize);
                  const overflow = naturalW > fitted.maxWidth;
                  return (
                     <tspan
                        key={i}
                        x={c.x}
                        dy={i === 0 ? 0 : fitted.lineHeight}
                        textLength={overflow ? fitted.maxWidth : undefined}
                        lengthAdjust={overflow ? "spacingAndGlyphs" : undefined}
                     >
                        {line}
                     </tspan>
                  );
               })}
            </text>
         )}
      </g>
   );
});

interface DragState {
   startX: number;
   startY: number;
   panX: number;
   panY: number;
   pointerId: number;
   moved: boolean;
}

export const HexGrid = ({
   state,
   hexSize,
   selected,
   tool,
   onToolChange,
   onHexClick,
   onHexContextMenu,
}: Props): JSX.Element => {
   const wrapperRef = useRef<HTMLDivElement>(null);
   const svgRef = useRef<SVGSVGElement>(null);

   const { widthPx: gridW, heightPx: gridH } = useMemo(
      () => gridDimensions(state.cols, state.rows, hexSize),
      [state.cols, state.rows, hexSize],
   );
   const palette = useMemo(() => paletteLookup(state.palette), [state.palette]);
   const coords = useMemo(() => allCoords(state.cols, state.rows), [state.cols, state.rows]);
   const rangeRings = useMemo(
      () => computeRangeRings(state, palette, hexSize),
      [state, palette, hexSize],
   );

   const [viewport, setViewport] = useState({ w: 0, h: 0 });
   const [zoom, setZoom] = useState(1);
   const [pan, setPan] = useState({ x: 0, y: 0 }); // world-space coord at the SVG's top-left
   const [grabbing, setGrabbing] = useState(false);
   const [shiftDown, setShiftDown] = useState(false); // for cursor hint only; behaviour is decided at pointerdown via e.shiftKey

   const dragRef = useRef<DragState | null>(null);
   const paintRef = useRef<{ pointerId: number; lastKey: string | null } | null>(null);
   const wasDraggedRef = useRef(false);
   // True if Shift was held when the current pointer interaction began. The
   // browser's `click` event fires after pointerup, so we remember the modifier
   // from pointerdown and use it to suppress hex clicks that started as a
   // shift-pan (even if the user releases Shift between mousedown and click).
   const shiftAtDownRef = useRef(false);
   // Read fresh tool inside event handlers without re-binding listeners.
   const toolRef = useRef(tool);
   useEffect(() => {
      toolRef.current = tool;
   }, [tool]);

   // Track Shift for the cursor hint. `keydown` fires repeatedly while held;
   // we only re-render when the boolean actually flips.
   useEffect(() => {
      const onKey = (e: KeyboardEvent) => {
         if (e.key !== "Shift") return;
         setShiftDown(e.type === "keydown");
      };
      const onBlur = () => setShiftDown(false);
      window.addEventListener("keydown", onKey);
      window.addEventListener("keyup", onKey);
      window.addEventListener("blur", onBlur);
      return () => {
         window.removeEventListener("keydown", onKey);
         window.removeEventListener("keyup", onKey);
         window.removeEventListener("blur", onBlur);
      };
   }, []);

   const hexKeyAtCursor = useCallback((clientX: number, clientY: number): string | null => {
      const el = document.elementFromPoint(clientX, clientY);
      const g = (el as Element | null)?.closest?.("g.hex");
      return g?.getAttribute("data-key") ?? null;
   }, []);
   // Keep latest zoom/pan in refs so wheel and pointer handlers attached via
   // useEffect read fresh values without re-binding every state change.
   const zoomRef = useRef(zoom);
   const panRef = useRef(pan);
   useEffect(() => {
      zoomRef.current = zoom;
   }, [zoom]);
   useEffect(() => {
      panRef.current = pan;
   }, [pan]);

   // Track wrapper size.
   useLayoutEffect(() => {
      const el = wrapperRef.current;
      if (!el) return;
      const measure = () => setViewport({ w: el.clientWidth, h: el.clientHeight });
      measure();
      const ro = new ResizeObserver(measure);
      ro.observe(el);
      return () => ro.disconnect();
   }, []);

   const fitToView = useCallback(() => {
      if (viewport.w === 0 || viewport.h === 0 || gridW === 0 || gridH === 0) return;
      const k = clamp(Math.min(viewport.w / gridW, viewport.h / gridH) * 0.95, MIN_ZOOM, MAX_ZOOM);
      setZoom(k);
      setPan({
         x: (gridW - viewport.w / k) / 2,
         y: (gridH - viewport.h / k) / 2,
      });
   }, [viewport.w, viewport.h, gridW, gridH]);

   // Auto-fit on first viewport measurement.
   const fittedRef = useRef(false);
   useEffect(() => {
      if (!fittedRef.current && viewport.w > 0 && viewport.h > 0) {
         fitToView();
         fittedRef.current = true;
      }
   }, [viewport.w, viewport.h, fitToView]);

   // Wheel zoom — centered on the cursor.
   // Attached as a non-passive listener so we can preventDefault and stop the
   // page from scrolling.
   useEffect(() => {
      const el = wrapperRef.current;
      if (!el) return;
      const onWheel = (e: WheelEvent) => {
         e.preventDefault();
         const rect = el.getBoundingClientRect();
         const cx = e.clientX - rect.left;
         const cy = e.clientY - rect.top;
         const prevZoom = zoomRef.current;
         const prevPan = panRef.current;
         const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
         const nextZoom = clamp(prevZoom * factor, MIN_ZOOM, MAX_ZOOM);
         if (nextZoom === prevZoom) return;
         // Pin the world point under the cursor so it stays put.
         const wx = prevPan.x + cx / prevZoom;
         const wy = prevPan.y + cy / prevZoom;
         setZoom(nextZoom);
         setPan({ x: wx - cx / nextZoom, y: wy - cy / nextZoom });
      };
      el.addEventListener("wheel", onWheel, { passive: false });
      return () => el.removeEventListener("wheel", onWheel);
   }, []);

   const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
      if (e.button !== 0) return; // left mouse only
      wasDraggedRef.current = false;
      shiftAtDownRef.current = e.shiftKey;
      // Holding Shift forces the pan branch regardless of the active tool.
      const effectiveTool: Tool = e.shiftKey ? "pan" : toolRef.current;
      if (effectiveTool === "paint") {
         // Paint the starting hex immediately and capture the pointer so we
         // keep receiving moves even if the cursor briefly leaves the SVG.
         const key = hexKeyAtCursor(e.clientX, e.clientY);
         paintRef.current = { pointerId: e.pointerId, lastKey: null };
         if (key) {
            paintRef.current.lastKey = key;
            onHexClick(key);
         }
         try {
            svgRef.current?.setPointerCapture(e.pointerId);
         } catch {
            // ignore
         }
         return;
      }
      // Pan tool: defer pointer capture until we actually see a drag, so a
      // click without movement still flows through to the hex's onClick.
      dragRef.current = {
         startX: e.clientX,
         startY: e.clientY,
         panX: panRef.current.x,
         panY: panRef.current.y,
         pointerId: e.pointerId,
         moved: false,
      };
   };

   const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
      const p = paintRef.current;
      if (p && p.pointerId === e.pointerId) {
         const key = hexKeyAtCursor(e.clientX, e.clientY);
         if (key && key !== p.lastKey) {
            p.lastKey = key;
            onHexClick(key);
         }
         return;
      }
      const d = dragRef.current;
      if (!d || d.pointerId !== e.pointerId) return;
      const dx = e.clientX - d.startX;
      const dy = e.clientY - d.startY;
      if (!d.moved && Math.abs(dx) + Math.abs(dy) > DRAG_THRESHOLD_PX) {
         d.moved = true;
         wasDraggedRef.current = true;
         setGrabbing(true);
         try {
            svgRef.current?.setPointerCapture(e.pointerId);
         } catch {
            // some browsers reject capture if the pointer state changed
         }
      }
      if (d.moved) {
         const k = zoomRef.current;
         setPan({ x: d.panX - dx / k, y: d.panY - dy / k });
      }
   };

   const endDrag = (e: React.PointerEvent<SVGSVGElement>) => {
      const releaseCapture = () => {
         try {
            if (svgRef.current?.hasPointerCapture(e.pointerId)) {
               svgRef.current.releasePointerCapture(e.pointerId);
            }
         } catch {
            // pointer may already be released
         }
      };
      if (paintRef.current && paintRef.current.pointerId === e.pointerId) {
         paintRef.current = null;
         releaseCapture();
         return;
      }
      const d = dragRef.current;
      if (d && d.pointerId === e.pointerId) {
         dragRef.current = null;
         setGrabbing(false);
         releaseCapture();
      }
   };

   const handleHexClick = useCallback(
      (key: string) => {
         // Shift-pan mode: clicks shouldn't paint either, even on a non-drag.
         if (shiftAtDownRef.current) {
            shiftAtDownRef.current = false;
            return;
         }
         // In paint mode the pointerdown flow already painted this hex, so
         // ignore the synthesized click event to avoid double-painting.
         if (toolRef.current === "paint") return;
         if (wasDraggedRef.current) {
            wasDraggedRef.current = false;
            return;
         }
         onHexClick(key);
      },
      [onHexClick],
   );

   const vbW = viewport.w > 0 ? viewport.w / zoom : gridW;
   const vbH = viewport.h > 0 ? viewport.h / zoom : gridH;

   const wrapperStyle: CSSProperties = {
      position: "relative",
      width: "100%",
      height: "100%",
      overflow: "hidden",
      background: "#0e0e0e",
   };

   // Cursor: Shift forces the pan-style cursor; otherwise the active tool wins.
   // `grabbing` (set during a drag) always overrides to grabbing.
   const cursor = grabbing
      ? "grabbing"
      : shiftDown
        ? "grab"
        : tool === "paint"
          ? "crosshair"
          : "grab";
   const svgStyle: CSSProperties = {
      display: "block",
      width: "100%",
      height: "100%",
      cursor,
      touchAction: "none",
   };

   return (
      <div
         ref={wrapperRef}
         className={`grid-viewport ${grabbing ? "grabbing" : ""}`}
         data-tool={tool}
         data-shift={shiftDown ? "true" : "false"}
         style={wrapperStyle}
      >
         <svg
            ref={svgRef}
            viewBox={`${pan.x} ${pan.y} ${vbW} ${vbH}`}
            preserveAspectRatio="xMidYMid meet"
            style={svgStyle}
            shapeRendering="geometricPrecision"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onPointerLeave={endDrag}
         >
            {coords.map(({ col, row }) => {
               const key = tileKey(col, row);
               return (
                  <HexCellNode
                     key={key}
                     col={col}
                     row={row}
                     size={hexSize}
                     cell={state.cells[key]}
                     palette={palette}
                     selected={selected === key}
                     onClick={() => handleHexClick(key)}
                     onContextMenu={(ev) => onHexContextMenu(key, ev)}
                  />
               );
            })}
            {rangeRings.length > 0 && (
               <g
                  className="range-rings"
                  fill="none"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{ pointerEvents: "none" }}
               >
                  {rangeRings.map((ring) => (
                     <g key={ring.key} stroke={ring.color} strokeWidth={Math.max(2, hexSize / 8)}>
                        {ring.edges.map(([x1, y1, x2, y2], i) => (
                           <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} />
                        ))}
                     </g>
                  ))}
               </g>
            )}
         </svg>

         <div className="grid-controls" aria-label="View controls">
            <div className="grid-controls-row">
               <button
                  type="button"
                  onClick={() => {
                     const next = clamp(zoomRef.current * 1.2, MIN_ZOOM, MAX_ZOOM);
                     // Zoom around the wrapper centre.
                     const cx = viewport.w / 2;
                     const cy = viewport.h / 2;
                     const wx = panRef.current.x + cx / zoomRef.current;
                     const wy = panRef.current.y + cy / zoomRef.current;
                     setZoom(next);
                     setPan({ x: wx - cx / next, y: wy - cy / next });
                  }}
                  title="Zoom in"
               >
                  +
               </button>
               <button
                  type="button"
                  onClick={() => {
                     const next = clamp(zoomRef.current / 1.2, MIN_ZOOM, MAX_ZOOM);
                     const cx = viewport.w / 2;
                     const cy = viewport.h / 2;
                     const wx = panRef.current.x + cx / zoomRef.current;
                     const wy = panRef.current.y + cy / zoomRef.current;
                     setZoom(next);
                     setPan({ x: wx - cx / next, y: wy - cy / next });
                  }}
                  title="Zoom out"
               >
                  −
               </button>
               <button type="button" onClick={fitToView} title="Fit to view">
                  Fit
               </button>
               <span className="grid-zoom-readout">{Math.round(zoom * 100)}%</span>
            </div>
            <div className="grid-controls-row tool-row" role="radiogroup" aria-label="Editing tool">
               <button
                  type="button"
                  className={`tool-btn ${tool === "pan" ? "active" : ""}`}
                  onClick={() => onToolChange("pan")}
                  role="radio"
                  aria-checked={tool === "pan"}
                  title="Pan tool — click and hold to move around"
               >
                  <ToolIconPan />
                  <span>Pan</span>
               </button>
               <button
                  type="button"
                  className={`tool-btn ${tool === "paint" ? "active" : ""}`}
                  onClick={() => onToolChange("paint")}
                  role="radio"
                  aria-checked={tool === "paint"}
                  title="Paint tool — click and hold to paint hexes"
               >
                  <ToolIconPaint />
                  <span>Paint</span>
               </button>
            </div>
         </div>
      </div>
   );
};

const ToolIconPan = () => (
   <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      {/* Grabby hand-ish glyph: simple outline of an open palm. */}
      <path
         d="M9 11V5a1.5 1.5 0 0 1 3 0v5M12 10V3.5a1.5 1.5 0 1 1 3 0V10M15 10V5a1.5 1.5 0 1 1 3 0v8.5M9 11V8a1.5 1.5 0 0 0-3 0v8c0 3 2 5 5.5 5h2C17 21 19 19 19 16v-3"
         stroke="currentColor"
         strokeWidth="1.6"
         strokeLinecap="round"
         strokeLinejoin="round"
      />
   </svg>
);

const ToolIconPaint = () => (
   <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      {/* Paintbrush glyph. */}
      <path
         d="M14 4l6 6-6 6-6-6 6-6zM8 10l-4 4a2 2 0 0 0 0 2.83l2.17 2.17a2 2 0 0 0 2.83 0L13 15"
         stroke="currentColor"
         strokeWidth="1.6"
         strokeLinecap="round"
         strokeLinejoin="round"
      />
   </svg>
);
