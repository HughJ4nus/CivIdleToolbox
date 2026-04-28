import { sanitizeMapState } from "./sanitize";
import { initialMapState, type MapState } from "./types";

const KEY = "cividle-hex-map:v1";

export const loadState = (): MapState => {
   try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return initialMapState();
      // sanitizeMapState handles every defensive check (type coercion, length
      // caps, color regex, schema migration), so a tampered or stale value in
      // localStorage can never reach the renderer.
      return sanitizeMapState(JSON.parse(raw));
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
