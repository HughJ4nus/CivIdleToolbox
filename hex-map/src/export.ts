// Exports the map (plus optional notes + annotations side panel) as a single
// SVG document. From there we either save the SVG directly, or rasterize it
// to a PNG via canvas.

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
import type { Annotation, MapState, PaletteEntry } from "./types";
import { buildRangeContext, getEffectiveRange } from "./wonderRange";

// ── Geometry constants for the exported side panel ──────────────────────────
const PANEL_WIDTH = 520;
const PANEL_PAD = 24;
const PANEL_GAP = 24; // space between map and panel
const TITLE_FONT = 28;
const SECTION_FONT = 14;
const NOTES_FONT = 14;
const NOTES_LINE_RATIO = 1.4;
const ROW_HEIGHT = 26;
const ROW_GAP = 4;
const TIER_BADGE_W = 48;
// NOTE: use single quotes around multi-word names so we can interpolate this
// safely into double-quoted SVG attributes (font-family="...").
const FONT_FAMILY = `system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif`;

const BG = "#0e0e0e";
const PANEL_BG = "#161616";
const PANEL_BORDER = "#2a2a2a";
const TEXT_PRIMARY = "#e6e6e6";
const TEXT_DIM = "#9a9a9a";
const TIER_BG = "#222";

// Module-level canvas reused for text measurement.
let measureCanvas: HTMLCanvasElement | null = null;
const measureCtx = (): CanvasRenderingContext2D | null => {
   if (typeof document === "undefined") return null;
   if (!measureCanvas) measureCanvas = document.createElement("canvas");
   return measureCanvas.getContext("2d");
};

const measure = (text: string, fontSize: number, weight = 400): number => {
   const ctx = measureCtx();
   if (!ctx) return text.length * fontSize * 0.55;
   ctx.font = `${weight} ${fontSize}px ${FONT_FAMILY}`;
   return ctx.measureText(text).width;
};

const wrapToWidth = (text: string, maxWidth: number, fontSize: number, weight = 400): string[] => {
   if (!text) return [];
   // Honour explicit newlines, then word-wrap each.
   const out: string[] = [];
   for (const paragraph of text.split(/\n/)) {
      if (!paragraph.trim()) {
         out.push("");
         continue;
      }
      const words = paragraph.split(/\s+/).filter(Boolean);
      let cur = words[0] ?? "";
      for (let i = 1; i < words.length; i++) {
         const w = words[i];
         const candidate = `${cur} ${w}`;
         if (measure(candidate, fontSize, weight) <= maxWidth) {
            cur = candidate;
         } else {
            out.push(cur);
            cur = w;
         }
      }
      if (cur || words.length === 0) out.push(cur);
   }
   return out;
};

const escapeXml = (s: string): string =>
   s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");

// ── Hex label fitting (mirrors HexGrid.tsx; copied so this module is
// self-contained) ───────────────────────────────────────────────────────────
const LINE_RATIO = 1.1;
const MAX_LINES = 3;
const MIN_FONT = 6;

interface FittedLabel {
   lines: string[];
   fontSize: number;
   lineHeight: number;
   maxWidth: number;
}

const fitHexLabel = (text: string, size: number): FittedLabel => {
   const trimmed = text.trim();
   const maxWidth = SQRT3 * size * 0.86;
   const maxHeight = size * 0.9;
   if (!trimmed) return { lines: [], fontSize: 0, lineHeight: 0, maxWidth };

   const baseFontSize = Math.min(size * 0.42, Math.max(8, size * 0.32));
   let fontSize = baseFontSize;

   for (let attempt = 0; attempt < 8; attempt++) {
      const lines = wrapToWidth(trimmed, maxWidth, fontSize, 600);
      const usedLines = Math.min(lines.length, MAX_LINES);
      const totalHeight = (usedLines - 1) * fontSize * LINE_RATIO + fontSize;
      const fits = lines.length <= MAX_LINES && totalHeight <= maxHeight;
      if (fits) return { lines, fontSize, lineHeight: fontSize * LINE_RATIO, maxWidth };
      const overflowH = (lines.length * fontSize * LINE_RATIO) / maxHeight;
      const overflowW = lines.length === 1 ? measure(trimmed, fontSize, 600) / maxWidth : 1;
      const shrink = Math.max(1.12, Math.max(overflowH, overflowW));
      fontSize = Math.max(MIN_FONT, fontSize / shrink);
      if (fontSize <= MIN_FONT) break;
   }
   const lines = wrapToWidth(trimmed, maxWidth, fontSize, 600).slice(0, MAX_LINES);
   return { lines, fontSize, lineHeight: fontSize * LINE_RATIO, maxWidth };
};

// ── Side panel layout ───────────────────────────────────────────────────────
interface PanelLayout {
   widthPx: number;
   heightPx: number;
   render: (originX: number) => string;
}

const layoutPanel = (state: MapState): PanelLayout => {
   const inner = PANEL_WIDTH - PANEL_PAD * 2;
   const titleLines = wrapToWidth(state.title || "Untitled Design", inner, TITLE_FONT, 700);

   const noteLines = state.notes ? wrapToWidth(state.notes, inner, NOTES_FONT) : [];

   const palette = new Map(state.palette.map((p) => [p.id, p]));
   const annotationLabelMaxWidth = inner - TIER_BADGE_W - 12;

   // Pre-wrap annotation labels (most stay one line; long ones wrap to two).
   const annotationRows = state.annotations.map((a) => {
      const label = a.label || "—";
      const lines = wrapToWidth(label, annotationLabelMaxWidth, SECTION_FONT, 500);
      const rowHeight = Math.max(ROW_HEIGHT, lines.length * (SECTION_FONT * NOTES_LINE_RATIO) + 8);
      return { ann: a, lines, rowHeight, color: a.colorId ? palette.get(a.colorId)?.color ?? null : null };
   });

   // Compute total height
   let y = PANEL_PAD;
   const titleHeight = titleLines.length * TITLE_FONT * 1.2;
   y += titleHeight + 12;

   let notesSectionHeight = 0;
   if (noteLines.length > 0) {
      notesSectionHeight = SECTION_FONT * 1.6 + noteLines.length * NOTES_FONT * NOTES_LINE_RATIO + 16;
      y += notesSectionHeight;
   }

   let annotationsSectionHeight = 0;
   if (annotationRows.length > 0) {
      const rowsTotal =
         annotationRows.reduce((sum, r) => sum + r.rowHeight, 0) +
         Math.max(0, annotationRows.length - 1) * ROW_GAP;
      annotationsSectionHeight = SECTION_FONT * 1.6 + rowsTotal + 8;
      y += annotationsSectionHeight;
   }
   y += PANEL_PAD;

   const heightPx = y;

   const render = (originX: number): string => {
      const parts: string[] = [];
      // Background card
      parts.push(
         `<rect x="${originX}" y="0" width="${PANEL_WIDTH}" height="${heightPx}" fill="${PANEL_BG}" stroke="${PANEL_BORDER}" stroke-width="1" rx="8" />`,
      );

      let cursorY = PANEL_PAD;

      // Title
      cursorY += TITLE_FONT * 0.9;
      for (let i = 0; i < titleLines.length; i++) {
         const line = titleLines[i];
         parts.push(
            `<text x="${originX + PANEL_PAD}" y="${cursorY + i * TITLE_FONT * 1.2}" ` +
               `font-family="${FONT_FAMILY}" font-size="${TITLE_FONT}" font-weight="700" fill="${TEXT_PRIMARY}">${escapeXml(line)}</text>`,
         );
      }
      cursorY += (titleLines.length - 1) * TITLE_FONT * 1.2 + TITLE_FONT * 0.3 + 12;

      // Notes
      if (noteLines.length > 0) {
         parts.push(
            `<text x="${originX + PANEL_PAD}" y="${cursorY}" ` +
               `font-family="${FONT_FAMILY}" font-size="${SECTION_FONT}" font-weight="700" fill="${TEXT_DIM}" ` +
               `letter-spacing="1.2">NOTES</text>`,
         );
         cursorY += SECTION_FONT * 0.6 + 12;
         for (let i = 0; i < noteLines.length; i++) {
            const line = noteLines[i];
            const yy = cursorY + i * NOTES_FONT * NOTES_LINE_RATIO;
            parts.push(
               `<text x="${originX + PANEL_PAD}" y="${yy}" ` +
                  `font-family="${FONT_FAMILY}" font-size="${NOTES_FONT}" fill="${TEXT_PRIMARY}">${escapeXml(line)}</text>`,
            );
         }
         cursorY += noteLines.length * NOTES_FONT * NOTES_LINE_RATIO + 12;
      }

      // Annotations
      if (annotationRows.length > 0) {
         parts.push(
            `<text x="${originX + PANEL_PAD}" y="${cursorY}" ` +
               `font-family="${FONT_FAMILY}" font-size="${SECTION_FONT}" font-weight="700" fill="${TEXT_DIM}" ` +
               `letter-spacing="1.2">BUILD ORDER</text>`,
         );
         cursorY += SECTION_FONT * 0.6 + 12;
         for (const row of annotationRows) {
            const rx = originX + PANEL_PAD;
            const rowY = cursorY;
            const tierW = TIER_BADGE_W;
            const labelX = rx + tierW + 12;
            const labelW = inner - tierW - 12;
            // Tier badge
            parts.push(
               `<rect x="${rx}" y="${rowY}" width="${tierW}" height="${row.rowHeight}" rx="4" fill="${TIER_BG}" />`,
            );
            parts.push(
               `<text x="${rx + tierW / 2}" y="${rowY + row.rowHeight / 2}" ` +
                  `font-family="${FONT_FAMILY}" font-size="${SECTION_FONT}" font-weight="700" fill="${TEXT_PRIMARY}" ` +
                  `text-anchor="middle" dominant-baseline="central">${escapeXml(row.ann.tier || "?")}</text>`,
            );
            // Label background — colors come from the palette which is loaded
            // through sanitize.ts, but escapeXml is a cheap defence-in-depth
            // for a hostile JSON import.
            const labelBg = row.color ?? PANEL_BG;
            parts.push(
               `<rect x="${labelX}" y="${rowY}" width="${labelW}" height="${row.rowHeight}" rx="4" ` +
                  `fill="${escapeXml(labelBg)}" stroke="${PANEL_BORDER}" stroke-width="1" />`,
            );
            // Label text — choose readable text color based on bg luminance.
            const textColor = row.color ? readableTextColor(row.color) : TEXT_PRIMARY;
            const textBaseY = rowY + (row.rowHeight - row.lines.length * SECTION_FONT * NOTES_LINE_RATIO) / 2 + SECTION_FONT;
            for (let i = 0; i < row.lines.length; i++) {
               parts.push(
                  `<text x="${labelX + 10}" y="${textBaseY + i * SECTION_FONT * NOTES_LINE_RATIO}" ` +
                     `font-family="${FONT_FAMILY}" font-size="${SECTION_FONT}" font-weight="500" fill="${textColor}">${escapeXml(row.lines[i] || "—")}</text>`,
               );
            }
            cursorY += row.rowHeight + ROW_GAP;
         }
      }

      return parts.join("\n");
   };

   return { widthPx: PANEL_WIDTH, heightPx, render };
};

const readableTextColor = (bg: string): string => {
   // Accepts #rrggbb or named CSS color (best-effort).
   const m = /^#([0-9a-f]{6})$/i.exec(bg.trim());
   if (!m) return "#111";
   const r = parseInt(m[1].slice(0, 2), 16);
   const g = parseInt(m[1].slice(2, 4), 16);
   const b = parseInt(m[1].slice(4, 6), 16);
   // Standard relative luminance.
   const L = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
   return L > 0.55 ? "#1a1a1a" : "#ffffff";
};

// ── Map (hex grid) rendering ────────────────────────────────────────────────
const renderMap = (state: MapState, hexSize: number): { svg: string; width: number; height: number } => {
   const palette = new Map(state.palette.map((p) => [p.id, p]));
   const { widthPx, heightPx } = gridDimensions(state.cols, state.rows, hexSize);
   const parts: string[] = [];
   parts.push(`<rect x="0" y="0" width="${widthPx}" height="${heightPx}" fill="${BG}" />`);
   for (const { col, row } of allCoords(state.cols, state.rows)) {
      const key = tileKey(col, row);
      const cell = state.cells[key];
      const fill = cell?.colorId ? palette.get(cell.colorId)?.color ?? "#1a1a1a" : "#1a1a1a";
      const points = hexPolygonPoints(col, row, hexSize);
      parts.push(
         // `fill` comes from the palette, which is sanitised on load/import.
      // escapeXml is defence-in-depth in case the sanitiser is bypassed.
      `<polygon points="${points}" fill="${escapeXml(fill)}" stroke="#0a0a0a" stroke-width="1" stroke-linejoin="round" />`,
      );
      const fitted = cell?.text ? fitHexLabel(cell.text, hexSize) : null;
      if (fitted && fitted.lines.length > 0) {
         const c = center(col, row, hexSize);
         const yStart = c.y - ((fitted.lines.length - 1) * fitted.lineHeight) / 2;
         const tspans = fitted.lines
            .map((line, i) => {
               const naturalW = measure(line, fitted.fontSize, 600);
               const overflow = naturalW > fitted.maxWidth;
               const lengthAttrs = overflow
                  ? ` textLength="${fitted.maxWidth}" lengthAdjust="spacingAndGlyphs"`
                  : "";
               const dy = i === 0 ? 0 : fitted.lineHeight;
               return `<tspan x="${c.x}" dy="${dy}"${lengthAttrs}>${escapeXml(line)}</tspan>`;
            })
            .join("");
         const sw = Math.max(0.4, fitted.fontSize / 12);
         parts.push(
            `<text x="${c.x}" y="${yStart}" text-anchor="middle" dominant-baseline="middle" ` +
               `font-family="${FONT_FAMILY}" font-size="${fitted.fontSize}" font-weight="600" ` +
               `fill="#ffffff" stroke="#000000" stroke-width="${sw}" paint-order="stroke">${tspans}</text>`,
         );
      }
   }
   parts.push(...renderRangeRings(state, palette, hexSize));
   return { svg: parts.join("\n"), width: widthPx, height: heightPx };
};

const renderRangeRings = (
   state: MapState,
   palette: Map<string, PaletteEntry>,
   hexSize: number,
): string[] => {
   if (!state.showRanges) return [];
   const out: string[] = [];
   const stroke = Math.max(2, hexSize / 8);
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
      const lines: string[] = [];
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
            lines.push(
               `<line x1="${a.x.toFixed(2)}" y1="${a.y.toFixed(2)}" x2="${b.x.toFixed(2)}" y2="${b.y.toFixed(2)}" />`,
            );
         }
      }
      if (lines.length === 0) continue;
      out.push(
         `<g fill="none" stroke="${escapeXml(color)}" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round">${lines.join("")}</g>`,
      );
   }
   return out;
};

// ── Public API ──────────────────────────────────────────────────────────────

export interface ExportOptions {
   hexSize?: number;
   includePanel?: boolean;
   /** PNG only. Multiplies the canvas resolution; 1 = SVG-native, 2 = retina. */
   pixelRatio?: number;
}

export const buildExportSvg = (state: MapState, opts: ExportOptions = {}): string => {
   const hexSize = opts.hexSize ?? 36;
   const includePanel =
      opts.includePanel ?? (state.notes.length > 0 || state.annotations.length > 0 || !!state.title);
   const margin = 24;

   const map = renderMap(state, hexSize);
   const panel = includePanel ? layoutPanel(state) : null;

   const totalW = map.width + margin * 2 + (panel ? panel.widthPx + PANEL_GAP : 0);
   const totalH = Math.max(map.height, panel?.heightPx ?? 0) + margin * 2;

   const mapTransform = `translate(${margin}, ${margin + Math.max(0, ((panel?.heightPx ?? 0) - map.height) / 2)})`;
   const panelOriginX = margin + map.width + PANEL_GAP;
   const panelTransform = `translate(0, ${margin + Math.max(0, (map.height - (panel?.heightPx ?? 0)) / 2)})`;

   return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${totalW}" height="${totalH}" viewBox="0 0 ${totalW} ${totalH}">
  <rect x="0" y="0" width="${totalW}" height="${totalH}" fill="${BG}" />
  <g transform="${mapTransform}">${map.svg}</g>
  ${panel ? `<g transform="${panelTransform}">${panel.render(panelOriginX)}</g>` : ""}
</svg>`;
};

const downloadBlob = (blob: Blob, filename: string): void => {
   const url = URL.createObjectURL(blob);
   const a = document.createElement("a");
   a.href = url;
   a.download = filename;
   document.body.appendChild(a);
   a.click();
   a.remove();
   URL.revokeObjectURL(url);
};

const safeName = (title: string): string =>
   (title.trim().replace(/[^a-z0-9_-]+/gi, "_") || "hex-map").slice(0, 80);

export const exportSvg = (state: MapState, opts: ExportOptions = {}): void => {
   const svg = buildExportSvg(state, opts);
   downloadBlob(new Blob([svg], { type: "image/svg+xml" }), `${safeName(state.title)}.svg`);
};

export const exportPng = async (state: MapState, opts: ExportOptions = {}): Promise<void> => {
   const svg = buildExportSvg(state, opts);
   const pixelRatio = opts.pixelRatio ?? 2;
   const blob = new Blob([svg], { type: "image/svg+xml" });
   const url = URL.createObjectURL(blob);

   try {
      const img = new Image();
      img.crossOrigin = "anonymous";
      await new Promise<void>((resolve, reject) => {
         img.onload = () => resolve();
         img.onerror = () => reject(new Error("Failed to load SVG for rasterization"));
         img.src = url;
      });
      // SVGs without an intrinsic size: parse from the viewBox in the SVG string.
      const sizeMatch = /<svg[^>]*\swidth="([0-9.]+)"[^>]*\sheight="([0-9.]+)"/.exec(svg);
      const w = sizeMatch ? Number(sizeMatch[1]) : img.naturalWidth || 1024;
      const h = sizeMatch ? Number(sizeMatch[2]) : img.naturalHeight || 768;

      const canvas = document.createElement("canvas");
      canvas.width = Math.round(w * pixelRatio);
      canvas.height = Math.round(h * pixelRatio);
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Canvas 2D context unavailable");
      ctx.fillStyle = BG;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

      const pngBlob: Blob = await new Promise((resolve, reject) =>
         canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob returned null"))), "image/png"),
      );
      downloadBlob(pngBlob, `${safeName(state.title)}.png`);
   } finally {
      URL.revokeObjectURL(url);
   }
};

// Helpers exported for the in-app sidebar (not the export pipeline).
export const annotationColorEntries = (palette: PaletteEntry[]): PaletteEntry[] => palette;

export const findColorForAnnotation = (
   palette: PaletteEntry[],
   colorId: string | null,
): { color: string | null; entry: PaletteEntry | null } => {
   if (!colorId) return { color: null, entry: null };
   const e = palette.find((p) => p.id === colorId) ?? null;
   return { color: e?.color ?? null, entry: e };
};

export const exportFilenameStub = safeName;

// Marker so we can identify generated files in tests later.
export const EXPORT_VERSION = 1;

// Re-export for convenience.
export type { Annotation };
