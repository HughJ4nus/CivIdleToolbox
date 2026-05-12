// User-set great-person + wonder levels, persisted to localStorage so
// the sidebar inputs survive a page reload. Pure storage layer; the
// chain math doesn't touch this file.

const KEY = "production-lines:user-bonus-levels:v1";

export interface UserState {
   /** Great-person key → base level (0 means "I don't have this one").
    *  Effective level for chain math = base + ageWisdom[gp.age]. */
   greatPeople: Record<string, number>;
   /** Wonder key → level. */
   wonders: Record<string, number>;
   /** Tech-age key → Age of Wisdom value. Adds directly to every GP of
    *  that age's effective level (per RebirthLogic.ts in upstream). */
   ageWisdom: Record<string, number>;
}

const empty = (): UserState => ({ greatPeople: {}, wonders: {}, ageWisdom: {} });

export const loadUserState = (): UserState => {
   try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return empty();
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return empty();
      return {
         greatPeople:
            parsed.greatPeople && typeof parsed.greatPeople === "object"
               ? parsed.greatPeople
               : {},
         wonders:
            parsed.wonders && typeof parsed.wonders === "object" ? parsed.wonders : {},
         ageWisdom:
            parsed.ageWisdom && typeof parsed.ageWisdom === "object"
               ? parsed.ageWisdom
               : {},
      };
   } catch {
      return empty();
   }
};

export const saveUserState = (state: UserState): void => {
   try {
      localStorage.setItem(KEY, JSON.stringify(state));
   } catch {
      /* quota / private mode — silently ignore */
   }
};
