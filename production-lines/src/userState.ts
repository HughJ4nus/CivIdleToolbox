// User-set great-person + wonder levels, persisted to localStorage so
// the sidebar inputs survive a page reload. Pure storage layer; the
// chain math doesn't touch this file.

const KEY = "production-lines:user-bonus-levels:v1";

export interface TradeTileBonus {
   /** Stable id for React keys; doesn't matter what it is. */
   id: string;
   /** Building key the player has the trade tile bonus on. Empty string
    *  when the row has just been added and the dropdown is unset. */
   building: string;
}

export interface UserState {
   /** Great-person key → base level (0 means "I don't have this one").
    *  Effective level for chain math = base + ageWisdom[gp.age]. */
   greatPeople: Record<string, number>;
   /** Wonder key → level. */
   wonders: Record<string, number>;
   /** Tech-age key → Age of Wisdom value. Adds directly to every GP of
    *  that age's effective level (per RebirthLogic.ts in upstream). */
   ageWisdom: Record<string, number>;
   /** Trade tile bonuses the player has explored. Each entry contributes
    *  +5 output to its target building, and the WorldTradeOrganization
    *  wonder adds another +wtoLevel per tile on top. */
   tradeTiles: TradeTileBonus[];
   /** Buildings the user has added to the Cathedral of Brasília
    *  production chain. Each listed building gets +N output multiplier
    *  where N is the list length (manual stand-in for the in-game
    *  adjacency-based effect we don't model). */
   cathedralOfBrasiliaBuildings: string[];
   /** Buildings the user has selected as Château Frontenac targets. The
    *  in-game wonder lets the player pick a few buildings; each picked
    *  building gets +1 effective level. */
   chateauFrontenacBuildings: string[];
   /** Buildings the user has marked as recipients of the United Nations
    *  General Assembly voted boost (changes weekly in-game). Each gets
    *  +(UN level + 4) output multiplier. The universal +1 to all
    *  tier-4..6 buildings is applied separately and doesn't depend
    *  on this list. */
   unitedNationsBuildings: string[];
   /** Player's current happiness reading. Drives a few wonder bonuses
    *  (Habitat 67's level boost to AI Lab, Ziggurat of Ur's output
    *  multiplier to old-age buildings). 0 means "not set / no bonus". */
   finalHappiness: number;
}

const empty = (): UserState => ({
   greatPeople: {},
   wonders: {},
   ageWisdom: {},
   tradeTiles: [],
   cathedralOfBrasiliaBuildings: [],
   chateauFrontenacBuildings: [],
   unitedNationsBuildings: [],
   finalHappiness: 0,
});

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
         tradeTiles: Array.isArray(parsed.tradeTiles)
            ? parsed.tradeTiles
                 .filter(
                    (t: unknown): t is TradeTileBonus =>
                       typeof t === "object" &&
                       t !== null &&
                       typeof (t as TradeTileBonus).id === "string" &&
                       typeof (t as TradeTileBonus).building === "string",
                 )
            : [],
         cathedralOfBrasiliaBuildings: Array.isArray(
            parsed.cathedralOfBrasiliaBuildings,
         )
            ? parsed.cathedralOfBrasiliaBuildings.filter(
                 (s: unknown): s is string => typeof s === "string",
              )
            : [],
         chateauFrontenacBuildings: Array.isArray(
            parsed.chateauFrontenacBuildings,
         )
            ? parsed.chateauFrontenacBuildings.filter(
                 (s: unknown): s is string => typeof s === "string",
              )
            : [],
         unitedNationsBuildings: Array.isArray(parsed.unitedNationsBuildings)
            ? parsed.unitedNationsBuildings.filter(
                 (s: unknown): s is string => typeof s === "string",
              )
            : [],
         finalHappiness:
            typeof parsed.finalHappiness === "number" && parsed.finalHappiness > 0
               ? parsed.finalHappiness
               : 0,
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
