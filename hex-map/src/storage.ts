import { sanitizeMapState } from "./sanitize";
import { initialMapState, type MapState } from "./types";

// v1 stored a single MapState; v2 stores a collection of user designs and
// remembers which one is active. Old v1 saves are migrated transparently.
const KEY_V2 = "cividle-hex-map:designs:v1";
const KEY_V1 = "cividle-hex-map:v1";

export interface DesignCollection {
   activeId: string;
   designs: Record<string, MapState>;
}

export const newDesignId = (): string =>
   `d-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const freshCollection = (): DesignCollection => {
   const id = newDesignId();
   return { activeId: id, designs: { [id]: initialMapState() } };
};

export const loadDesigns = (): DesignCollection => {
   // Try v2 first.
   try {
      const raw = localStorage.getItem(KEY_V2);
      if (raw) {
         const parsed = JSON.parse(raw);
         if (
            parsed &&
            typeof parsed === "object" &&
            typeof parsed.activeId === "string" &&
            parsed.designs &&
            typeof parsed.designs === "object"
         ) {
            const designs: Record<string, MapState> = {};
            for (const [id, raw] of Object.entries(parsed.designs)) {
               designs[id] = sanitizeMapState(raw);
            }
            const activeId = designs[parsed.activeId]
               ? parsed.activeId
               : Object.keys(designs)[0];
            if (activeId) return { activeId, designs };
         }
      }
   } catch {
      /* fall through to migration */
   }

   // Migrate v1 (single MapState) → v2 (collection with one design).
   try {
      const raw = localStorage.getItem(KEY_V1);
      if (raw) {
         const state = sanitizeMapState(JSON.parse(raw));
         const id = newDesignId();
         return { activeId: id, designs: { [id]: state } };
      }
   } catch {
      /* fall through */
   }

   return freshCollection();
};

export const saveDesigns = (data: DesignCollection): void => {
   try {
      localStorage.setItem(KEY_V2, JSON.stringify(data));
   } catch (err) {
      console.warn("Failed to persist designs", err);
   }
};
