import { useMemo, useState } from "react";
import bonusData from "./data/bonus-sources.json";

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

interface SidebarProps {
   gpLevels: Record<string, number>;
   wonderLevels: Record<string, number>;
   ageWisdom: Record<string, number>;
   onGpChange: (key: string, level: number) => void;
   onWonderChange: (key: string, level: number) => void;
   onAgeWisdomChange: (age: string, level: number) => void;
   /** Bulk-set every GP's level (testing helper). */
   onSetAllGpLevels: (level: number) => void;
}

export const Sidebar = ({
   gpLevels,
   wonderLevels,
   ageWisdom,
   onGpChange,
   onWonderChange,
   onAgeWisdomChange,
   onSetAllGpLevels,
}: SidebarProps): JSX.Element => {
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
                     {universalWonders.map((w) => (
                        <WonderRow
                           key={w.key}
                           wonder={w}
                           level={wonderLevels[w.key] ?? 0}
                           onChange={onWonderChange}
                        />
                     ))}
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
                                          {entries.map((w) => (
                                             <WonderRow
                                                key={w.key}
                                                wonder={w}
                                                level={wonderLevels[w.key] ?? 0}
                                                onChange={onWonderChange}
                                             />
                                          ))}
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
