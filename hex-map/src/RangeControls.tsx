import { useState } from "react";
import { FESTIVAL_TOGGLES, UPGRADE_TOGGLES } from "./wonderRange";

interface Props {
   showRanges: boolean;
   activeFestivals: string[];
   activeUpgrades: string[];
   onToggleShow: (next: boolean) => void;
   onToggleFestival: (wonderKey: string, next: boolean) => void;
   onToggleUpgrade: (upgradeId: string, next: boolean) => void;
}

export const RangeControls = ({
   showRanges,
   activeFestivals,
   activeUpgrades,
   onToggleShow,
   onToggleFestival,
   onToggleUpgrade,
}: Props): JSX.Element => {
   const [expanded, setExpanded] = useState(false);
   const festivalSet = new Set(activeFestivals);
   const upgradeSet = new Set(activeUpgrades);
   const activeCount = festivalSet.size + upgradeSet.size;

   return (
      <section className="range-controls">
         <header className="range-controls-header">
            <h3>Range outlines</h3>
            <label className="toggle">
               <input
                  type="checkbox"
                  checked={showRanges}
                  onChange={(e) => onToggleShow(e.target.checked)}
               />
               <span>Show</span>
            </label>
         </header>

         <button
            type="button"
            className="range-modifiers-toggle"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
         >
            <span className="caret">{expanded ? "▾" : "▸"}</span>
            Modifiers
            {activeCount > 0 && <span className="badge">{activeCount}</span>}
         </button>

         {expanded && (
            <div className="range-modifiers">
               <div className="range-group">
                  <h4>Festivals</h4>
                  <ul>
                     {FESTIVAL_TOGGLES.map((f) => (
                        <li key={f.key}>
                           <label className="toggle">
                              <input
                                 type="checkbox"
                                 checked={festivalSet.has(f.key)}
                                 disabled={!showRanges}
                                 onChange={(e) => onToggleFestival(f.key, e.target.checked)}
                              />
                              <span className="modifier-name">{f.name}</span>
                              <span className="modifier-delta">
                                 {f.baseRange} → {f.festivalRange}
                              </span>
                           </label>
                        </li>
                     ))}
                  </ul>
               </div>

               <div className="range-group">
                  <h4>Upgrades</h4>
                  <ul>
                     {UPGRADE_TOGGLES.map((u) => (
                        <li key={u.id}>
                           <label className="toggle">
                              <input
                                 type="checkbox"
                                 checked={upgradeSet.has(u.id)}
                                 disabled={!showRanges}
                                 onChange={(e) => onToggleUpgrade(u.id, e.target.checked)}
                              />
                              <span className="modifier-name">{u.name}</span>
                           </label>
                           <ul className="upgrade-affects">
                              {u.affects.map((a) => (
                                 <li key={a.key}>
                                    {a.name}: {a.baseRange} → {a.boostedRange}
                                 </li>
                              ))}
                           </ul>
                        </li>
                     ))}
                  </ul>
               </div>

               <p className="range-adjacency-note">
                  Adjacency boosts apply automatically: Yellow Crane Tower next to Yangtze
                  River, and Great Wall next to Forbidden City, get range 2 if those tiles
                  are labelled accordingly.
               </p>
            </div>
         )}
      </section>
   );
};
