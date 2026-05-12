// Shared shape for one entry in src/data/buildings.json. Kept in its own
// file so chain.ts and App.tsx can both import it without cycling.

export interface Building {
   key: string;
   name: string;
   special: "WorldWonder" | "NaturalWonder" | "HQ" | null;
   tier: number | null;
   input: Record<string, number>;
   output: Record<string, number>;
}
