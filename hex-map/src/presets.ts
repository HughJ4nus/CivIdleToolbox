// Premade designs surfaced in the title-input dropdown. Each preset returns
// a complete MapState; the loader runs it through sanitizeMapState before
// applying, so the same safety net as user-imported JSON applies.
//
// Wonder labels MUST match a name or key from src/data/buildings.json
// exactly (case-insensitive) for the wonder-range overlay to draw.
//
// To add a preset:
//   1. Build the design in the editor.
//   2. Export it as JSON via the toolbar.
//   3. Open the JSON, paste its contents into a new `build: () => ({...})`
//      below, and give it an `id` + display `name`.
//   4. Reload — it'll show up in the dropdown.
//
// The Cathedral-of-Brasília presets here use a small DSL: a `[dCol, dRow,
// label]` triple per hex, relative to the wonder. The wonder is always
// placed on an even row so neighbour offsets behave the same way for every
// preset (odd-r offset coords would otherwise flip neighbour columns
// depending on row parity).

import { sanitizeMapState } from "./sanitize";
import { initialMapState, type HexCell, type MapState, type PaletteEntry } from "./types";

export interface Preset {
   id: string;
   name: string;
   build: () => MapState;
}

// Each unique wonder gets its own palette entry so it stands out from the
// supporting tiles. Add a new entry here per wonder you introduce.
const WONDER_COLORS: Record<string, { color: string; label: string }> = {
   "Cathedral of Brasília": { color: "#06b6d4", label: "Cathedral of Brasília" },
};

// Standard supporting-tile color shared by every preset.
const SETUP_COLOR = "#bfdbfe";

const buildPalette = (wonderName: string): PaletteEntry[] => {
   const wonder = WONDER_COLORS[wonderName];
   return [
      // p1 always = the wonder featured by this preset.
      { id: "p1", color: wonder?.color ?? "#e74c3c", label: wonder?.label ?? wonderName },
      { id: "p2", color: SETUP_COLOR, label: "Setup tile" },
      { id: "p3", color: "#f1c40f", label: "Resource" },
      { id: "p4", color: "#3498db", label: "Production" },
      { id: "p5", color: "#9b59b6", label: "Storage / Warehouse" },
      { id: "p6", color: "#e67e22", label: "Market / Trade" },
      { id: "p7", color: "#95a5a6", label: "Reserved / empty" },
   ];
};

type RelHex = [dCol: number, dRow: number, label: string];

interface OffsetPresetSpec {
   id: string;
   name: string;
   title: string;
   wonder: string; // must match buildings.json `name` (or `key`) for the range overlay
   hexes: RelHex[]; // includes the wonder at offset (0, 0)
}

// Sizes the canvas to the design's bounding box plus 2 tiles of padding on
// each side, then places the wonder at the right offset so that padding is
// even all around. Forces the wonder to land on an even row so the offset
// coord neighbour rules stay consistent with the input layout.
const buildOffsetPreset = (spec: OffsetPresetSpec): MapState => {
   const cols = spec.hexes.map((h) => h[0]);
   const rows = spec.hexes.map((h) => h[1]);
   const minDc = Math.min(...cols);
   const maxDc = Math.max(...cols);
   const minDr = Math.min(...rows);
   const maxDr = Math.max(...rows);

   const width = maxDc - minDc + 1 + 4; // +2 padding each side
   const height = maxDr - minDr + 1 + 4;
   const wonderCol = 2 - minDc;
   let wonderRow = 2 - minDr;
   // Keep wonder on an even row so offset-coord neighbours match the input
   // layout. minDr is even in every current preset, so this is a no-op, but
   // future presets with odd minDr won't silently break.
   if (wonderRow % 2 !== 0) wonderRow += 1;

   const palette = buildPalette(spec.wonder);
   const wonderNameLc = spec.wonder.trim().toLowerCase();

   const cells: Record<string, HexCell> = {};
   for (const [dc, dr, label] of spec.hexes) {
      const key = `${wonderCol + dc},${wonderRow + dr}`;
      const isWonder = label.trim().toLowerCase() === wonderNameLc;
      cells[key] = { colorId: isWonder ? "p1" : "p2", text: label };
   }

   return {
      ...initialMapState(width, height),
      title: spec.title,
      palette,
      activeColorId: "p2",
      cells,
   };
};

const cobPreset = (
   id: string,
   name: string,
   title: string,
   hexes: RelHex[],
): Preset => ({
   id,
   name,
   build: () =>
      buildOffsetPreset({ id, name, title, wonder: "Cathedral of Brasília", hexes }),
});

// ── Ring-style preset (used by Atlas Mountains) ──────────────────────────
// The Atlas design has four tile categories with distinct colors. Each hex
// declares which "tier" it belongs to and the builder maps that to a palette
// slot.

type RingTier = "center" | "inner" | "outer" | "wonder";
type RingHex = [dCol: number, dRow: number, label: string, tier: RingTier];

const RING_PALETTE: PaletteEntry[] = [
   { id: "p1", color: "#6b7280", label: "Atlas Mountains (centre)" },
   { id: "p2", color: "#bfdbfe", label: "Inner ring" },
   { id: "p3", color: "#fed7aa", label: "Outer ring" },
   { id: "p4", color: "#06b6d4", label: "Ancillary wonder" },
   { id: "p5", color: "#9b59b6", label: "Storage / Warehouse" },
   { id: "p6", color: "#e67e22", label: "Market / Trade" },
   { id: "p7", color: "#95a5a6", label: "Reserved / empty" },
];

const RING_TO_COLOR: Record<RingTier, string> = {
   center: "p1",
   inner: "p2",
   outer: "p3",
   wonder: "p4",
};

interface RingPresetSpec {
   title: string;
   hexes: RingHex[];
   activeFestivals?: string[];
   activeUpgrades?: string[];
}

const buildRingPreset = (spec: RingPresetSpec): MapState => {
   const cols = spec.hexes.map((h) => h[0]);
   const rows = spec.hexes.map((h) => h[1]);
   const minDc = Math.min(...cols);
   const maxDc = Math.max(...cols);
   const minDr = Math.min(...rows);
   const maxDr = Math.max(...rows);
   const width = maxDc - minDc + 1 + 4;
   const height = maxDr - minDr + 1 + 4;
   const centerCol = 2 - minDc;
   let centerRow = 2 - minDr;
   if (centerRow % 2 !== 0) centerRow += 1;

   const cells: Record<string, HexCell> = {};
   for (const [dc, dr, label, tier] of spec.hexes) {
      const key = `${centerCol + dc},${centerRow + dr}`;
      cells[key] = { colorId: RING_TO_COLOR[tier], text: label };
   }

   return {
      ...initialMapState(width, height),
      title: spec.title,
      palette: RING_PALETTE,
      activeColorId: "p2",
      cells,
      activeFestivals: spec.activeFestivals ?? [],
      activeUpgrades: spec.activeUpgrades ?? [],
   };
};

export const PRESETS: Preset[] = [
   {
      id: "blank-45x45",
      name: "Blank 45×45",
      build: () => ({ ...initialMapState(45, 45), title: "Untitled Design" }),
   },

   // ── Cathedral of Brasília: Research Labs by religion ─────────────────
   cobPreset(
      "cob-research-catholicism",
      "+17 CoB Research Labs (Catholicism)",
      "+17 Cathedral of Brasília — Research Labs (Catholicism)",
      [
         [-1, -2, "Painting"],
         [ 0, -2, "Water"],
         [ 1, -2, "Wood"],
         [-1, -1, "Research Lab"],
         [ 0, -1, "Culture"],
         [ 1, -1, "Wheat"],
         [-2,  0, "Faith (Church)"],
         [-1,  0, "Faith (Shrine)"],
         [ 0,  0, "Cathedral of Brasília"],
         [ 1,  0, "Philosophy"],
         [ 2,  0, "School"],
         [-2,  1, "Music"],
         [-1,  1, "Poem (Writers Guild)"],
         [ 0,  1, "Poem (Poetry School)"],
         [ 1,  1, "Library"],
         [-1,  2, "Paper"],
         [ 0,  2, "Alcohol"],
         [ 1,  2, "Horse"],
      ],
   ),
   cobPreset(
      "cob-research-islam",
      "+18 CoB Research Labs (Islam)",
      "+18 Cathedral of Brasília — Research Labs (Islam)",
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
         [ 0,  0, "Cathedral of Brasília"],
         [ 1,  0, "Philosophy"],
         [ 2,  0, "School"],
         [-2,  1, "Music"],
         [-1,  1, "Poem (Writers Guild)"],
         [ 0,  1, "Poem (Poetry School)"],
         [ 1,  1, "Library"],
         [-1,  2, "Paper"],
         [ 0,  2, "Alcohol"],
         [ 1,  2, "Horse"],
      ],
   ),
   cobPreset(
      "cob-research-buddhism",
      "+18 CoB Research Labs (Buddhism)",
      "+18 Cathedral of Brasília — Research Labs (Buddhism)",
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
         [ 0,  0, "Cathedral of Brasília"],
         [ 1,  0, "Philosophy"],
         [ 2,  0, "School"],
         [-2,  1, "Music"],
         [-1,  1, "Poem (Writers Guild)"],
         [ 0,  1, "Poem (Poetry School)"],
         [ 1,  1, "Library"],
         [-1,  2, "Paper"],
         [ 0,  2, "Alcohol"],
         [ 1,  2, "Horse"],
      ],
   ),
   cobPreset(
      "cob-research-polytheism",
      "+16 CoB Research Labs (Poly)",
      "+16 Cathedral of Brasília — Research Labs (Polytheism)",
      [
         [-1, -2, "Painting"],
         [ 0, -2, "Water"],
         [ 1, -2, "Wood"],
         [-1, -1, "Research Lab"],
         [ 0, -1, "Culture"],
         [ 1, -1, "Wheat"],
         [-1,  0, "Faith (Shrine)"],
         [ 0,  0, "Cathedral of Brasília"],
         [ 1,  0, "Philosophy"],
         [ 2,  0, "School"],
         [-2,  1, "Music"],
         [-1,  1, "Poem (Writers Guild)"],
         [ 0,  1, "Poem (Poetry School)"],
         [ 1,  1, "Library"],
         [-1,  2, "Paper"],
         [ 0,  2, "Alcohol"],
         [ 1,  2, "Horse"],
      ],
   ),

   // ── Cathedral of Brasília: other setups ───────────────────────────────
   cobPreset(
      "cob-condos",
      "+12 CoB Condos",
      "+12 Cathedral of Brasília — Condos",
      [
         [ 0, -2, "Milk"],
         [ 1, -2, "Cheese"],
         [-1, -1, "Water"],
         [ 0, -1, "Wheat"],
         [ 1, -1, "Bread"],
         [-1,  0, "Condo"],
         [ 0,  0, "Cathedral of Brasília"],
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
      "+18 Cathedral of Brasília — Computer Labs",
      [
         // Power Source is intentionally outside the wonder's range — see
         // image_0_5: it's the corner tile that the player accepts as out of
         // range. Every other tile in this preset is inside range 2.
         [-1, -2, "Plastics (Gas)"],
         [ 0, -2, "Semiconductor"],
         [ 1, -2, "Computer Factory"],
         [ 2, -2, "Power Source"],
         [-2, -1, "Faith (Shrine)"],
         [-1, -1, "Plastics (Oil)"],
         [ 0, -1, "Research Lab"],
         [ 1, -1, "Computer Lab"],
         [-2,  0, "Faith (Mosque/Pagoda)"],
         [-1,  0, "Painting"],
         [ 0,  0, "Cathedral of Brasília"],
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

   // ── Atlas Mountains (max range = 6) ───────────────────────────────────
   // Range comes from base 2 + AtlasMountains festival (+2) + Suffete
   // Administration upgrade (+2). Both flags are set on the state so the
   // range overlay draws the full circle correctly.
   {
      id: "atlas-mountains-max",
      name: "Atlas Mountains (max range)",
      build: () =>
         buildRingPreset({
            title: "Atlas Mountains — max range (festival + Suffete Administration)",
            activeFestivals: ["AtlasMountains"],
            activeUpgrades: ["SuffeteAdministration"],
            hexes: [
               // Centre — must match the wonder's name in buildings.json
               [ 0,  0, "Atlas Mountains", "center"],

               // Ancillary wonders (cyan corner pieces)
               [-3,  0, "Swiss Bank", "wonder"],
               [ 6,  0, "Golden Gate Bridge", "wonder"],
               [-3,  4, "Statue of Liberty", "wonder"],

               // Inner ring (blue) — ~30 tiles around the wonder
               [-2, -2, "CivOasis", "inner"],
               [-1, -2, "Peace", "inner"],
               [ 0, -2, "Condo (Worker)", "inner"],
               [ 1, -2, "Reinforced Concrete", "inner"],
               [ 2, -2, "Biplane", "inner"],

               [-3, -1, "Hydro Dam (Water)", "inner"],
               [-2, -1, "Television", "inner"],
               [-1, -1, "Frigate", "inner"],
               [ 0, -1, "Politics", "inner"],
               [ 1, -1, "Train", "inner"],
               [ 2, -1, "CivGTP", "inner"],
               [ 3, -1, "Bitcoin", "inner"],

               [-2,  0, "Nuclear Submarine", "inner"],
               [-1,  0, "Mutual Fund", "inner"],
               [ 1,  0, "Magazine & Science", "inner"],
               [ 2,  0, "Artillery", "inner"],
               [ 3,  0, "Optical Fiber", "inner"],
               [ 4,  0, "Semiconductor", "inner"],

               [-3,  1, "Robocar", "inner"],
               [-2,  1, "Aircraft Carrier", "inner"],
               [-1,  1, "Tank", "inner"],
               [ 0,  1, "News paper", "inner"],
               [ 1,  1, "Siege Ram", "inner"],
               [ 2,  1, "Atomic Bomb", "inner"],
               [ 3,  1, "Software", "inner"],

               [-1,  2, "Rifle", "inner"],
               [ 0,  2, "Spacecraft", "inner"],
               [ 1,  2, "Sword", "inner"],
               [ 2,  2, "Furniture", "inner"],

               // Outer ring (peach) — top edge of the design
               [-3, -5, "Caravel", "outer"],
               [-2, -5, "Shrine (Faith)", "outer"],
               [-1, -5, "Chariot", "outer"],
               [ 0, -5, "Cheese", "outer"],
               [ 1, -5, "Flour", "outer"],
               [ 2, -5, "Coin", "outer"],
               [ 3, -5, "Bond", "outer"],

               [-4, -4, "Poem (Poetry School)", "outer"],
               [-3, -4, "Armor", "outer"],
               [-2, -4, "Brick", "outer"],
               [-1, -4, "Coal", "outer"],
               [ 0, -4, "Meat", "outer"],
               [ 1, -4, "Cotton", "outer"],
               [ 2, -4, "Sand", "outer"],
               [ 3, -4, "Garment", "outer"],

               // Outer ring — sparser middle/right edge (the source has
               // many empty tiles intentionally; only the labelled ones
               // are reproduced here)
               [-4, -3, "Nuclear Fuel Rod", "outer"],
               [ 3, -3, "Natural Gas", "outer"],
               [ 4, -3, "Marble", "outer"],
               [ 4, -2, "Oil", "outer"],
               [ 5, -2, "Music", "outer"],
               [ 4, -1, "Wood", "outer"],
               [ 5, -1, "Painting", "outer"],

               // Outer ring — left edge
               [-4,  0, "Planetery Rover", "outer"],
            ],
         }),
   },
];

export const loadPreset = (preset: Preset): MapState => sanitizeMapState(preset.build());
