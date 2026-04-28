// Validates and coerces an arbitrary parsed-JSON value into a clean MapState.
// Used both when loading from localStorage and when importing a user-supplied
// JSON file. Hostile or corrupt input must never reach the renderer or the
// export pipeline; everything that comes out of `sanitizeMapState` is safe to
// drop into raw SVG attributes.
//
// Rules:
//   • All strings are pinned to types and capped to a sensible length so a
//     malformed save can't blow up the renderer.
//   • Colors must look like a hex literal or a CSS function-style color.
//     Anything else falls back to a safe gray.
//   • Cell keys must match `${col},${row}`.
//   • Unknown fields are dropped silently.

import {
   DEFAULT_PALETTE,
   initialMapState,
   type Annotation,
   type HexCell,
   type MapState,
   type PaletteEntry,
} from "./types";

// Permits #RGB / #RGBA / #RRGGBB / #RRGGBBAA, plus the four CSS color
// functions with only digits, dot, whitespace, comma, percent inside the
// parens — so no quotes, no <, >, &, no script-y characters can sneak in.
const COLOR_RE = /^(#[0-9a-fA-F]{3,8}|(?:hsl|hsla|rgb|rgba)\(\s*[0-9.\s,%]+\))$/;

const MAX = {
   id: 32,
   title: 200,
   label: 200,
   tier: 8,
   colorId: 32,
   text: 500,
   notes: 10000,
} as const;

const isString = (v: unknown): v is string => typeof v === "string";
const isFiniteNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const cap = (s: string, max: number): string => (s.length > max ? s.slice(0, max) : s);

export const sanitizeColor = (c: unknown, fallback = "#888888"): string => {
   if (!isString(c)) return fallback;
   const trimmed = c.trim();
   return trimmed && COLOR_RE.test(trimmed) ? trimmed : fallback;
};

const sanitizePalette = (raw: unknown): PaletteEntry[] => {
   if (!Array.isArray(raw)) return [...DEFAULT_PALETTE];
   const out: PaletteEntry[] = [];
   const seen = new Set<string>();
   for (const e of raw) {
      if (!e || typeof e !== "object") continue;
      const r = e as Record<string, unknown>;
      let id = isString(r.id) ? cap(r.id, MAX.id) : `p${out.length + 1}`;
      // Avoid collisions silently — keep imports distinguishable.
      while (seen.has(id)) id = `${id}_`;
      seen.add(id);
      out.push({
         id,
         color: sanitizeColor(r.color),
         label: isString(r.label) ? cap(r.label, MAX.label) : "",
      });
   }
   return out.length > 0 ? out : [...DEFAULT_PALETTE];
};

const sanitizeAnnotations = (raw: unknown): Annotation[] => {
   if (!Array.isArray(raw)) return [];
   const out: Annotation[] = [];
   const seen = new Set<string>();
   for (const a of raw) {
      if (!a || typeof a !== "object") continue;
      const r = a as Record<string, unknown>;
      let id = isString(r.id) ? cap(r.id, MAX.id) : `a${out.length + 1}`;
      while (seen.has(id)) id = `${id}_`;
      seen.add(id);
      out.push({
         id,
         tier: isString(r.tier) ? cap(r.tier, MAX.tier) : "",
         colorId: r.colorId == null ? null : isString(r.colorId) ? cap(r.colorId, MAX.colorId) : null,
         label: isString(r.label) ? cap(r.label, MAX.label) : "",
      });
   }
   return out;
};

const sanitizeCells = (raw: unknown): Record<string, HexCell> => {
   if (!raw || typeof raw !== "object") return {};
   const out: Record<string, HexCell> = {};
   for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (!/^\d+,\d+$/.test(k)) continue; // must be `col,row`
      if (!v || typeof v !== "object") continue;
      const cv = v as Record<string, unknown>;
      const cell: HexCell = {};
      if (isString(cv.colorId)) cell.colorId = cap(cv.colorId, MAX.colorId);
      if (isString(cv.text)) cell.text = cap(cv.text, MAX.text);
      if (cell.colorId || cell.text) out[k] = cell;
   }
   return out;
};

export const sanitizeMapState = (raw: unknown): MapState => {
   const fallback = initialMapState();
   if (!raw || typeof raw !== "object") return fallback;
   const r = raw as Record<string, unknown>;
   if (r.version !== 1) return fallback;

   const cols = isFiniteNum(r.cols) ? Math.max(1, Math.min(80, Math.round(r.cols))) : fallback.cols;
   const rows = isFiniteNum(r.rows) ? Math.max(1, Math.min(80, Math.round(r.rows))) : fallback.rows;
   const title = isString(r.title) ? cap(r.title, MAX.title) : fallback.title;
   const notes = isString(r.notes) ? cap(r.notes, MAX.notes) : "";
   const palette = sanitizePalette(r.palette);
   const annotations = sanitizeAnnotations(r.annotations);
   const cells = sanitizeCells(r.cells);
   const activeColorId =
      isString(r.activeColorId) && palette.some((p) => p.id === r.activeColorId)
         ? r.activeColorId
         : null;

   return {
      version: 1,
      cols,
      rows,
      title,
      notes,
      palette,
      annotations,
      cells,
      activeColorId,
   };
};
