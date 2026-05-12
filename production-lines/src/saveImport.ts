// Parses a CivIdle save file and extracts the bits our sidebar cares
// about: per-GP levels, built-wonder levels, Age of Wisdom values.
//
// Save format reference: shared/logic/GameStateLogic.ts in upstream.
// Saves come in three shapes the user might hand us:
//   • Steam / desktop: raw DEFLATE-compressed JSON, written by fflate's
//     deflateSync (no gzip wrapper, no zlib header). File name "CivIdle".
//   • Older snapshots: gzip-wrapped JSON (some tooling produces these).
//   • Browser: raw JSON string from IndexedDB.
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
   /** Centre Pompidou's special field (Set<City> in upstream) — its
    *  in-game potency is `cities.size + 1`, not the building.level. */
   cities?: Set<unknown> | unknown[] | Record<string, unknown>;
   /** Picked path on directional wonders. Each is a string like
    *  "Cultivation" / "Christianity" / "Liberalism". */
   tradition?: string;
   religion?: string;
   ideology?: string;
}
interface TileLite {
   building?: BuildingLite;
}

// Wonders that store their picked "direction" in a custom field on the
// building data. The save importer maps each one onto a single
// `wonderDirections` map keyed by wonder type.
const DIRECTION_FIELDS: Record<string, "tradition" | "religion" | "ideology"> = {
   ChoghaZanbil: "tradition",
   LuxorTemple: "religion",
   BigBen: "ideology",
};

// Some wonders store their effective "level" in a custom field rather
// than the standard building.level (which is hard-capped at 1 for
// non-upgradeable wonders). Returns the synthetic level when applicable.
const wonderLevelOverride = (b: BuildingLite): number | null => {
   if (b.type === "CentrePompidou") {
      const c = b.cities;
      let cityCount = 0;
      if (c instanceof Set) cityCount = c.size;
      else if (Array.isArray(c)) cityCount = c.length;
      else if (c && typeof c === "object") cityCount = Object.keys(c).length;
      // +1 for the player's own civ — matches OnProductionComplete.tsx:1723.
      return cityCount + 1;
   }
   return null;
};

export interface ParsedSave {
   greatPeople: Record<string, number>;
   wonders: Record<string, number>;
   ageWisdom: Record<string, number>;
   /** Picked path per directional wonder (ChoghaZanbil/LuxorTemple/BigBen). */
   wonderDirections: Record<string, string>;
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

const looksLikeJson = (bytes: Uint8Array): boolean => {
   // Skip leading whitespace / BOM; first non-blank char is { or [ for JSON.
   for (let i = 0; i < Math.min(bytes.length, 8); i++) {
      const c = bytes[i];
      if (c === 0xef || c === 0xbb || c === 0xbf) continue; // UTF-8 BOM
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) continue;
      return c === 0x7b /* { */ || c === 0x5b /* [ */;
   }
   return false;
};

const decompress = async (
   bytes: Uint8Array,
   format: "gzip" | "deflate-raw" | "deflate",
): Promise<string> => {
   const stream = new Blob([bytes as BlobPart])
      .stream()
      .pipeThrough(new DecompressionStream(format));
   return await new Response(stream).text();
};

const decodeBytes = async (bytes: Uint8Array): Promise<string> => {
   // Plain JSON (browser-IndexedDB exports): no decompression.
   if (looksLikeJson(bytes)) return new TextDecoder().decode(bytes);
   // gzip-wrapped (older snapshots, custom backups).
   if (looksGzipped(bytes)) return decompress(bytes, "gzip");
   // Otherwise it's the Steam save format: fflate deflateSync output,
   // i.e. raw DEFLATE with no wrapper. Fall back to zlib-wrapped deflate
   // if that fails (some tooling adds the 0x78 header).
   try {
      return await decompress(bytes, "deflate-raw");
   } catch {
      return await decompress(bytes, "deflate");
   }
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
   const wonderDirections: Record<string, string> = {};
   const tiles = save.current?.tiles;
   if (tiles instanceof Map) {
      for (const tile of tiles.values()) {
         const b = tile?.building;
         if (!b) continue;
         if (!WONDER_KEYS.has(b.type)) continue;
         if (b.status && b.status !== "completed") continue;
         const override = wonderLevelOverride(b);
         const lvl = override ?? Math.max(1, b.level ?? 1);
         // If multiple cities ever stack the same wonder somehow, keep
         // the higher level — defensive, doesn't normally happen.
         wonders[b.type] = Math.max(wonders[b.type] ?? 0, lvl);
         // Pull the chosen path on directional wonders.
         const dirField = DIRECTION_FIELDS[b.type];
         if (dirField) {
            const picked = b[dirField];
            if (typeof picked === "string" && picked.length > 0) {
               wonderDirections[b.type] = picked;
            }
         }
      }
   }

   return {
      greatPeople,
      wonders,
      ageWisdom,
      wonderDirections,
      stats: {
         gpCount: Object.keys(greatPeople).length,
         wonderCount: Object.keys(wonders).length,
         ageWisdomCount: Object.keys(ageWisdom).length,
      },
   };
};
