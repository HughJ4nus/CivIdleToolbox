import { initialMapState, type MapState } from "./types";

const KEY = "cividle-hex-map:v1";

export const loadState = (): MapState => {
   try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return initialMapState();
      const parsed = JSON.parse(raw) as MapState;
      // Defensive: ensure required shapes exist.
      if (!parsed.palette || !parsed.cells || !parsed.cols || !parsed.rows) {
         return initialMapState();
      }
      // Migrate older saves that lacked notes/annotations.
      if (typeof parsed.notes !== "string") parsed.notes = "";
      if (!Array.isArray(parsed.annotations)) parsed.annotations = [];
      return parsed;
   } catch {
      return initialMapState();
   }
};

export const saveState = (state: MapState): void => {
   try {
      localStorage.setItem(KEY, JSON.stringify(state));
   } catch (err) {
      console.warn("Failed to persist map state", err);
   }
};
