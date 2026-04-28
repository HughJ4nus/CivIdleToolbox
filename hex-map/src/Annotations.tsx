import { useState } from "react";
import type { Annotation, PaletteEntry } from "./types";

interface Props {
   annotations: Annotation[];
   palette: PaletteEntry[];
   onAdd: () => void;
   onUpdate: (id: string, patch: Partial<Annotation>) => void;
   onRemove: (id: string) => void;
   onMove: (id: string, dir: -1 | 1) => void;
   notes: string;
   onNotesChange: (next: string) => void;
}

export const Annotations = ({
   annotations,
   palette,
   onAdd,
   onUpdate,
   onRemove,
   onMove,
   notes,
   onNotesChange,
}: Props): JSX.Element => {
   const [collapsed, setCollapsed] = useState(false);
   const colorOf = (id: string | null) =>
      (id && palette.find((p) => p.id === id)?.color) || "#1f1f1f";

   return (
      <div className="annotations">
         <div className="legend-header">
            <h3>
               <button
                  type="button"
                  className="collapse-btn"
                  onClick={() => setCollapsed((v) => !v)}
                  aria-label={collapsed ? "Expand" : "Collapse"}
                  title={collapsed ? "Expand" : "Collapse"}
               >
                  {collapsed ? "▸" : "▾"}
               </button>
               Export panel
            </h3>
         </div>

         {!collapsed && (
            <>
               <label className="block-label">Notes</label>
               <textarea
                  className="notes-input"
                  rows={5}
                  placeholder="Free-form notes printed on the right side of the export…"
                  value={notes}
                  onChange={(e) => onNotesChange(e.target.value)}
               />

               <div className="legend-header" style={{ marginTop: 16 }}>
                  <label className="block-label" style={{ margin: 0 }}>
                     Build order
                  </label>
                  <button type="button" onClick={onAdd} title="Add row">
                     + add row
                  </button>
               </div>

               {annotations.length === 0 && (
                  <p className="legend-hint" style={{ marginTop: 8 }}>
                     Add rows to print an ordered list of buildings/wonders next to the map. Each row has a
                     short tier badge (e.g. Roman numeral), an optional palette color, and a label.
                  </p>
               )}

               <ul className="ann-list">
                  {annotations.map((a, idx) => (
                     <li key={a.id} className="ann-row">
                        <input
                           type="text"
                           className="ann-tier"
                           value={a.tier}
                           maxLength={6}
                           onChange={(e) => onUpdate(a.id, { tier: e.target.value })}
                           aria-label="Tier"
                           placeholder="I"
                        />
                        <select
                           value={a.colorId ?? ""}
                           onChange={(e) => onUpdate(a.id, { colorId: e.target.value || null })}
                           className="ann-color"
                           style={{ background: colorOf(a.colorId) }}
                           aria-label="Color"
                        >
                           <option value="">—</option>
                           {palette.map((p) => (
                              <option key={p.id} value={p.id}>
                                 {p.label || p.id}
                              </option>
                           ))}
                        </select>
                        <input
                           type="text"
                           className="ann-label"
                           value={a.label}
                           onChange={(e) => onUpdate(a.id, { label: e.target.value })}
                           placeholder="Label"
                        />
                        <div className="ann-row-actions">
                           <button
                              type="button"
                              onClick={() => onMove(a.id, -1)}
                              disabled={idx === 0}
                              title="Move up"
                              className="icon-btn"
                           >
                              ▲
                           </button>
                           <button
                              type="button"
                              onClick={() => onMove(a.id, 1)}
                              disabled={idx === annotations.length - 1}
                              title="Move down"
                              className="icon-btn"
                           >
                              ▼
                           </button>
                           <button
                              type="button"
                              onClick={() => onRemove(a.id)}
                              title="Remove row"
                              className="icon-btn icon-btn-danger"
                           >
                              ×
                           </button>
                        </div>
                     </li>
                  ))}
               </ul>
            </>
         )}
      </div>
   );
};
