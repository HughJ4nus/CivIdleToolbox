import { useMemo, useRef, useState } from "react";
import type { Building } from "./buildingTypes";
import bonusData from "./data/bonus-sources.json";
import { parseSaveFile, type ParsedSave } from "./saveImport";
import type { TradeTileBonus } from "./userState";

// Where CivIdle keeps its Steam saves on disk. The Electron app writes
// to a custom dir (not its userData dir) so Steam Cloud can sync it.
// Path is the same shape on every OS: <platform-prefix>/CivIdleSaves/<SteamID>/CivIdle.
// SteamID is per-account so we just show "<SteamID>" as a placeholder.
const detectSavePath = (): string => {
   const ua =
      typeof navigator !== "undefined" ? navigator.userAgent || "" : "";
   if (/Win/i.test(ua)) {
      return "%APPDATA%\\CivIdleSaves\\<SteamID>\\CivIdle";
   }
   if (/Mac|iPhone|iPad/i.test(ua)) {
      return "~/Library/Application Support/CivIdleSaves/<SteamID>/CivIdle";
   }
   return "~/.config/CivIdleSaves/<SteamID>/CivIdle";
};

interface GreatPersonEntry {
   key: string;
   name: string;
   age: string;
   kind: "boost" | "levelBoost";
   multipliers?: string[];
   buildings?: string[];
}

interface WonderEntry {
   key: string;
   name: string;
   effect: string;
   /** False for non-upgradeable wonders (natural wonders + most fixed
    *  world wonders). The sidebar renders these as a checkbox. */
   levelable: boolean;
   /** Civilization name when the wonder is unique to one civ; null for
    *  universal wonders (any civ can build them). */
   civilization: string | null;
}

interface BonusData {
   greatPeople: GreatPersonEntry[];
   wonders: WonderEntry[];
}

const DATA = bonusData as unknown as BonusData;

// Directional wonders metadata extracted from upstream — used by the
// per-wonder direction dropdown.
interface DirectionalDef {
   kindLabel: string;
   paths: Record<string, string[]>;
}
const DIRECTIONAL_WONDERS = (
   bonusData as unknown as {
      directionalWonders?: Record<string, DirectionalDef>;
   }
).directionalWonders ?? {};

const AGE_ORDER = [
   "StoneAge",
   "BronzeAge",
   "IronAge",
   "ClassicalAge",
   "MiddleAge",
   "RenaissanceAge",
   "IndustrialAge",
   "WorldWarAge",
   "ColdWarAge",
   "InformationAge",
] as const;

const ageLabel: Record<string, string> = {
   StoneAge: "Stone Age",
   BronzeAge: "Bronze Age",
   IronAge: "Iron Age",
   ClassicalAge: "Classical Age",
   MiddleAge: "Middle Age",
   RenaissanceAge: "Renaissance Age",
   IndustrialAge: "Industrial Age",
   WorldWarAge: "World War Age",
   ColdWarAge: "Cold War Age",
   InformationAge: "Information Age",
};

// Renders one wonder row. Checkbox for non-levelable wonders (the user
// just toggles ownership on/off); number input for upgradeable ones.
// Both store the same shape — checkbox writes 0 or 1.
const WonderRow = ({
   wonder,
   level,
   onChange,
}: {
   wonder: WonderEntry;
   level: number;
   onChange: (key: string, level: number) => void;
}): JSX.Element => (
   <li className="sidebar-row">
      <div className="sidebar-row-text">
         <div className="sidebar-row-name">{wonder.name}</div>
         <div className="sidebar-row-effect">{wonder.effect}</div>
      </div>
      {wonder.levelable ? (
         <input
            type="number"
            min={0}
            max={999}
            value={level}
            onChange={(e) =>
               onChange(
                  wonder.key,
                  Math.max(0, Math.floor(Number(e.target.value) || 0)),
               )
            }
         />
      ) : (
         <input
            type="checkbox"
            className="sidebar-checkbox"
            checked={level > 0}
            onChange={(e) => onChange(wonder.key, e.target.checked ? 1 : 0)}
            title="Owned (this wonder isn't upgradeable in-game)"
         />
      )}
   </li>
);

// Special-cased wonder row that owns a user-curated building list. Used
// by Cathedral of Brasília (each listed building gets +N output where
// N=list length) and Château Frontenac (each listed building gets +1
// level boost). The row is a checkbox + inline expandable list with
// add/remove — bulk-set isn't useful here so it's just per-row dropdowns.
const WonderWithBuildingListRow = ({
   wonder,
   level,
   onChange,
   buildings,
   buildingOptions,
   isOpen,
   onToggleOpen,
   onAdd,
   onRemove,
   onBuildingChange,
   listLabel,
   summary,
}: {
   wonder: WonderEntry;
   level: number;
   onChange: (key: string, level: number) => void;
   buildings: string[];
   buildingOptions: Building[];
   isOpen: boolean;
   onToggleOpen: () => void;
   onAdd: () => void;
   onRemove: (index: number) => void;
   onBuildingChange: (index: number, building: string) => void;
   /** Heading for the expandable list (e.g. "Buildings in chain"). */
   listLabel: string;
   /** Right-side summary in the toggle (e.g. "+18 to each" or "+1 level each"). */
   summary: (count: number) => string;
}): JSX.Element => {
   const owned = level > 0;
   return (
      <li className="sidebar-row sidebar-row-cob">
         <div className="sidebar-row-text" style={{ flex: "1 1 100%" }}>
            <div className="sidebar-cob-header">
               <div>
                  <div className="sidebar-row-name">{wonder.name}</div>
                  <div className="sidebar-row-effect">{wonder.effect}</div>
               </div>
               {wonder.levelable ? (
                  <input
                     type="number"
                     min={0}
                     max={999}
                     value={level}
                     onChange={(e) =>
                        onChange(
                           wonder.key,
                           Math.max(0, Math.floor(Number(e.target.value) || 0)),
                        )
                     }
                  />
               ) : (
                  <input
                     type="checkbox"
                     className="sidebar-checkbox"
                     checked={owned}
                     onChange={(e) => onChange(wonder.key, e.target.checked ? 1 : 0)}
                     title="Owned (this wonder isn't upgradeable in-game)"
                  />
               )}
            </div>
            {owned && (
               <>
                  <button
                     type="button"
                     className="sidebar-section-toggle sub sidebar-cob-toggle"
                     onClick={onToggleOpen}
                     aria-expanded={isOpen}
                  >
                     <span className="caret">{isOpen ? "▾" : "▸"}</span>
                     {listLabel}
                     <span className="sidebar-age-count">
                        {buildings.length > 0 ? summary(buildings.length) : 0}
                     </span>
                  </button>
                  {isOpen && (
                     <>
                        <ul className="sidebar-list sidebar-cob-list">
                           {buildings.map((b, i) => (
                              <li
                                 key={i}
                                 className="sidebar-row sidebar-trade-tile-row"
                              >
                                 <select
                                    className="sidebar-trade-tile-select"
                                    value={b}
                                    onChange={(e) =>
                                       onBuildingChange(i, e.target.value)
                                    }
                                 >
                                    <option value="">— pick a building —</option>
                                    {buildingOptions.map((opt) => (
                                       <option key={opt.key} value={opt.key}>
                                          {opt.name}
                                       </option>
                                    ))}
                                 </select>
                                 <button
                                    type="button"
                                    className="sidebar-trade-tile-remove"
                                    onClick={() => onRemove(i)}
                                    title="Remove this building"
                                    aria-label="Remove building"
                                 >
                                    ×
                                 </button>
                              </li>
                           ))}
                        </ul>
                        <button
                           type="button"
                           className="sidebar-trade-tile-add"
                           onClick={onAdd}
                        >
                           + Add building
                        </button>
                     </>
                  )}
               </>
            )}
         </div>
      </li>
   );
};

// Wonder row for ChoghaZanbil / LuxorTemple / BigBen — each picks a
// path (Tradition / Religion / Ideology), and each level unlocks one
// upgrade in that path. The row pairs the standard number input with a
// dropdown for the chosen direction.
const WonderWithDirectionRow = ({
   wonder,
   level,
   onChange,
   direction,
   onDirectionChange,
   kindLabel,
   pathKeys,
}: {
   wonder: WonderEntry;
   level: number;
   onChange: (key: string, level: number) => void;
   direction: string;
   onDirectionChange: (key: string, direction: string) => void;
   kindLabel: string;
   pathKeys: string[];
}): JSX.Element => (
   <li className="sidebar-row sidebar-row-cob">
      <div className="sidebar-row-text" style={{ flex: "1 1 100%" }}>
         <div className="sidebar-cob-header">
            <div>
               <div className="sidebar-row-name">{wonder.name}</div>
               <div className="sidebar-row-effect">{wonder.effect}</div>
            </div>
            <input
               type="number"
               min={0}
               max={pathKeys.length === 0 ? 99 : 5}
               value={level}
               onChange={(e) =>
                  onChange(
                     wonder.key,
                     Math.max(0, Math.floor(Number(e.target.value) || 0)),
                  )
               }
            />
         </div>
         {level > 0 && (
            <div className="sidebar-direction-row">
               <span className="sidebar-direction-label">{kindLabel}</span>
               <select
                  className="sidebar-trade-tile-select"
                  value={direction}
                  onChange={(e) => onDirectionChange(wonder.key, e.target.value)}
               >
                  <option value="">— pick a {kindLabel.toLowerCase()} —</option>
                  {pathKeys.map((p) => (
                     <option key={p} value={p}>
                        {p}
                     </option>
                  ))}
               </select>
            </div>
         )}
      </div>
   </li>
);

interface SidebarProps {
   gpLevels: Record<string, number>;
   wonderLevels: Record<string, number>;
   ageWisdom: Record<string, number>;
   tradeTiles: TradeTileBonus[];
   /** Cathedral of Brasília chain buildings — manual list the user
    *  curates to stand in for the in-game adjacency-based effect. */
   cobBuildings: string[];
   /** Château Frontenac target buildings — user picks which buildings
    *  the wonder boosts (each gets +1 effective level). */
   chateauBuildings: string[];
   /** United Nations General Assembly voted-boost targets — each gets
    *  +(UN level + 4) output multiplier. */
   unBuildings: string[];
   /** All non-special production buildings, used to populate the trade
    *  tile dropdown. */
   allBuildings: Building[];
   onGpChange: (key: string, level: number) => void;
   onWonderChange: (key: string, level: number) => void;
   onAgeWisdomChange: (age: string, level: number) => void;
   onAddTradeTile: () => void;
   onRemoveTradeTile: (id: string) => void;
   onTradeTileBuildingChange: (id: string, building: string) => void;
   onCobAddBuilding: () => void;
   onCobRemoveBuilding: (index: number) => void;
   onCobBuildingChange: (index: number, building: string) => void;
   onChateauAddBuilding: () => void;
   onChateauRemoveBuilding: (index: number) => void;
   onChateauBuildingChange: (index: number, building: string) => void;
   onUnAddBuilding: () => void;
   onUnRemoveBuilding: (index: number) => void;
   onUnBuildingChange: (index: number, building: string) => void;
   /** Picked path per directional wonder (ChoghaZanbil/LuxorTemple/BigBen). */
   wonderDirections: Record<string, string>;
   onWonderDirectionChange: (key: string, direction: string) => void;
   /** Bulk-set every GP's level (testing helper). */
   onSetAllGpLevels: (level: number) => void;
   /** Replace GPs / wonders / Age of Wisdom with values parsed from a
    *  player's save file. Trade tiles are preserved (they're a
    *  multiplayer/server feature and aren't in the save). */
   onImportSave: (parsed: ParsedSave) => void;
}

export const Sidebar = ({
   gpLevels,
   wonderLevels,
   ageWisdom,
   tradeTiles,
   allBuildings,
   onGpChange,
   onWonderChange,
   onAgeWisdomChange,
   cobBuildings,
   chateauBuildings,
   unBuildings,
   onAddTradeTile,
   onRemoveTradeTile,
   onTradeTileBuildingChange,
   onCobAddBuilding,
   onCobRemoveBuilding,
   onCobBuildingChange,
   onChateauAddBuilding,
   onChateauRemoveBuilding,
   onChateauBuildingChange,
   onUnAddBuilding,
   onUnRemoveBuilding,
   onUnBuildingChange,
   wonderDirections,
   onWonderDirectionChange,
   onSetAllGpLevels,
   onImportSave,
}: SidebarProps): JSX.Element => {
   const fileInputRef = useRef<HTMLInputElement | null>(null);
   const [importStatus, setImportStatus] = useState<{
      kind: "ok" | "err";
      msg: string;
   } | null>(null);
   const savePath = useMemo(() => detectSavePath(), []);

   const handleSaveFile = async (file: File): Promise<void> => {
      try {
         const parsed = await parseSaveFile(file);
         onImportSave(parsed);
         setImportStatus({
            kind: "ok",
            msg: `Imported ${parsed.stats.gpCount} GPs · ${parsed.stats.wonderCount} wonders · ${parsed.stats.ageWisdomCount} ages`,
         });
      } catch (e) {
         setImportStatus({
            kind: "err",
            msg: `Couldn't read save: ${e instanceof Error ? e.message : "unknown error"}`,
         });
      }
   };
   // Group great people by age, preserving the AGE_ORDER ordering.
   const groupedGPs = useMemo(() => {
      const buckets = new Map<string, GreatPersonEntry[]>();
      for (const gp of DATA.greatPeople) {
         if (!buckets.has(gp.age)) buckets.set(gp.age, []);
         buckets.get(gp.age)!.push(gp);
      }
      return AGE_ORDER.filter((a) => buckets.has(a)).map((age) => ({
         age,
         entries: buckets.get(age)!,
      }));
   }, []);

   // Only show Age of Wisdom inputs for ages that actually have GPs.
   const wisdomAges = useMemo(() => groupedGPs.map((g) => g.age), [groupedGPs]);

   // Sorted list of buildings for the trade tile dropdown. The game only
   // assigns trade tile bonuses to Classical-Age-and-later production
   // buildings, but we don't have tech-age data per building locally —
   // showing every non-special production building is a strict superset
   // and harmless (the user picks what they actually have).
   const tradeTileOptions = useMemo(
      () =>
         allBuildings
            .filter((b) => !b.special)
            .slice()
            .sort((a, b) => a.name.localeCompare(b.name)),
      [allBuildings],
   );

   // Split wonders into universal vs civ-specific. Civ-specific are
   // grouped by civilization name so each civ gets its own collapsible
   // sub-section under the "Civilization-specific" header.
   const { universalWonders, civWonders } = useMemo(() => {
      const universal: WonderEntry[] = [];
      const byCiv = new Map<string, WonderEntry[]>();
      for (const w of DATA.wonders) {
         if (w.civilization) {
            if (!byCiv.has(w.civilization)) byCiv.set(w.civilization, []);
            byCiv.get(w.civilization)!.push(w);
         } else {
            universal.push(w);
         }
      }
      // Sort each list alphabetically; sort civilizations alphabetically too.
      universal.sort((a, b) => a.name.localeCompare(b.name));
      const civs = [...byCiv.entries()]
         .map(([civ, entries]) => ({
            civilization: civ,
            entries: entries.sort((a, b) => a.name.localeCompare(b.name)),
         }))
         .sort((a, b) => a.civilization.localeCompare(b.civilization));
      return { universalWonders: universal, civWonders: civs };
   }, []);

   const setCount = useMemo(
      () =>
         Object.values(gpLevels).filter((v) => v > 0).length +
         Object.values(wonderLevels).filter((v) => v > 0).length,
      [gpLevels, wonderLevels],
   );

   // Local state for the testing helper input.
   const [bulkLevel, setBulkLevel] = useState(0);

   // Each section is collapsed by default; clicking the heading toggles.
   const [openSections, setOpenSections] = useState<Record<string, boolean>>({
      ageWisdom: true,
      wonders: true,
   });
   const toggle = (id: string) =>
      setOpenSections((prev) => ({ ...prev, [id]: !prev[id] }));

   return (
      <aside className="sidebar">
         <div className="sidebar-header">
            <h2>Your bonuses</h2>
            <span className="set-count">{setCount} set</span>
         </div>
         <p className="sidebar-tagline">
            Enter levels for the great people and wonders you have. Bonuses
            apply to chain math when you open a production line — cards that
            pick up a bonus show a pill with the effective output multiplier.
         </p>
         <div className="sidebar-import">
            <button
               type="button"
               className="sidebar-import-btn"
               onClick={() => fileInputRef.current?.click()}
            >
               Import save file…
            </button>
            <input
               ref={fileInputRef}
               type="file"
               style={{ display: "none" }}
               onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void handleSaveFile(f);
                  // Reset so picking the same file twice still fires onChange.
                  e.target.value = "";
               }}
            />
            <div
               className="sidebar-import-hint"
               title="Browsers don't let websites pre-open arbitrary folders — copy this path into the file picker's location bar."
            >
               <span className="sidebar-import-hint-label">Save lives at</span>
               <code>{savePath}</code>
            </div>
            {importStatus && (
               <div className={`sidebar-import-status ${importStatus.kind}`}>
                  {importStatus.msg}
               </div>
            )}
         </div>

         {/* Wonders — universal at the top, civ-specific in a sub-section
             grouped by civilization. Non-levelable wonders render as
             checkboxes so the user can't accidentally type a level into
             something that's intrinsically max-1. */}
         <section className="sidebar-section">
            <button
               type="button"
               className="sidebar-section-toggle"
               onClick={() => toggle("wonders")}
               aria-expanded={openSections.wonders ?? false}
            >
               <span className="caret">{openSections.wonders ? "▾" : "▸"}</span>
               Wonders ({DATA.wonders.length})
            </button>
            {openSections.wonders && (
               <>
                  <ul className="sidebar-list">
                     {universalWonders.map((w) => {
                        const dirDef = DIRECTIONAL_WONDERS[w.key];
                        if (dirDef) {
                           return (
                              <WonderWithDirectionRow
                                 key={w.key}
                                 wonder={w}
                                 level={wonderLevels[w.key] ?? 0}
                                 onChange={onWonderChange}
                                 direction={wonderDirections[w.key] ?? ""}
                                 onDirectionChange={onWonderDirectionChange}
                                 kindLabel={dirDef.kindLabel}
                                 pathKeys={Object.keys(dirDef.paths)}
                              />
                           );
                        }
                        if (w.key === "UnitedNations") {
                           return (
                              <WonderWithBuildingListRow
                                 key={w.key}
                                 wonder={w}
                                 level={wonderLevels[w.key] ?? 0}
                                 onChange={onWonderChange}
                                 buildings={unBuildings}
                                 buildingOptions={tradeTileOptions}
                                 isOpen={openSections.unTargets ?? false}
                                 onToggleOpen={() => toggle("unTargets")}
                                 onAdd={onUnAddBuilding}
                                 onRemove={onUnRemoveBuilding}
                                 onBuildingChange={onUnBuildingChange}
                                 listLabel="General Assembly targets"
                                 summary={(n) => {
                                    const lvl = wonderLevels[w.key] ?? 0;
                                    return `${n} · +${lvl + 4} output each`;
                                 }}
                              />
                           );
                        }
                        return (
                           <WonderRow
                              key={w.key}
                              wonder={w}
                              level={wonderLevels[w.key] ?? 0}
                              onChange={onWonderChange}
                           />
                        );
                     })}
                  </ul>
                  {civWonders.length > 0 && (
                     <div className="sidebar-subsection">
                        <button
                           type="button"
                           className="sidebar-section-toggle sub"
                           onClick={() => toggle("civWonders")}
                           aria-expanded={openSections.civWonders ?? false}
                        >
                           <span className="caret">
                              {openSections.civWonders ? "▾" : "▸"}
                           </span>
                           Civilization-specific
                           <span className="sidebar-age-count">
                              {civWonders.reduce(
                                 (n, c) => n + c.entries.length,
                                 0,
                              )}
                           </span>
                        </button>
                        {openSections.civWonders &&
                           civWonders.map(({ civilization, entries }) => {
                              const id = `civ-${civilization}`;
                              const open = openSections[id] ?? false;
                              const setInThisCiv = entries.filter(
                                 (e) => (wonderLevels[e.key] ?? 0) > 0,
                              ).length;
                              return (
                                 <div
                                    key={civilization}
                                    className="sidebar-subsection sidebar-subsection-nested"
                                 >
                                    <button
                                       type="button"
                                       className="sidebar-section-toggle sub"
                                       onClick={() => toggle(id)}
                                       aria-expanded={open}
                                    >
                                       <span className="caret">
                                          {open ? "▾" : "▸"}
                                       </span>
                                       {civilization}
                                       <span className="sidebar-age-count">
                                          {setInThisCiv > 0
                                             ? `${setInThisCiv}/${entries.length}`
                                             : entries.length}
                                       </span>
                                    </button>
                                    {open && (
                                       <ul className="sidebar-list">
                                          {entries.map((w) => {
                                             if (w.key === "CathedralOfBrasilia") {
                                                return (
                                                   <WonderWithBuildingListRow
                                                      key={w.key}
                                                      wonder={w}
                                                      level={wonderLevels[w.key] ?? 0}
                                                      onChange={onWonderChange}
                                                      buildings={cobBuildings}
                                                      buildingOptions={tradeTileOptions}
                                                      isOpen={
                                                         openSections.cobChain ?? false
                                                      }
                                                      onToggleOpen={() =>
                                                         toggle("cobChain")
                                                      }
                                                      onAdd={onCobAddBuilding}
                                                      onRemove={onCobRemoveBuilding}
                                                      onBuildingChange={
                                                         onCobBuildingChange
                                                      }
                                                      listLabel="Buildings in chain"
                                                      summary={(n) => `${n} · +${n} to each`}
                                                   />
                                                );
                                             }
                                             if (w.key === "ChateauFrontenac") {
                                                return (
                                                   <WonderWithBuildingListRow
                                                      key={w.key}
                                                      wonder={w}
                                                      level={wonderLevels[w.key] ?? 0}
                                                      onChange={onWonderChange}
                                                      buildings={chateauBuildings}
                                                      buildingOptions={tradeTileOptions}
                                                      isOpen={
                                                         openSections.chateauTargets ?? false
                                                      }
                                                      onToggleOpen={() =>
                                                         toggle("chateauTargets")
                                                      }
                                                      onAdd={onChateauAddBuilding}
                                                      onRemove={onChateauRemoveBuilding}
                                                      onBuildingChange={
                                                         onChateauBuildingChange
                                                      }
                                                      listLabel="Selected buildings"
                                                      summary={(n) => `${n} · +1 level each`}
                                                   />
                                                );
                                             }
                                             return (
                                                <WonderRow
                                                   key={w.key}
                                                   wonder={w}
                                                   level={wonderLevels[w.key] ?? 0}
                                                   onChange={onWonderChange}
                                                />
                                             );
                                          })}
                                       </ul>
                                    )}
                                 </div>
                              );
                           })}
                     </div>
                  )}
               </>
            )}
         </section>

         {/* Trade tiles — each gives +5 output to its target building.
             World Trade Organization additionally adds +wtoLevel per
             tile (handled in the bonus resolver). */}
         <section className="sidebar-section">
            <button
               type="button"
               className="sidebar-section-toggle"
               onClick={() => toggle("tradeTiles")}
               aria-expanded={openSections.tradeTiles ?? false}
            >
               <span className="caret">
                  {openSections.tradeTiles ? "▾" : "▸"}
               </span>
               Trade tiles
               <span className="sidebar-age-count">{tradeTiles.length}</span>
            </button>
            {openSections.tradeTiles && (
               <>
                  <ul className="sidebar-list">
                     {tradeTiles.map((tile) => (
                        <li key={tile.id} className="sidebar-row sidebar-trade-tile-row">
                           <select
                              className="sidebar-trade-tile-select"
                              value={tile.building}
                              onChange={(e) =>
                                 onTradeTileBuildingChange(tile.id, e.target.value)
                              }
                           >
                              <option value="">— pick a building —</option>
                              {tradeTileOptions.map((b) => (
                                 <option key={b.key} value={b.key}>
                                    {b.name}
                                 </option>
                              ))}
                           </select>
                           <button
                              type="button"
                              className="sidebar-trade-tile-remove"
                              onClick={() => onRemoveTradeTile(tile.id)}
                              title="Remove this trade tile"
                              aria-label="Remove trade tile"
                           >
                              ×
                           </button>
                        </li>
                     ))}
                  </ul>
                  <button
                     type="button"
                     className="sidebar-trade-tile-add"
                     onClick={onAddTradeTile}
                  >
                     + Add trade tile
                  </button>
               </>
            )}
         </section>

         {/* Great people, grouped by age */}
         <section className="sidebar-section">
            <h3 className="sidebar-section-heading">
               Great people ({DATA.greatPeople.length})
            </h3>
            {/* Testing helper: bulk-set every GP's level. */}
            <div className="sidebar-bulk-row" title="Testing convenience — overwrites every GP's level">
               <span className="sidebar-bulk-label">Set all to</span>
               <input
                  type="number"
                  min={0}
                  max={999}
                  value={bulkLevel}
                  onChange={(e) =>
                     setBulkLevel(Math.max(0, Math.floor(Number(e.target.value) || 0)))
                  }
               />
               <button type="button" onClick={() => onSetAllGpLevels(bulkLevel)}>
                  Apply
               </button>
            </div>
            {groupedGPs.map(({ age, entries }) => {
               const id = `age-${age}`;
               const open = openSections[id] ?? false;
               const setInThisAge = entries.filter((e) => (gpLevels[e.key] ?? 0) > 0)
                  .length;
               const wisdomBonus = ageWisdom[age] ?? 0;
               return (
                  <div key={age} className="sidebar-subsection">
                     <button
                        type="button"
                        className="sidebar-section-toggle sub"
                        onClick={() => toggle(id)}
                        aria-expanded={open}
                     >
                        <span className="caret">{open ? "▾" : "▸"}</span>
                        {ageLabel[age] ?? age}
                        {wisdomBonus > 0 && (
                           <span className="sidebar-wisdom-badge" title="Age of Wisdom bonus">
                              +{wisdomBonus}
                           </span>
                        )}
                        <span className="sidebar-age-count">
                           {setInThisAge > 0
                              ? `${setInThisAge}/${entries.length}`
                              : entries.length}
                        </span>
                     </button>
                     {open && (
                        <ul className="sidebar-list">
                           {entries.map((gp) => {
                              const baseLevel = gpLevels[gp.key] ?? 0;
                              return (
                                 <li key={gp.key} className="sidebar-row">
                                    <div className="sidebar-row-text">
                                       <div className="sidebar-row-name">{gp.name}</div>
                                       <div className="sidebar-row-effect">
                                          {gp.kind === "levelBoost"
                                             ? "Level boost (raises a building's effective level)"
                                             : `${(gp.multipliers ?? []).join(" / ")} → ${(gp.buildings ?? []).join(", ")}`}
                                       </div>
                                    </div>
                                    <input
                                       type="number"
                                       min={0}
                                       max={999}
                                       value={baseLevel}
                                       onChange={(e) =>
                                          onGpChange(
                                             gp.key,
                                             Math.max(
                                                0,
                                                Math.floor(Number(e.target.value) || 0),
                                             ),
                                          )
                                       }
                                    />
                                    {/* +X badge — show only when AoW > 0 AND
                                        the user has a base level (so the
                                        bonus is actually doing something). */}
                                    <span
                                       className={`sidebar-wisdom-add${
                                          wisdomBonus > 0 && baseLevel > 0 ? "" : " empty"
                                       }`}
                                       title={
                                          wisdomBonus > 0
                                             ? `+${wisdomBonus} from Age of Wisdom (effective ${baseLevel + wisdomBonus})`
                                             : "No Age of Wisdom for this age"
                                       }
                                    >
                                       {wisdomBonus > 0 ? `+${wisdomBonus}` : ""}
                                    </span>
                                 </li>
                              );
                           })}
                        </ul>
                     )}
                  </div>
               );
            })}
         </section>

         {/* Age of Wisdom — adds directly to every GP of that age. Lives
             below Great People so the user typically configures GPs first
             and then sees the +X badges update as they tweak Wisdom. */}
         <section className="sidebar-section">
            <button
               type="button"
               className="sidebar-section-toggle"
               onClick={() => toggle("ageWisdom")}
               aria-expanded={openSections.ageWisdom ?? false}
            >
               <span className="caret">{openSections.ageWisdom ? "▾" : "▸"}</span>
               Age of Wisdom ({wisdomAges.length})
            </button>
            {openSections.ageWisdom && (
               <ul className="sidebar-list">
                  {wisdomAges.map((age) => (
                     <li key={age} className="sidebar-row">
                        <div className="sidebar-row-text">
                           <div className="sidebar-row-name">{ageLabel[age] ?? age}</div>
                           <div className="sidebar-row-effect">
                              +N effective level to every {ageLabel[age] ?? age} GP
                           </div>
                        </div>
                        <input
                           type="number"
                           min={0}
                           max={999}
                           value={ageWisdom[age] ?? 0}
                           onChange={(e) =>
                              onAgeWisdomChange(
                                 age,
                                 Math.max(0, Math.floor(Number(e.target.value) || 0)),
                              )
                           }
                        />
                     </li>
                  ))}
               </ul>
            )}
         </section>
      </aside>
   );
};
