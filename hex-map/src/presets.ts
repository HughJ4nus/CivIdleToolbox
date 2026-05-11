// Premade designs surfaced in the title-input dropdown. Each preset returns
// a complete MapState; the loader runs it through sanitizeMapState before
// applying, so the same safety net as user-imported JSON applies.
//
// To add a preset:
//   1. Build the design in the editor.
//   2. Export it as JSON via the toolbar.
//   3. Open the JSON, paste its contents into a new `build: () => ({...})`
//      below, and give it an `id` + display `name`.
//   4. Reload — it'll show up in the dropdown.
//
// The Cathedral-of-Brasilia presets here use a small DSL: a `[dCol, dRow,
// label]` triple per hex, relative to the Cathedral. The Cathedral always
// sits on an even row so neighbour offsets behave the same way for every
// preset (odd-r offset coords would otherwise flip neighbour columns
// depending on row parity).

import { sanitizeMapState } from "./sanitize";
import { initialMapState, type HexCell, type MapState, type PaletteEntry } from "./types";

export interface Preset {
   id: string;
   name: string;
   build: () => MapState;
}

// Palette tuned for the Cathedral-of-Brasilia setup screenshots:
// the wonder pops in cyan, every supporting hex shares a soft blue.
const COB_PALETTE: PaletteEntry[] = [
   { id: "p1", color: "#22d3ee", label: "Cathedral of Brasilia" },
   { id: "p2", color: "#bfdbfe", label: "Setup tile" },
   { id: "p3", color: "#f1c40f", label: "Resource" },
   { id: "p4", color: "#3498db", label: "Production" },
   { id: "p5", color: "#9b59b6", label: "Storage / Warehouse" },
   { id: "p6", color: "#e67e22", label: "Market / Trade" },
   { id: "p7", color: "#95a5a6", label: "Reserved / empty" },
];

type CobHex = [dCol: number, dRow: number, label: string];

// Cathedral always at (22, 22) — even row, so neighbour offsets are stable.
const CATHEDRAL_COL = 22;
const CATHEDRAL_ROW = 22;

const buildCobCells = (hexes: CobHex[]): Record<string, HexCell> => {
   const cells: Record<string, HexCell> = {};
   for (const [dc, dr, label] of hexes) {
      const col = CATHEDRAL_COL + dc;
      const row = CATHEDRAL_ROW + dr;
      const isWonder = label.toLowerCase().includes("cathedral of brasilia");
      cells[`${col},${row}`] = {
         colorId: isWonder ? "p1" : "p2",
         text: label,
      };
   }
   return cells;
};

const cobPreset = (id: string, name: string, title: string, hexes: CobHex[]): Preset => ({
   id,
   name,
   build: () => ({
      ...initialMapState(45, 45),
      title,
      palette: COB_PALETTE,
      activeColorId: "p2",
      cells: buildCobCells(hexes),
   }),
});

export const PRESETS: Preset[] = [
   {
      id: "blank-45x45",
      name: "Blank 45×45",
      build: () => ({ ...initialMapState(45, 45), title: "Untitled Design" }),
   },

   // ── Cathedral of Brasilia: Research Labs by religion ─────────────────
   cobPreset(
      "cob-research-catholicism",
      "+17 CoB Research Labs (Catholicism)",
      "+17 Cathedral of Brasilia — Research Labs (Catholicism)",
      [
         [-1, -2, "Painting"],
         [ 0, -2, "Water"],
         [ 1, -2, "Wood"],
         [-1, -1, "Research Lab"],
         [ 0, -1, "Culture"],
         [ 1, -1, "Wheat"],
         [-2,  0, "Faith (Church)"],
         [-1,  0, "Faith (Shrine)"],
         [ 0,  0, "Cathedral of Brasilia"],
         [ 1,  0, "Philosophy"],
         [ 2,  0, "School"],
         [-1,  1, "Music"],
         [ 0,  1, "Poem (Writers Guild)"],
         [ 1,  1, "Poem (Poetry School)"],
         [ 2,  1, "Library"],
         [-1,  2, "Paper"],
         [ 0,  2, "Alcohol"],
         [ 1,  2, "Horse"],
      ],
   ),
   cobPreset(
      "cob-research-islam",
      "+18 CoB Research Labs (Islam)",
      "+18 Cathedral of Brasilia — Research Labs (Islam)",
      [
         [-1, -2, "Painting"],
         [ 0, -2, "Milk"],
         [ 1, -2, "Cheese"],
         [-2, -1, "Opera"],
         [-1, -1, "Research Lab"],
         [ 0, -1, "Culture"],
         [ 1, -1, "Wheat"],
         [-2,  0, "Faith (Mosque)"],
         [-1,  0, "Faith (Shrine)"],
         [ 0,  0, "Cathedral of Brasilia"],
         [ 1,  0, "Philosophy"],
         [ 2,  0, "School"],
         [-1,  1, "Music"],
         [ 0,  1, "Poem (Writers Guild)"],
         [ 1,  1, "Poem (Poetry School)"],
         [ 2,  1, "Library"],
         [-1,  2, "Paper"],
         [ 0,  2, "Alcohol"],
         [ 1,  2, "Horse"],
      ],
   ),
   cobPreset(
      "cob-research-buddhism",
      "+18 CoB Research Labs (Buddhism)",
      "+18 Cathedral of Brasilia — Research Labs (Buddhism)",
      [
         [-1, -2, "Painting"],
         [ 0, -2, "Lumber"],
         [ 1, -2, "Copper or Wood or Water"],
         [-2, -1, "Furniture"],
         [-1, -1, "Research Lab"],
         [ 0, -1, "Culture"],
         [ 1, -1, "Wheat"],
         [-2,  0, "Faith (Pagoda)"],
         [-1,  0, "Faith (Shrine)"],
         [ 0,  0, "Cathedral of Brasilia"],
         [ 1,  0, "Philosophy"],
         [ 2,  0, "School"],
         [-1,  1, "Music"],
         [ 0,  1, "Poem (Writers Guild)"],
         [ 1,  1, "Poem (Poetry School)"],
         [ 2,  1, "Library"],
         [-1,  2, "Paper"],
         [ 0,  2, "Alcohol"],
         [ 1,  2, "Horse"],
      ],
   ),
   cobPreset(
      "cob-research-polytheism",
      "+16 CoB Research Labs (Poly)",
      "+16 Cathedral of Brasilia — Research Labs (Polytheism)",
      [
         [-1, -2, "Painting"],
         [ 0, -2, "Water"],
         [ 1, -2, "Wood"],
         [-1, -1, "Research Lab"],
         [ 0, -1, "Culture"],
         [ 1, -1, "Wheat"],
         [-1,  0, "Faith (Shrine)"],
         [ 0,  0, "Cathedral of Brasilia"],
         [ 1,  0, "Philosophy"],
         [ 2,  0, "School"],
         [-1,  1, "Music"],
         [ 0,  1, "Poem (Writers Guild)"],
         [ 1,  1, "Poem (Poetry School)"],
         [ 2,  1, "Library"],
         [-1,  2, "Paper"],
         [ 0,  2, "Alcohol"],
         [ 1,  2, "Horse"],
      ],
   ),

   // ── Cathedral of Brasilia: other setups ───────────────────────────────
   cobPreset(
      "cob-condos",
      "+12 CoB Condos",
      "+12 Cathedral of Brasilia — Condos",
      [
         [ 0, -2, "Milk"],
         [ 1, -2, "Cheese"],
         [-1, -1, "Water"],
         [ 0, -1, "Wheat"],
         [ 1, -1, "Bread"],
         [-1,  0, "Condo"],
         [ 0,  0, "Cathedral of Brasilia"],
         [ 1,  0, "Hut"],
         [ 2,  0, "Flour"],
         [-1,  1, "Apartment"],
         [ 0,  1, "House"],
         [ 1,  1, "Meat"],
         [ 0,  2, "Pizza"],
      ],
   ),
   cobPreset(
      "cob-computer-labs",
      "+18 CoB Computer Labs",
      "+18 Cathedral of Brasilia — Computer Labs",
      [
         [-2, -2, "Plastics (Gas)"],
         [-1, -2, "Semiconductor"],
         [ 0, -2, "Computer Factory"],
         [ 1, -2, "Power Source"],
         [-2, -1, "Faith (Shrine)"],
         [-1, -1, "Plastics (Oil)"],
         [ 0, -1, "Research Lab"],
         [ 1, -1, "Computer Lab"],
         [-2,  0, "Faith (Mosque/Pagoda)"],
         [-1,  0, "Painting"],
         [ 0,  0, "Cathedral of Brasilia"],
         [ 1,  0, "Philosophy"],
         [ 2,  0, "Silicon"],
         [-2,  1, "Horse"],
         [-1,  1, "Music"],
         [ 0,  1, "Culture"],
         [ 1,  1, "Poem (Poetry School)"],
         [-1,  2, "School or better Aluminium"],
         [ 0,  2, "Paper or Copper"],
         [ 1,  2, "Poem (Writers Guild)"],
      ],
   ),
];

export const loadPreset = (preset: Preset): MapState => sanitizeMapState(preset.build());
