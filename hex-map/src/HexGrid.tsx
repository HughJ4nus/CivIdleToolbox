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
import { SQRT3, allCoords, center, gridDimensions, hexPolygonPoints, tileKey } from "./hex";
import type { HexCell, MapState, PaletteEntry } from "./types";

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

interface Props {
   state: MapState;
   hexSize: number;
   selected: string | null;
   onHexClick: (key: string, ev: React.MouseEvent) => void;
   onHexContextMenu: (key: string, ev: React.MouseEvent) => void;
}

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 8;
const DRAG_THRESHOLD_PX = 4;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

const paletteLookup = (palette: PaletteEntry[]): Map<string, PaletteEntry> =>
   new Map(palette.map((p) => [p.id, p]));

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

   return (
      <g className="hex" onClick={onClick} onContextMenu={onContextMenu}>
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

   const [viewport, setViewport] = useState({ w: 0, h: 0 });
   const [zoom, setZoom] = useState(1);
   const [pan, setPan] = useState({ x: 0, y: 0 }); // world-space coord at the SVG's top-left
   const [grabbing, setGrabbing] = useState(false);

   const dragRef = useRef<DragState | null>(null);
   const wasDraggedRef = useRef(false);
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
      // NOTE: do NOT setPointerCapture here. If we capture on press, all
      // subsequent pointer events get re-targeted to the SVG, which means
      // the browser's click-target derivation never matches a hex (because
      // pointerup landed on the SVG, not the hex). That breaks click-to-paint.
      // We capture lazily on the first drag-move past the threshold instead.
      wasDraggedRef.current = false;
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
      const d = dragRef.current;
      if (!d || d.pointerId !== e.pointerId) return;
      const dx = e.clientX - d.startX;
      const dy = e.clientY - d.startY;
      if (!d.moved && Math.abs(dx) + Math.abs(dy) > DRAG_THRESHOLD_PX) {
         d.moved = true;
         wasDraggedRef.current = true;
         setGrabbing(true);
         // Now that it's actually a drag, capture so we keep getting moves
         // even if the cursor leaves the SVG.
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
      const d = dragRef.current;
      if (d && d.pointerId === e.pointerId) {
         dragRef.current = null;
         setGrabbing(false);
         try {
            if (svgRef.current?.hasPointerCapture(e.pointerId)) {
               svgRef.current.releasePointerCapture(e.pointerId);
            }
         } catch {
            // pointer may already be released
         }
      }
   };

   const handleHexClick = useCallback(
      (key: string, ev: React.MouseEvent) => {
         if (wasDraggedRef.current) {
            wasDraggedRef.current = false;
            return;
         }
         onHexClick(key, ev);
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

   const svgStyle: CSSProperties = {
      display: "block",
      width: "100%",
      height: "100%",
      cursor: grabbing ? "grabbing" : "grab",
      touchAction: "none",
   };

   return (
      <div ref={wrapperRef} className={`grid-viewport ${grabbing ? "grabbing" : ""}`} style={wrapperStyle}>
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
                     onClick={(ev) => handleHexClick(key, ev)}
                     onContextMenu={(ev) => onHexContextMenu(key, ev)}
                  />
               );
            })}
         </svg>

         <div className="grid-controls" aria-label="View controls">
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
      </div>
   );
};
