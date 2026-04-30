export interface PaletteEntry {
   id: string;
   color: string; // hex
   label: string; // legend description
}

export interface HexCell {
   colorId?: string; // refers to PaletteEntry.id
   text?: string;
}

export interface Annotation {
   id: string;
   tier: string; // short text shown on the left badge (e.g. "I", "II", "VI")
   colorId: string | null; // refers to PaletteEntry.id (null = no color, neutral row)
   label: string;
}

export interface MapState {
   version: 1;
   cols: number;
   rows: number;
   palette: PaletteEntry[];
   activeColorId: string | null;
   /** keyed by `${col},${row}` */
   cells: Record<string, HexCell>;
   title: string;
   notes: string;
   annotations: Annotation[];
   /** Whether the perimeter outline of a wonder's tile range is drawn. */
   showRanges: boolean;
   /** Wonder building keys for which a festival is assumed active. */
   activeFestivals: string[];
   /** Upgrade IDs assumed unlocked (e.g. "SuffeteAdministration"). */
   activeUpgrades: string[];
}

export const DEFAULT_PALETTE: PaletteEntry[] = [
   { id: "p1", color: "#e74c3c", label: "Wonder" },
   { id: "p2", color: "#f1c40f", label: "Resource" },
   { id: "p3", color: "#2ecc71", label: "Worker housing" },
   { id: "p4", color: "#3498db", label: "Production" },
   { id: "p5", color: "#9b59b6", label: "Storage / Warehouse" },
   { id: "p6", color: "#e67e22", label: "Market / Trade" },
   { id: "p7", color: "#95a5a6", label: "Reserved / empty" },
];

export const initialMapState = (cols = 45, rows = 45): MapState => ({
   version: 1,
   cols,
   rows,
   palette: DEFAULT_PALETTE,
   activeColorId: DEFAULT_PALETTE[0].id,
   cells: {},
   title: "Untitled Design",
   notes: "",
   annotations: [],
   showRanges: true,
   activeFestivals: [],
   activeUpgrades: [],
});

export const newAnnotation = (existing: Annotation[], colorId: string | null = null): Annotation => {
   const ids = new Set(existing.map((a) => a.id));
   let i = existing.length + 1;
   while (ids.has(`a${i}`)) i++;
   return { id: `a${i}`, tier: "I", colorId, label: "" };
};
