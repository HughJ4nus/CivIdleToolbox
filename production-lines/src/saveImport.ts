// Parses a CivIdle save file and extracts the bits our sidebar cares
// about: per-GP levels, built-wonder levels, Age of Wisdom values.
//
// Save format reference: shared/logic/GameStateLogic.ts in upstream.
// Saves come in two shapes the user might hand us:
//   • Steam / desktop: gzipped JSON (file name "CivIdle")
//   • Browser: raw JSON string from IndexedDB
// Both serialise Maps and Sets via this convention:
//   Map<K,V> → {"$type":"Map","value":[[k,v],...]}
//   Set<V>   → {"$type":"Set","value":[v,...]}
// Custom reviver below restores them into real Maps/Sets so we can walk
// the tile graph and find built wonders.

import bonusData from "./data/bonus-sources.json";

interface BuildingLite {
   type: string;
   level?: number;
   status?: string;
}
interface TileLite {
   building?: BuildingLite;
}

export interface ParsedSave {
   greatPeople: Record<string, number>;
   wonders: Record<string, number>;
   ageWisdom: Record<string, number>;
   /** Stats so the user can sanity-check the import. */
   stats: {
      gpCount: number;
      wonderCount: number;
      ageWisdomCount: number;
   };
}

const WONDER_KEYS = new Set<string>(
   (bonusData as { wonders: Array<{ key: string }> }).wonders.map((w) => w.key),
);

const reviver = (_key: string, value: unknown): unknown => {
   if (typeof value === "object" && value !== null) {
      const obj = value as { $type?: string; value?: unknown };
      if (obj.$type === "Map") return new Map(obj.value as Iterable<[unknown, unknown]>);
      if (obj.$type === "Set") return new Set(obj.value as Iterable<unknown>);
   }
   return value;
};

const looksGzipped = (bytes: Uint8Array): boolean =>
   bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;

const decodeBytes = async (bytes: Uint8Array): Promise<string> => {
   if (!looksGzipped(bytes)) return new TextDecoder().decode(bytes);
   // Browser-native gzip decode. Available in Chromium 80+ / Firefox 113+
   // / Safari 16.4+ — that covers anyone running CivIdle in the first place.
   const stream = new Blob([bytes as BlobPart])
      .stream()
      .pipeThrough(new DecompressionStream("gzip"));
   return await new Response(stream).text();
};

export const parseSaveFile = async (file: File): Promise<ParsedSave> => {
   const bytes = new Uint8Array(await file.arrayBuffer());
   const json = await decodeBytes(bytes);
   const save = JSON.parse(json, reviver) as {
      current?: { tiles?: Map<unknown, TileLite> };
      options?: {
         greatPeople?: Record<string, { level?: number } | number>;
         ageWisdom?: Record<string, number>;
      };
   };

   // ── Great people: options.greatPeople[key] = { level, amount } ──
   const greatPeople: Record<string, number> = {};
   const gpRaw = save.options?.greatPeople ?? {};
   for (const [key, entry] of Object.entries(gpRaw)) {
      // The entry is normally an object {level, amount} but be lenient
      // in case the format ever simplifies.
      const lvl =
         typeof entry === "number"
            ? entry
            : ((entry as { level?: number } | null)?.level ?? 0);
      if (lvl > 0) greatPeople[key] = lvl;
   }

   // ── Age of Wisdom: options.ageWisdom is already plain numbers ────
   const ageWisdom: Record<string, number> = {};
   const awRaw = save.options?.ageWisdom ?? {};
   for (const [key, value] of Object.entries(awRaw)) {
      if (typeof value === "number" && value > 0) ageWisdom[key] = value;
   }

   // ── Wonders: walk current.tiles and pick out completed buildings
   //    whose type is in our wonder list. Use building.level as the
   //    wonder's level; non-levelable wonders read back as 1 (max=1
   //    in upstream BuildingDefinitions), which is exactly what our
   //    resolver expects. Skip in-progress wonders so the user only
   //    gets credit for what's actually built.
   const wonders: Record<string, number> = {};
   const tiles = save.current?.tiles;
   if (tiles instanceof Map) {
      for (const tile of tiles.values()) {
         const b = tile?.building;
         if (!b) continue;
         if (!WONDER_KEYS.has(b.type)) continue;
         if (b.status && b.status !== "completed") continue;
         const lvl = Math.max(1, b.level ?? 1);
         // If multiple cities ever stack the same wonder somehow, keep
         // the higher level — defensive, doesn't normally happen.
         wonders[b.type] = Math.max(wonders[b.type] ?? 0, lvl);
      }
   }

   return {
      greatPeople,
      wonders,
      ageWisdom,
      stats: {
         gpCount: Object.keys(greatPeople).length,
         wonderCount: Object.keys(wonders).length,
         ageWisdomCount: Object.keys(ageWisdom).length,
      },
   };
};
